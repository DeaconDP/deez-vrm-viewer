import { BoneNameLookup, canReconnectDetachedMatches, matchByProximity, proximityMatchDistance, translationOfMatrix } from '../viewer/boneNameMatch';
import { BAKE_LIMITS, type BakeOptions, type BakeResult, type BakeStage, type BakeStats } from './types';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const FLOAT = 5126;
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_SIZE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

type Json = Record<string, any>;
type Matrix = number[];
type Progress = (stage: BakeStage, progress: number, detail: string, stats?: BakeStats) => void;

export class BakeError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'BakeError'; }
}

interface Chunk { type: number; offset: number; length: number }
interface ParsedGlb { json: Json; chunks: Chunk[]; bin: Chunk; source: ArrayBuffer }

interface AccessorView {
  accessor: Json;
  view: Json;
  data: DataView;
  start: number;
  stride: number;
  components: number;
  componentBytes: number;
}

interface SkinInfo { joints: number[]; inverseBindAccessor: number; inverseBinds: Matrix[] }

const fail = (code: string, message: string): never => { throw new BakeError(code, message); };
const finite = (value: number, label: string) => Number.isFinite(value) ? value : fail('NON_FINITE_DATA', `${label} contains a non-finite value.`);

export function bakedFileName(name: string) {
  const base = name.replace(/\.vrm$/i, '');
  return `${base}-baked.vrm`;
}

export function parseGlb(source: ArrayBuffer): ParsedGlb {
  if (source.byteLength < 20) fail('MALFORMED_GLB', 'The VRM is too small to contain a valid GLB.');
  const data = new DataView(source);
  if (data.getUint32(0, true) !== GLB_MAGIC) fail('MALFORMED_GLB', 'The file does not contain a GLB header.');
  if (data.getUint32(4, true) !== 2) fail('UNSUPPORTED_GLB', 'Only GLB version 2 VRM files can be baked.');
  if (data.getUint32(8, true) !== source.byteLength) fail('MALFORMED_GLB', 'The GLB declared length does not match the file size.');
  const chunks: Chunk[] = [];
  let offset = 12;
  while (offset < source.byteLength) {
    if (offset + 8 > source.byteLength) fail('MALFORMED_GLB', 'A GLB chunk header is truncated.');
    const length = data.getUint32(offset, true), type = data.getUint32(offset + 4, true);
    if (length % 4 || offset + 8 + length > source.byteLength) fail('MALFORMED_GLB', 'A GLB chunk has invalid bounds or alignment.');
    chunks.push({ type, offset: offset + 8, length });
    offset += 8 + length;
  }
  if (offset !== source.byteLength || chunks[0]?.type !== JSON_CHUNK) fail('MALFORMED_GLB', 'The GLB must begin with one JSON chunk.');
  const bins = chunks.filter(chunk => chunk.type === BIN_CHUNK);
  if (bins.length !== 1) fail('UNSUPPORTED_GLB', 'The beta baker requires exactly one embedded binary chunk.');
  let json: Json = {};
  try {
    const text = new TextDecoder().decode(new Uint8Array(source, chunks[0].offset, chunks[0].length)).replace(/[\u0000 ]+$/g, '');
    json = JSON.parse(text);
  } catch { fail('MALFORMED_GLB', 'The GLB JSON chunk could not be parsed.'); }
  if (json.asset?.version !== '2.0') fail('UNSUPPORTED_GLB', 'The embedded asset is not glTF 2.0.');
  return { json, chunks, bin: bins[0], source };
}

function align4(value: number) { return Math.ceil(value / 4) * 4; }

function materializeSparseAccessors(parsed: ParsedGlb, progress: Progress): ParsedGlb {
  const sparseEntries = (parsed.json.accessors ?? []).map((accessor: Json, index: number) => ({ accessor, index })).filter(({ accessor }: { accessor: Json }) => accessor.sparse);
  if (!sparseEntries.length) return parsed;
  progress('preflight', 0.05, `Expanding ${sparseEntries.length} sparse accessor${sparseEntries.length === 1 ? '' : 's'} safely`);
  const json = parsed.json, declaredLength = json.buffers?.[0]?.byteLength;
  if (!Number.isInteger(declaredLength) || declaredLength < 0 || declaredLength > parsed.bin.length) fail('MALFORMED_GLB', 'The embedded buffer has an invalid declared length.');
  json.bufferViews ??= [];
  const additions: { accessor: Json; bytes: Uint8Array; offset: number }[] = [];
  let nextOffset = align4(declaredLength);
  const binData = new DataView(parsed.source, parsed.bin.offset, parsed.bin.length);
  const region = (bufferViewIndex: number, relativeOffset: number, length: number, label: string) => {
    const view = json.bufferViews?.[bufferViewIndex];
    if (!view || (view.buffer ?? 0) !== 0 || view.extensions?.EXT_meshopt_compression) fail('UNSUPPORTED_ACCESSOR', `${label} is not stored in an uncompressed embedded buffer view.`);
    const start = (view.byteOffset ?? 0) + relativeOffset, end = start + length;
    if (start < (view.byteOffset ?? 0) || end > (view.byteOffset ?? 0) + view.byteLength || end > declaredLength) fail('MALFORMED_GLB', `${label} exceeds its buffer view bounds.`);
    return { view, start };
  };
  for (const { accessor, index } of sparseEntries) {
    const componentBytes = COMPONENT_BYTES[accessor.componentType], components = TYPE_SIZE[accessor.type], sparse = accessor.sparse;
    if (!componentBytes || !components || !Number.isInteger(accessor.count) || accessor.count < 0) fail('MALFORMED_GLB', `Sparse accessor ${index} has invalid metadata.`);
    if (!Number.isInteger(sparse.count) || sparse.count < 0 || sparse.count > accessor.count) fail('MALFORMED_GLB', `Sparse accessor ${index} has an invalid sparse count.`);
    const packed = componentBytes * components, dense = new Uint8Array(accessor.count * packed);
    if (Number.isInteger(accessor.bufferView)) {
      const baseView = json.bufferViews?.[accessor.bufferView];
      const stride = baseView?.byteStride ?? packed;
      if (!baseView || stride < packed || stride % componentBytes) fail('UNSUPPORTED_ACCESSOR', `Sparse accessor ${index} has an invalid base stride.`);
      const base = region(accessor.bufferView, accessor.byteOffset ?? 0, accessor.count ? (accessor.count - 1) * stride + packed : 0, `Sparse accessor ${index} base`);
      for (let element = 0; element < accessor.count; element++) dense.set(new Uint8Array(parsed.source, parsed.bin.offset + base.start + element * stride, packed), element * packed);
    }
    const indexType = sparse.indices?.componentType, indexBytes = COMPONENT_BYTES[indexType];
    if (![5121, 5123, 5125].includes(indexType) || !indexBytes) fail('UNSUPPORTED_ACCESSOR', `Sparse accessor ${index} uses unsupported index components.`);
    const indices = region(sparse.indices?.bufferView, sparse.indices?.byteOffset ?? 0, sparse.count * indexBytes, `Sparse accessor ${index} indices`);
    const values = region(sparse.values?.bufferView, sparse.values?.byteOffset ?? 0, sparse.count * packed, `Sparse accessor ${index} values`);
    let previous = -1;
    for (let sparseIndex = 0; sparseIndex < sparse.count; sparseIndex++) {
      const offset = indices.start + sparseIndex * indexBytes;
      const denseIndex = indexType === 5121 ? binData.getUint8(offset) : indexType === 5123 ? binData.getUint16(offset, true) : binData.getUint32(offset, true);
      if (denseIndex <= previous || denseIndex >= accessor.count) fail('MALFORMED_GLB', `Sparse accessor ${index} indices must be increasing and in range.`);
      previous = denseIndex;
      dense.set(new Uint8Array(parsed.source, parsed.bin.offset + values.start + sparseIndex * packed, packed), denseIndex * packed);
    }
    additions.push({ accessor, bytes: dense, offset: nextOffset });
    nextOffset = align4(nextOffset + dense.byteLength);
  }
  if (nextOffset > BAKE_LIMITS.maxInputBytes) fail('SPARSE_EXPANSION_TOO_LARGE', 'Expanding this VRM’s sparse accessors would exceed the 128 MiB safety limit.');
  const binary = new Uint8Array(nextOffset);
  binary.set(new Uint8Array(parsed.source, parsed.bin.offset, declaredLength));
  for (const addition of additions) {
    const bufferView = json.bufferViews.length;
    json.bufferViews.push({ buffer: 0, byteOffset: addition.offset, byteLength: addition.bytes.byteLength });
    binary.set(addition.bytes, addition.offset);
    addition.accessor.bufferView = bufferView;
    delete addition.accessor.byteOffset;
    delete addition.accessor.sparse;
  }
  json.buffers[0].byteLength = binary.byteLength;
  return parseGlb(rebuildGlb(parsed, binary));
}

