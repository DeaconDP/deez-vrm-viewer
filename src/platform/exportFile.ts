import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';

export type SaveFilter = { name: string; extensions: string[] };

export type SaveLocalFileResult =
  | { saved: true; path?: string }
  | { saved: false };

function isTauriRuntime() {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

function downloadInBrowser(bytes: Uint8Array, fileName: string, mimeType: string) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const url = URL.createObjectURL(new Blob([copy], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Save bytes via a native Save dialog on Tauri, or a browser download otherwise. */
export async function saveLocalFile(options: {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
  title?: string;
  filters: SaveFilter[];
}): Promise<SaveLocalFileResult> {
  if (!options.bytes.byteLength) throw new Error('Refusing to save an empty file.');

  if (!isTauriRuntime()) {
    downloadInBrowser(options.bytes, options.fileName, options.mimeType);
    return { saved: true };
  }

  const path = await save({
    title: options.title,
    defaultPath: options.fileName,
    filters: options.filters
  });
  if (!path) return { saved: false };

  await invoke('write_export_file', { path, bytes: options.bytes });
  return { saved: true, path };
}
