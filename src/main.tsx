import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  Aperture, BookOpen, Box, Camera, ChevronDown, ChevronRight, CircleHelp, Download, Eye, FileBox,
  FolderOpen, Gauge, Grid3X3, Hammer, Info, Maximize, Menu, PanelLeftClose, PanelRightClose,
  Image, Pause, Play, RefreshCw, Rotate3D, Search, Settings, ShieldCheck, SkipBack, Sparkles, Square, Sun, Undo2, Upload, X
} from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import type { AnimationLoopMode, AnimationState, LoadState, ModelSummary, TreeItem } from './types';
import { BAKE_LIMITS, type BakeStage, type BakeStats, type BakeWorkerResponse } from './bake/types';
import { validateModelFile } from './platform/files';
import { QUATERNIUS_LIBRARIES } from './viewer/quaterniusAnimations';
import termsUrl from '../TERMS.md?url';
import privacyUrl from '../PRIVACY.md?url';
import licenseUrl from '../LICENSE?url';
import noticesUrl from '../THIRD_PARTY_NOTICES.md?url';
import './styles.css';

type Controller = import('./viewer/ViewerController').ViewerController;
type BuiltInAnimationId = import('./viewer/ViewerController').BuiltInAnimationId;
type LegalView = 'about' | 'terms' | 'privacy' | 'licences';

const LEGAL_VERSION = '2026-07-03-v1';
const LEGAL_ACCEPTANCE_KEY = 'deez-vrm-viewer:legal-acceptance';

const hasAcceptedLegal = () => {
  try { return localStorage.getItem(LEGAL_ACCEPTANCE_KEY) === LEGAL_VERSION; }
  catch { return false; }
};

const EMPTY_ANIMATION: AnimationState = { name: '', source: null, duration: 0, time: 0, playing: false, loading: false, error: '' };
type BakeStatus = 'idle' | 'reading' | 'working' | 'complete' | 'error';
interface BakeUiState { status: BakeStatus; stage: BakeStage; progress: number; detail: string; error: string; stats?: BakeStats }
const EMPTY_BAKE: BakeUiState = { status: 'idle', stage: 'preflight', progress: 0, detail: '', error: '' };
interface SceneSettings { key: number; fill: number; rim: number; exposure: number; backgroundMode: 'color' | 'image'; backgroundColor: string; backgroundName: string }
const DEFAULT_SCENE: SceneSettings = { key: 3.4, fill: 2.2, rim: 2.4, exposure: 1.05, backgroundMode: 'color', backgroundColor: '#70777d', backgroundName: '' };

const formatBytes = (bytes: number) => bytes > 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

function IconButton({ label, active, onClick, children, hideMobile = false }: { label: string; active?: boolean; onClick?: () => void; children: ComponentChildren; hideMobile?: boolean }) {
  return <button class={`icon-button ${active ? 'active' : ''} ${hideMobile ? 'hide-mobile' : ''}`} aria-label={label} title={label} onClick={onClick}>{children}</button>;
}

function Accordion({ title, open = false, children }: { title: string; open?: boolean; children: ComponentChildren }) {
  const [expanded, setExpanded] = useState(open);
  return <section class="accordion">
    <button class="accordion-title" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? <ChevronDown /> : <ChevronRight />}<span>{title}</span></button>
    {expanded && <div class="accordion-body">{children}</div>}
  </section>;
}

function EmptyState({ onOpen, onUrl }: { onOpen: () => void; onUrl: () => void }) {
  return <div class="empty-state">
    <div class="drop-glyph"><FileBox /></div>
    <h1>Drop a VRM file here</h1>
    <p>Inspect VRM 0.x, VRM 1.0, GLB, and glTF models.</p>
    <button class="primary" onClick={onOpen}><FolderOpen /> Choose a file</button>
    <button class="text-button" onClick={onUrl}>Open public URL</button>
    <span class="private-note"><Eye /> Files stay on this device</span>
  </div>;
}

function Explorer({ model, filter, setFilter, selected, setSelected }: { model: ModelSummary | null; filter: string; setFilter: (v: string) => void; selected: TreeItem | null; setSelected: (v: TreeItem) => void }) {
  const groups = useMemo(() => {
    if (!model) return [];
    const itemGroups = [
      ['Nodes', model.items.filter(i => i.kind === 'node')], ['Meshes', model.items.filter(i => i.kind === 'mesh')],
      ['Humanoid', model.items.filter(i => i.kind === 'bone')], ['Expressions', model.expressions.map((x, n) => ({ id: `expression-${n}`, label: x, kind: 'system' as const }))],
      ['Materials', model.items.filter(i => i.kind === 'material')]
    ] as [string, TreeItem[]][];
    const query = filter.trim().toLowerCase();
    return itemGroups.map(([name, items]) => [name, query ? items.filter(i => i.label.toLowerCase().includes(query)) : items] as [string, TreeItem[]]);
  }, [model, filter]);
  return <div class="panel-content explorer">
    <div class="panel-heading"><div><span class="eyebrow">MODEL STRUCTURE</span><h2>Scene Explorer</h2></div><button class="more">•••</button></div>
    <label class="search"><Search /><input value={filter} onInput={e => setFilter(e.currentTarget.value)} placeholder="Filter scene" aria-label="Filter scene" /></label>
    <div class="tree" role="tree">
      <div class="tree-root"><ChevronDown /><Box /><span>{model?.name ?? 'Scene'}</span></div>
      {!model && <p class="muted tree-empty">Open a model to inspect its contents.</p>}
      {groups.map(([name, items]) => <details open={name === 'Expressions' || name === 'Meshes'} key={name}>
        <summary><span>{name}</span><b>{items.length}</b></summary>
        {items.slice(0, 250).map(item => <button role="treeitem" class={selected?.id === item.id ? 'selected' : ''} onClick={() => setSelected(item)} key={item.id}>
          <span class={`item-dot ${item.kind}`} /> <span>{item.label}</span>{item.detail && <small>{item.detail}</small>}
        </button>)}
      </details>)}
    </div>
  </div>;
}

