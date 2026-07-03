import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { retargetQuaterniusClip } from './quaterniusAnimations';

describe('retargetQuaterniusClip', () => {
  it('bakes source hip rotation and motion onto a normalized VRM bone', () => {
    const source = new THREE.Group();
    const pelvis = new THREE.Object3D();
    pelvis.name = 'pelvis';
    pelvis.position.y = 1;
    source.add(pelvis);

    const targetScene = new THREE.Group();
    const targetHips = new THREE.Object3D();
    targetHips.name = 'NormalizedHips';
    targetHips.position.y = 2;
    targetScene.add(targetHips);

    const clip = new THREE.AnimationClip('TestMotion', 1, [
      new THREE.QuaternionKeyframeTrack('pelvis.quaternion', [0, 1], [0, 0, 0, 1, 0, Math.SQRT1_2, 0, Math.SQRT1_2]),
      new THREE.VectorKeyframeTrack('pelvis.position', [0, 1], [0, 1, 0, .25, 1.5, 0])
    ]);
    const vrm = {
      scene: targetScene,
      humanoid: {
        resetNormalizedPose() {},
        update() {},
        getNormalizedBoneNode(name: string) { return name === 'hips' ? targetHips : null; }
      }
    } as unknown as VRM;

    const result = retargetQuaterniusClip(source, clip, vrm, 10);
    expect(result.name).toBe('TestMotion');
    expect(result.duration).toBe(1);
    expect(result.tracks.map(track => track.name)).toEqual(['NormalizedHips.quaternion', 'NormalizedHips.position']);
    expect(Array.from(result.tracks[0].values).every(Number.isFinite)).toBe(true);
    expect(result.tracks[1].values[result.tracks[1].values.length - 3]).toBeCloseTo(.25);
    expect(result.tracks[1].values[result.tracks[1].values.length - 2]).toBeCloseTo(2.5);
  });
});
