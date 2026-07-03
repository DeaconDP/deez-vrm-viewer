import { describe, expect, it } from 'vitest';
import { BakeError, bakeVrm, bakedFileName, invert, multiply, parseGlb } from './meshBaker';

const JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;

function makeGlb(json: Record<string, any>, binary: ArrayBuffer) {
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(encoded.length / 4) * 4, binLength = Math.ceil(binary.byteLength / 4) * 4;
  const output = new ArrayBuffer(12 + 8 + jsonLength + 8 + binLength), view = new DataView(output), bytes = new Uint8Array(output);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, output.byteLength, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, JSON_CHUNK, true); bytes.fill(0x20, 20, 20 + jsonLength); bytes.set(encoded, 20);
  const binHeader = 20 + jsonLength; view.setUint32(binHeader, binLength, true); view.setUint32(binHeader + 4, BIN_CHUNK, true);
  bytes.set(new Uint8Array(binary), binHeader + 8);
  return output;
}

function fixture(options: { compressed?: boolean; sparse?: boolean; malformedSparse?: boolean; zeroWeight?: boolean; zeroVectors?: boolean; normalizedWeights?: boolean } = {}) {
  // position, normal, tangent, joints, weights, morph position, inverse bind matrix
  const binary = new ArrayBuffer(152), data = new DataView(binary);
  [1, 0, 0].forEach((v, i) => data.setFloat32(i * 4, v, true));
  (options.zeroVectors ? [0, 0, 0] : [0, 1, 0]).forEach((v, i) => data.setFloat32(12 + i * 4, v, true));
  (options.zeroVectors ? [0, 0, 0, 1] : [1, 0, 0, 1]).forEach((v, i) => data.setFloat32(24 + i * 4, v, true));
  data.setUint8(40, 0);
  if (options.normalizedWeights) data.setUint8(44, options.zeroWeight ? 0 : 255);
  else [options.zeroWeight ? 0 : 1, 0, 0, 0].forEach((v, i) => data.setFloat32(44 + i * 4, v, true));
  [0, 0.5, 0].forEach((v, i) => data.setFloat32(60 + i * 4, v, true));
  const ibm = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -2, 0, 0, 1];
  ibm.forEach((v, i) => data.setFloat32(72 + i * 4, v, true));
  data.setUint8(136, 0);
  [2, 0, 0].forEach((v, i) => data.setFloat32(140 + i * 4, v, true));
  const views = [
    { buffer: 0, byteOffset: 0, byteLength: 12 }, { buffer: 0, byteOffset: 12, byteLength: 12 },
    { buffer: 0, byteOffset: 24, byteLength: 16 }, { buffer: 0, byteOffset: 40, byteLength: 4 },
    { buffer: 0, byteOffset: 44, byteLength: 16 }, { buffer: 0, byteOffset: 60, byteLength: 12 },
    { buffer: 0, byteOffset: 72, byteLength: 64 }, { buffer: 0, byteOffset: 136, byteLength: 1 },
    { buffer: 0, byteOffset: 140, byteLength: 12 }
  ];
  const accessors = [
    { bufferView: 0, componentType: 5126, count: 1, type: 'VEC3', ...((options.sparse || options.malformedSparse) ? { sparse: { count: options.malformedSparse ? 2 : 1, indices: { bufferView: 7, componentType: 5121 }, values: { bufferView: 8 } } } : {}) },
    { bufferView: 1, componentType: 5126, count: 1, type: 'VEC3' },
    { bufferView: 2, componentType: 5126, count: 1, type: 'VEC4' },
    { bufferView: 3, componentType: 5121, count: 1, type: 'VEC4' },
    { bufferView: 4, componentType: options.normalizedWeights ? 5121 : 5126, normalized: !!options.normalizedWeights, count: 1, type: 'VEC4' },
    { bufferView: 5, componentType: 5126, count: 1, type: 'VEC3' },
    { bufferView: 6, componentType: 5126, count: 1, type: 'MAT4' }
  ];
  return makeGlb({
    asset: { version: '2.0' }, buffers: [{ byteLength: binary.byteLength }], bufferViews: views, accessors,
    extensionsUsed: ['VRMC_vrm'], extensions: { VRMC_vrm: { specVersion: '1.0', meta: 0, humanoid: 0 } },
    nodes: [
      { name: 'Root', children: [1, 2], translation: [1, 0, 0] },
      { name: 'Joint', translation: [2, 0, 0] },
      { name: 'Mesh', mesh: 0, skin: 0, scale: [2, 2, 2] }
    ],
    meshes: [{ primitives: [{
      attributes: { POSITION: 0, NORMAL: 1, TANGENT: 2, JOINTS_0: 3, WEIGHTS_0: 4 }, targets: [{ POSITION: 5 }],
      ...(options.compressed ? { extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: {} } } } : {})
    }] }],
    skins: [{ joints: [1], inverseBindMatrices: 6 }], scenes: [{ nodes: [0] }], scene: 0
  }, binary);
}