function Inspector({ model, selected, expressionValues, onExpression, onReset }: { model: ModelSummary | null; selected: TreeItem | null; expressionValues: Record<string, number>; onExpression: (name: string, value: number) => void; onReset: () => void }) {
  const isExpression = selected?.id.startsWith('expression-');
  return <div class="panel-content inspector">
    <div class="panel-heading"><div><span class="eyebrow">SELECTION</span><h2>Inspector</h2></div><Settings /></div>
    {!model ? <div class="inspector-empty"><Aperture /><p>Nothing selected</p><span>Model properties will appear here.</span></div> : <>
      <div class="selection-card"><span class={`item-dot ${selected?.kind ?? 'system'}`} /><div><b>{selected?.label ?? model.name}</b><small>{selected?.kind ?? `${model.format} root`}</small></div></div>
      {isExpression && selected && <Accordion title="Expression Preview" open>
        <label class="slider-label"><span>Weight</span><output>{Math.round((expressionValues[selected.label] ?? 0) * 100)}%</output></label>
        <input type="range" min="0" max="1" step="0.01" value={expressionValues[selected.label] ?? 0} onInput={e => onExpression(selected.label, Number(e.currentTarget.value))} />
        <button class="secondary wide" onClick={onReset}><Undo2 /> Reset expressions</button>
      </Accordion>}
      <Accordion title="General" open>
        <dl><dt>Type</dt><dd>{selected?.kind ?? model.format}</dd><dt>Name</dt><dd>{selected?.label ?? model.name}</dd>{selected?.detail && <><dt>Detail</dt><dd>{selected.detail}</dd></>}</dl>
      </Accordion>
      <Accordion title="VRM Metadata" open={!selected}>
        <dl><dt>Format</dt><dd>{model.format} {model.version}</dd><dt>Author</dt><dd>{model.authors.join(', ') || 'Not specified'}</dd><dt>Generator</dt><dd>{model.generator}</dd><dt>Licence</dt><dd class="wrap">{model.license}</dd></dl>
      </Accordion>
      <Accordion title="Diagnostics">
        <dl><dt>File size</dt><dd>{formatBytes(model.size)}</dd><dt>Load time</dt><dd>{model.loadMs.toFixed(0)} ms</dd><dt>Nodes</dt><dd>{model.nodes}</dd><dt>Meshes</dt><dd>{model.meshes}</dd><dt>Triangles</dt><dd>{model.triangles.toLocaleString()}</dd><dt>Materials</dt><dd>{model.materials}</dd><dt>Textures</dt><dd>{model.textures}</dd><dt>Bones</dt><dd>{model.bones}</dd></dl>
      </Accordion>
    </>}
  </div>;
}

function ScenePanel({ settings, error, onChange, onFile, onUrl, onReset }: { settings: SceneSettings; error: string; onChange: (patch: Partial<SceneSettings>) => void; onFile: () => void; onUrl: (url: string) => void; onReset: () => void }) {
  const [url, setUrl] = useState('');
  const slider = (label: string, key: 'key' | 'fill' | 'rim', hint: string) => <label class="scene-slider"><span><b>{label}</b><small>{hint}</small></span><output>{settings[key].toFixed(1)}</output><input type="range" min="0" max="8" step="0.1" value={settings[key]} onInput={e => onChange({ [key]: Number(e.currentTarget.value) })} /></label>;
  return <div class="panel-content scene-panel">
    <div class="panel-heading"><div><span class="eyebrow">LOOK DEV</span><h2>Scene</h2></div><Sun /></div>
    <Accordion title="Studio lighting" open>
      {slider('Key light', 'key', 'Main light from the front-right')}
      {slider('Fill light', 'fill', 'Softens shadows from above')}
      {slider('Rim light', 'rim', 'Separates the silhouette behind')}
      <label class="scene-slider"><span><b>Exposure</b><small>Overall rendered brightness</small></span><output>{settings.exposure.toFixed(2)}</output><input type="range" min="0.25" max="2.5" step="0.05" value={settings.exposure} onInput={e => onChange({ exposure: Number(e.currentTarget.value) })} /></label>
    </Accordion>
    <Accordion title="Background" open>
      <div class="background-modes"><button class={settings.backgroundMode === 'color' ? 'selected' : ''} onClick={() => onChange({ backgroundMode: 'color' })}><span class="color-swatch" style={{ background: settings.backgroundColor }} />Solid color</button><button class={settings.backgroundMode === 'image' ? 'selected' : ''} onClick={onFile}><Image />Image file</button></div>
      <label class="color-row"><span>Background color</span><input type="color" value={settings.backgroundColor} onChange={e => onChange({ backgroundColor: e.currentTarget.value, backgroundMode: 'color' })} /></label>
      <form class="background-url" onSubmit={e => { e.preventDefault(); onUrl(url); }}><label>Image URL</label><div><input type="url" value={url} onInput={e => setUrl(e.currentTarget.value)} placeholder="https://example.com/background.jpg" required /><button class="secondary">Apply</button></div></form>
      {settings.backgroundMode === 'image' && settings.backgroundName && <p class="background-current"><Image />{settings.backgroundName}</p>}
      {error && <p class="inline-error">{error}</p>}
      <p class="process-note"><Eye /> Local images stay on this device. Remote servers must allow CORS.</p>
    </Accordion>
    <div class="scene-reset"><button class="secondary wide" onClick={onReset}><Undo2 /> Reset scene</button></div>
  </div>;
}

