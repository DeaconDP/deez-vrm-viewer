import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';

export const QUATERNIUS_ANIMATIONS = [
  'A_TPose', 'Chest_Open', 'ClimbUp_1m', 'Consume', 'Farm_Harvest', 'Farm_PlantSeed', 'Farm_Watering',
  'Hit_Knockback', 'Idle_FoldArms_Loop', 'Idle_Lantern_Loop', 'Idle_No_Loop', 'Idle_Rail_Call',
  'Idle_Rail_Loop', 'Idle_Shield_Break', 'Idle_Shield_Loop', 'Idle_TalkingPhone_Loop', 'LayToIdle',
  'Melee_Hook', 'Melee_Hook_Rec', 'NinjaJump_Idle_Loop', 'NinjaJump_Land', 'NinjaJump_Start',
  'OverhandThrow', 'Shield_Dash', 'Shield_OneShot', 'Slide_Exit', 'Slide_Loop', 'Slide_Start',
  'Sword_Block', 'Sword_Dash', 'Sword_Heavy_Combo', 'Sword_Regular_A', 'Sword_Regular_A_Rec',
  'Sword_Regular_B', 'Sword_Regular_B_Rec', 'Sword_Regular_C', 'Sword_Regular_Combo',
  'TreeChopping_Loop', 'Walk_Carry_Loop', 'Yes', 'Zombie_Idle_Loop', 'Zombie_Scratch',
  'Zombie_Walk_Fwd_Loop'
] as const;

export type QuaterniusAnimationName = typeof QUATERNIUS_ANIMATIONS[number];

const BONE_MAP: ReadonlyArray<readonly [string, VRMHumanBoneName]> = [
  ['pelvis', 'hips'], ['spine_01', 'spine'], ['spine_02', 'chest'], ['spine_03', 'upperChest'],
  ['neck_01', 'neck'], ['Head', 'head'],
  ['clavicle_l', 'leftShoulder'], ['upperarm_l', 'leftUpperArm'], ['lowerarm_l', 'leftLowerArm'], ['hand_l', 'leftHand'],
  ['clavicle_r', 'rightShoulder'], ['upperarm_r', 'rightUpperArm'], ['lowerarm_r', 'rightLowerArm'], ['hand_r', 'rightHand'],
  ['thigh_l', 'leftUpperLeg'], ['calf_l', 'leftLowerLeg'], ['foot_l', 'leftFoot'], ['ball_l', 'leftToes'],
  ['thigh_r', 'rightUpperLeg'], ['calf_r', 'rightLowerLeg'], ['foot_r', 'rightFoot'], ['ball_r', 'rightToes'],
  ['thumb_01_l', 'leftThumbMetacarpal'], ['thumb_02_l', 'leftThumbProximal'], ['thumb_03_l', 'leftThumbDistal'],
  ['index_01_l', 'leftIndexProximal'], ['index_02_l', 'leftIndexIntermediate'], ['index_03_l', 'leftIndexDistal'],
  ['middle_01_l', 'leftMiddleProximal'], ['middle_02_l', 'leftMiddleIntermediate'], ['middle_03_l', 'leftMiddleDistal'],
  ['ring_01_l', 'leftRingProximal'], ['ring_02_l', 'leftRingIntermediate'], ['ring_03_l', 'leftRingDistal'],
  ['pinky_01_l', 'leftLittleProximal'], ['pinky_02_l', 'leftLittleIntermediate'], ['pinky_03_l', 'leftLittleDistal'],
  ['thumb_01_r', 'rightThumbMetacarpal'], ['thumb_02_r', 'rightThumbProximal'], ['thumb_03_r', 'rightThumbDistal'],
  ['index_01_r', 'rightIndexProximal'], ['index_02_r', 'rightIndexIntermediate'], ['index_03_r', 'rightIndexDistal'],
  ['middle_01_r', 'rightMiddleProximal'], ['middle_02_r', 'rightMiddleIntermediate'], ['middle_03_r', 'rightMiddleDistal'],
  ['ring_01_r', 'rightRingProximal'], ['ring_02_r', 'rightRingIntermediate'], ['ring_03_r', 'rightRingDistal'],
  ['pinky_01_r', 'rightLittleProximal'], ['pinky_02_r', 'rightLittleIntermediate'], ['pinky_03_r', 'rightLittleDistal']
];

interface BonePair {
  source: THREE.Object3D;
  target: THREE.Object3D;
  targetBone: VRMHumanBoneName;
  sourceRestWorld: THREE.Quaternion;
  sourceRestPosition: THREE.Vector3;
  targetRestWorld: THREE.Quaternion;
  targetRestPosition: THREE.Vector3;
}

