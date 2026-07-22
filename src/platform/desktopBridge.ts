import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';

type ModelPayload = { name: string; bytes: Uint8Array };
type ModelListener = (payload: ModelPayload) => void;

function isTauriRuntime() {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

function toBytes(value: ArrayBuffer | number[] | Uint8Array) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return Uint8Array.from(value);
}

function isModelPath(path: string) {
  const lower = path.toLowerCase();
  return lower.endsWith('.vrm') || lower.endsWith('.glb') || lower.endsWith('.gltf');
}

export function installDesktopBridge() {
  if (!isTauriRuntime() || window.desktop) return;

  const queued: ModelPayload[] = [];
  const listeners = new Set<ModelListener>();

  const deliver = (payload: ModelPayload) => {
    if (listeners.size === 0) queued.push(payload);
    else listeners.forEach(listener => listener(payload));
  };

  const loadPath = async (path: string) => {
    const result = await invoke<{ name: string; bytes: number[] | Uint8Array }>('read_model_file', { path });
    deliver({ name: result.name, bytes: toBytes(result.bytes) });
  };

  window.desktop = {
    onOpenModel(listener) {
      listeners.add(listener);
      while (queued.length) listener(queued.shift()!);
      return () => { listeners.delete(listener); };
    }
  };

  void listen<string>('open-model-path', event => {
    void loadPath(event.payload).catch(error => console.error(error));
  });

  void getCurrentWebview().onDragDropEvent(event => {
    if (event.payload.type !== 'drop') return;
    const path = event.payload.paths.find(isModelPath);
    if (!path) {
      console.error('Drop a .vrm, .glb, or .gltf model.');
      return;
    }
    void loadPath(path).catch(error => console.error(error));
  }).catch(error => console.error(error));

  void invoke<string | null>('take_pending_model_path')
    .then(path => { if (path) return loadPath(path); })
    .catch(error => console.error(error));
}