function AnimationPanel({ model, animation, speed, loop, inPlace, onPreset, onImport, onPlayPause, onStop, onSeek, onSpeed, onLoop, onInPlace, onResetPose }: {
  model: ModelSummary | null; animation: AnimationState; speed: number; loop: AnimationLoopMode; inPlace: boolean;
  onPreset: (id: BuiltInAnimationId) => void; onImport: () => void; onPlayPause: () => void; onStop: () => void;
  onSeek: (time: number) => void; onSpeed: (speed: number) => void; onLoop: (mode: AnimationLoopMode) => void;
  onInPlace: (value: boolean) => void; onResetPose: () => void;
}) {
  const compatible = model?.format === 'VRM';
  const formatTime = (time: number) => `${Math.floor(time / 60)}:${(time % 60).toFixed(1).padStart(4, '0')}`;
  const formatMotionName = (name: string) => name.replace(/^ual[12]:/, '').replaceAll('_', ' ').replace(/\bRec\b/g, '(recovery)').replace(/\bLoop\b/g, 'loop');
  const animationLibrary = animation.name.startsWith('ual1:') ? 'Quaternius UAL1' : 'Quaternius UAL2';
  return <div class="panel-content animation-panel">
    <div class="panel-heading"><div><span class="eyebrow">MOTION LAB</span><h2>Animation Preview</h2></div><Play /></div>
    <div class={`compatibility ${compatible ? 'ok' : ''}`}><span class="status-dot" /><div><b>{compatible ? 'VRM humanoid ready' : model ? 'Retargeting unavailable' : 'Open a VRM model first'}</b><small>{compatible ? 'Motions will be mapped through standard humanoid bones.' : 'VRMA previews need a VRM 0.x or 1.0 humanoid.'}</small></div></div>

    <div class="process-block">
      <span class="process-number">1</span><div class="process-copy"><b>Choose the motion</b><p>Pick from 86 animations across the bundled Universal Animation Library 1 and 2 Standard packs.</p></div>
      <label class="motion-picker"><span>Quaternius animation</span><select disabled={!compatible || animation.loading} value={animation.source === 'built-in' ? animation.name : ''} onChange={e => e.currentTarget.value && onPreset(e.currentTarget.value as BuiltInAnimationId)}><option value="">Select a motion…</option>{QUATERNIUS_LIBRARIES.map(library => <optgroup label={library.label} key={library.id}>{library.animations.map(name => <option value={`${library.id}:${name}`} key={`${library.id}:${name}`}>{formatMotionName(name)}</option>)}</optgroup>)}</select></label>
      <div class="creator-credit"><b>Animations and models by <a href="https://quaternius.com/" target="_blank" rel="noreferrer">@Quaternius</a></b><span><a href="https://quaternius.com/packs/universalanimationlibrary.html" target="_blank" rel="noreferrer">UAL 1</a> + <a href="https://quaternius.com/packs/universalanimationlibrary2.html" target="_blank" rel="noreferrer">UAL 2</a> · <a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noreferrer">CC0 1.0</a> · <a href="https://www.patreon.com/quaternius" target="_blank" rel="noreferrer">Support on Patreon</a></span></div>
      <button class="secondary wide" disabled={!compatible || animation.loading} onClick={onImport}><Upload />{animation.loading ? 'Reading animation…' : 'Import your own .vrma'}</button>
      <p class="process-note"><Eye /> Imported animations stay in this browser and are never uploaded.</p>
      {animation.error && <p class="inline-error">{animation.error}</p>}
    </div>

    <div class="process-block">
      <span class="process-number">2</span><div class="process-copy"><b>Control playback</b><p>Scrub to inspect a pose, then choose exactly how the clip should run.</p></div>
      <div class="now-playing"><span>Now loaded</span><b>{animation.name ? formatMotionName(animation.name) : 'No animation selected'}</b><small>{animation.source === 'file' ? 'Local VRMA file' : animation.source === 'built-in' ? `${animationLibrary} · CC0 1.0` : 'Choose a motion above'}</small></div>
      <label class="timeline"><input type="range" min="0" max={animation.duration || 1} step="0.01" value={animation.time} disabled={!animation.duration} onInput={e => onSeek(Number(e.currentTarget.value))} /><span>{formatTime(animation.time)} / {formatTime(animation.duration)}</span></label>
      <div class="transport">
        <button class="secondary" disabled={!animation.duration} onClick={() => onStop()} title="Stop and return to the first frame"><Square /> Stop</button>
        <button class="primary" disabled={!animation.duration} onClick={onPlayPause}>{animation.playing ? <Pause /> : <Play />}{animation.playing ? 'Pause' : 'Play'}</button>
        <button class="secondary icon-only" disabled={!animation.duration} onClick={onResetPose} title="Reset the humanoid to its rest pose"><SkipBack /></button>
      </div>
      <label class="control-row"><span>Playback speed <small>0.1×–2×</small></span><output>{speed.toFixed(1)}×</output><input type="range" min="0.1" max="2" step="0.1" value={speed} onInput={e => onSpeed(Number(e.currentTarget.value))} /></label>
      <label class="select-row"><span>After the last frame</span><select value={loop} onChange={e => onLoop(e.currentTarget.value as AnimationLoopMode)}><option value="repeat">Repeat</option><option value="once">Stop on last frame</option><option value="pingpong">Play forward and backward</option></select></label>
      <label class="check-row"><input type="checkbox" checked={inPlace} onChange={e => onInPlace(e.currentTarget.checked)} /><span><b>Keep model in place</b><small>Suppress horizontal hip movement so locomotion clips do not leave the camera.</small></span></label>
    </div>

    <div class="process-block learning-block">
      <span class="process-number">3</span><div class="process-copy"><b>Understand the pipeline</b><p>A VRMA stores motion against standard humanoid bone names. The viewer retargets those tracks to the normalized skeleton inside the open VRM, then Three.js evaluates them frame by frame before VRM spring bones update.</p></div>
      <a href="https://github.com/vrm-c/vrm-specification/tree/master/specification/VRMC_vrm_animation-1.0" target="_blank" rel="noreferrer"><BookOpen /> VRM Animation specification</a>
      <a href="https://github.com/pixiv/three-vrm/tree/dev/packages/three-vrm-animation" target="_blank" rel="noreferrer"><BookOpen /> Three-VRM animation implementation</a>
      <a href="https://vrm-c.github.io/bvh2vrma/" target="_blank" rel="noreferrer"><BookOpen /> Convert BVH motion to VRMA</a>
      <a href="https://quaternius.com/packs/universalanimationlibrary2.html" target="_blank" rel="noreferrer"><BookOpen /> Quaternius CC0 motion library</a>
      <a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noreferrer"><Info /> What the CC0 licence permits</a>
    </div>
  </div>;
}