/** Samples a Quaternius skeletal clip and bakes it onto a VRM normalized humanoid. */
export function retargetQuaterniusClip(sourceScene: THREE.Object3D, sourceClip: THREE.AnimationClip, vrm: VRM, fps = 30) {
  vrm.humanoid.resetNormalizedPose();
  vrm.humanoid.update();
  vrm.scene.updateMatrixWorld(true);
  sourceScene.updateMatrixWorld(true);

  const pairs: BonePair[] = BONE_MAP.flatMap(([sourceName, targetBone]) => {
    const source = sourceScene.getObjectByName(sourceName);
    const target = vrm.humanoid.getNormalizedBoneNode(targetBone);
    return source && target ? [{
      source, target, targetBone,
      sourceRestWorld: source.getWorldQuaternion(new THREE.Quaternion()),
      sourceRestPosition: source.getWorldPosition(new THREE.Vector3()),
      targetRestWorld: target.getWorldQuaternion(new THREE.Quaternion()),
      targetRestPosition: target.getWorldPosition(new THREE.Vector3())
    }] : [];
  });
  if (!pairs.length) throw new Error('The bundled motion rig could not be mapped to this VRM humanoid.');

  const sourceHead = pairs.find(pair => pair.targetBone === 'head')?.sourceRestPosition;
  const sourceFeet = pairs.filter(pair => pair.targetBone === 'leftFoot' || pair.targetBone === 'rightFoot');
  const targetHead = pairs.find(pair => pair.targetBone === 'head')?.targetRestPosition;
  const targetFeet = pairs.filter(pair => pair.targetBone === 'leftFoot' || pair.targetBone === 'rightFoot');
  const averageY = (items: BonePair[], side: 'source' | 'target') => items.reduce((sum, pair) => sum + (side === 'source' ? pair.sourceRestPosition.y : pair.targetRestPosition.y), 0) / Math.max(1, items.length);
  const sourceHeight = sourceHead ? Math.abs(sourceHead.y - averageY(sourceFeet, 'source')) : 1;
  const targetHeight = targetHead ? Math.abs(targetHead.y - averageY(targetFeet, 'target')) : sourceHeight;
  const positionScale = sourceHeight > 1e-5 ? targetHeight / sourceHeight : 1;

  const mixer = new THREE.AnimationMixer(sourceScene);
  const action = mixer.clipAction(sourceClip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const frameCount = Math.max(1, Math.ceil(sourceClip.duration * fps));
  const times = Array.from({ length: frameCount + 1 }, (_, frame) => Math.min(sourceClip.duration, frame / fps));
  const rotationValues = new Map<BonePair, number[]>();
  const hipPositions: number[] = [];
  pairs.forEach(pair => rotationValues.set(pair, []));

  for (const time of times) {
    mixer.setTime(time);
    sourceScene.updateMatrixWorld(true);
    const desiredWorld = new Map<THREE.Object3D, THREE.Quaternion>();

    for (const pair of pairs) {
      const current = pair.source.getWorldQuaternion(new THREE.Quaternion());
      const delta = current.multiply(pair.sourceRestWorld.clone().invert());
      desiredWorld.set(pair.target, delta.multiply(pair.targetRestWorld));
    }

    for (const pair of pairs) {
      let ancestor: THREE.Object3D | null = pair.target.parent;
      while (ancestor && !desiredWorld.has(ancestor)) ancestor = ancestor.parent;
      let parentWorld: THREE.Quaternion;
      if (ancestor) {
        const ancestorDesired = desiredWorld.get(ancestor)!;
        const ancestorRest = ancestor.getWorldQuaternion(new THREE.Quaternion());
        const parentRest = pair.target.parent?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion();
        parentWorld = ancestorDesired.clone().multiply(ancestorRest.invert()).multiply(parentRest);
      } else {
        parentWorld = pair.target.parent?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion();
      }
      const inverseParentWorld = parentWorld.clone().invert();
      const local = inverseParentWorld.clone().multiply(desiredWorld.get(pair.target)!).normalize();
      rotationValues.get(pair)!.push(local.x, local.y, local.z, local.w);

      if (pair.targetBone === 'hips') {
        const displacement = pair.source.getWorldPosition(new THREE.Vector3()).sub(pair.sourceRestPosition).multiplyScalar(positionScale);
        displacement.applyQuaternion(inverseParentWorld);
        const position = pair.target.position.clone().add(displacement);
        hipPositions.push(position.x, position.y, position.z);
      }
    }
  }

  action.stop();
  mixer.uncacheRoot(sourceScene);
  const tracks: THREE.KeyframeTrack[] = pairs.map(pair => new THREE.QuaternionKeyframeTrack(`${pair.target.name}.quaternion`, times, rotationValues.get(pair)!));
  const hips = pairs.find(pair => pair.targetBone === 'hips');
  if (hips && hipPositions.length) tracks.push(new THREE.VectorKeyframeTrack(`${hips.target.name}.position`, times, hipPositions));
  return new THREE.AnimationClip(sourceClip.name, sourceClip.duration, tracks).optimize();
}