function twoMeshFixture(expressionBound = false) {
  const first = parseGlb(fixture()), json = first.json;
  const binary = new Uint8Array(212);
  binary.set(new Uint8Array(first.source, first.bin.offset, 152));
  binary.set(new Uint8Array(first.source, first.bin.offset, 60), 152);
  const sourceViews = json.bufferViews.slice(0, 5);
  const newViews = sourceViews.map((view: Record<string, any>) => ({ ...view, byteOffset: view.byteOffset + 152 }));
  const viewStart = json.bufferViews.length; json.bufferViews.push(...newViews);
  const accessorStart = json.accessors.length;
  json.accessors.push(...json.accessors.slice(0, 5).map((accessor: Record<string, any>, index: number) => ({ ...accessor, bufferView: viewStart + index })));
  json.buffers[0].byteLength = binary.byteLength;
  json.meshes[0].primitives[0].targets = [];
  json.meshes.push({ primitives: [{ attributes: { POSITION: accessorStart, NORMAL: accessorStart + 1, TANGENT: accessorStart + 2, JOINTS_0: accessorStart + 3, WEIGHTS_0: accessorStart + 4 } }] });
  json.nodes[0].children.push(3); json.nodes.push({ name: 'Clothing', mesh: 1, skin: 0 });
  if (expressionBound) json.extensions.VRMC_vrm.expressions = { custom: { clothing: { morphTargetBinds: [{ node: 3, index: 0, weight: 1 }] } } };
  return makeGlb(json, binary.buffer);
}

function oneMeshWithTwoPrimitivesFixture() {
  const parsed = parseGlb(twoMeshFixture()), json = parsed.json;
  json.meshes[0].primitives.push(json.meshes[1].primitives[0]);
  delete json.nodes[3].mesh; delete json.nodes[3].skin;
  return makeGlb(json, parsed.source.slice(parsed.bin.offset, parsed.bin.offset + parsed.bin.length));
}

function equivalentSkinFixture() {
  const parsed = parseGlb(twoMeshFixture()), json = parsed.json;
  json.skins.push({ ...json.skins[0] });
  json.nodes[3].skin = 1;
  return makeGlb(json, parsed.source.slice(parsed.bin.offset, parsed.bin.offset + parsed.bin.length));
}

