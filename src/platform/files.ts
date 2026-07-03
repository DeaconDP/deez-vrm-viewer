const ACCEPTED = /\.(vrm|glb|gltf)$/i;

export async function validateModelFile(file: File): Promise<string | null> {
  if (!ACCEPTED.test(file.name)) return 'Choose a .vrm, .glb, or .gltf model.';
  if (!file.size) return 'This file is empty and cannot be opened.';
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const binary = file.name.toLowerCase().endsWith('.vrm') || file.name.toLowerCase().endsWith('.glb');
  if (binary && (head.length < 4 || head[0] !== 0x67 || head[1] !== 0x6c || head[2] !== 0x54 || head[3] !== 0x46)) {
    return 'This file does not contain a valid binary glTF/VRM header.';
  }
  if (!binary) {
    const text = new TextDecoder().decode(head).trimStart();
    if (!text.startsWith('{')) return 'This glTF file does not begin with valid JSON.';
  }
  return null;
}
