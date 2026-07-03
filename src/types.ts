export type LoadState = 'idle' | 'reading' | 'parsing' | 'ready' | 'error';

export type AnimationLoopMode = 'repeat' | 'once' | 'pingpong';

export interface AnimationState {
  name: string;
  source: 'built-in' | 'file' | null;
  duration: number;
  time: number;
  playing: boolean;
  loading: boolean;
  error: string;
}

export interface TreeItem {
  id: string;
  label: string;
  kind: 'node' | 'mesh' | 'material' | 'texture' | 'bone' | 'system';
  detail?: string;
}

export interface ModelSummary {
  name: string;
  format: 'VRM' | 'glTF';
  version: string;
  generator: string;
  size: number;
  loadMs: number;
  nodes: number;
  meshes: number;
  triangles: number;
  materials: number;
  textures: number;
  bones: number;
  expressions: string[];
  authors: string[];
  license: string;
  items: TreeItem[];
}
