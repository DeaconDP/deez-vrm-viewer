# Deez VRM Viewer

A private, local-first VRM 0.x / VRM 1.0 model viewer. Models are processed entirely in your browser and are never uploaded.

No analytics, trackers, model uploads, or cloud account.

## Quick start

| Platform | How to run |
| --- | --- |
| **Windows** | Double-click `Deez VRM Viewer.bat` |
| **macOS / Linux / dev** | `npm install` then `npm run dev` |

Requires [Node.js](https://nodejs.org/) 20 or newer.

## One-click Windows start

Double-click **Deez VRM Viewer.bat**. On the first run it installs the app's local dependencies, starts the viewer, and opens it in your browser. Later runs start immediately.

The launcher requires Node.js 20 or newer. If Node.js is missing and Windows Package Manager is available, it installs the current Node.js LTS release automatically.

## Features

- Local drag-and-drop and file picker for `.vrm`, `.glb`, and `.gltf`
- VRM 0.x and 1.0 rendering through `@pixiv/three-vrm`
- Orbit, pan, zoom, camera presets, grid, and turntable
- Scene tree, expressions, metadata, and diagnostics
- CC0 built-in animation previews: idle, wave, walk, and bow
- Local `.vrma` import with retargeting, timeline scrubbing, speed, loop, root-motion, pause, stop, and pose-reset controls
- Cancellable local mesh baking for supported `.vrm` files, with clean bind poses and a separate `-baked.vrm` output
- Local PNG screenshots, including transparent 2× capture
- Responsive desktop/mobile UI and installable offline PWA shell

## Development

```bash
git clone https://github.com/DeaconDP/deez-vrm-viewer.git
cd deez-vrm-viewer
npm install
npm run dev      # local dev server at http://127.0.0.1:5173
npm run build    # production build to dist/
npm test         # vitest unit tests
npm run preview  # serve the production build locally
```

Stack: [Preact](https://preactjs.com/), [Vite](https://vite.dev/), [Three.js](https://threejs.org/), [@pixiv/three-vrm](https://github.com/pixiv/three-vrm).

## Animation preview workflow

1. Open a VRM 0.x or VRM 1.0 humanoid. Animation retargeting is deliberately disabled for ordinary glTF models because they do not provide the standardized humanoid bone map VRMA requires.
2. Open the **Animation** tab. Choose one of the bundled CC0 diagnostic motions, or import a local `.vrma` file. Imported motion data stays inside the browser.
3. Use the timeline and transport controls to inspect individual poses or play the clip. Playback speed, end behavior, and horizontal root motion are independently controllable.
4. Stop returns to the first frame; the pose-reset button stops playback and restores the humanoid rest pose.

Further reading: [VRM Animation specification](https://github.com/vrm-c/vrm-specification/tree/master/specification/VRMC_vrm_animation-1.0), [three-vrm-animation](https://github.com/pixiv/three-vrm/tree/dev/packages/three-vrm-animation), [BVH-to-VRMA converter](https://vrm-c.github.io/bvh2vrma/), and the [Quaternius CC0 animation library](https://quaternius.com/packs/universalanimationlibrary2.html).

## Bake Meshes beta workflow

1. Open a local binary `.vrm`, then select **Bake Meshes (beta)**.
2. Optionally enable **Merge compatible meshes**. This concatenates same-material, non-morph geometry sharing a skin while keeping different materials, expression-bound, weight-animated, and custom-extension meshes separate.
3. Choose **Bake and download VRM**. A worker checks the file against conservative memory, geometry, morph, and skin limits before changing its in-memory copy. Sparse accessors are expanded only inside that temporary copy.
4. The result downloads as `<name>-baked.vrm`. The selected source is read-only and is never overwritten. Compressed, malformed, remote, and otherwise unsupported models are refused without producing a partial file.

## Legal

This is proprietary software, licensed rather than sold. Use is subject to the
[Terms of Use](TERMS.md) and [Privacy Notice](PRIVACY.md). See [LICENSE](LICENSE)
for the end-user licence and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
for the open-source components and licences included in the App.

The in-app first-run notice records acceptance locally on the user's device.
Changing `LEGAL_VERSION` in `src/main.tsx` will require users to accept the
updated documents again.