function identity(): Matrix { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }

export function multiply(a: Matrix, b: Matrix): Matrix {
  const out = new Array<number>(16);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    let value = 0;
    for (let k = 0; k < 4; k++) value += a[k * 4 + row] * b[column * 4 + k];
    out[column * 4 + row] = value;
  }
  return out;
}

export function invert(m: Matrix): Matrix {
  const a = m.slice(), out = identity();
  for (let column = 0; column < 4; column++) {
    let pivot = column;
    for (let row = column + 1; row < 4; row++) if (Math.abs(a[column * 4 + row]) > Math.abs(a[column * 4 + pivot])) pivot = row;
    const pivotValue = a[column * 4 + pivot];
    if (!Number.isFinite(pivotValue) || Math.abs(pivotValue) < 1e-10) fail('SINGULAR_TRANSFORM', 'A bone or mesh transform cannot be inverted safely.');
    if (pivot !== column) for (let c = 0; c < 4; c++) {
      [a[c * 4 + column], a[c * 4 + pivot]] = [a[c * 4 + pivot], a[c * 4 + column]];
      [out[c * 4 + column], out[c * 4 + pivot]] = [out[c * 4 + pivot], out[c * 4 + column]];
    }
    const scale = 1 / a[column * 4 + column];
    for (let c = 0; c < 4; c++) { a[c * 4 + column] *= scale; out[c * 4 + column] *= scale; }
    for (let row = 0; row < 4; row++) if (row !== column) {
      const factor = a[column * 4 + row];
      for (let c = 0; c < 4; c++) { a[c * 4 + row] -= factor * a[c * 4 + column]; out[c * 4 + row] -= factor * out[c * 4 + column]; }
    }
  }
  return out;
}