function BakePanel({ model, source, bake, mergeMeshes, onMergeMeshes, onBake, onCancel }: { model: ModelSummary | null; source: File | null; bake: BakeUiState; mergeMeshes: boolean; onMergeMeshes: (value: boolean) => void; onBake: () => void; onCancel: () => void }) {
  const eligible = model?.format === 'VRM' && !!source && /\.vrm$/i.test(source.name);
  const busy = bake.status === 'reading' || bake.status === 'working';
  return <div class="panel-content bake-panel">
    <div class="panel-heading"><div><span class="eyebrow">REPAIR LAB</span><h2>Bake Meshes</h2></div><Hammer /></div>
    <div class={`compatibility ${eligible ? 'ok' : ''}`}><span class="status-dot" /><div><b>{eligible ? 'Local VRM ready' : model ? 'This source is view-only' : 'Open a local VRM first'}</b><small>{eligible ? 'The source file is read-only and will never be overwritten.' : 'Beta baking requires a binary .vrm chosen from this device.'}</small></div></div>

    <div class="process-block">
      <span class="process-number">1</span><div class="process-copy"><b>What this repairs</b><p>The rest shape and bind poses are rebuilt. Duplicate hair or clothing armatures are conservatively reconnected when they contain a matching humanoid bone chain.</p></div>
      <div class="bake-note"><Info /><span><b>{mergeMeshes ? 'Compatible meshes will be merged.' : 'Meshes will stay separate.'}</b> Materials, expressions, textures, the humanoid rig, spring bones, and VRM metadata are preserved.</span></div>
      <label class="check-row bake-merge"><input type="checkbox" checked={mergeMeshes} disabled={busy} onChange={e => onMergeMeshes(e.currentTarget.checked)} /><span><b>Merge compatible meshes</b><small>Joins same-material geometry using the same skeleton. Different materials plus expression, morph, animated, or custom-extension meshes remain separate.</small></span></label>
    </div>

    <div class="process-block">
      <span class="process-number">2</span><div class="process-copy"><b>Safety preflight</b><p>Sparse attributes are expanded inside the temporary worker copy; unsupported layouts are refused before output. Work runs away from the viewer so the interface remains responsive.</p></div>
      <dl class="limit-grid">
        <dt>Source</dt><dd>{source ? source.name : 'No local file'}</dd>
        <dt>File size</dt><dd>{source ? formatBytes(source.size) : '—'} / 128 MiB</dd>
        <dt>Vertices</dt><dd>Maximum {BAKE_LIMITS.maxSkinnedVertices.toLocaleString()}</dd>
        <dt>Morph records</dt><dd>Maximum {BAKE_LIMITS.maxMorphVertexRecords.toLocaleString()}</dd>
        <dt>Joints per skin</dt><dd>Maximum {BAKE_LIMITS.maxJointsPerSkin}</dd>
      </dl>
    </div>

    <div class="process-block">
      <span class="process-number">3</span><div class="process-copy"><b>Bake a new copy</b><p>The result downloads as <code>{source ? source.name.replace(/\.vrm$/i, '') + '-baked.vrm' : 'avatar-baked.vrm'}</code>. The open source remains your untouched original.</p></div>
      {busy && <div class="bake-progress" role="status"><div><span>{bake.stage.replace('-', ' ')}</span><output>{Math.round(bake.progress * 100)}%</output></div><div class="progress"><i style={{ width: `${Math.max(4, bake.progress * 100)}%` }} /></div><small>{bake.detail}</small></div>}
      {bake.stats && <div class="bake-result"><ShieldCheck /><span><b>{bake.status === 'complete' ? 'Baked copy downloaded' : 'Preflight complete'}</b><small>{bake.stats.meshes} source meshes · {bake.stats.vertices.toLocaleString()} vertices{bake.stats.reconnectedSkins ? ` · ${bake.stats.reconnectedSkins} detached skins reconnected` : ''}{bake.stats.mergedMeshes !== undefined ? ` · ${bake.stats.mergedMeshes} nodes + ${bake.stats.mergedPrimitives ?? 0} render meshes joined` : ''}</small></span></div>}
      {bake.error && <p class="inline-error">{bake.error}</p>}
      {busy ? <button class="secondary wide" onClick={onCancel}><X /> Cancel baking</button> : <button class="primary wide" disabled={!eligible} onClick={onBake}><Download /> Bake and download VRM</button>}
      <p class="process-note"><Eye /> Processing and download creation stay entirely on this device.</p>
    </div>
  </div>;
}

