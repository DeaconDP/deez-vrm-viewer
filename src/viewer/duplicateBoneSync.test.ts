import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DuplicateBoneSync } from './duplicateBoneSync';

function skinnedMesh(bones: THREE.Bone[]) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0], 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0], 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  mesh.bind(new THREE.Skeleton(bones));
  return mesh;
}

describe('DuplicateBoneSync', () => {
  it('copies canonical pose deltas while preserving the detached rig rest pose', () => {
    const root = new THREE.Group();
    const source = new THREE.Bone(); source.name = 'Head'; source.position.set(0, 2, 0);
    const sourceSpine = new THREE.Bone(); sourceSpine.name = 'Spine';
    const sourceHips = new THREE.Bone(); sourceHips.name = 'Hips';
    const target = new THREE.Bone(); target.name = 'Head_1'; target.position.set(0, 3, 0);
    const targetSpine = new THREE.Bone(); targetSpine.name = 'Spine_1';
    const targetHips = new THREE.Bone(); targetHips.name = 'Hips_1';
    root.add(source, sourceSpine, sourceHips, target, targetSpine, targetHips, skinnedMesh([target, targetSpine, targetHips]));

    const sync = new DuplicateBoneSync(root, [
      { boneName: 'head', node: source },
      { boneName: 'spine', node: sourceSpine },
      { boneName: 'hips', node: sourceHips }
    ]);
    source.position.x = 0.25;
    source.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4);
    sync.update();

    expect(sync.count).toBe(3);
    expect(sync.unsyncedDetachedSkeletons).toBe(0);
    expect(target.position.toArray()).toEqual([0.25, 3, 0]);
    expect(target.quaternion.angleTo(source.quaternion)).toBeCloseTo(0);
  });

  it('matches clothing bones through humanoid aliases and Blender suffixes', () => {
    const root = new THREE.Group();
    const sourceHead = new THREE.Bone(); sourceHead.name = 'J_Bip_C_Head';
    const sourceSpine = new THREE.Bone(); sourceSpine.name = 'J_Bip_C_Spine';
    const sourceHips = new THREE.Bone(); sourceHips.name = 'J_Bip_C_Hips';
    const coatHead = new THREE.Bone(); coatHead.name = 'Head.001';
    const coatSpine = new THREE.Bone(); coatSpine.name = 'Spine';
    const coatHips = new THREE.Bone(); coatHips.name = 'Hips';
    root.add(sourceHead, sourceSpine, sourceHips, coatHead, coatSpine, coatHips, skinnedMesh([coatHead, coatSpine, coatHips]));

    const sync = new DuplicateBoneSync(root, [
      { boneName: 'head', node: sourceHead },
      { boneName: 'spine', node: sourceSpine },
      { boneName: 'hips', node: sourceHips }
    ]);
    expect(sync.count).toBe(3);
    expect(sync.unsyncedDetachedSkeletons).toBe(0);
  });

  it('matches unrelated clothing bone names by rest-pose proximity', () => {
    const root = new THREE.Group();
    const sourceHead = new THREE.Bone(); sourceHead.name = 'BodyHead'; sourceHead.position.set(0, 1.6, 0);
    const sourceSpine = new THREE.Bone(); sourceSpine.name = 'BodySpine'; sourceSpine.position.set(0, 1.1, 0);
    const sourceHips = new THREE.Bone(); sourceHips.name = 'BodyHips'; sourceHips.position.set(0, 1, 0);
    const coatHead = new THREE.Bone(); coatHead.name = 'ClothA'; coatHead.position.set(0, 1.6, 0);
    const coatSpine = new THREE.Bone(); coatSpine.name = 'ClothB'; coatSpine.position.set(0, 1.1, 0);
    const coatHips = new THREE.Bone(); coatHips.name = 'ClothC'; coatHips.position.set(0, 1, 0);
    root.add(sourceHead, sourceSpine, sourceHips, coatHead, coatSpine, coatHips, skinnedMesh([coatHead, coatSpine, coatHips]));

    const sync = new DuplicateBoneSync(root, [
      { boneName: 'head', node: sourceHead },
      { boneName: 'spine', node: sourceSpine },
      { boneName: 'hips', node: sourceHips }
    ]);
    expect(sync.count).toBe(3);
    expect(sync.unsyncedDetachedSkeletons).toBe(0);
  });

  it('syncs hair accessories that only share a head anchor', () => {
    const root = new THREE.Group();
    const source = new THREE.Bone(); source.name = 'Head'; source.position.set(0, 1.6, 0);
    const target = new THREE.Bone(); target.name = 'Head_1'; target.position.set(0, 1.6, 0);
    const hairA = new THREE.Bone(); hairA.name = 'HairA'; hairA.position.set(0.1, 1.7, 0);
    const hairB = new THREE.Bone(); hairB.name = 'HairB'; hairB.position.set(-0.1, 1.7, 0);
    root.add(source, target, hairA, hairB, skinnedMesh([target, hairA, hairB]));

    const sync = new DuplicateBoneSync(root, [{ boneName: 'head', node: source }]);
    expect(sync.count).toBe(1);
    expect(sync.unsyncedDetachedSkeletons).toBe(0);
  });

  it('does not warn for hybrid skins that already include humanoid joints plus secondary bones', () => {
    const root = new THREE.Group();
    const hips = new THREE.Bone(); hips.name = 'Hips';
    const spine = new THREE.Bone(); spine.name = 'Spine';
    const chest = new THREE.Bone(); chest.name = 'Chest';
    const coatTail = new THREE.Bone(); coatTail.name = 'CoatTail'; coatTail.position.set(0, 0.2, -0.2);
    root.add(hips, spine, chest, coatTail, skinnedMesh([hips, spine, chest, coatTail]));

    const sync = new DuplicateBoneSync(root, [
      { boneName: 'hips', node: hips },
      { boneName: 'spine', node: spine },
      { boneName: 'chest', node: chest }
    ]);
    expect(sync.count).toBe(0);
    expect(sync.unsyncedDetachedSkeletons).toBe(0);
  });

  it('reports fully detached skins with no humanoid overlap', () => {
    const root = new THREE.Group();
    const source = new THREE.Bone(); source.name = 'Head'; source.position.set(0, 1.6, 0);
    const coatRoot = new THREE.Bone(); coatRoot.name = 'CoatRoot'; coatRoot.position.set(10, 10, 10);
    const coatMid = new THREE.Bone(); coatMid.name = 'CoatMid'; coatMid.position.set(10, 11, 10);
    root.add(source, coatRoot, coatMid, skinnedMesh([coatRoot, coatMid]));

    const sync = new DuplicateBoneSync(root, [{ boneName: 'head', node: source }]);
    expect(sync.count).toBe(0);
    expect(sync.unsyncedDetachedSkeletons).toBe(1);
  });

  it('ignores same-named nodes that are not skin bones', () => {
    const root = new THREE.Group(), source = new THREE.Bone(), decoration = new THREE.Object3D();
    source.name = decoration.name = 'Head'; root.add(source, decoration);
    const sync = new DuplicateBoneSync(root, [{ boneName: 'head', node: source }]);
    expect(sync.count).toBe(0);
    expect(sync.unsyncedDetachedSkeletons).toBe(0);
  });
});
