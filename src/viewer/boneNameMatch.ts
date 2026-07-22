/** Strip Blender/gltf numeric suffixes and compare bone names case-insensitively. */
export function normalizeBoneName(name: string): string {
  let value = name.trim();
  let previous = '';
  while (value !== previous) {
    previous = value;
    value = value.replace(/[._-]\d+$/i, '').replace(/_\d+$/i, '');
  }
  return value.toLowerCase().replace(/[\s_|.:-]+/g, '');
}

/** Generate lookup keys for a VRM humanoid bone id (e.g. leftUpperArm). */
export function humanoidBoneAliases(boneName: string): string[] {
  const trimmed = boneName.trim();
  if (!trimmed) return [];
  const pascal = trimmed.replace(/^[a-z]/, c => c.toUpperCase()).replace(/([a-z])([A-Z])/g, '$1$2');
  const spaced = trimmed.replace(/([a-z])([A-Z])/g, '$1 $2');
  const underscored = spaced.replace(/\s+/g, '_');
  const dotted = spaced.replace(/\s+/g, '.');
  return [...new Set([
    trimmed,
    pascal,
    spaced,
    underscored,
    dotted,
    `mixamorig${trimmed}`,
    `mixamorig:${trimmed}`,
    `mixamorig_${trimmed}`
  ])];
}

/** Torso/head bones strong enough to anchor an accessory (hair/clothing) reconnect. */
export const CORE_HUMANOID_ANCHORS = new Set([
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head'
]);

const STANDARD_HUMANOID_BONES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftEye', 'rightEye', 'jaw',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
  'leftThumbProximal', 'leftThumbIntermediate', 'leftThumbDistal',
  'leftIndexProximal', 'leftIndexIntermediate', 'leftIndexDistal',
  'leftMiddleProximal', 'leftMiddleIntermediate', 'leftMiddleDistal',
  'leftRingProximal', 'leftRingIntermediate', 'leftRingDistal',
  'leftLittleProximal', 'leftLittleIntermediate', 'leftLittleDistal',
  'rightThumbProximal', 'rightThumbIntermediate', 'rightThumbDistal',
  'rightIndexProximal', 'rightIndexIntermediate', 'rightIndexDistal',
  'rightMiddleProximal', 'rightMiddleIntermediate', 'rightMiddleDistal',
  'rightRingProximal', 'rightRingIntermediate', 'rightRingDistal',
  'rightLittleProximal', 'rightLittleIntermediate', 'rightLittleDistal'
] as const;

const MIN_SUFFIX_KEY_LENGTH = 4;

const humanoidNameHints: string[] = (() => {
  const keys = new Set<string>();
  for (const bone of STANDARD_HUMANOID_BONES) {
    for (const alias of humanoidBoneAliases(bone)) {
      keys.add(alias);
      const normalized = normalizeBoneName(alias);
      if (normalized) keys.add(normalized);
    }
  }
  return [...keys];
})();

/** True when a name looks like a VRM humanoid bone even if unique resolve failed. */
export function looksLikeHumanoidBoneName(name: string | undefined | null): boolean {
  if (!name) return false;
  const exact = humanoidNameHints.includes(name) || humanoidNameHints.includes(normalizeBoneName(name));
  if (exact) return true;
  const normalized = normalizeBoneName(name);
  if (normalized.length < MIN_SUFFIX_KEY_LENGTH) return false;
  let best = 0;
  for (const key of humanoidNameHints) {
    if (key.length < MIN_SUFFIX_KEY_LENGTH || !normalized.endsWith(key)) continue;
    best = Math.max(best, key.length);
  }
  return best >= MIN_SUFFIX_KEY_LENGTH;
}

/** Rest-pose proximity gate: 10% of hips→head height, floored at 5 cm. */
export function proximityMatchDistance(modelHeight: number): number {
  const height = Number.isFinite(modelHeight) && modelHeight > 1e-3 ? modelHeight : 1.6;
  return Math.max(height * 0.1, 0.05);
}