function nodeMatrix(node: Json): Matrix {
  if (node.matrix) {
    if (!Array.isArray(node.matrix) || node.matrix.length !== 16) fail('MALFORMED_GLB', 'A node matrix is invalid.');
    return node.matrix.map((value: number) => finite(value, 'Node matrix'));
  }
  const t = node.translation ?? [0, 0, 0], q = node.rotation ?? [0, 0, 0, 1], s = node.scale ?? [1, 1, 1];
  if (t.length !== 3 || q.length !== 4 || s.length !== 3) fail('MALFORMED_GLB', 'A node transform has an invalid size.');
  const [x, y, z, w] = q.map((v: number) => finite(v, 'Node rotation'));
  const [sx, sy, sz] = s.map((v: number) => finite(v, 'Node scale'));
  return [
    (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    finite(t[0], 'Node translation'), finite(t[1], 'Node translation'), finite(t[2], 'Node translation'), 1
  ];
}

function buildHierarchy(nodes: Json[]) {
  const parents = new Array<number>(nodes.length).fill(-1);
  nodes.forEach((node, parent) => (node.children ?? []).forEach((child: number) => {
    if (!Number.isInteger(child) || !nodes[child]) fail('MALFORMED_GLB', 'The node hierarchy contains an invalid child reference.');
    if (parents[child] !== -1) fail('UNSUPPORTED_HIERARCHY', 'A node has multiple parents and cannot be normalized safely.');
    parents[child] = parent;
  }));
  const visiting = new Set<number>(), worlds = new Array<Matrix>(nodes.length);
  const worldFor = (index: number): Matrix => {
    if (worlds[index]) return worlds[index];
    if (visiting.has(index)) fail('UNSUPPORTED_HIERARCHY', 'The node hierarchy contains a cycle.');
    visiting.add(index);
    const local = nodeMatrix(nodes[index]);
    worlds[index] = parents[index] === -1 ? local : multiply(worldFor(parents[index]), local);
    visiting.delete(index);
    return worlds[index];
  };
  nodes.forEach((_, index) => worldFor(index));
  return { parents, worlds };
}

function humanoidBoneEntries(json: Json): { boneName: string; node: number }[] {
  const vrm1Bones = json.extensions?.VRMC_vrm?.humanoid?.humanBones;
  if (vrm1Bones && !Array.isArray(vrm1Bones)) {
    return Object.entries(vrm1Bones).flatMap(([boneName, bone]: [string, any]) => Number.isInteger(bone?.node) ? [{ boneName, node: bone.node as number }] : []);
  }
  const vrm0Bones = json.extensions?.VRM?.humanoid?.humanBones;
  if (Array.isArray(vrm0Bones)) {
    return vrm0Bones.flatMap((bone: Json) => Number.isInteger(bone?.node) && typeof bone?.bone === 'string' ? [{ boneName: bone.bone as string, node: bone.node as number }] : []);
  }
  return [];
}

function humanoidModelHeight(humanoid: { boneName: string; node: number }[], worlds: Matrix[]) {
  const hips = humanoid.find(entry => entry.boneName === 'hips');
  const head = humanoid.find(entry => entry.boneName === 'head');
  if (hips && head && worlds[hips.node] && worlds[head.node]) {
    const height = Math.abs(translationOfMatrix(worlds[head.node]).y - translationOfMatrix(worlds[hips.node]).y);
    if (height > 1e-3) return height;
  }
  return 1.6;
}

function repairDetachedSkeletons(json: Json, nodes: Json[], skins: Json[], skinInfos: SkinInfo[], worlds: Matrix[]) {
  const humanoid = humanoidBoneEntries(json);
  const canonicalNodes = new Set(humanoid.map(entry => entry.node));
  const boneNameByNode = new Map(humanoid.map(entry => [entry.node, entry.boneName]));
  if (!canonicalNodes.size) return { reconnectedSkins: 0, remappedJoints: 0, unrepairedDetachedSkins: 0, unrepairedJointNames: [] as string[] };

  const lookup = new BoneNameLookup<number>();
  const canonicalTargets = humanoid.flatMap(({ boneName, node }) => {
    if (!nodes[node] || !worlds[node]) return [];
    lookup.register({ boneName, name: nodes[node].name, value: node });
    return [{ id: node, point: translationOfMatrix(worlds[node]) }];
  });
  const maxDistance = proximityMatchDistance(humanoidModelHeight(humanoid, worlds));

  let reconnectedSkins = 0, remappedJoints = 0, unrepairedDetachedSkins = 0;
  const unrepairedJointNames: string[] = [];
  const rememberUnrepairedNames = (joints: number[]) => {
    for (const joint of joints) {
      const name = nodes[joint]?.name;
      if (!name || unrepairedJointNames.includes(name)) continue;
      unrepairedJointNames.push(name);
      if (unrepairedJointNames.length >= 8) break;
    }
  };

  skinInfos.forEach((info, skinIndex) => {
    const detachedJoints = info.joints.filter(joint => !canonicalNodes.has(joint));
    if (!detachedJoints.length) return;
    const fullyDetached = !info.joints.some(joint => canonicalNodes.has(joint));

    const replacement = new Map<number, number>();
    for (const joint of detachedJoints) {
      const canonical = lookup.resolve(nodes[joint]?.name);
      if (canonical != null) replacement.set(joint, canonical);
    }

    {
      const unmatched = detachedJoints.filter(joint => !replacement.has(joint));
      const usedTargets = new Set(replacement.values());
      const spatial = matchByProximity(
        unmatched.filter(joint => worlds[joint]).map(joint => ({ id: joint, point: translationOfMatrix(worlds[joint]) })),
        canonicalTargets.filter(target => !usedTargets.has(target.id)),
        maxDistance
      );
      for (const { source, target } of spatial) replacement.set(source, target);
    }

    const matchedBoneNames = [...replacement.values()].flatMap(node => {
      const boneName = boneNameByNode.get(node);
      return boneName ? [boneName] : [];
    });
    const unmatchedNames = detachedJoints.filter(joint => !replacement.has(joint)).map(joint => nodes[joint]?.name);
    // Full duplicate humanoid chains need ≥3 matches; hair/cloth accessories may
    // only share a single core torso/head anchor plus secondary bones.
    if (!canReconnectDetachedMatches(matchedBoneNames, unmatchedNames)) {
      // Only warn for fully detached skins (no humanoid joints already). A main
      // body skin that also carries secondary bones is expected to keep them.
      if (fullyDetached) {
        unrepairedDetachedSkins++;
        rememberUnrepairedNames(detachedJoints);
      }
      return;
    }
    const repairedJoints = info.joints.map(joint => replacement.get(joint) ?? joint);
    if (new Set(repairedJoints).size !== repairedJoints.length) {
      if (fullyDetached) {
        unrepairedDetachedSkins++;
        rememberUnrepairedNames(detachedJoints);
      }
      return;
    }

    const jointSet = new Set(info.joints);
    for (const [detached, canonical] of replacement) {
      const detachedChildren: number[] = nodes[detached].children ?? [];
      for (const child of [...detachedChildren]) {
        if (replacement.has(child) || !jointSet.has(child)) continue;
        nodes[detached].children = (nodes[detached].children ?? []).filter((value: number) => value !== child);
        nodes[canonical].children ??= [];
        if (!nodes[canonical].children.includes(child)) nodes[canonical].children.push(child);
        const local = multiply(invert(worlds[canonical]), worlds[child]);
        delete nodes[child].translation; delete nodes[child].rotation; delete nodes[child].scale;
        nodes[child].matrix = local;
      }
    }

    info.joints = repairedJoints;
    skins[skinIndex].joints = repairedJoints;
    if (replacement.has(skins[skinIndex].skeleton)) skins[skinIndex].skeleton = replacement.get(skins[skinIndex].skeleton);
    reconnectedSkins++;
    remappedJoints += replacement.size;
  });
  return { reconnectedSkins, remappedJoints, unrepairedDetachedSkins, unrepairedJointNames };
}

function transformPoint(m: Matrix, v: number[]) {
  return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];
}

function transformDirection(m: Matrix, v: number[]) {
  return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]];
}

function normalize(v: number[]) {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(length)) fail('NON_FINITE_DATA', 'A transformed normal or tangent contains a non-finite value.');
  if (length < 1e-12) return [0, 0, 0];
  return [v[0] / length, v[1] / length, v[2] / length];
}

