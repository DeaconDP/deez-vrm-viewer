import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { createVRMAnimationClip, VRMAnimationLoaderPlugin, type VRMAnimation } from '@pixiv/three-vrm-animation';
import type { AnimationLoopMode, AnimationState, ModelSummary } from '../types';
import { DuplicateBoneSync } from './duplicateBoneSync';
import { retargetQuaterniusClip, type QuaterniusAnimationId, type QuaterniusLibraryId } from './quaterniusAnimations';

export type BuiltInAnimationId = QuaterniusAnimationId;

const EMPTY_ANIMATION: AnimationState = { name: '', source: null, duration: 0, time: 0, playing: false, loading: false, error: '' };

export class ViewerController {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(36, 1, 0.01, 1000);
  private controls: OrbitControls;
  private clock = new THREE.Clock();
  private vrm: VRM | null = null;
  private model: THREE.Object3D | null = null;
  private grid = new THREE.GridHelper(20, 20, 0x67717c, 0x383e45);
  private fillLight = new THREE.DirectionalLight(0xeef5ff, 2.2);
  private keyLight = new THREE.DirectionalLight(0xfff1dc, 3.4);
  private rimLight = new THREE.DirectionalLight(0xb8d8ff, 2.4);
  private backgroundTexture: THREE.Texture | null = null;
  private backgroundColor = new THREE.Color(0x70777d);
  private backgroundRequest = 0;
  private raf = 0;
  private animate = false;
  private turntable = false;
  private resizeObserver: ResizeObserver;
  private mixer: THREE.AnimationMixer | null = null;
  private action: THREE.AnimationAction | null = null;
  private sourceClip: THREE.AnimationClip | null = null;
  private animationState: AnimationState = { ...EMPTY_ANIMATION };
  private animationListener: ((state: AnimationState) => void) | null = null;
  private loopMode: AnimationLoopMode = 'repeat';
  private speed = 1;
  private inPlace = true;
  private duplicateBoneSync: DuplicateBoneSync | null = null;
  private quaterniusLibraries = new Map<QuaterniusLibraryId, { scene: THREE.Group; animations: THREE.AnimationClip[] }>();
  private quaterniusLoads = new Map<QuaterniusLibraryId, Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>>();

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, innerWidth < 760 ? 1.5 : 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene.background = this.backgroundColor;
    this.camera.position.set(0, 1.35, 3.2);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 1.15, 0);
    this.controls.enableDamping = true;
    this.controls.addEventListener('change', this.render);
    this.controls.addEventListener('start', () => this.startLoop());
    this.controls.addEventListener('end', () => setTimeout(() => this.stopLoop(), 350));
    this.grid.visible = false;
    this.scene.add(this.grid);
    this.fillLight.position.set(0, 4, 1);
    this.scene.add(this.fillLight);
    this.keyLight.position.set(3, 5, 4);
    this.scene.add(this.keyLight);
    this.rimLight.position.set(-4, 3, -4);
    this.scene.add(this.rimLight);
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(canvas.parentElement!);
    this.resize();
  }

  setAnimationListener(listener: (state: AnimationState) => void) {
    this.animationListener = listener;
    listener({ ...this.animationState });
  }

  private emitAnimation(patch: Partial<AnimationState> = {}) {
    this.animationState = { ...this.animationState, ...patch };
    this.animationListener?.({ ...this.animationState });
  }

  private resize = () => {
    const host = this.canvas.parentElement!;
    const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.render();
  };

  private tick = () => {
    if (!this.animate) return;
    const delta = Math.min(this.clock.getDelta(), 0.05);
    if (this.animationState.playing && this.mixer) {
      this.mixer.update(delta * this.speed);
      const duration = this.animationState.duration;
      const time = this.action ? Math.min(this.action.time, duration) : 0;
      this.emitAnimation({ time });
    }
    if (this.vrm && this.duplicateBoneSync) {
      this.vrm.humanoid.update();
      this.duplicateBoneSync.update();
    }
    this.vrm?.update(delta);
    if (this.turntable && this.model) this.model.rotation.y += delta * 0.35;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.tick);
  };

  render = () => this.renderer.render(this.scene, this.camera);
  private startLoop() { if (!this.animate) { this.animate = true; this.clock.start(); this.tick(); } }
  private stopLoop() { if (!this.turntable && !this.animationState.playing) { this.animate = false; cancelAnimationFrame(this.raf); this.render(); } }

  async load(url: string, fileName: string, size: number, onProgress: (n: number) => void): Promise<ModelSummary> {
    const started = performance.now();
    this.unload();
    const loader = new GLTFLoader();
    loader.register(parser => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url, event => event.total && onProgress(event.loaded / event.total));
    this.vrm = gltf.userData.vrm ?? null;
    this.model = this.vrm?.scene ?? gltf.scene;
    if (this.vrm) {
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      const rawBones = Object.values(this.vrm.humanoid.rawHumanBones).flatMap(bone => bone ? [bone.node] : []);
      this.duplicateBoneSync = new DuplicateBoneSync(this.vrm.scene, rawBones);
      VRMUtils.combineSkeletons(gltf.scene);
      VRMUtils.rotateVRM0(this.vrm);
      this.duplicateBoneSync.update();
      this.mixer = new THREE.AnimationMixer(this.vrm.scene);
      this.mixer.addEventListener('finished', this.onAnimationFinished);
    }
    this.scene.add(this.model);
    this.frameAll();
    this.render();

    let nodes = 0, meshes = 0, triangles = 0, bones = 0;
    const materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
    const items: ModelSummary['items'] = [];
    this.model.traverse(object => {
      nodes++;
      const any = object as THREE.Object3D & { isBone?: boolean; isMesh?: boolean; geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
      if (any.isBone) { bones++; items.push({ id: object.uuid, label: object.name || 'Unnamed bone', kind: 'bone' }); }
      else if (any.isMesh) {
        meshes++; items.push({ id: object.uuid, label: object.name || `Mesh ${meshes}`, kind: 'mesh' });
        if (any.geometry) triangles += any.geometry.index ? any.geometry.index.count / 3 : (any.geometry.attributes.position?.count ?? 0) / 3;
        for (const material of Array.isArray(any.material) ? any.material : [any.material]) if (material) {
          materials.add(material);
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
        }
      } else if (object !== this.model) items.push({ id: object.uuid, label: object.name || `Node ${nodes}`, kind: 'node' });
    });
    for (const material of materials) items.push({ id: material.uuid, label: material.name || 'Unnamed material', kind: 'material', detail: material.type });
    const meta = this.vrm?.meta;
    const normalMeta = meta as unknown as { name?: string; title?: string; authors?: string[]; author?: string; licenseUrl?: string; otherLicenseUrl?: string } | undefined;
    const expressionManager = this.vrm?.expressionManager;
    const expressions = expressionManager?.expressions.map(e => e.expressionName) ?? [];
    const version = this.vrm ? ((gltf.userData.vrmMeta?.metaVersion as string | undefined) ?? (meta as any)?.metaVersion ?? '1.0') : '2.0';
    return {
      name: normalMeta?.name || normalMeta?.title || fileName.replace(/\.(vrm|glb|gltf)$/i, ''), format: this.vrm ? 'VRM' : 'glTF', version,
      generator: gltf.parser.json.asset?.generator ?? 'Not specified', size, loadMs: performance.now() - started,
      nodes, meshes, triangles: Math.round(triangles), materials: materials.size, textures: textures.size, bones, expressions,
      authors: normalMeta?.authors ?? (normalMeta?.author ? [normalMeta.author] : []), license: normalMeta?.licenseUrl ?? normalMeta?.otherLicenseUrl ?? 'Not specified', items
    };
  }

  unload() {
    this.clearAnimation();
    if (!this.model) return;
    this.scene.remove(this.model);
    this.model.traverse(object => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      mats.forEach(material => { Object.values(material).forEach(v => v instanceof THREE.Texture && v.dispose()); material.dispose(); });
    });
    this.vrm = null; this.model = null; this.mixer = null; this.duplicateBoneSync = null; this.render();
  }

  frameAll() {
    if (!this.model) { this.camera.position.set(0, 1.35, 3.2); this.controls.target.set(0, 1.15, 0); this.controls.update(); return; }
    const box = new THREE.Box3().setFromObject(this.model), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    const distance = Math.max(size.x, size.y, size.z) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.25;
    this.controls.target.copy(center); this.camera.position.set(center.x, center.y + size.y * 0.04, center.z + distance); this.controls.update(); this.render();
  }

  setView(view: 'front' | 'back' | 'left' | 'right') {
    const target = this.controls.target, distance = this.camera.position.distanceTo(target);
    const vectors = { front: [0, 0, distance], back: [0, 0, -distance], left: [-distance, 0, 0], right: [distance, 0, 0] } as const;
    this.camera.position.set(target.x + vectors[view][0], target.y, target.z + vectors[view][2]); this.controls.update(); this.render();
  }
  toggleGrid() { this.grid.visible = !this.grid.visible; this.render(); return this.grid.visible; }
  toggleTurntable() { this.turntable = !this.turntable; this.turntable ? this.startLoop() : this.stopLoop(); return this.turntable; }

  private onAnimationFinished = () => {
    this.emitAnimation({ playing: false, time: this.animationState.duration });
    this.stopLoop();
  };

  private loadQuaterniusLibrary(libraryId: QuaterniusLibraryId) {
    const loaded = this.quaterniusLibraries.get(libraryId);
    if (loaded) return Promise.resolve(loaded);
    const pending = this.quaterniusLoads.get(libraryId);
    if (pending) return pending;
    const fileName = libraryId === 'ual1' ? 'UAL1_Standard.glb' : 'UAL2_Standard.glb';
    const url = new URL(`animations/quaternius/${fileName}`, document.baseURI).href;
    const load = new GLTFLoader().loadAsync(url).then(gltf => {
      const library = { scene: gltf.scene, animations: gltf.animations };
      this.quaterniusLibraries.set(libraryId, library);
      return library;
    }).finally(() => { this.quaterniusLoads.delete(libraryId); });
    this.quaterniusLoads.set(libraryId, load);
    return load;
  }

  async loadBuiltInAnimation(id: BuiltInAnimationId) {
    if (!this.vrm || !this.mixer) throw new Error('Open a VRM humanoid before choosing a preview animation.');
    this.emitAnimation({ loading: true, error: '' });
    try {
      const [libraryId, animationName] = id.split(':') as [QuaterniusLibraryId, string];
      const library = await this.loadQuaterniusLibrary(libraryId);
      const sourceClip = library.animations.find(clip => clip.name === animationName);
      if (!sourceClip) throw new Error(`The bundled Quaternius clip “${id}” is missing.`);
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (!this.vrm) throw new Error('The VRM was closed while the animation was loading.');
      const clip = retargetQuaterniusClip(library.scene.clone(true), sourceClip, this.vrm);
      clip.name = id;
      this.setAnimationClip(clip, 'built-in');
      return { name: clip.name, duration: clip.duration };
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      this.emitAnimation({ loading: false, error: message });
      throw reason;
    }
  }

  async loadVRMA(url: string, fileName: string) {
    if (!this.vrm || !this.mixer) throw new Error('VRMA retargeting requires an open VRM humanoid.');
    this.emitAnimation({ loading: true, error: '' });
    try {
      const loader = new GLTFLoader();
      loader.register(parser => new VRMAnimationLoaderPlugin(parser));
      const gltf = await loader.loadAsync(url);
      const animations = gltf.userData.vrmAnimations as VRMAnimation[] | undefined;
      if (!animations?.length) throw new Error('This file contains no VRM Animation data (VRMC_vrm_animation).');
      const clip = createVRMAnimationClip(animations[0], this.vrm);
      clip.name = fileName.replace(/\.vrma$/i, '');
      this.setAnimationClip(clip, 'file');
      return { name: clip.name, duration: clip.duration };
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      this.emitAnimation({ loading: false, error: message });
      throw reason;
    }
  }

  private playableClip() {
    if (!this.sourceClip) return null;
    const clip = this.sourceClip.clone();
    if (this.inPlace) {
      clip.tracks.forEach(track => {
        if (!(track instanceof THREE.VectorKeyframeTrack) || !track.name.endsWith('.position')) return;
        const values = track.values;
        const originX = values[0], originZ = values[2];
        for (let i = 0; i < values.length; i += 3) { values[i] = originX; values[i + 2] = originZ; }
      });
    }
    return clip;
  }

  private setAnimationClip(clip: THREE.AnimationClip, source: 'built-in' | 'file') {
    this.stopAnimationAction();
    this.sourceClip = clip;
    this.createAction();
    this.emitAnimation({ name: clip.name, source, duration: clip.duration, time: 0, playing: false, loading: false, error: '' });
    this.seekAnimation(0);
  }

  private createAction() {
    const clip = this.playableClip();
    if (!clip || !this.mixer) return;
    this.action = this.mixer.clipAction(clip);
    this.applyLoop();
  }

  private applyLoop() {
    if (!this.action) return;
    const loop = this.loopMode === 'once' ? THREE.LoopOnce : this.loopMode === 'pingpong' ? THREE.LoopPingPong : THREE.LoopRepeat;
    this.action.setLoop(loop, this.loopMode === 'once' ? 1 : Infinity);
    this.action.clampWhenFinished = this.loopMode === 'once';
  }

  playAnimation() {
    if (!this.action) throw new Error('Choose or import an animation first.');
    if (this.animationState.time >= this.animationState.duration) { this.action.reset(); this.emitAnimation({ time: 0 }); }
    this.action.paused = false;
    this.action.play();
    this.emitAnimation({ playing: true, error: '' });
    this.startLoop();
  }

  pauseAnimation() {
    if (this.action) this.action.paused = true;
    this.emitAnimation({ playing: false });
    this.stopLoop();
  }

  stopAnimation(resetPose = true) {
    this.stopAnimationAction();
    this.createAction();
    if (resetPose) this.resetPose();
    this.emitAnimation({ playing: false, time: 0 });
    this.stopLoop();
  }

  resetPose() {
    this.vrm?.humanoid.resetNormalizedPose();
    this.vrm?.expressionManager?.resetValues();
    this.vrm?.humanoid.update();
    this.duplicateBoneSync?.update();
    this.vrm?.update(0);
    this.render();
  }

  seekAnimation(time: number) {
    if (!this.action || !this.mixer) return;
    const wasPlaying = this.animationState.playing;
    this.action.paused = false;
    this.action.play();
    this.mixer.setTime(THREE.MathUtils.clamp(time, 0, this.animationState.duration));
    this.action.paused = !wasPlaying;
    this.vrm?.humanoid.update();
    this.duplicateBoneSync?.update();
    this.vrm?.update(0);
    this.emitAnimation({ time: THREE.MathUtils.clamp(time, 0, this.animationState.duration) });
    this.render();
  }

  setAnimationSpeed(speed: number) { this.speed = THREE.MathUtils.clamp(speed, .1, 2); }
  setAnimationLoop(mode: AnimationLoopMode) { this.loopMode = mode; this.applyLoop(); }
  setAnimationInPlace(inPlace: boolean) {
    const time = this.animationState.time, playing = this.animationState.playing;
    this.inPlace = inPlace;
    this.stopAnimationAction(); this.createAction(); this.seekAnimation(time);
    if (playing) this.playAnimation();
  }

  private stopAnimationAction() {
    if (this.action && this.mixer) { this.action.stop(); this.mixer.uncacheClip(this.action.getClip()); }
    this.action = null;
  }

  private clearAnimation() {
    this.stopAnimationAction();
    if (this.mixer) { this.mixer.removeEventListener('finished', this.onAnimationFinished); this.mixer.stopAllAction(); }
    this.sourceClip = null;
    this.emitAnimation({ ...EMPTY_ANIMATION });
  }
  setExpression(name: string, weight: number) { this.vrm?.expressionManager?.setValue(name, weight); this.vrm?.expressionManager?.update(); this.render(); }
  resetExpressions() { this.vrm?.expressionManager?.resetValues(); this.vrm?.expressionManager?.update(); this.render(); }
  setLighting(key: number, fill: number, rim: number, exposure: number) {
    this.keyLight.intensity = THREE.MathUtils.clamp(key, 0, 8);
    this.fillLight.intensity = THREE.MathUtils.clamp(fill, 0, 8);
    this.rimLight.intensity = THREE.MathUtils.clamp(rim, 0, 8);
    this.renderer.toneMappingExposure = THREE.MathUtils.clamp(exposure, .25, 2.5);
    this.render();
  }
  setBackgroundColor(color: string) {
    this.backgroundRequest++;
    this.backgroundTexture?.dispose(); this.backgroundTexture = null;
    this.backgroundColor.set(color);
    this.scene.background = this.backgroundColor;
    this.render();
  }
  async setBackgroundImage(url: string) {
    const request = ++this.backgroundRequest;
    const texture = await new THREE.TextureLoader().loadAsync(url);
    if (request !== this.backgroundRequest) { texture.dispose(); return; }
    texture.colorSpace = THREE.SRGBColorSpace;
    this.backgroundTexture?.dispose(); this.backgroundTexture = texture;
    this.scene.background = texture;
    this.render();
  }
  capture(transparent = false, scale = 1) {
    const old = this.scene.background, size = this.renderer.getSize(new THREE.Vector2()), ratio = this.renderer.getPixelRatio();
    if (transparent) this.scene.background = null;
    this.renderer.setPixelRatio(ratio * scale); this.renderer.setSize(size.x, size.y, false); this.render();
    const data = this.canvas.toDataURL('image/png');
    this.scene.background = old; this.renderer.setPixelRatio(ratio); this.renderer.setSize(size.x, size.y, false); this.render();
    return data;
  }
  dispose() { this.unload(); this.backgroundRequest++; this.backgroundTexture?.dispose(); this.resizeObserver.disconnect(); this.controls.dispose(); this.renderer.dispose(); cancelAnimationFrame(this.raf); }
}