/**
 * Enough evidence to remap a detached skin: a short humanoid chain, or a single
 * core torso/head anchor with only non-humanoid secondary bones left unmatched.
 */
export function canReconnectDetachedMatches(
  matchedBoneNames: Iterable<string>,
  unmatchedNames: Iterable<string | undefined | null>,
  minChainMatches = 3
): boolean {
  const matched = [...matchedBoneNames];
  if (matched.length >= minChainMatches) return true;
  if (matched.length < 1) return false;
  if (!matched.some(name => CORE_HUMANOID_ANCHORS.has(name))) return false;
  for (const name of unmatchedNames) {
    if (looksLikeHumanoidBoneName(name)) return false;
  }
  return true;
}

export interface CanonicalBoneRef<T> {
  boneName?: string;
  name?: string;
  value: T;
}

export interface SpatialPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * Greedy one-to-one assignment of sources to the nearest unused target within maxDistance.
 * Returns pairs only for assignments that clear the distance gate.
 */
export function matchByProximity<TSource, TTarget>(
  sources: { id: TSource; point: SpatialPoint }[],
  targets: { id: TTarget; point: SpatialPoint }[],
  maxDistance: number
): { source: TSource; target: TTarget; distance: number }[] {
  const candidates: { source: TSource; target: TTarget; distance: number }[] = [];
  for (const source of sources) {
    for (const target of targets) {
      const dx = source.point.x - target.point.x;
      const dy = source.point.y - target.point.y;
      const dz = source.point.z - target.point.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance <= maxDistance) candidates.push({ source: source.id, target: target.id, distance });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  const usedSources = new Set<TSource>(), usedTargets = new Set<TTarget>();
  const pairs: { source: TSource; target: TTarget; distance: number }[] = [];
  for (const candidate of candidates) {
    if (usedSources.has(candidate.source) || usedTargets.has(candidate.target)) continue;
    usedSources.add(candidate.source);
    usedTargets.add(candidate.target);
    pairs.push(candidate);
  }
  return pairs;
}

export function translationOfMatrix(matrix: number[]): SpatialPoint {
  return { x: matrix[12] ?? 0, y: matrix[13] ?? 0, z: matrix[14] ?? 0 };
}

export function distanceBetween(a: SpatialPoint, b: SpatialPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Maps bone name variants onto canonical values. Colliding keys become unusable
 * (null) so one coincidental rename cannot steal another bone's identity.
 */
export class BoneNameLookup<T> {
  private readonly keys = new Map<string, T | null>();

  register(ref: CanonicalBoneRef<T>) {
    const labels = new Set<string>();
    if (ref.name) labels.add(ref.name);
    if (ref.boneName) {
      for (const alias of humanoidBoneAliases(ref.boneName)) labels.add(alias);
    }
    for (const label of labels) {
      for (const key of new Set([label, normalizeBoneName(label)])) {
        if (!key) continue;
        this.keys.set(key, this.keys.has(key) && this.keys.get(key) !== ref.value ? null : ref.value);
      }
    }
  }

  resolve(name: string | undefined | null): T | undefined {
    if (!name) return undefined;
    const exact = this.keys.get(name) ?? this.keys.get(normalizeBoneName(name));
    if (exact != null) return exact;
    if (exact === null) return undefined;

    const normalized = normalizeBoneName(name);
    if (normalized.length < MIN_SUFFIX_KEY_LENGTH) return undefined;

    let bestKey = '';
    let bestValue: T | undefined;
    let ambiguous = false;
    for (const [key, value] of this.keys) {
      if (value == null || key.length < MIN_SUFFIX_KEY_LENGTH) continue;
      if (!normalized.endsWith(key)) continue;
      if (key.length > bestKey.length) {
        bestKey = key;
        bestValue = value;
        ambiguous = false;
      } else if (key.length === bestKey.length && value !== bestValue) {
        ambiguous = true;
      }
    }
    return ambiguous ? undefined : bestValue;
  }
}