function getAccessor(parsed: ParsedGlb, index: number, expectedType?: string, allowedComponents?: number[]): AccessorView {
  const accessor = parsed.json.accessors?.[index];
  if (!accessor) fail('MISSING_ACCESSOR', `Accessor ${index} is missing.`);
  if (accessor.sparse) fail('SPARSE_ACCESSOR', 'Sparse accessors are not supported by the beta baker.');
  if (expectedType && accessor.type !== expectedType) fail('UNSUPPORTED_ACCESSOR', `Accessor ${index} must be ${expectedType}.`);
  if (allowedComponents && !allowedComponents.includes(accessor.componentType)) fail('UNSUPPORTED_ACCESSOR', `Accessor ${index} uses an unsupported component type.`);
  const view = parsed.json.bufferViews?.[accessor.bufferView];
  if (!view || (view.buffer ?? 0) !== 0) fail('UNSUPPORTED_ACCESSOR', `Accessor ${index} is not stored in the embedded binary buffer.`);
  if (view.extensions?.EXT_meshopt_compression) fail('COMPRESSED_GEOMETRY', 'Meshopt-compressed geometry is not supported by the beta baker.');
  const componentBytes = COMPONENT_BYTES[accessor.componentType], components = TYPE_SIZE[accessor.type];
  if (!componentBytes || !components || !Number.isInteger(accessor.count) || accessor.count < 0) fail('MALFORMED_GLB', `Accessor ${index} has invalid metadata.`);
  const packed = componentBytes * components, stride = view.byteStride ?? packed;
  if (stride < packed || stride % componentBytes) fail('UNSUPPORTED_ACCESSOR', `Accessor ${index} has an invalid byte stride.`);
  const relative = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const last = accessor.count ? relative + (accessor.count - 1) * stride + packed : relative;
  if (relative < 0 || last > parsed.bin.length || last > (view.byteOffset ?? 0) + view.byteLength) fail('MALFORMED_GLB', `Accessor ${index} exceeds its buffer bounds.`);
  return { accessor, view, data: new DataView(parsed.source, parsed.bin.offset, parsed.bin.length), start: relative, stride, components, componentBytes };
}

function readComponent(view: AccessorView, element: number, component: number) {
  const offset = view.start + element * view.stride + component * view.componentBytes;
  const type = view.accessor.componentType;
  let value: number;
  if (type === 5120) value = view.data.getInt8(offset);
  else if (type === 5121) value = view.data.getUint8(offset);
  else if (type === 5122) value = view.data.getInt16(offset, true);
  else if (type === 5123) value = view.data.getUint16(offset, true);
  else if (type === 5125) value = view.data.getUint32(offset, true);
  else value = view.data.getFloat32(offset, true);
  if (view.accessor.normalized && type !== FLOAT) {
    if (type === 5120) value = Math.max(value / 127, -1);
    else if (type === 5121) value /= 255;
    else if (type === 5122) value = Math.max(value / 32767, -1);
    else if (type === 5123) value /= 65535;
    else if (type === 5125) value /= 4294967295;
  }
  return finite(value, 'Accessor data');
}

function readVector(view: AccessorView, element: number) { return Array.from({ length: view.components }, (_, i) => readComponent(view, element, i)); }
function writeFloatVector(view: AccessorView, element: number, values: number[]) {
  if (view.accessor.componentType !== FLOAT) fail('UNSUPPORTED_ACCESSOR', 'Bake output attributes must use float components.');
  values.forEach((value, component) => view.data.setFloat32(view.start + element * view.stride + component * 4, finite(value, 'Bake output'), true));
}

function extensionFingerprint(value: any): any {
  if (Array.isArray(value)) return value.map(extensionFingerprint);
  if (!value || typeof value !== 'object') return undefined;
  const result: Json = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'extensions' || key === 'extensionsUsed' || key === 'extensionsRequired') result[key] = child;
    else {
      const nested = extensionFingerprint(child);
      if (nested !== undefined && (Array.isArray(nested) ? nested.some(v => v !== undefined) : Object.keys(nested).length)) result[key] = nested;
    }
  }
  return result;
}

