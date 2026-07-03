import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DuplicateBoneSync } from './duplicateBoneSync';

describe('DuplicateBoneSync', () => {
  it('copies canonical pose deltas while preserving the detached rig rest pose', () => {
    const root = new THREE.Group();
    const source = new THREE.Bone(); source.name = 'Head'; source.position.set(0, 2, 0);
    const sourceSpine = new THREE.Bone(); sourceSpine.name = 'Spine';
    const sourceHips = new THREE.Bone(); sourceHips.name = 'Hips';
    const target = new THREE.Bone(); target.name = 'Head_1'; target.position.set(0, 3, 0);
    const targetSpine = new THREE.Bone(); targetSpine.name = 'Spine_1';
    const targetHips = new THREE.Bone(); targetHips.name = 'Hips_1';
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0], 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0], 4));
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    mesh.bind(new THREE.Skeleton([target, targetSpine, targetHips]));
    root.add(source, sourceSpine, sourceHips, target, targetSpine, targetHips, mesh);

    const sync = new DuplicateBoneSync(root, [source, sourceSpine, sourceHips]);
    source.position.x = 0.25;
    source.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4);
    sync.update();

    expect(sync.count).toBe(3);
    expect(target.position.toArray()).toEqual([0.25, 3, 0]);
    expect(target.quaternion.angleTo(source.quaternion)).toBeCloseTo(0);
  });

  it('ignores same-named nodes that are not skin bones', () => {
    const root = new THREE.Group(), source = new THREE.Bone(), decoration = new THREE.Object3D();
    source.name = decoration.name = 'Head'; root.add(source, decoration);
    const sync = new DuplicateBoneSync(root, [source]);
    expect(sync.count).toBe(0);
  });
});
