/** Headless adapter for the reproducible benchmark. Uses the production engine and projection code. */
import { Gpu } from './core/gpu';
import { Engine } from './core/engine';
import { loadLevel } from './core/scene';
import { OVERCAST } from './core/clay';
import { ViewRenderer, type ViewSpec } from './core/views';
import { captureValidation, validateViews } from './core/validation-engine';
import { coverageOverlay } from './core/validation';
import { toDataUrl, urlToRGBA, bitmapToRGBA } from './core/image';
import { DEFAULT_PIPELINE, prepareView } from './core/pipeline';
import { configureFal, runEdit } from './providers/fal';
import { colorCorrect, featherComposite, keepOnly } from './core/composite';
import { exportGlb } from './core/export';
import type { PromptSetting } from './providers/models';
import { fillColours } from './core/finish';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { makeCamera } from './core/views';

let engine: Engine, renderer: ViewRenderer;
let inputs: { spec: ViewSpec; raw: Uint8ClampedArray }[] = [];
const scenes = new Map<string, THREE.Group>();
const encode = (bytes: Uint8Array) => {
  let s = ''; for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(s);
};

const benchmark = {
  async init(level = '/samples/tatooine.glb', size = 512, atlas = 2048) {
    configureFal();
    const gpu = new Gpu(document.querySelector('canvas')!);
    engine = new Engine(gpu, await loadLevel(level, 'tatooine'), { viewSize: size, atlasSize: atlas, lighting: OVERCAST });
    renderer = new ViewRenderer(gpu, engine.level, size);
    return { parts: engine.level.labels, triangles: engine.level.triangles, size, atlas };
  },
  reset() { engine.atlas.reset(); inputs = []; },
  async generate(spec: ViewSpec, look: { style: string; setting: PromptSetting }, independent = false) {
    if (independent) engine.atlas.reset();
    const p = prepareView(engine, spec, { ...DEFAULT_PIPELINE, style: look.style, setting: look.setting, wording: 'survey' }, inputs.length === 0 || independent);
    const r = await runEdit(p.model, { imageUrl: toDataUrl(p.state, engine.size, engine.size), prompt: p.prompt, seed: 7, size: 1024 });
    const native = { width: r.image.width, height: r.image.height };
    const gen = bitmapToRGBA(r.image, engine.size, engine.size); r.image.close();
    const corrected = colorCorrect(p.state, gen, p.masks, engine.size, engine.size);
    const comp = keepOnly(featherComposite(p.state, corrected, p.masks, engine.size, engine.size, 5), p.geometry, p.geometry);
    engine.paint(spec, comp); inputs.push({ spec, raw: gen });
    return { image: toDataUrl(gen, engine.size, engine.size), input: toDataUrl(p.state, engine.size, engine.size),
      native, calibrated: engine.size, seconds: r.seconds, requestId: r.requestId, prompt: p.model.text?.(p.prompt) ?? p.model.input({ imageUrl: '', prompt: p.prompt, seed: 7, size: 1024 }).prompt };
  },
  async project(targets: { spec: ViewSpec; url: string }[], omit = -1) {
    engine.atlas.reset(); inputs = [];
    for (let i = 0; i < targets.length; i++) {
      const raw = await urlToRGBA(targets[i].url, engine.size, engine.size);
      inputs.push({ spec: targets[i].spec, raw });
      if (i !== omit) engine.paint(targets[i].spec, raw);
    }
  },
  async validate() { return validateViews(engine, inputs, { size: 256, atlasSize: engine.options.atlasSize }); },
  capture(spec: ViewSpec) {
    const c = captureValidation(engine, renderer, spec), n = c.geometry.length;
    const masks = new Uint8ClampedArray(n * 4), labels = new Uint8ClampedArray(n * 4);
    for (let p = 0; p < n; p++) {
      masks.set([c.geometry[p] * 255, c.observed[p] * 255, c.filled[p] * 255, 255], p * 4);
      const label = Math.round(c.frame.normal[4 * p + 3]); labels.set([label, label, label, 255], p * 4);
    }
    return { image: toDataUrl(c.frame.color, engine.size, engine.size), masks: toDataUrl(masks, engine.size, engine.size),
      overlay: toDataUrl(coverageOverlay(c.frame.color, c.geometry, c.observed, c.filled), engine.size, engine.size),
      labels: toDataUrl(labels, engine.size, engine.size), projection: c.frame.projection };
  },
  finish() {
    const size = Math.min(engine.atlas.size, 1024), sample = engine.atlas.readBytes([.5, .5, .5], size), quality = engine.atlas.cellQuality(size), tex = engine.atlas.texelGeometry(size);
    // The production part-aware finishing rule. Fill is tagged below the observed-quality threshold.
    const labels = new Int32Array(size * size), painted = new Uint8Array(size * size);
    for (let p = 0; p < labels.length; p++) { labels[p] = tex.nrm[4 * p + 3] > .5 ? Math.round(tex.pos[4 * p + 3]) - 1 : -1; painted[p] = quality[p] > .0003 ? 1 : 0; }
    const fill = fillColours(sample.data, painted, labels, size);
    engine.atlas.fillUnpainted(fill.rgba, size);
  },
  async glb() { return encode(new Uint8Array(await exportGlb(engine))); },
  async renderModel(url: string, coverageUrl: string, spec: ViewSpec) {
    async function draw(path: string) {
      if (!scenes.has(path)) {
        const gltf = await new GLTFLoader().loadAsync(path);
        gltf.scene.traverse(o => {
          if (!(o instanceof THREE.Mesh)) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          const basic = mats.map((m: THREE.MeshStandardMaterial) => new THREE.MeshBasicMaterial({
            map: m.map ?? m.emissiveMap, color: 0xffffff, side: THREE.DoubleSide, toneMapped: false }));
          o.material = Array.isArray(o.material) ? basic : basic[0];
        });
        scenes.set(path, gltf.scene);
      }
      const scene = new THREE.Scene(); scene.add(scenes.get(path)!);
      const rt = new THREE.WebGLRenderTarget(engine.size, engine.size, { depthBuffer: true });
      rt.texture.colorSpace = THREE.SRGBColorSpace;
      engine.gpu.renderer.toneMapping = THREE.NoToneMapping;
      engine.gpu.draw(scene, makeCamera(spec), rt, 0x131313, 1);
      const data = engine.gpu.readU8(rt); rt.dispose(); return data;
    }
    const color = await draw(url), coverage = await draw(coverageUrl);
    const c = captureValidation(engine, renderer, spec);
    const observed = c.geometry.map((g, p) => g && coverage[4 * p + 1] > 240 ? 1 : 0), filled = c.geometry.map((g, p) => g && !observed[p] ? 1 : 0);
    for (let p = 0; p < c.geometry.length; p++) coverage.set([c.geometry[p] * 255, observed[p] * 255, filled[p] * 255, 255], p * 4);
    return { image: toDataUrl(color, engine.size, engine.size), masks: toDataUrl(coverage, engine.size, engine.size),
      overlay: toDataUrl(coverageOverlay(color, c.geometry, observed, filled), engine.size, engine.size) };
  },
};
declare global { interface Window { benchmark: typeof benchmark } }
window.benchmark = benchmark;