function mergeCompatibleMeshes(parsed: ParsedGlb, targets: { node: Json; nodeIndex: number }[]) {
  const json = parsed.json;
  const vrm1 = json.extensions?.VRMC_vrm, vrm0 = json.extensions?.VRM;
  const boundNodes = new Set<number>(), boundMeshes = new Set<number>();
  const collectVrm1Binds = (expressions: Json | undefined) => expressions && Object.values(expressions).forEach((expression: any) => (expression?.morphTargetBinds ?? []).forEach((bind: Json) => Number.isInteger(bind.node) && boundNodes.add(bind.node)));
  collectVrm1Binds(vrm1?.expressions?.preset); collectVrm1Binds(vrm1?.expressions?.custom);
  for (const group of vrm0?.blendShapeMaster?.blendShapeGroups ?? []) for (const bind of group.binds ?? []) if (Number.isInteger(bind.mesh)) boundMeshes.add(bind.mesh);
  const weightAnimated = new Set<number>();
  for (const animation of json.animations ?? []) for (const channel of animation.channels ?? []) if (channel.target?.path === 'weights' && Number.isInteger(channel.target.node)) weightAnimated.add(channel.target.node);
  const vrm1Annotations: Json[] = vrm1?.firstPerson?.meshAnnotations ?? [];
  const vrm0Annotations: Json[] = vrm0?.firstPerson?.meshAnnotations ?? [];
  const annotationKey = (nodeIndex: number, meshIndex: number) => {
    const one = vrm1Annotations.filter(annotation => annotation.node === nodeIndex).map(annotation => annotation.type).sort();
    const zero = vrm0Annotations.filter(annotation => annotation.mesh === meshIndex).map(annotation => annotation.firstPersonFlag).sort();
    return JSON.stringify([one, zero]);
  };
  const groups = new Map<string, { node: Json; nodeIndex: number }[]>();
  for (const target of targets) {
    const mesh = json.meshes[target.node.mesh];
    const skin = json.skins[target.node.skin];
    const hasMorphs = (mesh.primitives ?? []).some((primitive: Json) => primitive.targets?.length) || mesh.weights?.length || mesh.extras?.targetNames?.length;
    const customData = target.node.extensions || mesh.extensions || skin.extensions || skin.extras;
    if (hasMorphs || customData || boundNodes.has(target.nodeIndex) || boundMeshes.has(target.node.mesh) || weightAnimated.has(target.nodeIndex)) continue;
    // Exporters commonly duplicate an otherwise identical glTF skin for every
    // renderer. After baking, skins with the same ordered joint table and
    // skeleton use the same clean bind poses, so their JOINTS_n values are
    // directly compatible even when the skin indices differ.
    const skinKey = JSON.stringify([skin.joints, skin.skeleton ?? -1]);
    const key = `${skinKey}:${annotationKey(target.nodeIndex, target.node.mesh)}`;
    const group = groups.get(key) ?? []; group.push(target); groups.set(key, group);
  }
  let mergedMeshes = 0;
  const survivorMeshIndexes = new Set<number>();
  for (const group of groups.values()) {
    const survivor = group[0], survivorMeshIndex = survivor.node.mesh, survivorMesh = json.meshes[survivorMeshIndex];
    survivorMeshIndexes.add(survivorMeshIndex);
    if (group.length < 2) continue;
    survivorMesh.name = survivorMesh.name ? `${survivorMesh.name} (merged)` : 'Baked merged meshes';
    for (const source of group.slice(1)) {
      survivorMesh.primitives.push(...json.meshes[source.node.mesh].primitives);
      for (const annotation of vrm1Annotations) if (annotation.node === source.nodeIndex) annotation.node = survivor.nodeIndex;
      for (const annotation of vrm0Annotations) if (annotation.mesh === source.node.mesh) annotation.mesh = survivorMeshIndex;
      delete source.node.mesh; delete source.node.skin;
      mergedMeshes++;
    }
  }
  const dedupe = (items: Json[]) => {
    const seen = new Set<string>();
    return items.filter(item => { const key = JSON.stringify(item); if (seen.has(key)) return false; seen.add(key); return true; });
  };
  if (vrm1?.firstPerson?.meshAnnotations) vrm1.firstPerson.meshAnnotations = dedupe(vrm1Annotations);
  if (vrm0?.firstPerson?.meshAnnotations) vrm0.firstPerson.meshAnnotations = dedupe(vrm0Annotations);

  const logicalLength = json.buffers?.[0]?.byteLength;
  if (!Number.isInteger(logicalLength) || logicalLength < 0 || logicalLength > parsed.bin.length) fail('MALFORMED_GLB', 'The embedded buffer length is invalid before mesh merging.');
  json.bufferViews ??= []; json.accessors ??= [];
  const additions: { offset: number; bytes: Uint8Array }[] = [];
  let nextOffset = align4(logicalLength), mergedPrimitives = 0;
  const appendAccessor = (bytes: Uint8Array, metadata: Json) => {
    const offset = nextOffset; nextOffset = align4(nextOffset + bytes.byteLength);
    if (nextOffset > BAKE_LIMITS.maxInputBytes) fail('MERGE_TOO_LARGE', 'Merging this VRM would exceed the 128 MiB safety limit.');
    const bufferView = json.bufferViews.length; json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength });
    const accessor = json.accessors.length; json.accessors.push({ ...metadata, bufferView, byteOffset: 0 });
    additions.push({ offset, bytes });
    return accessor;
  };
  const schemaFor = (primitive: Json) => {
    if (primitive.targets?.length || primitive.extensions || primitive.extras) return null;
    const semantics = Object.keys(primitive.attributes ?? {}).sort();
    if (!semantics.includes('POSITION')) return null;
    const schema = semantics.map(semantic => {
      const accessor = json.accessors[primitive.attributes[semantic]];
      return accessor && !accessor.sparse ? [semantic, accessor.componentType, accessor.type, !!accessor.normalized] : null;
    });
    return schema.every(Boolean) ? JSON.stringify([primitive.material ?? -1, primitive.mode ?? 4, schema]) : null;
  };
  for (const meshIndex of survivorMeshIndexes) {
    const mesh = json.meshes[meshIndex], primitiveGroups = new Map<string, Json[]>(), untouched: Json[] = [];
    for (const primitive of mesh.primitives) {
      const key = schemaFor(primitive);
      if (!key) { untouched.push(primitive); continue; }
      const group = primitiveGroups.get(key) ?? []; group.push(primitive); primitiveGroups.set(key, group);
    }
    const combined: Json[] = [];
    for (const group of primitiveGroups.values()) {
      if (group.length < 2) { combined.push(...group); continue; }
      const semantics = Object.keys(group[0].attributes).sort();
      const positionViews = group.map(primitive => getAccessor(parsed, primitive.attributes.POSITION, 'VEC3', [FLOAT]));
      const counts = positionViews.map(view => view.accessor.count), totalVertices = counts.reduce((sum, count) => sum + count, 0);
      const attributes: Json = {};
      for (const semantic of semantics) {
        const views = group.map((primitive, index) => {
          const view = getAccessor(parsed, primitive.attributes[semantic]);
          if (view.accessor.count !== counts[index]) fail('UNSUPPORTED_ACCESSOR', 'A primitive attribute count does not match POSITION during merging.');
          return view;
        });
        const first = views[0], packed = first.componentBytes * first.components, bytes = new Uint8Array(totalVertices * packed);
        let destination = 0;
        for (const view of views) for (let element = 0; element < view.accessor.count; element++) {
          bytes.set(new Uint8Array(view.data.buffer, view.data.byteOffset + view.start + element * view.stride, packed), destination);
          destination += packed;
        }
        const metadata: Json = { componentType: first.accessor.componentType, count: totalVertices, type: first.accessor.type };
        if (first.accessor.normalized) metadata.normalized = true;
        if (semantic === 'POSITION') {
          metadata.min = [Infinity, Infinity, Infinity]; metadata.max = [-Infinity, -Infinity, -Infinity];
          views.forEach(view => { for (let element = 0; element < view.accessor.count; element++) for (let component = 0; component < 3; component++) {
            const value = readComponent(view, element, component); metadata.min[component] = Math.min(metadata.min[component], value); metadata.max[component] = Math.max(metadata.max[component], value);
          } });
        }
        attributes[semantic] = appendAccessor(bytes, metadata);
      }
      const totalIndices = group.reduce((sum, primitive, index) => sum + (Number.isInteger(primitive.indices) ? getAccessor(parsed, primitive.indices, 'SCALAR', [5121, 5123, 5125]).accessor.count : counts[index]), 0);
      const indexType = totalVertices > 65535 ? 5125 : 5123, indexBytes = indexType === 5125 ? 4 : 2;
      const indexData = new Uint8Array(totalIndices * indexBytes), indexView = new DataView(indexData.buffer);
      let indexOutput = 0, vertexOffset = 0;
      group.forEach((primitive, primitiveIndex) => {
        const source = Number.isInteger(primitive.indices) ? getAccessor(parsed, primitive.indices, 'SCALAR', [5121, 5123, 5125]) : null;
        const count = source?.accessor.count ?? counts[primitiveIndex];
        for (let i = 0; i < count; i++) {
          const value = (source ? readComponent(source, i, 0) : i) + vertexOffset;
          if (indexType === 5125) indexView.setUint32(indexOutput * indexBytes, value, true); else indexView.setUint16(indexOutput * indexBytes, value, true);
          indexOutput++;
        }
        vertexOffset += counts[primitiveIndex];
      });
      const indices = appendAccessor(indexData, { componentType: indexType, count: totalIndices, type: 'SCALAR', min: [0], max: [Math.max(0, totalVertices - 1)] });
      const primitive: Json = { attributes, indices };
      if (group[0].material !== undefined) primitive.material = group[0].material;
      if (group[0].mode !== undefined) primitive.mode = group[0].mode;
      combined.push(primitive); mergedPrimitives += group.length - 1;
    }
    mesh.primitives = [...untouched, ...combined];
  }
  if (!additions.length) return { parsed, mergedMeshes, mergedPrimitives };
  const binary = new Uint8Array(nextOffset);
  binary.set(new Uint8Array(parsed.source, parsed.bin.offset, logicalLength));
  additions.forEach(addition => binary.set(addition.bytes, addition.offset));
  json.buffers[0].byteLength = binary.byteLength;
  return { parsed: parseGlb(rebuildGlb(parsed, binary)), mergedMeshes, mergedPrimitives };
}

