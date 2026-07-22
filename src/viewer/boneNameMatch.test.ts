import { describe, expect, it } from 'vitest';
import {
  BoneNameLookup,
  canReconnectDetachedMatches,
  humanoidBoneAliases,
  looksLikeHumanoidBoneName,
  matchByProximity,
  normalizeBoneName,
  proximityMatchDistance
} from './boneNameMatch';

describe('boneNameMatch', () => {
  it('strips Blender and glTF numeric suffixes case-insensitively', () => {
    expect(normalizeBoneName('Head_1')).toBe('head');
    expect(normalizeBoneName('Hips.001')).toBe('hips');
    expect(normalizeBoneName('LeftUpperArm_12')).toBe('leftupperarm');
    expect(normalizeBoneName('  Spine.002  ')).toBe('spine');
  });

  it('resolves humanoid aliases onto the canonical bone', () => {
    const lookup = new BoneNameLookup<string>();
    lookup.register({ boneName: 'leftUpperArm', name: 'J_Bip_L_UpperArm', value: 'arm' });
    expect(lookup.resolve('J_Bip_L_UpperArm')).toBe('arm');
    expect(lookup.resolve('leftUpperArm')).toBe('arm');
    expect(lookup.resolve('LeftUpperArm')).toBe('arm');
    expect(lookup.resolve('Left Upper Arm')).toBe('arm');
    expect(lookup.resolve('mixamorig:LeftUpperArm')).toBe('arm');
  });

  it('resolves prefixed clothing bones through the longest unique suffix', () => {
    const lookup = new BoneNameLookup<string>();
    lookup.register({ boneName: 'hips', name: 'J_Bip_C_Hips', value: 'hips' });
    lookup.register({ boneName: 'spine', name: 'J_Bip_C_Spine', value: 'spine' });
    expect(lookup.resolve('Coat_Hips')).toBe('hips');
    expect(lookup.resolve('Jacket.Spine')).toBe('spine');
    expect(lookup.resolve('Arm')).toBeUndefined();
  });

  it('marks colliding keys as unusable', () => {
    const lookup = new BoneNameLookup<string>();
    lookup.register({ name: 'Head', value: 'a' });
    lookup.register({ name: 'Head', value: 'b' });
    expect(lookup.resolve('Head')).toBeUndefined();
  });

  it('lists stable aliases for a humanoid bone id', () => {
    expect(humanoidBoneAliases('hips')).toEqual(expect.arrayContaining(['hips', 'Hips', 'mixamorig:hips']));
  });

  it('assigns sources to the nearest unused target within the distance gate', () => {
    const pairs = matchByProximity(
      [
        { id: 'a', point: { x: 0, y: 1, z: 0 } },
        { id: 'b', point: { x: 0, y: 2, z: 0 } },
        { id: 'far', point: { x: 10, y: 10, z: 10 } }
      ],
      [
        { id: 'hips', point: { x: 0, y: 1, z: 0 } },
        { id: 'head', point: { x: 0, y: 2, z: 0 } }
      ],
      0.1
    );
    expect(pairs).toEqual([
      { source: 'a', target: 'hips', distance: 0 },
      { source: 'b', target: 'head', distance: 0 }
    ]);
  });

  it('floors proximity distance at five centimeters', () => {
    expect(proximityMatchDistance(0.2)).toBe(0.05);
    expect(proximityMatchDistance(1.6)).toBeCloseTo(0.16);
  });

  it('allows accessory reconnect from a single core anchor', () => {
    expect(canReconnectDetachedMatches(['head'], ['HairA', 'HairB'])).toBe(true);
    expect(canReconnectDetachedMatches(['head'], ['LeftUpperArm'])).toBe(false);
    expect(canReconnectDetachedMatches(['leftHand'], ['HairA'])).toBe(false);
    expect(looksLikeHumanoidBoneName('Coat_Hips')).toBe(true);
    expect(looksLikeHumanoidBoneName('HairA')).toBe(false);
  });
});
