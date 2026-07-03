import * as THREE from 'three';

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

function snapshot(node: THREE.Object3D): TransformSnapshot {
  return {
    position: node.position.clone(),
    quaternion: node.quaternion.clone(),
    scale: node.scale.clone()
  };
}

/**
 * Mirrors humanoid pose deltas into detached exporter-created armatures.
 * Matching is deliberately conservative: only bones used by a SkinnedMesh and
 * sharing a unique exact name with a canonical raw humanoid bone are touched.
 */
export class DuplicateBoneSync {
  private readonly pairs: BonePair[];
  private readonly rotationDelta = new THREE.Quaternion();
  private readonly positionDelta = new THREE.Vector3();

  constructor(root: THREE.Object3D, canonicalBones: THREE.Object3D[]) {
    const names = new Map<string, THREE.Object3D | null>();
    for (const bone of canonicalBones) {
      if (!bone.name) continue;
      for (const name of new Set([bone.name, bone.name.replace(/_\d+$/, '')])) {
        names.set(name, names.has(name) ? null : bone);
      }
    }

    const canonicalSet = new Set(canonicalBones), skeletons = new Set<THREE.Skeleton>();
    root.traverse(object => {
      const mesh = object as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh) skeletons.add(mesh.skeleton);
    });

    this.pairs = [];
    const added = new Set<THREE.Object3D>();
    for (const skeleton of skeletons) {
      const matches = skeleton.bones.flatMap(target => {
        // GLTFLoader suffixes repeated node names (e.g. Head_1, Head_2) to
        // keep animation bindings unique. The source JSON names remain exact.
        const deduplicatedName = target.name.replace(/_\d+$/, '');
        const source = names.get(target.name) ?? names.get(deduplicatedName);
        return source && source !== target && !canonicalSet.has(target) ? [{ source, target }] : [];
      });
      if (matches.length < 3) continue;
      for (const { source, target } of matches) {
        if (added.has(target)) continue;
        added.add(target);
        this.pairs.push({ source, target, sourceRest: snapshot(source), targetRest: snapshot(target) });
      }
    }
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