function rebuildGlb(parsed: ParsedGlb, replacementBin?: Uint8Array): ArrayBuffer {
  const encoded = new TextEncoder().encode(JSON.stringify(parsed.json));
  const jsonLength = align4(encoded.length);
  const chunks = parsed.chunks.map((chunk, index) => index === 0 ? { ...chunk, length: jsonLength } : chunk.type === BIN_CHUNK && replacementBin ? { ...chunk, length: align4(replacementBin.byteLength) } : chunk);
  const total = 12 + chunks.reduce((sum, chunk) => sum + 8 + chunk.length, 0);
  const output = new ArrayBuffer(total), data = new DataView(output), bytes = new Uint8Array(output);
  data.setUint32(0, GLB_MAGIC, true); data.setUint32(4, 2, true); data.setUint32(8, total, true);
  let offset = 12;
  chunks.forEach((chunk, index) => {
    data.setUint32(offset, chunk.length, true); data.setUint32(offset + 4, chunk.type, true);
    if (index === 0) { bytes.fill(0x20, offset + 8, offset + 8 + chunk.length); bytes.set(encoded, offset + 8); }
    else if (chunk.type === BIN_CHUNK && replacementBin) bytes.set(replacementBin, offset + 8);
    else bytes.set(new Uint8Array(parsed.source, parsed.chunks[index].offset, parsed.chunks[index].length), offset + 8);
    offset += 8 + chunk.length;
  });
  return output;
}