function detachedRigFixture() {
  const parsed = parseGlb(twoMeshFixture()), json = parsed.json;
  const original = new Uint8Array(parsed.source, parsed.bin.offset, json.buffers[0].byteLength);
  const binary = new Uint8Array(original.byteLength + 7 * 64);
  binary.set(original);
  const data = new DataView(binary.buffer);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let matrix = 0; matrix < 7; matrix++) identity.forEach((value, component) => data.setFloat32(original.byteLength + (matrix * 16 + component) * 4, value, true));
  const mainView = json.bufferViews.length;
  json.bufferViews.push({ buffer: 0, byteOffset: original.byteLength, byteLength: 3 * 64 });
  const detachedView = json.bufferViews.length;
  json.bufferViews.push({ buffer: 0, byteOffset: original.byteLength + 3 * 64, byteLength: 4 * 64 });
  const mainBinds = json.accessors.length;
  json.accessors.push({ bufferView: mainView, componentType: 5126, count: 3, type: 'MAT4' });
  const detachedBinds = json.accessors.length;
  json.accessors.push({ bufferView: detachedView, componentType: 5126, count: 4, type: 'MAT4' });
  json.buffers[0].byteLength = binary.byteLength;

  json.extensions.VRMC_vrm.humanoid = { humanBones: { hips: { node: 1 }, spine: { node: 4 }, chest: { node: 5 } } };
  json.nodes[0].children = [1, 2, 3, 6];
  json.nodes[1].name = 'Hips'; json.nodes[1].children = [4];
  json.nodes.push(
    { name: 'Spine', children: [5] },
    { name: 'Chest' },
    { name: 'Hips', children: [7] },
    { name: 'Spine', children: [8] },
    { name: 'Chest', children: [9] },
    { name: 'CoatTail' }
  );
  json.skins[0] = { joints: [1, 4, 5], skeleton: 1, inverseBindMatrices: mainBinds };
  json.skins.push({ joints: [6, 7, 8, 9], skeleton: 6, inverseBindMatrices: detachedBinds });
  json.nodes[3].skin = 1;
  return makeGlb(json, binary.buffer);
}

