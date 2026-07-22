import * as THREE from 'three';
import { BoneNameLookup, canReconnectDetachedMatches, matchByProximity, proximityMatchDistance } from './boneNameMatch';

interface TransformSnapshot {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

interface BonePair {
  source: THREE.Object3D;
  target: THREE.Object3D;
  sourceRest: TransformSnapshot;
  targetRest: TransformSnapshot;
}

export interface HumanoidBoneEntry {
  boneName: string;
  node: THREE.Object3D;
}

function snapshot(node: THREE.Object3D): TransformSnapshot {
  return {
    position: node.position.clone(),
    quaternion: node.quaternion.clone(),
    scale: node.scale.clone()
  };
}

function worldPoint(node: THREE.Object3D) {
  node.updateWorldMatrix(true, false);
  const position = new THREE.Vector3();
  node.getWorldPosition(position);
  return { x: position.x, y: position.y, z: position.z };
}

function humanoidModelHeight(humanoidBones: HumanoidBoneEntry[]) {
  const hips = humanoidBones.find(entry => entry.boneName === 'hips')?.node;
  const head = humanoidBones.find(entry => entry.boneName === 'head')?.node;
  if (hips && head) {
    const height = Math.abs(worldPoint(head).y - worldPoint(hips).y);
    if (height > 1e-3) return height;
  }
  return 1.6;
}

/**
 * Mirrors humanoid pose deltas into detached exporter-created armatures.
 * Matching mirrors bake reconnect: name/alias/suffix or rest-pose proximity,
 * with a ≥3 chain or a single core torso/head accessory anchor.
 */
export class DuplicateBoneSync {
  private readonly pairs: BonePair[];
  private readonly rotationDelta = new THREE.Quaternion();
  private readonly positionDelta = new THREE.Vector3();
  readonly unsyncedDetachedSkeletons: number;

  constructor(root: THREE.Object3D, humanoidBones: HumanoidBoneEntry[]) {
    const lookup = new BoneNameLookup<THREE.Object3D>();
    const boneNameByNode = new Map<THREE.Object3D, string>();
    const canonicalBones: THREE.Object3D[] = [];
    for (const { boneName, node } of humanoidBones) {
      if (!node) continue;
      canonicalBones.push(node);
      boneNameByNode.set(node, boneName);
      lookup.register({ boneName, name: node.name, value: node });
    }

    const canonicalSet = new Set(canonicalBones), skeletons = new Set<THREE.Skeleton>();
    root.traverse(object => {
      const mesh = object as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh) skeletons.add(mesh.skeleton);
    });

    const maxDistance = proximityMatchDistance(humanoidModelHeight(humanoidBones));
    const canonicalTargets = canonicalBones.map(node => ({ id: node, point: worldPoint(node) }));

    this.pairs = [];
    const added = new Set<THREE.Object3D>();
    let unsynced = 0;
    for (const skeleton of skeletons) {
      const nonCanonical = skeleton.bones.filter(bone => !canonicalSet.has(bone));
      if (!nonCanonical.length) continue;
      const fullyDetached = !skeleton.bones.some(bone => canonicalSet.has(bone));

      const matches: { source: THREE.Object3D; target: THREE.Object3D }[] = [];
      const unmatched: THREE.Object3D[] = [];
      for (const target of nonCanonical) {
        const source = lookup.resolve(target.name);
        if (source && source !== target) matches.push({ source, target });
        else unmatched.push(target);
      }

      {
        const usedSources = new Set(matches.map(pair => pair.source));
        const spatial = matchByProximity(
          unmatched.map(target => ({ id: target, point: worldPoint(target) })),
          canonicalTargets.filter(target => !usedSources.has(target.id)),
          maxDistance
        );
        for (const { source, target } of spatial) matches.push({ source: target, target: source });
      }

      const matchedBoneNames = matches.flatMap(pair => {
        const boneName = boneNameByNode.get(pair.source);
        return boneName ? [boneName] : [];
      });
      const unmatchedAfter = nonCanonical
        .filter(bone => !matches.some(pair => pair.target === bone))
        .map(bone => bone.name);

      if (!canReconnectDetachedMatches(matchedBoneNames, unmatchedAfter)) {
        // Hybrid skins that already include humanoid joints plus secondary
        // hair/cloth bones are expected; only fully detached leftovers warn.
        if (fullyDetached) unsynced++;
        continue;
      }
      for (const { source, target } of matches) {
        if (added.has(target)) continue;
        added.add(target);
        this.pairs.push({ source, target, sourceRest: snapshot(source), targetRest: snapshot(target) });
      }
    }
    this.unsyncedDetachedSkeletons = unsynced;
  }

  get count() { return this.pairs.length; }

  update() {
    for (const { source, target, sourceRest, targetRest } of this.pairs) {
      this.positionDelta.copy(source.position).sub(sourceRest.position);
      target.position.copy(targetRest.position).add(this.positionDelta);
      this.rotationDelta.copy(sourceRest.quaternion).invert().multiply(source.quaternion);
      target.quaternion.copy(targetRest.quaternion).multiply(this.rotationDelta).normalize();
      target.scale.set(
        targetRest.scale.x * (sourceRest.scale.x ? source.scale.x / sourceRest.scale.x : 1),
        targetRest.scale.y * (sourceRest.scale.y ? source.scale.y / sourceRest.scale.y : 1),
        targetRest.scale.z * (sourceRest.scale.z ? source.scale.z / sourceRest.scale.z : 1)
      );
      target.updateMatrix();
    }
  }
}