export function bakeVrm(source: ArrayBuffer, fileName: string, progress: Progress = () => {}, options: BakeOptions = {}): BakeResult {
  if (!/\.vrm$/i.test(fileName)) fail('NOT_VRM_FILE', 'Bake Meshes requires a local .vrm file.');
  if (source.byteLength > BAKE_LIMITS.maxInputBytes) fail('FILE_TOO_LARGE', 'This VRM exceeds the 128 MiB beta baking limit.');
  progress('preflight', 0.02, 'Reading the VRM container');
  let parsed = parseGlb(source);
  parsed = materializeSparseAccessors(parsed, progress);
  let json = parsed.json;
  const originalFingerprint = JSON.stringify(extensionFingerprint(json));
  if (json.extensionsUsed?.includes('EXT_meshopt_compression') || json.extensionsRequired?.includes('EXT_meshopt_compression')) fail('COMPRESSED_GEOMETRY', 'Meshopt-compressed VRMs are not supported by the beta baker.');
  const nodes: Json[] = json.nodes ?? [], meshes: Json[] = json.meshes ?? [], skins: Json[] = json.skins ?? [];
  if (!nodes.length || !meshes.length || !skins.length) fail('NO_SKINNED_MESHES', 'This VRM does not contain bakeable skinned meshes.');

  let { parents, worlds } = buildHierarchy(nodes);

  const skinInfos: SkinInfo[] = skins.map((skin, skinIndex) => {
    if (!Array.isArray(skin.joints) || !skin.joints.length || skin.joints.length > BAKE_LIMITS.maxJointsPerSkin) fail('UNSUPPORTED_SKIN', `Skin ${skinIndex} must contain 1–256 joints.`);
    if (!Number.isInteger(skin.inverseBindMatrices)) fail('MISSING_BIND_POSES', `Skin ${skinIndex} has no inverse bind matrices.`);
    const accessor = getAccessor(parsed, skin.inverseBindMatrices, 'MAT4', [FLOAT]);
    if (accessor.accessor.count < skin.joints.length) fail('MISSING_BIND_POSES', `Skin ${skinIndex} has too few inverse bind matrices.`);
    const inverseBinds = skin.joints.map((joint: number, jointIndex: number) => {
      if (!nodes[joint]) fail('UNSUPPORTED_SKIN', `Skin ${skinIndex} references a missing joint.`);
      return readVector(accessor, jointIndex);
    });
    return { joints: [...skin.joints], inverseBindAccessor: skin.inverseBindMatrices, inverseBinds };
  });

  const targets = nodes.map((node, nodeIndex) => ({ node, nodeIndex })).filter(({ node }) => Number.isInteger(node.mesh) && Number.isInteger(node.skin));
  if (!targets.length) fail('NO_SKINNED_MESHES', 'This VRM does not contain a mesh attached to a skin.');
  const usedMeshes = new Set<number>(), writableAccessors = new Set<number>();
  let vertexCount = 0, morphCount = 0;
  for (const { node, nodeIndex } of targets) {
    if (!meshes[node.mesh] || !skinInfos[node.skin]) fail('MALFORMED_GLB', `Skinned node ${nodeIndex} references missing mesh or skin data.`);
    if (usedMeshes.has(node.mesh)) fail('SHARED_MESH', 'A skinned mesh is instanced by multiple nodes and cannot be baked in place safely.');
    if (node.children?.length) fail('UNSUPPORTED_HIERARCHY', 'A skinned mesh node has children that would move during normalization.');
    usedMeshes.add(node.mesh);
    for (const primitive of meshes[node.mesh].primitives ?? []) {
      if (primitive.extensions?.KHR_draco_mesh_compression) fail('COMPRESSED_GEOMETRY', 'Draco-compressed geometry is not supported by the beta baker.');
      const positionIndex = primitive.attributes?.POSITION;
      if (!Number.isInteger(positionIndex)) fail('MISSING_SKIN_DATA', 'A skinned primitive has no POSITION attribute.');
      for (const accessorIndex of [positionIndex, primitive.attributes?.NORMAL, primitive.attributes?.TANGENT, ...(primitive.targets ?? []).flatMap((target: Json) => [target.POSITION, target.NORMAL, target.TANGENT])]) {
        if (!Number.isInteger(accessorIndex)) continue;
        if (writableAccessors.has(accessorIndex)) fail('SHARED_ACCESSOR', 'Multiple skinned attributes share writable geometry data.');
        writableAccessors.add(accessorIndex);
      }
      const position = getAccessor(parsed, positionIndex, 'VEC3', [FLOAT]);
      vertexCount += position.accessor.count;
      for (const target of primitive.targets ?? []) if (Number.isInteger(target.POSITION) || Number.isInteger(target.NORMAL) || Number.isInteger(target.TANGENT)) morphCount += position.accessor.count;
    }
  }
  const stats: BakeStats = { meshes: targets.length, vertices: vertexCount, morphVertexRecords: morphCount, skins: new Set(targets.map(({ node }) => node.skin)).size };
  if (vertexCount > BAKE_LIMITS.maxSkinnedVertices) fail('TOO_MANY_VERTICES', 'This VRM exceeds the 2 million skinned-vertex beta limit.');
  if (morphCount > BAKE_LIMITS.maxMorphVertexRecords) fail('TOO_MANY_MORPHS', 'This VRM exceeds the 8 million morph-record beta limit.');
  progress('preflight', 0.12, `Found ${targets.length} skinned mesh${targets.length === 1 ? '' : 'es'}`, stats);

  const repair = repairDetachedSkeletons(json, nodes, skins, skinInfos, worlds);
  if (repair.reconnectedSkins) {
    stats.reconnectedSkins = repair.reconnectedSkins;
    stats.remappedJoints = repair.remappedJoints;
    progress('bind-poses', 0.14, `Reconnected ${repair.reconnectedSkins} detached skin${repair.reconnectedSkins === 1 ? '' : 's'} to the humanoid rig`, stats);
    ({ parents, worlds } = buildHierarchy(nodes));
  }
  if (repair.unrepairedDetachedSkins) {
    stats.unrepairedDetachedSkins = repair.unrepairedDetachedSkins;
    if (repair.unrepairedJointNames.length) stats.unrepairedJointNames = repair.unrepairedJointNames;
    progress('bind-poses', 0.15, `${repair.unrepairedDetachedSkins} detached skin${repair.unrepairedDetachedSkins === 1 ? '' : 's'} could not be reconnected`, stats);
  }

  let completed = 0;
  for (const { node } of targets) {
    const skin = skinInfos[node.skin], mesh = meshes[node.mesh];
    const matrices = skin.joints.map((_, i) => multiply(worlds[skin.joints[i]], skin.inverseBinds[i]));
    for (const primitive of mesh.primitives ?? []) {
      const position = getAccessor(parsed, primitive.attributes.POSITION, 'VEC3', [FLOAT]);
      const normal = Number.isInteger(primitive.attributes.NORMAL) ? getAccessor(parsed, primitive.attributes.NORMAL, 'VEC3', [FLOAT]) : null;
      const tangent = Number.isInteger(primitive.attributes.TANGENT) ? getAccessor(parsed, primitive.attributes.TANGENT, 'VEC4', [FLOAT]) : null;
      const morphTargets = (primitive.targets ?? []).map((target: Json) => ({
        position: Number.isInteger(target.POSITION) ? getAccessor(parsed, target.POSITION, 'VEC3', [FLOAT]) : null,
        normal: Number.isInteger(target.NORMAL) ? getAccessor(parsed, target.NORMAL, 'VEC3', [FLOAT]) : null,
        tangent: Number.isInteger(target.TANGENT) ? getAccessor(parsed, target.TANGENT, 'VEC3', [FLOAT]) : null
      }));
      for (const target of morphTargets) for (const accessor of [target.position, target.normal, target.tangent]) {
        if (accessor && accessor.accessor.count !== position.accessor.count) fail('UNSUPPORTED_ACCESSOR', 'A morph target has a mismatched vertex count.');
      }
      const jointSets: AccessorView[] = [], weightSets: AccessorView[] = [];
      for (let set = 0; set < 2; set++) {
        const ji = primitive.attributes[`JOINTS_${set}`], wi = primitive.attributes[`WEIGHTS_${set}`];
        if (Number.isInteger(ji) !== Number.isInteger(wi)) fail('MISSING_SKIN_DATA', 'JOINTS and WEIGHTS attributes must be paired.');
        if (Number.isInteger(ji)) {
          const joints = getAccessor(parsed, ji, 'VEC4', [5121, 5123]);
          const weights = getAccessor(parsed, wi, 'VEC4', [FLOAT, 5121, 5123]);
          if (joints.accessor.count !== position.accessor.count || weights.accessor.count !== position.accessor.count) fail('MISSING_SKIN_DATA', 'Skin attributes have mismatched vertex counts.');
          if (weights.accessor.componentType !== FLOAT && !weights.accessor.normalized) fail('UNSUPPORTED_ACCESSOR', 'Integer skin weights must be normalized.');
          jointSets.push(joints); weightSets.push(weights);
        }
      }
      if (!Number.isInteger(primitive.attributes.JOINTS_0) || !Number.isInteger(primitive.attributes.WEIGHTS_0)) fail('MISSING_SKIN_DATA', 'A skinned primitive has no JOINTS_0 and WEIGHTS_0 attributes.');

      const influences = (vertex: number) => {
        const result: { matrix: Matrix; weight: number }[] = [];
        jointSets.forEach((joints, set) => {
          const js = readVector(joints, vertex), ws = readVector(weightSets[set], vertex);
          js.forEach((joint, i) => {
            if (!Number.isInteger(joint) || !matrices[joint]) fail('INVALID_JOINT', 'A vertex references a joint outside its skin.');
            if (ws[i] > 0) result.push({ matrix: matrices[joint], weight: ws[i] });
          });
        });
        const sum = result.reduce((total, item) => total + item.weight, 0);
        if (!Number.isFinite(sum) || sum < 1e-8) fail('ZERO_SKIN_WEIGHT', 'A skinned vertex has zero total bone weight.');
        return { result, sum };
      };
      const weighted = (value: number[], items: { matrix: Matrix; weight: number }[], point: boolean) => {
        const out = [0, 0, 0];
        items.forEach(({ matrix, weight }) => {
          const transformed = point ? transformPoint(matrix, value) : transformDirection(matrix, value);
          for (let i = 0; i < 3; i++) out[i] += transformed[i] * weight;
        });
        return out;
      };
      const positionMin = [Infinity, Infinity, Infinity], positionMax = [-Infinity, -Infinity, -Infinity];
      for (let vertex = 0; vertex < position.accessor.count; vertex++) {
        const { result, sum } = influences(vertex);
        const originalNormal = normal ? readVector(normal, vertex) : null;
        const originalTangent = tangent ? readVector(tangent, vertex) : null;
        const bakedPosition = weighted(readVector(position, vertex), result, true).map(v => v / sum);
        writeFloatVector(position, vertex, bakedPosition);
        bakedPosition.forEach((value, component) => { positionMin[component] = Math.min(positionMin[component], value); positionMax[component] = Math.max(positionMax[component], value); });
        if (normal && originalNormal) writeFloatVector(normal, vertex, normalize(weighted(originalNormal, result, false)));
        if (tangent && originalTangent) {
          const baked = normalize(weighted(originalTangent, result, false));
          writeFloatVector(tangent, vertex, [...baked, originalTangent[3]]);
        }
        for (const target of morphTargets) {
          if (target.position) {
            writeFloatVector(target.position, vertex, weighted(readVector(target.position, vertex), result, false).map(v => v / sum));
          }
          for (const semantic of ['NORMAL', 'TANGENT'] as const) {
            const accessor = semantic === 'NORMAL' ? target.normal : target.tangent;
            if (!accessor) continue;
            const base = semantic === 'NORMAL' ? normal : tangent;
            if (!base) fail('MISSING_SKIN_DATA', `A morph ${semantic} exists without a base ${semantic}.`);
            const originalBase = (semantic === 'NORMAL' ? originalNormal : originalTangent)?.slice(0, 3)
              ?? fail('MISSING_SKIN_DATA', `A morph ${semantic} exists without readable base data.`);
            const delta = readVector(accessor, vertex);
            const bakedBase = normalize(weighted(originalBase, result, false));
            const bakedEnd = normalize(weighted(originalBase.map((v, i) => v + delta[i]), result, false));
            writeFloatVector(accessor, vertex, bakedEnd.map((v, i) => v - bakedBase[i]));
          }
        }
      }
      if (position.accessor.count) { position.accessor.min = positionMin; position.accessor.max = positionMax; }
      completed += position.accessor.count;
      progress('geometry', 0.16 + 0.68 * completed / vertexCount, `Baked ${completed.toLocaleString()} of ${vertexCount.toLocaleString()} vertices`, stats);
    }
  }

  progress('bind-poses', 0.84, 'Writing clean inverse bind matrices', stats);
  const writtenBinds = new Map<number, string>();
  skinInfos.forEach(info => {
    const cleanBinds = info.joints.map(joint => invert(worlds[joint]));
    const signature = JSON.stringify(cleanBinds);
    const previous = writtenBinds.get(info.inverseBindAccessor);
    if (previous && previous !== signature) fail('SHARED_BIND_POSES', 'Multiple skins share incompatible inverse bind matrix storage.');
    if (previous) return;
    const accessor = getAccessor(parsed, info.inverseBindAccessor, 'MAT4', [FLOAT]);
    cleanBinds.forEach((matrix, index) => writeFloatVector(accessor, index, matrix));
    writtenBinds.set(info.inverseBindAccessor, signature);
  });

  const sceneIndex = json.scene ?? 0, scene = json.scenes?.[sceneIndex];
  if (!scene) fail('UNSUPPORTED_HIERARCHY', 'The VRM has no default scene to receive normalized meshes.');
  scene.nodes ??= [];
  for (const { node, nodeIndex } of targets) {
    const parent = parents[nodeIndex];
    if (parent >= 0) nodes[parent].children = nodes[parent].children.filter((child: number) => child !== nodeIndex);
    for (const candidate of json.scenes ?? []) if (candidate !== scene && candidate.nodes?.includes(nodeIndex)) fail('UNSUPPORTED_HIERARCHY', 'A skinned mesh belongs to multiple scenes.');
    if (!scene.nodes.includes(nodeIndex)) scene.nodes.push(nodeIndex);
    delete node.translation; delete node.rotation; delete node.scale; delete node.matrix;
  }
  if (options.mergeCompatibleMeshes) {
    const merge = mergeCompatibleMeshes(parsed, targets);
    parsed = merge.parsed; json = parsed.json; stats.mergedMeshes = merge.mergedMeshes; stats.mergedPrimitives = merge.mergedPrimitives;
  }
  const expectedFingerprint = JSON.stringify(extensionFingerprint(json));
  if (!options.mergeCompatibleMeshes && expectedFingerprint !== originalFingerprint) fail('EXTENSION_CHANGED', 'VRM extension data changed unexpectedly; no output was produced.');

  progress('validation', 0.92, 'Validating the rebuilt VRM', stats);
  const output = rebuildGlb(parsed), validation = parseGlb(output);
  if (JSON.stringify(extensionFingerprint(validation.json)) !== expectedFingerprint) fail('EXTENSION_CHANGED', 'The rebuilt file did not preserve all VRM extension data.');
  progress('download', 1, 'Baked VRM is ready', stats);
  return { buffer: output, fileName: bakedFileName(fileName), stats };
}