describe('mesh baker', () => {
  it('names output without overwriting the source', () => {
    expect(bakedFileName('Avatar.VRM')).toBe('Avatar-baked.vrm');
  });

  it('inverts and multiplies transforms', () => {
    const matrix = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1];
    const product = multiply(matrix, invert(matrix));
    product.forEach((value, index) => expect(value).toBeCloseTo(index % 5 === 0 ? 1 : 0, 6));
  });

  it('bakes a skinned rest pose and preserves VRM extensions', () => {
    const original = fixture(), before = parseGlb(original);
    const extension = JSON.stringify(before.json.extensions);
    const result = bakeVrm(original, 'avatar.vrm');
    const parsed = parseGlb(result.buffer), output = new DataView(result.buffer, parsed.bin.offset, parsed.bin.length);
    expect(result.stats).toEqual({ meshes: 1, vertices: 1, morphVertexRecords: 1, skins: 1 });
    // Joint world translation is 3 and the old inverse bind translation is -2: baked x = 2.
    expect(output.getFloat32(0, true)).toBeCloseTo(2);
    // New inverse bind is inverse joint world: translation -3.
    expect(output.getFloat32(72 + 12 * 4, true)).toBeCloseTo(-3);
    expect(parsed.json.nodes[2].scale).toBeUndefined();
    expect(parsed.json.scenes[0].nodes).toContain(2);
    expect(JSON.stringify(parsed.json.extensions)).toBe(extension);
  });

  it('decodes normalized integer skin weights', () => {
    const result = bakeVrm(fixture({ normalizedWeights: true }), 'avatar.vrm');
    expect(result.stats.vertices).toBe(1);
  });

  it('densifies sparse accessors before baking', () => {
    const result = bakeVrm(fixture({ sparse: true }), 'avatar.vrm');
    const parsed = parseGlb(result.buffer), output = new DataView(result.buffer, parsed.bin.offset, parsed.bin.length);
    const positionAccessor = parsed.json.accessors[0], positionView = parsed.json.bufferViews[positionAccessor.bufferView];
    expect(positionAccessor.sparse).toBeUndefined();
    expect(output.getFloat32(positionView.byteOffset, true)).toBeCloseTo(3);
  });

  it('preserves finite zero-length normals and tangents without aborting', () => {
    const result = bakeVrm(fixture({ zeroVectors: true }), 'avatar.vrm');
    const parsed = parseGlb(result.buffer), output = new DataView(result.buffer, parsed.bin.offset, parsed.bin.length);
    expect([output.getFloat32(12, true), output.getFloat32(16, true), output.getFloat32(20, true)]).toEqual([0, 0, 0]);
    expect([output.getFloat32(24, true), output.getFloat32(28, true), output.getFloat32(32, true)]).toEqual([0, 0, 0]);
  });

  it('optionally merges compatible non-morph meshes that share a skin', () => {
    const result = bakeVrm(twoMeshFixture(), 'avatar.vrm', () => {}, { mergeCompatibleMeshes: true });
    const parsed = parseGlb(result.buffer);
    expect(result.stats.mergedMeshes).toBe(1);
    expect(result.stats.mergedPrimitives).toBe(1);
    expect(parsed.json.meshes[0].primitives).toHaveLength(1);
    expect(parsed.json.accessors[parsed.json.meshes[0].primitives[0].attributes.POSITION].count).toBe(2);
    expect(parsed.json.nodes[3].mesh).toBeUndefined();
    expect(parsed.json.nodes[3].skin).toBeUndefined();
  });

  it('merges meshes that use equivalent duplicated skin records', () => {
    const result = bakeVrm(equivalentSkinFixture(), 'avatar.vrm', () => {}, { mergeCompatibleMeshes: true });
    const parsed = parseGlb(result.buffer);
    expect(result.stats.mergedMeshes).toBe(1);
    expect(result.stats.mergedPrimitives).toBe(1);
    expect(parsed.json.meshes[0].primitives).toHaveLength(1);
    expect(parsed.json.nodes[3].mesh).toBeUndefined();
    expect(parsed.json.nodes[3].skin).toBeUndefined();
  });

  it('reconnects duplicated humanoid chains while preserving secondary bones', () => {
    const result = bakeVrm(detachedRigFixture(), 'avatar.vrm');
    const parsed = parseGlb(result.buffer), detached = parsed.json.skins[1];
    expect(result.stats.reconnectedSkins).toBe(1);
    expect(result.stats.remappedJoints).toBe(3);
    expect(detached.joints).toEqual([1, 4, 5, 9]);
    expect(detached.skeleton).toBe(1);
    expect(parsed.json.nodes[5].children).toContain(9);
    expect(parsed.json.nodes[8].children ?? []).not.toContain(9);
  });

  it('keeps expression-bound meshes separate when merging is requested', () => {
    const result = bakeVrm(twoMeshFixture(true), 'avatar.vrm', () => {}, { mergeCompatibleMeshes: true });
    const parsed = parseGlb(result.buffer);
    expect(result.stats.mergedMeshes).toBe(0);
    expect(result.stats.mergedPrimitives).toBe(0);
    expect(parsed.json.nodes[3].mesh).toBe(1);
    expect(parsed.json.extensions.VRMC_vrm.expressions.custom.clothing.morphTargetBinds[0].node).toBe(3);
  });

  it('joins compatible render primitives already contained in one mesh node', () => {
    const result = bakeVrm(oneMeshWithTwoPrimitivesFixture(), 'avatar.vrm', () => {}, { mergeCompatibleMeshes: true });
    const parsed = parseGlb(result.buffer);
    expect(result.stats.mergedMeshes).toBe(0);
    expect(result.stats.mergedPrimitives).toBe(1);
    expect(parsed.json.meshes[0].primitives).toHaveLength(1);
  });

  it.each([
    ['compressed geometry', { compressed: true }, 'COMPRESSED_GEOMETRY'],
    ['malformed sparse accessors', { malformedSparse: true }, 'MALFORMED_GLB'],
    ['zero weights', { zeroWeight: true }, 'ZERO_SKIN_WEIGHT']
  ])('rejects %s without output', (_label, options, code) => {
    try { bakeVrm(fixture(options), 'avatar.vrm'); throw new Error('Expected rejection'); }
    catch (error) { expect(error).toBeInstanceOf(BakeError); expect((error as BakeError).code).toBe(code); }
  });

  it('rejects malformed chunk bounds', () => {
    const glb = fixture(); new DataView(glb).setUint32(12, 0xfffffff0, true);
    expect(() => parseGlb(glb)).toThrow(BakeError);
  });
});
