export const BAKE_LIMITS = {
  maxInputBytes: 128 * 1024 * 1024,
  maxSkinnedVertices: 2_000_000,
  maxMorphVertexRecords: 8_000_000,
  maxJointsPerSkin: 256
} as const;

export interface BakeStats {
  meshes: number;
  vertices: number;
  morphVertexRecords: number;
  skins: number;
  reconnectedSkins?: number;
  remappedJoints?: number;
  unrepairedDetachedSkins?: number;
  unrepairedJointNames?: string[];
  mergedMeshes?: number;
  mergedPrimitives?: number;
}

export interface BakeOptions { mergeCompatibleMeshes?: boolean }

export type BakeStage = 'preflight' | 'geometry' | 'bind-poses' | 'validation' | 'download';

export type BakeWorkerRequest = { type: 'start'; buffer: ArrayBuffer; fileName: string; options?: BakeOptions };

export type BakeWorkerResponse =
  | { type: 'progress'; stage: BakeStage; progress: number; detail: string; stats?: BakeStats }
  | { type: 'complete'; buffer: ArrayBuffer; fileName: string; stats: BakeStats }
  | { type: 'cancelled' }
  | { type: 'error'; code: string; message: string };

export interface BakeResult {
  buffer: ArrayBuffer;
  fileName: string;
  stats: BakeStats;
}
