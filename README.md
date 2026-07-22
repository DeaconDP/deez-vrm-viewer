# Deez VRM Viewer

A private, local-first VRM 0.x / VRM 1.0 model viewer. Models are processed entirely on your device and are never uploaded.

No analytics, trackers, model uploads, or cloud account.

## Quick start

| Platform | How to run |
| --- | --- |
| **Windows** | Double-click `run.bat` (or the in-repo release exe after first build) |
| **macOS** | Double-click `run.command` |
| **Linux / terminal** | `npm install` then `npm run tauri:dev` |

Requires:

- [Node.js](https://nodejs.org/) 20 or newer
- [Rust toolchain](https://rustup.rs/) (`cargo` / `rustc`) for the native shell
- On Windows: WebView2 (usually already installed)

The app opens in its **own desktop window** (Tauri). On Windows, one-click launch builds and runs the **release** binary (`src-tauri/target/release/deez-vrm-viewer.exe`). Use `npm run tauri:dev` when you want the hot-reload Vite webview on [http://127.0.0.1:5188](http://127.0.0.1:5188).

## One-click Windows start

Double-click **run.bat**, or the in-repo release exe at `src-tauri/target/release/deez-vrm-viewer.exe`. Both use the same update-then-run flow:

1. Quick check for git updates (fetch; fast-forward pull when the tree is clean and behind)
2. Refresh npm deps if `package-lock.json` changed
3. Rebuild the release exe whenever sources (or the binary) no longer match the freshness stamp — never launches a stale build
4. Open the app only after a post-build freshness assert passes

A loading screen appears while this runs; the terminal stays hidden. First run (and runs after source/git/dep changes) may take longer while it compiles. Later runs are usually a quick check, then open. The release exe also re-checks freshness on startup and hands back to the launcher if the stamp is stale.

If Node.js is missing and Windows Package Manager is available, it installs the current Node.js LTS release automatically. If Rust is missing, it opens the rustup installer page. Offline or dirty git trees still launch from local sources (pull is skipped). Setup details are written under `.run/` if something fails.

## Features

- Native desktop window via [Tauri](https://tauri.app/)
- Local drag-and-drop and file picker for `.vrm`, `.glb`, and `.gltf`
- OS file associations and File → Open Model… (Ctrl+O)
- VRM 0.x and 1.0 rendering through `@pixiv/three-vrm`
- Orbit, pan, zoom, camera presets, grid, and turntable
- Scene tree, expressions, metadata, and diagnostics
- All 86 animations from Quaternius' CC0 Universal Animation Library 1 and 2 Standard packs, retargeted to VRM humanoids
- Local `.vrma` import with retargeting, timeline scrubbing, speed, loop, root-motion, pause, stop, and pose-reset controls
- Cancellable local mesh baking for supported `.vrm` files, with clean bind poses and a separate `-baked.vrm` output
- Local PNG screenshots, including transparent 2× capture
- Optional Vite/PWA web build for frontend-only iteration (`npm run dev` / `npm run build`)

## Development

```bash
git clone https://github.com/DeaconDP/deez-vrm-viewer.git
cd deez-vrm-viewer
npm install
npm run tauri:dev   # primary: native window + Vite on http://127.0.0.1:5188
npm run dev         # frontend-only Vite server (no native shell)
npm run build       # production web build to dist/
npm run tauri:build # native installer (NSIS on Windows)
npm test            # vitest unit tests
npm run preview     # serve the production web build locally
```

Stack: [Tauri](https://tauri.app/), [Preact](https://preactjs.com/), [Vite](https://vite.dev/), [Three.js](https://threejs.org/), [@pixiv/three-vrm](https://github.com/pixiv/three-vrm).

## Animation preview workflow

1. Open a VRM 0.x or VRM 1.0 humanoid. Animation retargeting is deliberately disabled for ordinary glTF models because they do not provide the standardized humanoid bone map VRMA requires.
2. Open the **Animation** tab. Choose one of the 86 bundled Quaternius motions, or import a local `.vrma` file. Imported motion data stays on this device.
3. Use the timeline and transport controls to inspect individual poses or play the clip. Playback speed, end behavior, and horizontal root motion are independently controllable.
4. Stop returns to the first frame; the pose-reset button stops playback and restores the humanoid rest pose.

The bundled motions and mannequin models are from Quaternius' [Universal Animation Library 1](https://quaternius.com/packs/universalanimationlibrary.html) and [Universal Animation Library 2](https://quaternius.com/packs/universalanimationlibrary2.html), dedicated to the public domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Please consider [supporting Quaternius on Patreon](https://www.patreon.com/quaternius).

Further reading: [VRM Animation specification](https://github.com/vrm-c/vrm-specification/tree/master/specification/VRMC_vrm_animation-1.0), [three-vrm-animation](https://github.com/pixiv/three-vrm/tree/dev/packages/three-vrm-animation), and [BVH-to-VRMA converter](https://vrm-c.github.io/bvh2vrma/).

## Bake Meshes beta workflow

1. Open a local binary `.vrm`, then select **Bake Meshes (beta)**.
2. **Merge compatible meshes** is enabled by default and can be turned off. It concatenates same-material, non-morph geometry using the same skeleton while keeping different materials, expression-bound, weight-animated, and custom-extension meshes separate.
3. Choose **Bake and download VRM**. A worker checks the file against conservative memory, geometry, morph, and skin limits before changing its in-memory copy. It also reconnects detached armatures when at least three joints uniquely match the canonical humanoid chain (by node name, humanoid bone id, or common aliases), preserving secondary hair and clothing bones. Sparse accessors are expanded only inside that temporary copy.
4. On desktop, a Save dialog writes `<name>-baked.vrm` where you choose; in the browser it downloads to your usual downloads folder. The baked copy is then opened in the viewer for preview. The selected source is read-only and is never overwritten. If a detached clothing or hair skin cannot be matched, the bake result warns instead of silently leaving it unbound. Compressed, malformed, remote, and otherwise unsupported models are refused without producing a partial file.

## Legal

This project is open source under the [MIT License](LICENSE). You may use,
modify, and distribute it freely, provided you retain the copyright and
permission notice. Use is also subject to the [Terms of Use](TERMS.md) and
[Privacy Notice](PRIVACY.md). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
for bundled open-source components and their licences.

The in-app first-run notice records acceptance locally on the user's device.
Changing `LEGAL_VERSION` in `src/main.tsx` will require users to accept the
updated documents again.