function LegalDialog({ view, setView, mustAccept, onAccept, onClose }: { view: LegalView; setView: (view: LegalView) => void; mustAccept: boolean; onAccept: () => void; onClose: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const documents = { terms: termsUrl, privacy: privacyUrl, licences: noticesUrl };
  const copy = {
    about: <><h2>About Deez VRM Viewer</h2><p>A proprietary, local-first viewer by Dale Deacon, trading as Worldbuild.io and deac.online.</p><div class="legal-callout"><b>Your files stay local by default.</b><span>Files selected from your device are rendered in your browser. Opening a public URL contacts that third-party server directly.</span></div><p>Version 1.0.0 · Legal terms version 1.0, effective 3 July 2026.</p></>,
    terms: <><h2>Terms of Use</h2><p><b>Important:</b> the Terms allocate risk, disclaim warranties, limit liability, and include an indemnity, subject always to rights that applicable law does not allow us to exclude.</p><p>You are responsible for the models and URLs you open, all required creator and personality permissions, embedded VRM licence terms, and any screenshots or other outputs you use or publish.</p><p>The App is provided “as is”. Large, malformed, or hostile 3D files can consume device resources or cause instability. Keep backups and use trusted sources.</p></>,
    privacy: <><h2>Privacy Notice</h2><p>The App has no Provider-operated accounts, analytics, advertising, telemetry, trackers, or cloud upload. Local files are processed transiently in your browser.</p><p>Your legal acceptance and PWA cache are stored on this device. A remote model host, site host, browser, operating system, network, or distributor may process technical data independently.</p></>,
    licences: <><h2>Licensing</h2><p>The original App is proprietary and licensed, not sold. All rights are reserved. Third-party open-source components keep their respective MIT or ISC licences.</p><p>Nothing in the App grants rights to a model, avatar, texture, likeness, brand, or other user-supplied content.</p></>
  };
  return <div class="modal-backdrop legal-backdrop" onClick={() => !mustAccept && onClose()}>
    <section class="dialog legal-dialog" role="dialog" aria-modal="true" aria-labelledby="legal-title" onClick={e => e.stopPropagation()}>
      <div class="dialog-head"><div><span class="eyebrow">LEGAL &amp; LICENSING</span><h1 id="legal-title">{mustAccept ? 'Before you continue' : 'App information'}</h1></div>{!mustAccept && <button onClick={onClose} aria-label="Close legal information"><X /></button>}</div>
      <nav class="legal-tabs" aria-label="Legal documents">{(['about', 'terms', 'privacy', 'licences'] as LegalView[]).map(item => <button class={view === item ? 'active' : ''} onClick={() => setView(item)}>{item === 'licences' ? 'Licences' : item[0].toUpperCase() + item.slice(1)}</button>)}</nav>
      <div class="legal-copy">{copy[view]}{view !== 'about' && <a class="document-link" href={documents[view]} target="_blank" rel="noreferrer">Read the full {view === 'licences' ? 'third-party notices' : view} ↗</a>}{view === 'licences' && <a class="document-link secondary-document" href={licenseUrl} target="_blank" rel="noreferrer">Read the proprietary software licence ↗</a>}</div>
      {mustAccept && <div class="legal-accept"><label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.currentTarget.checked)} /><span>I have read and agree to the <a href={termsUrl} target="_blank" rel="noreferrer">Terms of Use</a> and acknowledge the <a href={privacyUrl} target="_blank" rel="noreferrer">Privacy Notice</a>.</span></label><button class="primary" disabled={!confirmed} onClick={onAccept}>Agree and continue</button><small>If you do not agree, do not use the App.</small></div>}
    </section>
  </div>;
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null), fileInput = useRef<HTMLInputElement>(null), animationInput = useRef<HTMLInputElement>(null), backgroundInput = useRef<HTMLInputElement>(null), controller = useRef<Controller | null>(null), objectUrl = useRef(''), animationUrl = useRef(''), backgroundUrl = useRef('');
  const bakeWorker = useRef<Worker | null>(null), bakeGeneration = useRef(0);
  const [state, setState] = useState<LoadState>('idle'), [progress, setProgress] = useState(0), [error, setError] = useState('');
  const [model, setModel] = useState<ModelSummary | null>(null), [fileName, setFileName] = useState('No model open');
  const [leftOpen, setLeftOpen] = useState(true), [rightOpen, setRightOpen] = useState(true), [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<TreeItem | null>(null), [grid, setGrid] = useState(false), [turntable, setTurntable] = useState(false);
  const [expressionValues, setExpressionValues] = useState<Record<string, number>>({}), [urlOpen, setUrlOpen] = useState(false), [captureOpen, setCaptureOpen] = useState(false);
  const [rightTab, setRightTab] = useState<'inspector' | 'scene' | 'animation' | 'bake'>('inspector'), [animation, setAnimation] = useState<AnimationState>(EMPTY_ANIMATION);
  const [sceneSettings, setSceneSettings] = useState<SceneSettings>(DEFAULT_SCENE), [sceneError, setSceneError] = useState('');
  const [sourceFile, setSourceFile] = useState<File | null>(null), [bake, setBake] = useState<BakeUiState>(EMPTY_BAKE);
  const [mergeMeshes, setMergeMeshes] = useState(true);
  const [animationSpeed, setAnimationSpeed] = useState(1), [animationLoop, setAnimationLoop] = useState<AnimationLoopMode>('repeat'), [inPlace, setInPlace] = useState(true);
  const [legalAccepted, setLegalAccepted] = useState(hasAcceptedLegal), [legalView, setLegalView] = useState<LegalView>('about'), [legalOpen, setLegalOpen] = useState(false);

  useEffect(() => {
    let live = true;
    import('./viewer/ViewerController').then(({ ViewerController }) => { if (live && canvasRef.current) { controller.current = new ViewerController(canvasRef.current); controller.current.setAnimationListener(setAnimation); controller.current.setLighting(sceneSettings.key, sceneSettings.fill, sceneSettings.rim, sceneSettings.exposure); controller.current.setBackgroundColor(sceneSettings.backgroundColor); } });
    return () => { live = false; bakeWorker.current?.terminate(); controller.current?.dispose(); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); if (animationUrl.current) URL.revokeObjectURL(animationUrl.current); if (backgroundUrl.current) URL.revokeObjectURL(backgroundUrl.current); };
  }, []);

  const cancelBake = (showCancelled = true) => {
    bakeGeneration.current++;
    bakeWorker.current?.terminate(); bakeWorker.current = null;
    setBake(showCancelled ? { ...EMPTY_BAKE, detail: 'Baking cancelled.' } : EMPTY_BAKE);
  };

  const loadUrl = async (url: string, name: string, size = 0) => {
    if (!controller.current) return;
    setState('parsing'); setProgress(0); setError(''); setSelected(null); setFileName(name);
    try { const result = await controller.current.load(url, name, size, setProgress); setModel(result); setState('ready'); setSelected(null); return true; }
    catch (reason) { console.error(reason); setError(reason instanceof Error ? reason.message : String(reason)); setState('error'); setModel(null); return false; }
  };
  const openFile = async (file: File) => {
    cancelBake(false); setSourceFile(null);
    const validationError = await validateModelFile(file);
    if (validationError) { setError(validationError); setState('error'); return; }
    if (file.size > 250 * 1024 * 1024 && !confirm(`${file.name} is larger than 250 MB and may exhaust graphics memory. Open it anyway?`)) return;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = URL.createObjectURL(file);
    if (await loadUrl(objectUrl.current, file.name, file.size)) setSourceFile(file);
  };
  const onDrop = (event: DragEvent) => { event.preventDefault(); const file = event.dataTransfer?.files[0]; if (file) void openFile(file); };
  const expression = (name: string, value: number) => { setExpressionValues(old => ({ ...old, [name]: value })); controller.current?.setExpression(name, value); };
  const resetExpressions = () => { setExpressionValues({}); controller.current?.resetExpressions(); };
  const screenshot = (transparent: boolean, scale: number) => { const anchor = document.createElement('a'); anchor.download = `${model?.name ?? 'deez-vrm'}-${Date.now()}.png`; anchor.href = controller.current?.capture(transparent, scale) ?? ''; anchor.click(); setCaptureOpen(false); };
  const choosePreset = (id: BuiltInAnimationId) => { void controller.current?.loadBuiltInAnimation(id).catch(reason => setAnimation(old => ({ ...old, error: reason instanceof Error ? reason.message : String(reason) }))); };
  const openAnimation = async (file: File) => {
    if (!/\.vrma$/i.test(file.name)) { setAnimation(old => ({ ...old, error: 'Choose a .vrma file. GLB and FBX motions must be converted to VRMA first.' })); return; }
    if (file.size > 50 * 1024 * 1024 && !confirm(`${file.name} is larger than 50 MB. Open it anyway?`)) return;
    if (animationUrl.current) URL.revokeObjectURL(animationUrl.current);
    animationUrl.current = URL.createObjectURL(file);
    try { await controller.current?.loadVRMA(animationUrl.current, file.name); }
    catch (reason) { console.error(reason); }
  };
  const playPause = () => { try { animation.playing ? controller.current?.pauseAnimation() : controller.current?.playAnimation(); } catch (reason) { setAnimation(old => ({ ...old, error: reason instanceof Error ? reason.message : String(reason) })); } };
  const changeSpeed = (value: number) => { setAnimationSpeed(value); controller.current?.setAnimationSpeed(value); };
  const changeLoop = (value: AnimationLoopMode) => { setAnimationLoop(value); controller.current?.setAnimationLoop(value); };
  const changeInPlace = (value: boolean) => { setInPlace(value); controller.current?.setAnimationInPlace(value); };
  const changeScene = (patch: Partial<SceneSettings>) => {
    setSceneError('');
    setSceneSettings(old => {
      const next = { ...old, ...patch };
      controller.current?.setLighting(next.key, next.fill, next.rim, next.exposure);
      if (next.backgroundMode === 'color') controller.current?.setBackgroundColor(next.backgroundColor);
      return next;
    });
  };
  const applyBackgroundImage = async (url: string, name: string) => {
    setSceneError('');
    try { await controller.current?.setBackgroundImage(url); setSceneSettings(old => ({ ...old, backgroundMode: 'image', backgroundName: name })); }
    catch { setSceneError('The image could not be loaded. Check the address, file type, and CORS permissions.'); }
  };
  const openBackground = (file: File) => {
    if (!file.type.startsWith('image/')) { setSceneError('Choose a PNG, JPEG, WebP, GIF, AVIF, or other browser-supported image.'); return; }
    if (backgroundUrl.current) URL.revokeObjectURL(backgroundUrl.current);
    backgroundUrl.current = URL.createObjectURL(file); void applyBackgroundImage(backgroundUrl.current, file.name);
  };
  const openBackgroundUrl = (value: string) => {
    try { const parsed = new URL(value); if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error(); void applyBackgroundImage(parsed.href, parsed.hostname); }
    catch { setSceneError('Enter a valid HTTP or HTTPS image URL.'); }
  };
  const resetScene = () => { setSceneSettings(DEFAULT_SCENE); setSceneError(''); controller.current?.setLighting(DEFAULT_SCENE.key, DEFAULT_SCENE.fill, DEFAULT_SCENE.rim, DEFAULT_SCENE.exposure); controller.current?.setBackgroundColor(DEFAULT_SCENE.backgroundColor); };
  const submitUrl = (event: SubmitEvent) => { event.preventDefault(); const input = new FormData(event.currentTarget as HTMLFormElement).get('url')?.toString() ?? ''; try { const parsed = new URL(input); if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') throw new Error(); cancelBake(false); setSourceFile(null); void loadUrl(parsed.href, parsed.pathname.split('/').pop() || 'Remote model'); setUrlOpen(false); } catch { setError('Enter a valid HTTPS model URL.'); setState('error'); } };
  const acceptLegal = () => { try { localStorage.setItem(LEGAL_ACCEPTANCE_KEY, LEGAL_VERSION); } catch { /* Acceptance remains valid for this session. */ } setLegalAccepted(true); };
  const showLegal = (view: LegalView) => { setLegalView(view); setLegalOpen(true); };

  const startBake = async () => {
    if (!sourceFile || model?.format !== 'VRM' || !/\.vrm$/i.test(sourceFile.name)) return;
    cancelBake(false);
    if (sourceFile.size > BAKE_LIMITS.maxInputBytes) { setBake({ ...EMPTY_BAKE, status: 'error', error: 'This VRM exceeds the 128 MiB beta baking limit.' }); return; }
    const generation = ++bakeGeneration.current;
    setBake({ ...EMPTY_BAKE, status: 'reading', detail: 'Reading the untouched source file…', progress: 0.01 });
    try {
      const buffer = await sourceFile.arrayBuffer();
      if (generation !== bakeGeneration.current) return;
      const worker = new Worker(new URL('./bake/bake.worker.ts', import.meta.url), { type: 'module' });
      bakeWorker.current = worker;
      worker.onmessage = (event: MessageEvent<BakeWorkerResponse>) => {
        if (generation !== bakeGeneration.current) return;
        const message = event.data;
        if (message.type === 'progress') setBake(old => ({ ...old, status: 'working', stage: message.stage, progress: message.progress, detail: message.detail, stats: message.stats ?? old.stats, error: '' }));
        else if (message.type === 'complete') {
          worker.terminate(); bakeWorker.current = null;
          const url = URL.createObjectURL(new Blob([message.buffer], { type: 'model/gltf-binary' }));
          const anchor = document.createElement('a'); anchor.href = url; anchor.download = message.fileName; anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 30_000);
          setBake({ status: 'complete', stage: 'download', progress: 1, detail: 'The baked copy was sent to your downloads.', error: '', stats: message.stats });
        } else if (message.type === 'error') {
          worker.terminate(); bakeWorker.current = null;
          setBake(old => ({ ...old, status: 'error', error: message.message, detail: '' }));
        } else if (message.type === 'cancelled') cancelBake(true);
      };
      worker.onerror = event => {
        if (generation !== bakeGeneration.current) return;
        worker.terminate(); bakeWorker.current = null;
        setBake(old => ({ ...old, status: 'error', error: event.message || 'The baking worker stopped unexpectedly.', detail: '' }));
      };
      setBake({ ...EMPTY_BAKE, status: 'working', detail: 'Starting safety preflight…', progress: 0.02 });
      worker.postMessage({ type: 'start', buffer, fileName: sourceFile.name, options: { mergeCompatibleMeshes: mergeMeshes } }, [buffer]);
    } catch (reason) {
      if (generation !== bakeGeneration.current) return;
      setBake({ ...EMPTY_BAKE, status: 'error', error: reason instanceof Error ? reason.message : String(reason) });
    }
  };

  useEffect(() => { const keys = (e: KeyboardEvent) => { if ((e.target as HTMLElement).matches('input,textarea')) return; if (e.key.toLowerCase() === 'g') setGrid(controller.current?.toggleGrid() ?? false); if (e.key === 'Home' || e.key.toLowerCase() === 'f') controller.current?.frameAll(); if (e.key === 'Escape') { setUrlOpen(false); setCaptureOpen(false); } }; addEventListener('keydown', keys); return () => removeEventListener('keydown', keys); }, []);

  return <main class={`app ${!leftOpen ? 'left-closed' : ''} ${!rightOpen ? 'right-closed' : ''}`} onDragOver={e => e.preventDefault()} onDrop={onDrop}>
    <header class="toolbar">
      <div class="brand"><img src="/icon-192.png" /><div><b>Deez VRM Viewer</b><span>{fileName}</span></div></div>
      <div class="toolbar-actions primary-actions">
        <IconButton label="Open model" onClick={() => fileInput.current?.click()}><FolderOpen /></IconButton>
        <IconButton label="Open public URL" onClick={() => setUrlOpen(true)} hideMobile><Upload /></IconButton>
        <IconButton label="Reload model" hideMobile><RefreshCw /></IconButton>
        <span class="toolbar-divider" />
        <IconButton label="Frame model" onClick={() => controller.current?.frameAll()}><Maximize /></IconButton>
        {(['front', 'back', 'left', 'right'] as const).map(view => <button class="view-button hide-mobile" onClick={() => controller.current?.setView(view)} title={`${view} view`}>{view[0].toUpperCase()}</button>)}
        <IconButton label="Turntable" active={turntable} onClick={() => setTurntable(controller.current?.toggleTurntable() ?? false)} hideMobile>{turntable ? <Square /> : <Play />}</IconButton>
        <IconButton label="Grid" active={grid} onClick={() => setGrid(controller.current?.toggleGrid() ?? false)} hideMobile><Grid3X3 /></IconButton>
        <IconButton label="Screenshot" onClick={() => setCaptureOpen(true)}><Camera /></IconButton>
      </div>
      <div class="toolbar-actions utility-actions"><IconButton label="Scene appearance" active={rightTab === 'scene'} onClick={() => { setRightTab('scene'); setRightOpen(true); }}><Sparkles /></IconButton><IconButton label="Animation preview" active={rightTab === 'animation'} onClick={() => { setRightTab('animation'); setRightOpen(true); }}><Play /></IconButton><IconButton label="Bake meshes" active={rightTab === 'bake'} onClick={() => { setRightTab('bake'); setRightOpen(true); }}><Hammer /></IconButton><IconButton label="About and legal" onClick={() => showLegal('about')} hideMobile><CircleHelp /></IconButton><IconButton label="Legal menu" onClick={() => showLegal('terms')}><Menu /></IconButton></div>
      <input ref={fileInput} hidden type="file" accept=".vrm,.glb,.gltf,model/gltf-binary,model/gltf+json" onChange={e => e.currentTarget.files?.[0] && void openFile(e.currentTarget.files[0])} />
      <input ref={animationInput} hidden type="file" accept=".vrma" onChange={e => { const file = e.currentTarget.files?.[0]; if (file) void openAnimation(file); e.currentTarget.value = ''; }} />
      <input ref={backgroundInput} hidden type="file" accept="image/*" onChange={e => { const file = e.currentTarget.files?.[0]; if (file) openBackground(file); e.currentTarget.value = ''; }} />
    </header>
    <aside class="left-panel"><Explorer model={model} filter={filter} setFilter={setFilter} selected={selected} setSelected={setSelected} /></aside>
    <section class="viewport">
      <canvas ref={canvasRef} aria-label={model ? `3D view of ${model.name}` : 'Empty 3D model viewport'} />
      {state === 'idle' && <EmptyState onOpen={() => fileInput.current?.click()} onUrl={() => setUrlOpen(true)} />}
      {state === 'parsing' && <div class="loading"><div class="spinner" /><b>Opening {fileName}</b><span>{progress ? `${Math.round(progress * 100)}%` : 'Reading model…'}</span><div class="progress"><i style={{ width: `${Math.max(8, progress * 100)}%` }} /></div></div>}
      {state === 'error' && <div class="error-card"><X /><div><b>This model could not be opened.</b><p>{error}</p><button class="secondary" onClick={() => fileInput.current?.click()}>Choose another file</button></div></div>}
      <button class="panel-toggle left-toggle" onClick={() => setLeftOpen(!leftOpen)} aria-label="Toggle scene explorer"><PanelLeftClose /></button>
      <button class="panel-toggle right-toggle" onClick={() => setRightOpen(!rightOpen)} aria-label="Toggle inspector"><PanelRightClose /></button>
      {model && <div class="viewport-badge"><span class="status-dot" />{model.format} {model.version}</div>}
    </section>
    <aside class="right-panel"><div class="panel-tabs"><button class={rightTab === 'inspector' ? 'active' : ''} onClick={() => setRightTab('inspector')}>Inspector</button><button class={rightTab === 'scene' ? 'active' : ''} onClick={() => setRightTab('scene')}>Scene</button><button class={rightTab === 'animation' ? 'active' : ''} onClick={() => setRightTab('animation')}>Animation <small>(beta)</small></button><button class={rightTab === 'bake' ? 'active' : ''} onClick={() => setRightTab('bake')}>Bake <small>(beta)</small></button></div>{rightTab === 'inspector' ? <Inspector model={model} selected={selected} expressionValues={expressionValues} onExpression={expression} onReset={resetExpressions} /> : rightTab === 'scene' ? <ScenePanel settings={sceneSettings} error={sceneError} onChange={changeScene} onFile={() => backgroundInput.current?.click()} onUrl={openBackgroundUrl} onReset={resetScene} /> : rightTab === 'animation' ? <AnimationPanel model={model} animation={animation} speed={animationSpeed} loop={animationLoop} inPlace={inPlace} onPreset={choosePreset} onImport={() => animationInput.current?.click()} onPlayPause={playPause} onStop={() => controller.current?.stopAnimation()} onSeek={time => controller.current?.seekAnimation(time)} onSpeed={changeSpeed} onLoop={changeLoop} onInPlace={changeInPlace} onResetPose={() => controller.current?.stopAnimation(true)} /> : <BakePanel model={model} source={sourceFile} bake={bake} mergeMeshes={mergeMeshes} onMergeMeshes={setMergeMeshes} onBake={() => void startBake()} onCancel={() => cancelBake(true)} />}</aside>
    <footer class="statusbar">
      <span class="status-summary"><span class={`status-dot ${state}`} />{state === 'ready' ? 'Ready' : state === 'idle' ? 'Waiting for model' : state}</span>
      <span class="footer-credit"><button onClick={() => showLegal('terms')}>Terms</button><i>·</i><button onClick={() => showLegal('privacy')}>Privacy</button><i>·</i><button onClick={() => showLegal('licences')}>Licences</button><i>·</i><a href="https://quaternius.com/packs/universalanimationlibrary2.html" target="_blank" rel="noreferrer">Animations by Quaternius</a><i>·</i><span>built for <a href="https://vrm.dev/" target="_blank" rel="noreferrer">VRM</a> by <a href="https://deac.online/" target="_blank" rel="noreferrer">deac.online</a> at <a href="https://worldbuild.io/" target="_blank" rel="noreferrer">worldbuild.io</a> with codex</span></span>
      <div class="model-summary">{model && <><span>{model.meshes} meshes</span><span>{model.triangles.toLocaleString()} tris</span><span>{formatBytes(model.size)}</span></>}<span class="fps"><Gauge /> 60 FPS</span></div>
    </footer>
    {urlOpen && <div class="modal-backdrop" onClick={() => setUrlOpen(false)}><form class="dialog" onSubmit={submitUrl} onClick={e => e.stopPropagation()}><div class="dialog-head"><h2>Open public URL</h2><button type="button" onClick={() => setUrlOpen(false)}><X /></button></div><p>The server must allow browser access (CORS). The model is never uploaded anywhere else.</p><input name="url" type="url" required autoFocus placeholder="https://example.com/avatar.vrm" /><div class="dialog-actions"><button type="button" class="secondary" onClick={() => setUrlOpen(false)}>Cancel</button><button class="primary">Open model</button></div></form></div>}
    {captureOpen && <div class="modal-backdrop" onClick={() => setCaptureOpen(false)}><div class="dialog" onClick={e => e.stopPropagation()}><div class="dialog-head"><h2>Save screenshot</h2><button onClick={() => setCaptureOpen(false)}><X /></button></div><p>Export the current camera view as a PNG. Everything stays local.</p><div class="capture-grid"><button onClick={() => screenshot(false, 1)}><Download /><b>Current view</b><span>Background · 1×</span></button><button onClick={() => screenshot(true, 2)}><Download /><b>Transparent 2×</b><span>High resolution</span></button></div></div></div>}
    {(!legalAccepted || legalOpen) && <LegalDialog view={legalView} setView={setLegalView} mustAccept={!legalAccepted} onAccept={acceptLegal} onClose={() => setLegalOpen(false)} />}
  </main>;
}

render(<App />, document.getElementById('app')!);
