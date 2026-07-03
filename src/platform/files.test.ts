import { describe, expect, it } from 'vitest';
import { validateModelFile } from './files';

describe('validateModelFile', () => {
  it('accepts GLB magic in a VRM file', async () => {
    expect(await validateModelFile(new File([new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0])], 'avatar.vrm'))).toBeNull();
  });
  it('rejects a renamed non-model', async () => {
    expect(await validateModelFile(new File(['hello'], 'fake.vrm'))).toMatch(/valid binary/);
  });
  it('rejects unsupported extensions', async () => {
    expect(await validateModelFile(new File(['hello'], 'notes.txt'))).toMatch(/Choose/);
  });
  it('accepts JSON glTF', async () => {
    expect(await validateModelFile(new File(['  {"asset":{"version":"2.0"}}'], 'model.gltf'))).toBeNull();
  });
});
