/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import * as THREE from 'three';
import { INDOOR, INDOOR_SOFT, OUTDOOR, OVERCAST, type Lighting } from './core/clay';
import { aoImage, bakeAo, withOcclusion, type AoOptions } from './core/ao';
import { Engine } from './core/engine';
import { exportGlb } from './core/export';
import { nameParts } from './core/naming';
import { makePbr, pbrMetadata, type PbrOptions } from './core/pbr';
import { buildAlignedMaps, validateAlignedSource, type AlignedMapSource } from './core/aligned-maps';
import { suggestMaterialPreset, validateMaterialAssignments, type MaterialAssignments } from './core/material-presets';
import { Gpu } from './core/gpu';
import { toBlob, urlToRGBA } from './core/image';
import { runPipeline, type PipelineEvent, type PipelineOptions, type RunRecord, type ViewRecord, loadStyleImages } from './core/pipeline';
import { DEFAULT_PLAN, plan as makePlan, samplePlayerPoints, surfaceOf, type Plan, type PlanOptions } from './core/planner';
import { cutIslands, islandLimit, layoutHash, nearScaled, pagedLayout, seenCells, seenDistance, seenLayout, seenShare, seenTriangles, stripLayout } from './core/layout';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { fillColours } from './core/finish';
import { matchCorners, partMesh, pickParts, toGlb, type PartMesh, type PartStats } from './core/partpass';
import { runEdit, runRetexture } from './providers/fal';
import { PAINTED, PART_QUALITY } from './core/atlas';
import { DEFAULT_GROUND, GROUND_QUALITY, TILE_VARIANTS, edgeField, floorHeight, isGround, matchTiles, meanColour, tileGrain, toneField, type GroundOptions } from './core/ground';
import { bitmapToRGBA, toCanvas, toDataUrl } from './core/image';
import { REFERENCE_PRICE, groundNotePrompt, priceOf, propSheetPrompt, isPainted } from './providers/models';
import { drawNotes, gapNotes, noteComposite, notesInView, pinNotes, type Note } from './core/notes';
import { boundsOf, propCameras, propGroups } from './core/proppass';
import { pickReferences } from './core/references';
import { DEFAULT_PIPELINE, generateView, prepareView, promptText } from './core/pipeline';
import { editMask, masksFromState } from './core/composite';
import { makeCamera, lookAt } from './core/views';
import { resizeRGBA } from './core/image';
import { loadLevel, setTriangles, type Level } from './core/scene';
import { unwrap as unwrapUVs, uvHealth, type UvHealth } from './core/unwrap';
import { browserXatlas } from './core/xatlas-browser';
import { MODELS, PART_MODEL } from './providers/models';
import type { ViewSpec } from './core/views';
import { Viewer } from './core/viewer';

/**
 * How far ahead of the room's views a prop's own views and a ground note are stored. They are there to replace what
 * is there, whatever it was captured at: at 3 a bench's own views lost to the room's on nine tenths of it.
 */
const PROP_DETAIL = 20, NOTE_DETAIL = 20;

export const LIGHTING: Record<string, Lighting> = { outdoor: OUTDOOR, overcast: OVERCAST, indoor: INDOOR, 'indoor-soft': INDOOR_SOFT };

/** One loaded level with its engine and viewer: the object both the UI and the headless API drive. */
export class Session {
  readonly gpu: Gpu;
  level?: Level;
  engine?: Engine;
  viewer?: Viewer;
  plan?: Plan;
  record?: RunRecord;
  private abort?: AbortController;
  /** The projection rules were set by hand (api.projection): loading a run doesn't replace them with the run's own. */
  projectionSet = false;
  /** Uploads of finished views still on their way to disk (see `run`'s `saveAs`). */
  private saving: Promise<void> = Promise.resolve();

  constructor(readonly canvas: HTMLCanvasElement) {
    this.gpu = new Gpu(canvas);
  }

  /**
   * @param layout 'seen': lay the texture out again so the faces players can see get the texels (core/layout.ts);
   *   'near': join faces into strips, size each island by how near a player gets to it, and pack again;
   *   'file': the level's own UVs.
   * @param pages how many textures the level is painted over: 1, 4 or 16, each `atlasSize` px. With more than one the
   *   islands of the layout are packed again, each wholly on one page and all at one scale (core/layout.ts pagedLayout).
   * @param unwrap 'auto': make texture coordinates from scratch (core/unwrap.ts, xatlas) when the file's are missing
   *   or can't hold a painting (collapsed, tiling or overlapping); 'always': whatever the file's are like; 'off': keep
   *   the file's, and refuse a file without any. The layout above then runs on what this gives.
   */
  async load(source: string | ArrayBuffer, name: string, lighting: Lighting = OUTDOOR, atlasSize = 4096, viewSize = 2048,
    layout: 'file' | 'seen' | 'near' = 'file', area?: number[], pages = 1, unwrap: 'auto' | 'always' | 'off' = 'auto') {
    this.viewer?.dispose();
    this.engine?.atlas.dispose();
    this.projectionSet = false;
    this.seenAt512 = undefined;
    this.partFiles.clear();
    this.groundTiles = undefined;
    this.groundNoteComps.clear();
    this.level = await loadLevel(source, name, { allowMissingUV: unwrap !== 'off' });
    let uvHealthInfo: UvHealth | undefined;
    if (unwrap !== 'off') {
      const g = this.level.geometry;
      const position = g.getAttribute('position').array;
      uvHealthInfo = uvHealth(position, g.getAttribute('uv').array);   // all at 0 when no mesh had any: 'missing'
      if (this.level.missingUV?.length) uvHealthInfo.problem ??= `no texture coordinates on ${this.level.missingUV.join(', ')}`;
      const reason = unwrap === 'always' ? 'asked' : uvHealthInfo.problem;
      if (reason) {
        const u = await unwrapUVs(position, g.getAttribute('label').array, browserXatlas());
        g.setAttribute('uv', new THREE.Float32BufferAttribute(u.uv, 2));
        this.level.unwrap = { reason, meshes: u.meshes, charts: u.charts, fill: u.fill, hash: layoutHash(u.uv), seconds: u.seconds };
      }
    }
    // `area`: min x, y, z then max x, y, z of where players can be (see Level.playArea)
    // any triples after those six are eye positions given by hand (see Level.spots)
    if (area && area.length >= 6) {
      this.level.playArea = new THREE.Box3(new THREE.Vector3(area[0], area[1], area[2]), new THREE.Vector3(area[3], area[4], area[5]));
      const spots: THREE.Vector3[] = [];
      for (let i = 6; i + 2 < area.length; i += 3) spots.push(new THREE.Vector3(area[i], area[i + 1], area[i + 2]));
      if (spots.length) this.level.spots = spots;
    }
    if (layout === 'seen') {
      const t0 = performance.now();
      const level = this.level, g = level.geometry;
      // where players' eyes can be, sampled more densely than the cameras are: a player walks everywhere
      const eyes = samplePlayerPoints(level, { ...DEFAULT_PLAN, spacing: 2 });
      const position = g.getAttribute('position').array, uv = g.getAttribute('uv').array;
      const l = seenLayout(position, uv, eyes.length ? seenTriangles(position, level.bvh, eyes) : new Uint8Array(position.length / 9).fill(1));
      if (l.applied) g.setAttribute('uv', new THREE.Float32BufferAttribute(l.uv, 2));
      level.layout = { applied: l.applied, gain: l.gain, seenSurface: l.seenSurface, seenTexture: l.seenTexture, islands: l.islands,
        hash: layoutHash(l.uv), seconds: (performance.now() - t0) / 1000 };
    }
    const grid = Math.round(Math.sqrt(pages));
    if (grid * grid !== pages || grid > 4) throw new Error(`a level is painted over 1, 4 or 16 textures, not ${pages}`);
    if (layout === 'near') {
      const t0 = performance.now();
      const level = this.level, g = level.geometry;
      const eyes = samplePlayerPoints(level, { ...DEFAULT_PLAN, spacing: 2 });
      const position = g.getAttribute('position').array, uv = g.getAttribute('uv').array, label = g.getAttribute('label').array;
      const part = new Int32Array(position.length / 9);
      for (let t = 0; t < part.length; t++) part[t] = label[3 * t];
      // with nowhere for a player to stand, every face counts as within reach
      const dist = eyes.length ? seenDistance(position, level.bvh, eyes) : new Float32Array(part.length).fill(1);
      const share = seenShare(position, uv, dist);
      const strips = stripLayout(position, uv, part);
      const sized = nearScaled(position, strips.uv, dist);
      const l = this.packOverPages(sized.uv, grid);
      const hash = layoutHash(l.uv), seconds = (performance.now() - t0) / 1000;
      level.layout = { kind: 'near', applied: true, gain: l.gain, seenSurface: share.surface, seenTexture: share.texture, islands: l.islands, hash, seconds,
        strips: strips.strips, joined: strips.joined, before: strips.before, full: sized.full, cut: l.cut, pieces: l.pieces };
      if (grid > 1) level.pages = { grid, gain: l.gain, islands: l.islands, fill: l.fill, cut: l.cut, pieces: l.pieces, hash, seconds };
    } else if (pages > 1) {
      const t0 = performance.now();
      const l = this.packOverPages(this.level.geometry.getAttribute('uv').array, grid);
      this.level.pages = { grid, gain: l.gain, islands: l.islands, fill: l.fill, cut: l.cut, pieces: l.pieces, hash: layoutHash(l.uv), seconds: (performance.now() - t0) / 1000 };
    }
    this.engine = new Engine(this.gpu, this.level, { lighting, atlasSize, atlasPages: pages, viewSize });
    this.viewer = new Viewer(this.engine, this.canvas);
    this.plan = undefined;
    this.record = undefined;
    return { triangles: this.level.triangles, area: Math.round(this.level.surfaceArea),
      ...(uvHealthInfo ? { uvHealth: uvHealthInfo } : {}), ...(this.level.unwrap ? { unwrap: this.level.unwrap } : {}),
      ...(this.level.layout ? { layout: this.level.layout } : {}),
      ...(this.level.pages ? { pages: { ...this.level.pages, size: atlasSize } } : {}) };
  }

  setLighting(l: Lighting) {
    if (!this.engine || !this.viewer) return;
    this.engine.clay.setLighting(l);
    this.viewer.syncLighting();
  }

  /** The reviewed Sento material in the main atlas viewer, with the original painted atlas intact. No model calls. */
  async loadSentoFloor(viewSize = 1024) {
    const { SENTO_FLOOR } = await import('./presets/sento-floor');
    const info = await this.load(SENTO_FLOOR.model, 'Sento', OVERCAST, 2048, viewSize, 'file');
    const engine = this.engine!, viewer = this.viewer!;
    const paint = await urlToRGBA(SENTO_FLOOR.paint, 2048, 2048);
    if (this.engine !== engine) return info;
    engine.atlas.importPaint(paint, 2048);
    await viewer.setFloorDetail(SENTO_FLOOR.detail);
    if (this.viewer !== viewer) return info;
    const materials: MaterialAssignments = {};
    for (const label of engine.level.labels) { const preset = suggestMaterialPreset(label); if (preset) materials[label] = preset; }
    this.setMaterialPresets(materials);
    viewer.displayLighting = { ...OVERCAST };
    viewer.camera.position.set(-1.3, .7, -.15);
    viewer.camera.fov = 52;
    viewer.camera.updateProjectionMatrix();
    viewer.controls.target.set(-1.3, 0, -1.3);
    viewer.controls.update();
    viewer.setMode('lit');
    return info;
  }

  makePlan(opts: Partial<PlanOptions> = {}) {
    if (!this.engine) throw new Error('load a level first');
    this.plan = makePlan(this.gpu, this.engine.level, this.engine.views, opts, undefined, surfaceOf(this.engine.atlas, opts.grid ?? DEFAULT_PLAN.grid));
    this.viewer!.showPlan(this.plan.points, this.plan.views);
    return this.plan;
  }

  /**
   * Paint the level. With `saveAs` (a run id) every view goes to disk under runs/<id>/ as soon as it's painted,
   * with a run.json that describes the run so far: a crash or a closed tab then loses nothing that was paid for,
   * and `--resume <id>` carries on from it. Saved views drop their images from memory (the composite is kept).
   */
  async run(opts: Partial<PipelineOptions>, onEvent: (e: PipelineEvent) => void, saveAs?: string) {
    if (!this.engine || !this.viewer) throw new Error('load a level first');
    this.abort = new AbortController();
    this.engine.atlas.reset();
    this.clearPbr();
    this.viewer.sky.reset();
    this.viewer.setMode('textured');
    const record = await runPipeline(this.engine, opts, this.during(onEvent, saveAs), this.abort.signal, this.plan);
    if (this.level?.shapes) record.parts = [...this.level.labels];
    this.record = record;
    if (saveAs) await this.saveRun(saveAs);
    return record;
  }

  /** Extend the current run: plan views only where the texture is still missing or poor, paint them on top. */
  async topUp(opts: Partial<PipelineOptions>, onEvent: (e: PipelineEvent) => void, saveAs?: string) {
    if (!this.engine || !this.viewer || !this.record || !this.plan) throw new Error('load a run first');
    this.abort = new AbortController();
    const grid = opts.plan?.grid ?? 256;
    const existing = this.engine.atlas.cellQuality(grid);
    const plan = makePlan(this.gpu, this.engine.level, this.engine.views, { ...opts.plan, grid }, existing, surfaceOf(this.engine.atlas, grid));
    const prior = this.record;
    this.clearPbr();   // the texture is about to change under the maps
    const record = await runPipeline(this.engine, opts, this.during(onEvent, saveAs, prior), this.abort.signal, plan,
      { views: prior.views, cost: prior.cost, seconds: prior.seconds, plan: this.plan });
    if (this.level?.shapes) record.parts = [...this.level.labels];
    this.record = record;
    this.plan = record.plan;
    if (saveAs) await this.saveRun(saveAs);
    return record;
  }

  /** The pipeline's events, handled for the viewer and (with `saveAs`) written to disk as they come. */
  private during(onEvent: (e: PipelineEvent) => void, saveAs?: string, prior?: RunRecord) {
    let plan: Plan | undefined;
    let options: PipelineOptions | undefined;
    const done: ViewRecord[] = [];
    const t0 = performance.now();
    return (e: PipelineEvent) => {
      if (e.type === 'planned') {
        plan = e.plan;
        options = e.options;
        if (!prior) this.plan = e.plan;
        this.viewer!.showPlan(e.plan.points, e.plan.views);
      }
      if (e.type === 'view-done') this.addSky(e.view);
      if (e.type === 'done') this.viewer!.sky.finish();
      this.viewer!.dirty = true;
      onEvent(e);
      if (e.type === 'view-done' && saveAs && plan && options) {
        const view = e.view;
        done.push(view);
        // the run so far, as `loadRun` and a top-up would find it: earlier views first, then the ones painted now
        const soFar: RunRecord = prior
          ? { ...prior, options, views: [...prior.views, ...done], cost: prior.cost + e.cost,
              seconds: prior.seconds + (performance.now() - t0) / 1000 }
          : { level: this.engine!.level.name, options, plan, views: [...done], cost: e.cost, seconds: e.elapsed };
        this.saving = this.saving.then(async () => {
          await this.saveView(saveAs, view);
          await this.put(saveAs, 'run.json', JSON.stringify(this.meta(soFar, true), null, 1));
          view.clay = view.state = view.gen = new Uint8ClampedArray(0);
          view.edit = new Uint8Array(0);
        }).catch((err) => console.warn(`saving view ${view.index} failed: ${(err as Error).message}`));
      }
    };
  }

  /**
   * Pack the level's islands over `grid` x `grid` pages, all at one scale. Islands too long for a page at that scale
   * are cut in pieces first (core/layout.ts cutIslands): that gives the level some more triangles for the same surface.
   * @param uv the layout to pack: the level's own, or one made from it (2 per corner, not packed)
   */
  private packOverPages(uv: ArrayLike<number>, grid: number) {
    const level = this.level!, g = level.geometry;
    const position = g.getAttribute('position').array, normal = g.getAttribute('normal').array, label = g.getAttribute('label').array;
    const cut = cutIslands(position, normal, uv, label, islandLimit(position, uv, grid));
    if (cut.cut) setTriangles(level, cut);
    const part = new Int32Array(cut.position.length / 9);
    for (let t = 0; t < part.length; t++) part[t] = cut.label[3 * t];
    const l = pagedLayout(cut.position, cut.uv, grid, part, undefined, cut.cls);
    level.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(l.uv, 2));
    return { ...l, cut: cut.cut, pieces: cut.pieces };
  }

  private clearPbr() {
    if (!this.engine?.pbr) return;
    this.engine.pbr = undefined;
    this.viewer?.setPbr(undefined);
    if (this.record) this.record.pbr = undefined;
  }

  /**
   * Predict aligned height and roughness, derive normals, and show them in the lit display (one model call per
   * tile). Baked maps are exported with the .glb; their source fields and presets are saved with the run.
   */
  async makePbr(opts: Partial<PbrOptions> = {}, onProgress?: (done: number, total: number) => void) {
    if (!this.engine || !this.viewer) throw new Error('load a level first');
    this.abort = new AbortController();
    const engine = this.engine, revision = engine.atlas.revision;
    const maps = await makePbr(engine, opts, onProgress, this.abort.signal);
    if (this.engine !== engine || engine.atlas.revision !== revision) throw new Error('The painting changed while material maps were being made; maps were not applied');
    this.engine.pbr = maps;
    this.viewer.setPbr(maps);
    if (this.record) this.record.pbr = pbrMetadata(maps);
    return maps;
  }

  /** Change material responses locally. Keep source maps, so repeated edits never accumulate filtering. */
  setMaterialPresets(assignments: MaterialAssignments) {
    if (!this.engine || !this.viewer || !this.level) throw new Error('Load a level first');
    const engine = this.engine, selected = validateMaterialAssignments(assignments, this.level.labels);
    const current = engine.pbr;
    const source: AlignedMapSource = current?.source ?? {
      size: current?.size ?? Math.min(1024, engine.atlas.size), layoutHash: layoutHash(this.level.geometry.getAttribute('uv').array),
      kind: current ? 'legacy-normal' : 'flat', normal: current?.normal, roughness: current?.orm,
      roughnessBase: current ? .88 : .92,
    };
    if (source.layoutHash !== layoutHash(this.level.geometry.getAttribute('uv').array)) throw new Error('The material maps belong to another UV layout');
    const built = buildAlignedMaps(source, engine.atlas.texelGeometry(source.size), this.level.labels, selected, current?.strength ?? 1);
    engine.materialPresets = selected;
    engine.pbr = { ...built, source, size: source.size, strength: current?.strength ?? 1,
      tiles: current?.tiles ?? 0, cost: current?.cost ?? 0, seconds: current?.seconds ?? 0 };
    this.viewer.setPbr(engine.pbr); this.viewer.syncMaterialResponses();
    if (this.record) this.record.pbr = pbrMetadata(engine.pbr);
    return { assignments: { ...selected }, source: source.kind, size: source.size };
  }

  /** Install a reviewed, already aligned height/normal/roughness set. A dedicated height channel takes priority. */
  setMaterialMapSource(source: AlignedMapSource) {
    if (!this.engine || !this.viewer || !this.level) throw new Error('Load a level first');
    validateAlignedSource(source);
    if (source.layoutHash !== layoutHash(this.level.geometry.getAttribute('uv').array)) throw new Error('The material maps belong to another UV layout');
    const owned = { ...source, height: source.height?.slice(), normal: source.normal?.slice(), roughness: source.roughness?.slice() };
    const built = buildAlignedMaps(owned, this.engine.atlas.texelGeometry(source.size), this.level.labels, this.engine.materialPresets);
    this.engine.pbr = { ...built, source: owned, size: source.size, tiles: 0, cost: 0, seconds: 0, strength: 1 };
    this.viewer.setPbr(this.engine.pbr);
    if (this.record) this.record.pbr = pbrMetadata(this.engine.pbr);
  }

  stop() {
    this.abort?.abort();
  }

  /**
   * Bake the level's ambient occlusion (rays against the geometry, no model call). It shows in the lit display,
   * goes into the exported material's occlusion channel and is saved with the run.
   */
  async bakeAo(opts: Partial<AoOptions> = {}, onProgress?: (done: number, total: number) => void) {
    if (!this.engine || !this.viewer) throw new Error('load a level first');
    this.abort = new AbortController();
    const ao = await bakeAo(this.engine, opts, onProgress, this.abort.signal);
    this.engine.ao = ao;
    this.viewer.setAo(ao);
    return ao;
  }

  /**
   * Name the shapes of a level that came without part names (one vision-model question per shape). The names go
   * into the prompts of the next run; `setPartName` corrects one by hand.
   */
  async nameParts(look: string, onProgress?: (done: number, total: number) => void) {
    if (!this.engine) throw new Error('load a level first');
    this.abort = new AbortController();
    return nameParts(this.engine, look, {}, onProgress, this.abort.signal);
  }

  setPartName(part: number, name: string) {
    if (this.level?.shapes && part >= 0 && part < this.level.labels.length) this.level.labels[part] = name.trim().toLowerCase();
  }

  /**
   * Where a walk starts: a player's eye position near `near` (default: what the orbit camera looks at). Uses the
   * plan's points when there is a plan, else samples the walkable floor the way the planner does.
   */
  walkStart(near?: THREE.Vector3): THREE.Vector3 {
    if (!this.engine || !this.viewer) throw new Error('load a level first');
    const pts = this.plan?.points.length ? this.plan.points : samplePlayerPoints(this.engine.level, DEFAULT_PLAN);
    const to = near ?? this.viewer.controls.target;
    if (!pts.length) return this.engine.level.bounds.getCenter(new THREE.Vector3()).setY(this.engine.level.bounds.max.y + 2);
    return pts.reduce((best, p) => (p.distanceToSquared(to) < best.distanceToSquared(to) ? p : best)).clone();
  }

  private addSky(v: { spec: ViewSpec; model: string; comp: Uint8ClampedArray }) {
    // only views whose model painted the whole frame: masked fills leave the clay sky as it was
    if (v.spec.kind === 'roof' || MODELS[v.model]?.mask) return;
    this.viewer!.sky.addView(v.spec, v.comp, this.engine!.geometryMask(v.spec), this.engine!.size);
  }

  /** Textured GLB of the level (unlit material with the baked texture). */
  /**
   * The part pass (core/partpass.ts): texture on their own the parts the painting left much of unpainted, and copy
   * each into the level's texture. One model call a part.
   * @param saveAs the run's folder, to keep each textured part for loading the run again
   */
  async partPass(opts: { max?: number; minShare?: number; only?: string[] } = {}, onProgress?: (message: string) => void, saveAs?: string) {
    const e = this.engine, level = this.level, record = this.record;
    if (!e || !level || !record) throw new Error('paint or load a run first');
    // per part: how much of what players see of it is still unpainted, and how big it is
    const V = 512;
    const cells = e.atlas.texelGeometry(V), quality = e.atlas.cellQuality(V);
    const seen = seenCells(cells.pos, cells.nrm, level.bvh, samplePlayerPoints(level, { ...DEFAULT_PLAN, spacing: 1.5 }));
    const stats: PartStats[] = level.labels.map((_, label) => ({ label, seen: 0, unpainted: 0, area: 0, triangles: 0 }));
    for (let i = 0; i < V * V; i++) {
      if (!seen[i]) continue;
      const s = stats[Math.round(cells.pos[4 * i + 3]) - 1];
      if (!s) continue;
      s.seen++;
      if (!(quality[i] > PAINTED)) s.unpainted++;
    }
    const meshes = level.labels.map((_, label) => partMesh(level.geometry, label));
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    meshes.forEach((m, k) => {
      stats[k]!.triangles = m.position.length / 9;
      for (let t = 0; t < m.position.length; t += 9) {
        a.fromArray(m.position, t); b.fromArray(m.position, t + 3); c.fromArray(m.position, t + 6);
        stats[k]!.area += b.sub(a).cross(c.sub(a)).length() / 2;
      }
    });
    const picked = opts.only ? opts.only.map((n) => level.labels.indexOf(n)).filter((k) => k >= 0)
      : pickParts(stats, level.surfaceArea, opts.max ?? 6, opts.minShare);
    const done: { name: string; price: number; seconds: number; unpainted: number; exact: boolean }[] = [];
    for (const label of picked) {
      if (this.abort?.signal.aborted) break;
      const name = level.labels[label] || `part ${label}`;
      const m = meshes[label]!;
      onProgress?.(`texturing ${name} on its own (${m.position.length / 9} triangles)`);
      const look = record.options.style.split(';')[0] ?? record.options.style;
      // a still of the part as the room's views painted it, when they painted enough of it to show its look
      const s = stats[label]!;
      const still = s.seen && s.unpainted / s.seen < 0.6 ? this.partStill(m) : undefined;
      const r = await runRetexture(toGlb(m.position, m.normal), `${name}, as found in ${look}. The whole object is this one thing: ${name}. ` +
        'Realistic materials, evenly lit, no shadows or highlights painted in, no lettering, stencils, labels or logos.', this.abort?.signal, still);
      const file = `part_${name.replace(/[^a-z0-9]+/gi, '_')}.glb`;
      if (saveAs) await this.put(saveAs, file, new Blob([r.glb], { type: 'model/gltf-binary' }));
      // made to match a still of the room, the texture can stand for the whole part; made from words alone it only fills gaps
      const applied = await this.applyPart(label, r.glb, still ? 'auto' : 'gaps');
      record.cost += PART_MODEL.price;
      record.partPass = (record.partPass ?? []).filter((p) => p.name !== name);   // a part done again replaces its earlier texture
      record.partPass.push({ name, file, price: PART_MODEL.price, exact: applied.exact, still: !!still });
      done.push({ name, price: PART_MODEL.price, seconds: r.seconds, unpainted: stats[label]?.seen ? stats[label]!.unpainted / stats[label]!.seen : 0, exact: applied.exact });
      onProgress?.(`${name}: textured in ${r.seconds.toFixed(0)} s${applied.exact ? '' : ' (its triangles came back changed: matched by position)'}`);
    }
    this.viewer?.setMode('textured');
    return { parts: done, cost: done.reduce((t, p) => t + p.price, 0) };
  }

  /**
   * A still of one part in the painted level, for the part pass to match. Taken from a player spot standing on the
   * part's own floor (not on top of it or its neighbours), with a clear line to its middle and far enough back to
   * hold it in frame; of the nearest few such spots, the one that sees the most of the part already painted. No
   * still when even that one sees it mostly bare: a picture of clay teaches the model clay.
   */
  private partStill(m: PartMesh): string | undefined {
    const v = this.viewer, level = this.level, e = this.engine;
    if (!v || !level || !e) return undefined;
    const box = new THREE.Box3();
    const p = new THREE.Vector3(), n = new THREE.Vector3(), to = new THREE.Vector3();
    for (let i = 0; i < m.position.length; i += 3) box.expandByPoint(p.fromArray(m.position, i));
    const centre = box.getCenter(new THREE.Vector3()), radius = box.getSize(new THREE.Vector3()).length() / 2;
    const G = 512, quality = e.atlas.cellQuality(G);
    const ray = new THREE.Ray();
    const spots = samplePlayerPoints(level, { ...DEFAULT_PLAN, spacing: 1.5 }).map((eye) => ({ eye, d: eye.distanceTo(centre) }))
      .filter((s) => s.d > Math.max(1.5, 1.3 * radius) && s.d < 14 && s.eye.y - DEFAULT_PLAN.eyeHeight < box.min.y + 0.3)
      .sort((a, b) => a.d - b.d);
    let best: { eye: THREE.Vector3; d: number } | undefined, bestShare = 0, tried = 0;
    for (const s of spots) {
      ray.origin.copy(s.eye);
      ray.direction.subVectors(centre, s.eye).divideScalar(s.d);
      const hit = level.bvh.raycastFirst(ray, THREE.DoubleSide);
      if (hit && hit.distance < s.d - radius - 0.1) continue;   // something else stands in the way
      // of the part's triangles that face this spot, the share (by area) the views have painted
      let facing = 0, painted = 0;
      for (let t = 0; t < m.position.length / 9; t++) {
        p.set((m.position[9 * t] + m.position[9 * t + 3] + m.position[9 * t + 6]) / 3, (m.position[9 * t + 1] + m.position[9 * t + 4] + m.position[9 * t + 7]) / 3,
          (m.position[9 * t + 2] + m.position[9 * t + 5] + m.position[9 * t + 8]) / 3);
        n.set(m.normal[9 * t], m.normal[9 * t + 1], m.normal[9 * t + 2]);
        if (n.dot(to.subVectors(s.eye, p)) <= 0) continue;
        const a = new THREE.Vector3().fromArray(m.position, 9 * t), b = new THREE.Vector3().fromArray(m.position, 9 * t + 3), c = new THREE.Vector3().fromArray(m.position, 9 * t + 6);
        const area = b.sub(a).cross(c.sub(a)).length() / 2;
        const u = (m.uv[6 * t] + m.uv[6 * t + 2] + m.uv[6 * t + 4]) / 3, w = (m.uv[6 * t + 1] + m.uv[6 * t + 3] + m.uv[6 * t + 5]) / 3;
        const q = quality[Math.min(G - 1, Math.floor(w * G)) * G + Math.min(G - 1, Math.floor(u * G))] ?? 0;
        facing += area;
        if (q > PAINTED) painted += area;
      }
      const share = facing ? painted / facing : 0;
      if (share > bestShare) { bestShare = share; best = s; }
      if (++tried >= 6) break;
    }
    if (!best || bestShare < 0.5) return undefined;
    const w = this.canvas.width, h = this.canvas.height;
    v.resize(1024, 1024);
    v.camera.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(radius / best.d)) * 1.25, 25, 80);
    v.camera.position.copy(best.eye);
    v.camera.lookAt(centre);
    v.camera.updateProjectionMatrix();
    v.setMode('textured');
    const overlay = v.overlay.visible;
    v.overlay.visible = false;
    v.render(v.camera);
    const url = this.canvas.toDataURL('image/jpeg', 0.92);
    v.overlay.visible = overlay;
    v.resize(w, h);
    return url;
  }

  /** The textured parts of the loaded run, by part name, to put them back after the views are replayed. */
  private partFiles = new Map<string, ArrayBuffer>();

  /** After the run's views were projected again: put its part textures and its finishing fill back. */
  async restoreExtras() {
    const r = this.record;
    if (!r || !this.level) return;
    this.layGround();   // first: it reads the ground as the views alone painted it
    this.paintGroundNotes();
    for (const p of r.partPass ?? []) {
      const buf = this.partFiles.get(p.name), label = this.level.labels.indexOf(p.name);
      if (buf && label >= 0) await this.applyPart(label, buf, p.still ? 'auto' : 'gaps');
    }
    if (r.finished) this.finish();
  }

  /** The tiles of the run's ground (RGBA, square), to lay it again after the views are replayed. */
  private groundTiles?: Uint8ClampedArray[];

  /**
   * The ground pass (core/ground.ts): paint a few tiles of the ground's material seen from straight above, and lay
   * them over all of the ground, so it has one scale and no stretch. The views are projected again first: the pass
   * reads the tone the views gave the ground, and must find it as they left it.
   * @param opts `style`: what the ground is made of (default: the run's floor style); `only`: lay it on the up-facing
   *   faces of these parts and not on the floor players walk on; `reuse`: lay the run's tiles again (other span, patch
   *   size or dirt) without painting new ones; `reference: false`: don't show the model a still of the painted ground
   */
  async ground(opts: Partial<GroundOptions> & { style?: string; only?: string[]; seed?: number; reuse?: boolean; reference?: boolean } = {},
    onProgress?: (message: string) => void, saveAs?: string) {
    const e = this.engine, record = this.record;
    if (!e || !record) throw new Error('paint or load a run first');
    const prior = record.ground;
    const o = { ...DEFAULT_GROUND, ...(prior ? { span: prior.span, cell: prior.cell, dirt: prior.dirt } : {}), ...(prior && opts.reuse ? { turn: prior.turn } : {}), ...opts };
    o.cell = Math.min(o.cell, o.span / 4);
    const style = opts.style ?? prior?.style ?? record.options.floorStyle;
    const seed = opts.seed ?? prior?.seed ?? 7;
    let files = prior?.files ?? [], size = prior?.size ?? 2048, price = prior?.price ?? 0;
    if (opts.reuse && !this.groundTiles?.length) throw new Error('this run has no ground tiles to lay again');
    if (!opts.reuse) {
      this.abort = new AbortController();
      const model = MODELS['flux3-klein'];
      size = 2048;
      const count = THREE.MathUtils.clamp(Math.round(o.tiles), 1, 3);
      // plain gray with a little grain: there is nothing in it for the model to keep but the framing
      const flat = new Uint8ClampedArray(4 * size * size);
      for (let i = 0; i < flat.length; i += 4) { flat[i] = flat[i + 1] = flat[i + 2] = 124 + ((i * 2654435761) >>> 29); flat[i + 3] = 255; }
      // in the run's own wording and light: a painted place gets painted tiles
      const prompt = { look: '', roofLook: '', parts: '', mode: 'floor' as const, floorLook: style, span: o.span, context: false, floor: true, overcast: true,
        ...(record.options.wording ? { wording: record.options.wording } : {}), ...(record.options.setting ? { setting: record.options.setting } : {}) };
      // a still of the ground as the views painted it, for the first tile to match
      e.replay(record.views);
      const still = opts.reference === false ? undefined : this.groundStill();
      if (still && saveAs) await this.put(saveAs, 'ground_reference.jpg', await (await fetch(still)).blob());
      const tiles: Uint8ClampedArray[] = [];
      for (let k = 0; k < count; k++) {
        onProgress?.(`painting ground tile ${k + 1}/${count}: ${style}`);
        const r = await runEdit(model, k === 0
          ? { imageUrl: toDataUrl(flat, size, size, 'image/jpeg', 0.9), prompt: { ...prompt, reference: !!still }, swatchUrl: still, seed: seed + k, size }
          : { imageUrl: toDataUrl(tiles[0], size, size, 'image/jpeg', 0.92), prompt: { ...prompt, variant: TILE_VARIANTS[k] ?? '' }, seed: seed + k, size },
        this.abort.signal);
        tiles.push(bitmapToRGBA(r.image, size, size));
      }
      this.groundTiles = matchTiles(tiles);
      files = this.groundTiles.map((_, k) => `ground_${k}.png`);
      if (saveAs) for (let k = 0; k < files.length; k++) await this.put(saveAs, files[k], await toBlob(this.groundTiles[k], size, size, 'image/png'));
      const paid = count * priceOf(model, size);
      record.cost += paid;
      price += paid;
    }
    // a tile with a grain (rows, boards) is laid without turning its patches
    const grain = tileGrain(this.groundTiles![0], size);
    const turn = o.turn ?? (grain > 0.25 ? 0 : 2);
    record.ground = { files, size, style, span: o.span, cell: o.cell, turn, dirt: o.dirt, seed, ...(opts.only ?? prior?.only ? { only: opts.only ?? prior?.only } : {}), price };
    e.replay(record.views);
    const laid = this.layGround();
    this.paintGroundNotes();
    // then what came after the views, less the ground: part textures and the fill
    const r = record;
    for (const p of r.partPass ?? []) {
      const buf = this.partFiles.get(p.name), label = this.level!.labels.indexOf(p.name);
      if (buf && label >= 0) await this.applyPart(label, buf, p.still ? 'auto' : 'gaps');
    }
    if (r.finished) this.finish();
    this.viewer?.setMode('textured');
    return { tiles: files.length, span: o.span, cell: o.cell, turn, grain: +grain.toFixed(2), cost: price, ...laid };
  }

  /**
   * A still of the ground as the views painted it, for the ground pass to match: from the player spot that looks
   * down on the most well-painted ground a few steps ahead. None when the views painted little of the ground.
   */
  private groundStill(): string | undefined {
    const v = this.viewer, level = this.level, e = this.engine;
    if (!v || !level || !e) return undefined;
    const eyes = samplePlayerPoints(level, { ...DEFAULT_PLAN, spacing: 1.5 });
    const floorY = floorHeight(eyes, DEFAULT_PLAN.eyeHeight, (level.playArea ?? level.bounds).min.y);
    const n = 512, quality = e.atlas.cellQuality(n), cells = e.atlas.texelGeometry(n);
    // well-painted ground, counted in 1 m squares
    const good = new Map<string, number>();
    for (let i = 0; i < n * n; i++) {
      if (cells.nrm[4 * i + 3] < 0.5 || quality[i] < 0.05 || !isGround(cells.nrm[4 * i + 1], cells.pos[4 * i + 1], -1, floorY)) continue;
      const key = `${Math.floor(cells.pos[4 * i])},${Math.floor(cells.pos[4 * i + 2])}`;
      good.set(key, (good.get(key) ?? 0) + 1);
    }
    const at = (x: number, z: number) => good.get(`${Math.floor(x)},${Math.floor(z)}`) ?? 0;
    let best: { eye: THREE.Vector3; target: THREE.Vector3 } | undefined, most = 0;
    const ray = new THREE.Ray();
    for (const eye of eyes) {
      if (Math.abs(eye.y - DEFAULT_PLAN.eyeHeight - floorY) > 0.15) continue;
      for (let k = 0; k < 8; k++) {
        const dx = Math.cos((k / 8) * 2 * Math.PI), dz = Math.sin((k / 8) * 2 * Math.PI);
        // the ground the still would show: 1.5 to 4.5 m ahead, a metre to either side
        let score = 0;
        for (let d = 1.5; d <= 4.5; d += 1) for (let sde = -1; sde <= 1; sde++) score += Math.min(at(eye.x + d * dx - sde * dz, eye.z + d * dz + sde * dx), 30);
        if (score <= most) continue;
        const target = new THREE.Vector3(eye.x + 3 * dx, floorY, eye.z + 3 * dz);
        ray.origin.copy(eye);
        ray.direction.subVectors(target, eye).normalize();
        const hit = level.bvh.raycastFirst(ray, THREE.DoubleSide);
        if (hit && hit.distance < eye.distanceTo(target) - 0.2) continue;   // something stands there
        most = score;
        best = { eye, target };
      }
    }
    if (!best || most < 150) return undefined;
    const w = this.canvas.width, h = this.canvas.height;
    v.resize(1024, 1024);
    v.camera.fov = 55;
    v.camera.position.copy(best.eye);
    v.camera.lookAt(best.target);
    v.camera.updateProjectionMatrix();
    v.setMode('textured');
    const overlay = v.overlay.visible;
    v.overlay.visible = false;
    v.render(v.camera);
    const url = this.canvas.toDataURL('image/jpeg', 0.92);
    v.overlay.visible = overlay;
    v.resize(w, h);
    return url;
  }

  /** Lay the run's ground tiles over the ground as it stands (right after the views were projected). */
  private layGround() {
    const g = this.record?.ground, e = this.engine, level = this.level, tiles = this.groundTiles;
    if (!g || !e || !level || !tiles?.length) return { ground: 0, painted: 0 };
    const box = level.playArea ?? level.bounds;
    // the floor is where most players stand: a level's lowest point may be the underside of its ground slab
    const floorY = floorHeight(samplePlayerPoints(level, { ...DEFAULT_PLAN, spacing: 1.5 }), DEFAULT_PLAN.eyeHeight, box.min.y);
    const labels = (g.only ?? []).map((name) => level.labels.indexOf(name)).filter((k) => k >= 0);
    const span = new THREE.Vector3().subVectors(box.max, box.min);
    const cell = Math.max(0.25, Math.max(span.x, span.z) / 512);
    const edges = edgeField(level.bvh, box, floorY, cell);
    // the ground as the views painted it: its overall tone, and where it is lighter and darker
    const n = Math.min(1024, e.atlas.size);
    const { data } = e.atlas.readBytes([0.5, 0.5, 0.5], n);
    const quality = e.atlas.cellQuality(n), cells = e.atlas.texelGeometry(n);
    const samples: number[] = [];
    const painted = [0, 0, 0];
    let ground = 0;
    for (let i = 0; i < n * n; i++) {
      if (cells.nrm[4 * i + 3] < 0.5) continue;
      if (!isGround(cells.nrm[4 * i + 1], cells.pos[4 * i + 1], Math.round(cells.pos[4 * i + 3]) - 1, floorY, labels, 0.15, !!g.any)) continue;
      ground++;
      if (!(quality[i] > PAINTED) || g.match === false) continue;   // a new material takes nothing from the old paint
      samples.push(cells.pos[4 * i], cells.pos[4 * i + 2], data[4 * i], data[4 * i + 1], data[4 * i + 2]);
      for (let k = 0; k < 3; k++) painted[k] += data[4 * i + k] / 255;
    }
    const count = samples.length / 5;
    const mean = meanColour(tiles[0]);
    // the tiles brought to the tone the views gave the ground, which is the tone of the walls around it
    const base = (count >= 50 ? [0, 1, 2].map((k) => THREE.MathUtils.clamp(painted[k] / count / Math.max(mean[k], 0.02), 0.6, 1.6)) : [1, 1, 1]) as [number, number, number];
    const tone = toneField(samples, { origin: edges.origin, cell, width: edges.width, height: edges.height }, base);
    e.atlas.layGround({ tiles: tiles.map((t) => ({ data: t, size: g.size })), span: g.span, cell: g.cell, seed: g.seed, floorY, turn: g.turn, labels,
      quality: GROUND_QUALITY, dirt: g.dirt, any: !!g.any, mirror: g.lay === 'mirror', edges, tone: { data: tone, width: edges.width, height: edges.height },
      field: { origin: edges.origin, size: [edges.width * cell, edges.height * cell] } });
    return { ground: ground / (n * n), painted: ground ? count / ground : 0, tone: base.map((b) => +b.toFixed(2)) };
  }

  /** The ground notes' pictures (RGBA at view size), by file, to put them back after the ground is laid again. */
  private groundNoteComps = new Map<string, Uint8ClampedArray>();

  /**
   * Notes on ground that is already painted (core/notes.ts): a drain cover, a repaired patch, a damp streak. Each is
   * carried out from a camera hung straight over its spot, after the ground pass, and only the note's own footprint
   * goes onto the level, fading into the ground around it. One model call a note (MiniMax H3, which reads the notes).
   */
  async groundNotes(notes: Note[], onProgress?: (message: string) => void, saveAs?: string) {
    const e = this.engine, level = this.level, record = this.record;
    if (!e || !level || !record) throw new Error('paint or load a run first');
    this.abort = new AbortController();
    const S = e.size, model = MODELS.h3;
    const done: { text: string; seconds: number }[] = [];
    const up = new THREE.Vector3(0, 1, 0), ray = new THREE.Ray();
    for (const note of pinNotes(notes, level.geometry, level.bvh)) {
      if (this.abort.signal.aborted) break;
      const end = note.to ?? note.at;
      const mid: [number, number, number] = [(note.at[0] + end[0]) / 2, (note.at[1] + end[1]) / 2, (note.at[2] + end[2]) / 2];
      // the picture shows the note with room around it: two and a half times its extent, 3 to 9 m across
      const span = THREE.MathUtils.clamp(2.5 * (Math.hypot(end[0] - note.at[0], end[2] - note.at[2]) + note.size), 3, 9);
      ray.origin.set(mid[0], mid[1] + 0.05, mid[2]);
      ray.direction.copy(up);
      const above = level.bvh.raycastFirst(ray, THREE.DoubleSide);
      const height = Math.min(span / (2 * Math.tan(THREE.MathUtils.degToRad(30))), above ? above.distance - 0.3 : Infinity);
      const fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(span / 2 / height)), 30, 100);
      const spec: ViewSpec = { id: 9000 + done.length, position: [mid[0], mid[1] + height, mid[2]], yaw: 0, pitch: THREE.MathUtils.degToRad(-88), fov, kind: 'floor', floor: mid[1] };
      const { state } = e.renderView(spec);
      const { pos, nrm } = e.readGeometry();
      const [seen] = notesInView([note], makeCamera(spec), pos, nrm, new Uint8Array(S * S), S);
      if (!seen?.well) { onProgress?.(`"${note.text}": its spot cannot be seen whole from above, left out`); continue; }
      onProgress?.(`ground note: ${note.text}`);
      const prompt = groundNotePrompt(record.options.floorStyle);
      const r = await runEdit({ ...model, input: (i) => ({ ...model.input(i), prompt }) },
        { imageUrl: toDataUrl(drawNotes(state, S, [seen]), S, S, 'image/jpeg', 0.95), prompt: { look: '', roofLook: '', parts: '', mode: 'floor', floor: true }, seed: 7, size: S }, this.abort.signal);
      const gen = bitmapToRGBA(r.image, S, S);
      const ground = new Uint8Array(S * S);
      for (let i = 0; i < ground.length; i++) ground[i] = nrm[4 * i + 3] > 0.5 && nrm[4 * i + 1] > 0.7 ? 1 : 0;
      const comp = noteComposite(state, gen, seen.footprint, S, ground);
      const file = `ground_note_${note.text.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)}.png`;
      this.groundNoteComps.set(file, comp);
      if (saveAs) {
        await this.put(saveAs, file, await toBlob(comp, S, S, 'image/png'));
        await this.put(saveAs, file.replace('.png', '_gen.jpg'), await toBlob(gen, S, S, 'image/jpeg', 0.9));
      }
      e.paint(spec, comp, NOTE_DETAIL);
      const price = priceOf(model, S);
      record.cost += price;
      record.groundNotes = [...(record.groundNotes ?? []).filter((n) => n.file !== file), { text: note.text, spec, file, price }];
      done.push({ text: note.text, seconds: r.seconds });
    }
    // what came after the ground goes back over it: part textures and the fill
    for (const p of record.partPass ?? []) {
      const buf = this.partFiles.get(p.name), label = level.labels.indexOf(p.name);
      if (buf && label >= 0) await this.applyPart(label, buf, p.still ? 'auto' : 'gaps');
    }
    if (record.finished) this.finish();
    this.viewer?.setMode('textured');
    return { notes: done, cost: done.length * priceOf(model, S) };
  }

  /**
   * Repairs: a region that is painted wrongly (a stretch of panelling that came out as plaster, a smear) is painted
   * again. For each region a camera stands where a player could and looks at it; in the picture the model gets,
   * the region is bare gray among what is painted round it, as a hole is, and it is filled by the same path every
   * run fills its holes with. Only the region's pixels go back onto the level, ahead of what was there. The views
   * join the run like any others.
   * @param regions each a box in the level (`min`, `max`); `text`: what it should be, drawn as a note on the gray,
   *   when the surroundings alone would not say; `from`: where the camera stands, when the best of the players' spots will not do;
   *   `again`: a repair of a repair that went wrong goes ahead of the first by this factor (2 or more)
   * @param dry make the pictures the model would get and hand them back, without calling it or painting anything
   */
  async repairRegions(regions: { min: [number, number, number]; max: [number, number, number]; text?: string; from?: [number, number, number]; again?: number }[],
    onProgress?: (message: string) => void, saveAs?: string, dry = false) {
    const e = this.engine, level = this.level, record = this.record;
    if (!e || !level || !record) throw new Error('paint or load a run first');
    this.abort = new AbortController();
    const S = e.size, o = { ...DEFAULT_PIPELINE, ...record.options };
    const model = MODELS[o.fillModel] ?? MODELS.h3;
    const spots = samplePlayerPoints(level, { ...DEFAULT_PLAN, spacing: 1.5 });
    const done: { index: number; pixels: number; seconds: number; from: number[] }[] = [];
    const sent: string[] = [];
    const ray = new THREE.Ray();
    let cost = 0;
    for (const region of regions) {
      if (this.abort.signal.aborted) break;
      const box = new THREE.Box3(new THREE.Vector3(...region.min), new THREE.Vector3(...region.max));
      const middle = box.getCenter(new THREE.Vector3()), radius = box.getSize(new THREE.Vector3()).length() / 2;
      // the surface in the middle of the region, and which way it faces
      const [pin] = pinNotes([{ text: '', at: middle.toArray() as [number, number, number] }], level.geometry, level.bvh);
      const target = new THREE.Vector3(...pin.at), normal = new THREE.Vector3(...pin.normal);
      // the player's spot that faces it most squarely from about the right distance, with a clear line to it
      const ideal = THREE.MathUtils.clamp(2.6 * radius, 3.5, 9);
      let eye: THREE.Vector3 | undefined, best = -Infinity;
      for (const s of region.from ? [new THREE.Vector3(...region.from)] : spots) {
        const d = s.distanceTo(target);
        if (d < 0.8) continue;
        ray.origin.copy(s);
        ray.direction.subVectors(target, s).divideScalar(d);
        const facing = -normal.dot(ray.direction);
        const hit = level.bvh.raycastFirst(ray, THREE.DoubleSide);
        if (!region.from && (facing < 0.2 || (hit && hit.distance < d - 0.15))) continue;
        // the right distance first: a spot right under a patch of wall, or over a patch of floor, looks at it so
        // steeply that the picture shows nothing else, and the model has nothing to continue from
        const score = 0.3 * facing - Math.abs(d - ideal) / ideal;
        if (score > best) { best = score; eye = s; }
      }
      if (!eye) { onProgress?.(`region at ${middle.toArray().map((v) => v.toFixed(1)).join(', ')}: no spot sees it, left out`); continue; }
      const fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(1.7 * radius / eye.distanceTo(target))), 40, 95);
      const index = Math.max(-1, ...record.views.map((v) => v.index)) + 1;
      const spec: ViewSpec = { ...lookAt(eye, target, fov, index), kind: 'clean' };
      // everything a view has painted shows as it is, however far off it was painted from: only the region is to be painted here
      const p = prepareView(e, spec, { ...o, gapNotes: false, notes: undefined }, false, false, 1e-9);
      const { pos, nrm } = e.readGeometry();
      const grown = box.clone().expandByScalar(0.03);
      const mask = new Uint8Array(S * S), labelOf = new Int16Array(S * S).fill(-1);
      const inside = new THREE.Vector3(), parts = new Map<number, number>();
      let pixels = 0;
      for (let i = 0; i < S * S; i++) {
        if (nrm[4 * i + 3] < 0.5 || !grown.containsPoint(inside.set(pos[4 * i], pos[4 * i + 1], pos[4 * i + 2]))) continue;
        mask[i] = 1; labelOf[i] = 0; pixels++;
        const l = Math.round(nrm[4 * i + 3]) - 1;
        parts.set(l, (parts.get(l) ?? 0) + 1);
      }
      if (pixels < 0.002 * S * S) { onProgress?.(`region at ${middle.toArray().map((v) => v.toFixed(1)).join(', ')}: too little of it in sight, left out`); continue; }
      // what the region is made of, by the parts in it (the largest first), for the prompt
      const names = [...parts.entries()].sort((x, y) => y[1] - x[1]).filter(([, n]) => n > 0.03 * pixels).map(([l]) => level.labels[l]).filter(Boolean).join(', ');
      const state = new Uint8ClampedArray(p.state);
      for (let i = 0; i < S * S; i++) if (mask[i]) for (let k = 0; k < 3; k++) state[4 * i + k] = p.clay[4 * i + k];
      p.state = state;
      p.masks = { geometry: p.masks.geometry, known: p.masks.known.map((k, i) => (mask[i] ? 0 : k)) };
      p.keep = mask;
      p.edit = editMask(p.masks, S, S, Math.round(3 * S / 1024));
      if (region.text && model.readsNotes) {
        p.notes = gapNotes(labelOf, mask, [region.text], S, 1, 0, (n) => n, 1);
        p.sent = drawNotes(state, S, p.notes);
      } else { p.notes = undefined; p.sent = undefined; }
      p.model = model;
      p.prompt = { ...p.prompt, mode: 'fill', shapes: true, plain: false, parts: names, ...(p.notes?.length ? { notes: region.text } : { notes: undefined }) };
      onProgress?.(`repair: ${region.text ?? names} (${(100 * pixels / (S * S)).toFixed(0)}% of the picture)`);
      if (dry) { const n = Math.min(1536, S); sent.push(toDataUrl(resizeRGBA(p.sent ?? p.state, S, S, n), n, n, 'image/jpeg', 0.85)); continue; }
      const r = await generateView(p, S, o.seed + index, o.feather, this.abort.signal);
      const detail = NOTE_DETAIL * Math.max(1, region.again ?? 1);
      e.paint(spec, r.comp, detail);
      const price = priceOf(model, S);
      const view: ViewRecord = { index, wave: Math.max(-1, ...record.views.map((v) => v.wave)) + 1, spec, model: model.key, first: false,
        unknownFraction: pixels / (S * S), prompt: promptText(p), left: r.left, seconds: r.seconds, price, detail, notes: [region.text ?? `repair: ${names}`],
        clay: p.clay, state: p.sent ?? p.state, edit: p.edit, gen: r.gen, comp: r.comp, coverage: e.atlas.coverage(), predicted: 0 };
      record.views.push(view);
      record.cost += price;
      cost += price;
      done.push({ index, pixels, seconds: r.seconds, from: eye.toArray().map((v) => +v.toFixed(2)) });
      if (saveAs) {
        await this.saveView(saveAs, view);
        view.clay = view.state = view.gen = new Uint8ClampedArray(0);
        view.edit = new Uint8Array(0);
      }
    }
    if (dry) return { repairs: done, cost: 0, sent };
    if (record.finished) this.finish();
    this.viewer?.setMode('textured');
    return { repairs: done, cost };
  }

  /** After the ground was laid again: put the ground notes back on it. */
  private paintGroundNotes() {
    for (const n of this.record?.groundNotes ?? []) {
      const comp = this.groundNoteComps.get(n.file);
      if (comp) this.engine!.paint(n.spec, comp, NOTE_DETAIL);
    }
  }

  /**
   * The prop pass (core/proppass.ts): props painted on their own by the model that paints the room. A few cameras
   * stand round each prop; each one's render shows the prop gray with a note that names it, comes with pictures that
   * already show it (the prop's own earlier angle first, then the room's views), and only the prop's pixels go onto
   * the level, ahead of what the room's views put there. The views join the run like any others.
   * @param opts `only`: these parts; else the parts with most of what players see left unpainted, `max` of them.
   *   `angles`: cameras a prop. `mode`: 'sheet' (default) paints the prop's cameras as one sheet in one call, so its
   *   sides agree; 'sequence' paints one camera after another, each continuing the last, with a note that names the
   *   prop and with reference pictures. `runId`: the run's folder, to fetch the room's views from as references
   */
  async propPass(opts: { max?: number; only?: string[]; angles?: number; runId?: string; mode?: 'sheet' | 'sequence'; model?: string;
    /** Gather the parts' shapes into props by where they stand (core/proppass.ts propGroups): one prop a cluster, of whatever parts. */
    split?: boolean;
    /** In a painted place: the parts drawn as cels, as the film draws its machines; the others are painted as background. Unset: all. */
    cels?: string[];
    /** Make the sheets and hand them back without calling a model or painting anything: to see what the cameras show. */
    dry?: boolean;
    /** Cameras given by hand for a part, by its name: the ones found for it suit a barrel, not a machine 8 m tall among gantries. */
    cameras?: Record<string, { position: [number, number, number]; target: [number, number, number]; fov?: number }[]> } = {}, onProgress?: (message: string) => void, saveAs?: string) {
    const e = this.engine, level = this.level, record = this.record;
    if (!e || !level || !record) throw new Error('paint or load a run first');
    this.abort = new AbortController();
    // MiniMax H3 unless told otherwise: it was built on H3, which reads the notes the one-by-one mode draws; a sheet needs none
    const S = e.size, model = MODELS[opts.model ?? 'h3'] ?? MODELS.h3, runId = saveAs ?? opts.runId;
    const o = { ...DEFAULT_PIPELINE, ...record.options };
    // a painted place: a sheet is told it is frames of the film, and is sent the first two of the look's frames for the design
    // (a machine is sent the first two frames, which a look puts its machines in; a thing of the background the next two)
    const frames = isPainted(o.wording) && !opts.dry ? await loadStyleImages(o.styleImages?.slice(0, 4), this.abort.signal) : undefined;
    const picked = opts.only ? opts.only.map((n) => level.labels.indexOf(n)).filter((k) => k >= 0) : this.unfinishedParts(opts.max ?? 5);
    const eyes = samplePlayerPoints(level, { ...DEFAULT_PLAN, spacing: 1.5 });
    const small = (rgba: Uint8ClampedArray) => { const n = Math.min(1024, S); return toDataUrl(resizeRGBA(rgba, S, S, n), n, n, 'image/jpeg', 0.85); };
    const room = record.views.filter((v) => (v.spec.kind ?? 'ground') === 'ground');
    const done: { name: string; views: number; price: number }[] = [];
    const sheets: { name: string; sides: number; url: string }[] = [];
    // one prop a part, or (split) the parts' shapes gathered into props by where they stand
    const props: { labels: number[]; box: THREE.Box3; samples?: THREE.Vector3[] }[] = opts.split
      ? propGroups(picked.map((label) => ({ label, position: partMesh(level.geometry, label).position })))
      : picked.map((label) => ({ labels: [label], box: boundsOf(partMesh(level.geometry, label).position) }));
    const inside = new THREE.Vector3();
    if (opts.dry) for (const prop of props) onProgress?.(`prop: ${prop.labels.map((l) => level.labels[l]).join(' + ')} at ${prop.box.min.toArray().map((x) => x.toFixed(1))} to ${prop.box.max.toArray().map((x) => x.toFixed(1))}`);
    for (const prop of props) {
      const label = prop.labels[0], names = prop.labels.map((l) => level.labels[l]).filter(Boolean);
      const name = names.length > 2 ? `${names[0]} with ${names.slice(1, -1).join(', ')} and ${names[names.length - 1]}` : names.join(' with ');
      if (!name || this.abort.signal.aborted) continue;
      const box = prop.box, wide = box.clone().expandByScalar(0.06);
      // which prop a view is of: its name and where it stands (two clusters of drums share a name). A prop this run
      // already has views of is left alone, so the pass can be run again after it was cut short.
      const key = `prop at ${box.getCenter(inside).toArray().map((x) => x.toFixed(1)).join(',')}`;
      if (opts.split && record.views.some((v) => v.notes?.[0] === name && v.notes[1] === key)) { onProgress?.(`${name}: already painted`); continue; }
      // the prop's own pixels: of its parts, and (split) within its bounds, so the other cluster of the same part is not it
      const own = (l: number, pos: Float32Array, i: number) => prop.labels.includes(l) && (!opts.split || wide.containsPoint(inside.set(pos[4 * i], pos[4 * i + 1], pos[4 * i + 2])));
      const cel = opts.cels ? opts.cels.includes(names[0]) : true;
      const film = frames && (cel || frames.length < 3 ? frames.slice(0, 2) : frames.slice(2, 4));
      const given = opts.cameras?.[name];
      const cams = given?.length
        ? given.map((c, k) => ({ ...lookAt(new THREE.Vector3(...c.position), new THREE.Vector3(...c.target), c.fov ?? 60, k), kind: 'clean' as const }))
        : propCameras(box, eyes, level.bvh, opts.angles ?? 4, prop.samples);
      const centre = box.getCenter(new THREE.Vector3()).toArray() as [number, number, number];
      // the room's views that show the prop, fetched once, small
      const shows: string[] = [];
      if (runId) for (const v of pickReferences(centre, room, 2, level.bvh)) {
        const n = Math.min(1024, S);
        shows.push(toDataUrl(await urlToRGBA(`/runs/${runId}/view_${v.index}_gen.jpg`, n, n), n, n, 'image/jpeg', 0.85));
      }
      const mine: string[] = [];
      let spent = 0;
      if (opts.mode !== 'sequence' && (cams.length >= 2 || (opts.split && cams.length))) {
        // A turnaround sheet: the cameras' pictures side by side in one image, the prop gray in each, painted by one
        // call. What one picture shows of the prop then agrees with the next, which separate calls do not manage.
        const sheet = document.createElement('canvas');
        sheet.width = sheet.height = 2 * S;
        const ctx = sheet.getContext('2d')!;
        const panels: { p: ReturnType<typeof prepareView>; mask: Uint8Array; pixels: number }[] = [];
        for (let k = 0; k < Math.min(4, cams.length); k++) {
          const index = Math.max(-1, ...record.views.map((v) => v.index)) + 1 + k;
          const p = prepareView(e, { ...cams[k], id: index }, { ...o, gapNotes: false, notes: undefined }, false);
          const { nrm, pos } = e.readGeometry();
          const mask = new Uint8Array(S * S), state = new Uint8ClampedArray(p.state);
          let pixels = 0;
          for (let i = 0; i < S * S; i++) {
            if (!(nrm[4 * i + 3] > 0.5) || !own(Math.round(nrm[4 * i + 3]) - 1, pos, i)) continue;
            mask[i] = 1;
            pixels++;
            for (let c = 0; c < 3; c++) state[4 * i + c] = p.clay[4 * i + c];
          }
          p.state = state;
          if (pixels < 0.004 * S * S) continue;   // next to nothing of it in this frame: a model would paint some other gray thing as it
          ctx.drawImage(toCanvas(state, S, S), (panels.length % 2) * S, Math.floor(panels.length / 2) * S);
          panels.push({ p, mask, pixels });
        }
        const n = panels.length;
        if (!n) { onProgress?.(`${name}: no camera shows it`); continue; }
        onProgress?.(`${name}: one sheet of ${n} sides`);
        if (opts.dry) { sheets.push({ name, sides: n, url: sheet.toDataURL('image/jpeg', 0.8) }); continue; }
        const prompt = propSheetPrompt(name, n, record.options.style, film && { frames: film.length, place: o.setting?.place, cel });
        // A pass whose page died left the sides it had paid for on disk and not a word of them in run.json. The same
        // pass again makes the same cameras with the same numbers, so what is there is taken from there, not bought twice.
        const paid = !!saveAs && (await Promise.all(panels.map(({ p }) => fetch(`/runs/${saveAs}/view_${p.spec.id}_gen.jpg`, { method: 'HEAD' })
          .then((res) => res.ok && (res.headers.get('content-type') ?? '').startsWith('image/'), () => false)))).every(Boolean);
        if (paid) onProgress?.(`${name}: its ${n} sides are on disk from a pass that was cut short`);
        const r = paid ? undefined : await runEdit({ ...model, input: (i) => ({ ...model.input(i), prompt }) },
          { imageUrl: sheet.toDataURL('image/jpeg', 0.93), ...(film?.length ? { styleUrls: film } : {}), prompt: { look: '', roofLook: '', parts: '', mode: 'fill', floor: false }, seed: o.seed, size: 2 * S }, this.abort.signal);
        const big = r && bitmapToRGBA(r.image, 2 * S, 2 * S);
        const price = (priceOf(model, 2 * S) + (film?.length ?? 0) * (model.imagePrice ?? 0)) / n;
        for (const [k, { p, mask, pixels }] of panels.entries()) {
          const ox = (k % 2) * S, oy = Math.floor(k / 2) * S;
          const gen = big ? new Uint8ClampedArray(4 * S * S) : await urlToRGBA(`/runs/${saveAs}/view_${p.spec.id}_gen.jpg`, S, S);
          const comp = new Uint8ClampedArray(4 * S * S);
          for (let y = 0; y < S; y++) {
            if (big) gen.set(big.subarray(4 * ((oy + y) * 2 * S + ox), 4 * ((oy + y) * 2 * S + ox + S)), 4 * y * S);
            for (let x = 0; x < S; x++) {
              const i = y * S + x;
              if (!mask[i]) continue;
              comp[4 * i] = gen[4 * i]; comp[4 * i + 1] = gen[4 * i + 1]; comp[4 * i + 2] = gen[4 * i + 2]; comp[4 * i + 3] = 255;
            }
          }
          e.paint(p.spec, comp, PROP_DETAIL);
          const view: ViewRecord = { index: p.spec.id, wave: Math.max(-1, ...record.views.map((v) => v.wave)) + 1, spec: p.spec, model: model.key, first: false,
            unknownFraction: pixels / (S * S), prompt, seconds: (r?.seconds ?? 0) / n, price, detail: PROP_DETAIL, notes: opts.split ? [name, key] : [name],
            clay: p.clay, state: p.state, edit: mask, gen, comp, coverage: e.atlas.coverage(), predicted: 0 };
          record.views.push(view);
          record.cost += price;
          spent += price;
          mine.push('');
          if (saveAs) {
            if (!paid) await this.saveView(saveAs, view);
            view.clay = view.state = view.gen = new Uint8ClampedArray(0);
            view.edit = new Uint8Array(0);
          }
        }
        // the run's index after every prop: a pass that dies then keeps what it has painted
        if (saveAs) await this.put(saveAs, 'run.json', JSON.stringify(this.meta(record, true), null, 1));
      } else for (const cam of cams) {
        const index = Math.max(-1, ...record.views.map((v) => v.index)) + 1;
        const spec: ViewSpec = { ...cam, id: index };
        const p = prepareView(e, spec, { ...o, gapNotes: false, notes: undefined }, false);
        // What the prop's own earlier cameras painted stays, and this one continues it: three cameras each painting
        // the whole barrel their own way leave hoops that do not meet where their pictures join. Only a prop's own
        // views are stored this far ahead of what a camera here could capture.
        const own = masksFromState(e.renderView(spec, 5).mask).known;
        const { nrm } = e.readGeometry();
        const labelOf = new Int16Array(S * S), mask = new Uint8Array(S * S);
        let pixels = 0, whole = 0;
        for (let i = 0; i < S * S; i++) {
          labelOf[i] = nrm[4 * i + 3] > 0.5 ? Math.round(nrm[4 * i + 3]) - 1 : -1;
          if (labelOf[i] !== label) continue;
          whole++;
          if (!own[i]) { mask[i] = 1; pixels++; }
        }
        if (whole < 0.01 * S * S || pixels < 0.1 * whole) continue;   // too little of it in sight from here, or left to paint
        const partly = pixels < 0.9 * whole;
        // the prop (what is left of it) is what this view paints: gray in the picture the model gets, and nothing else is projected
        const state = new Uint8ClampedArray(p.state);
        for (let i = 0; i < S * S; i++) if (mask[i]) for (let k = 0; k < 3; k++) state[4 * i + k] = p.clay[4 * i + k];
        p.state = state;
        p.masks = { geometry: p.masks.geometry, known: p.masks.known.map((k, i) => (mask[i] ? 0 : k)) };
        p.keep = mask;
        p.edit = editMask(p.masks, S, S, Math.round(3 * S / 1024));
        p.notes = gapNotes(labelOf, mask, level.labels, S, 1, 0, (n) => (partly
          ? `this object is one thing: ${n}. Paint its gray part to continue the rest of it`
          : `this gray object is one thing: ${n}. Paint all of it`), 1);
        p.sent = drawNotes(state, S, p.notes);
        const refs = [...mine.slice(-1), ...shows].slice(0, 3);
        p.model = model;
        p.prompt = { ...p.prompt, mode: 'fill', shapes: true, plain: false, parts: name, notes: name, references: refs.length || undefined };
        onProgress?.(`${name}: angle ${mine.length + 1} of ${cams.length}`);
        const r = await generateView(p, S, o.seed + index, o.feather, this.abort.signal, undefined, undefined, refs);
        e.paint(spec, r.comp, PROP_DETAIL);
        const price = priceOf(model, S) + refs.length * REFERENCE_PRICE;
        const view: ViewRecord = { index, wave: Math.max(-1, ...record.views.map((v) => v.wave)) + 1, spec, model: model.key, first: false,
          unknownFraction: pixels / (S * S), prompt: promptText(p), left: r.left, seconds: r.seconds, price, detail: PROP_DETAIL, notes: [name],
          clay: p.clay, state: p.sent, edit: p.edit, gen: r.gen, comp: r.comp, coverage: e.atlas.coverage(), predicted: 0 };
        record.views.push(view);
        record.cost += price;
        spent += price;
        mine.push(small(r.gen));
        if (saveAs) {
          await this.saveView(saveAs, view);
          view.clay = view.state = view.gen = new Uint8ClampedArray(0);
          view.edit = new Uint8Array(0);
        }
      }
      if (mine.length) done.push({ name, views: mine.length, price: +spent.toFixed(3) });
    }
    // as a loaded run would have it: every view, then the ground, the part textures and the fill over them
    e.replay(record.views);
    await this.restoreExtras();
    this.viewer?.setMode('textured');
    return { props: done, cost: +done.reduce((t, d) => t + d.price, 0).toFixed(3), ...(opts.dry ? { sheets } : {}) };
  }

  /** The parts with the largest share of what players see still unpainted (as the part pass picks them). */
  private unfinishedParts(max: number): number[] {
    const e = this.engine!, level = this.level!;
    const V = 512;
    const cells = e.atlas.texelGeometry(V), quality = e.atlas.cellQuality(V);
    const seen = seenCells(cells.pos, cells.nrm, level.bvh, samplePlayerPoints(level, { ...DEFAULT_PLAN, spacing: 1.5 }));
    const stats: PartStats[] = level.labels.map((_, label) => ({ label, seen: 0, unpainted: 0, area: 0, triangles: 0 }));
    for (let i = 0; i < V * V; i++) {
      if (!seen[i]) continue;
      const st = stats[Math.round(cells.pos[4 * i + 3]) - 1];
      if (!st) continue;
      st.seen++;
      if (!(quality[i] > PAINTED)) st.unpainted++;
    }
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    level.labels.forEach((_, k) => {
      const m = partMesh(level.geometry, k);
      stats[k]!.triangles = m.position.length / 9;
      for (let t = 0; t < m.position.length; t += 9) {
        a.fromArray(m.position, t); b.fromArray(m.position, t + 3); c.fromArray(m.position, t + 6);
        stats[k]!.area += b.sub(a).cross(c.sub(a)).length() / 2;
      }
    });
    return pickParts(stats, level.surfaceArea, max);
  }

  /** Which texture cells (512 x 512) a player can see: worked out once a level. */
  private seenAt512?: Uint8Array;

  /**
   * Copy a part's own textured mesh (a GLB from the part pass) into the level's texture.
   * @param mode 'whole': the part takes this texture everywhere; 'gaps': only where no view painted; 'auto': whole
   *   when over 15% of what players see of the part is unpainted (one coherent texture beats a patchwork of two
   *   that do not line up: planks from the views beside planks from the model), gaps otherwise
   */
  private async applyPart(label: number, glb: ArrayBuffer, mode: 'auto' | 'whole' | 'gaps' = 'auto') {
    this.partFiles.set(this.level!.labels[label] ?? '', glb.slice(0));   // the loader may take the buffer it is given
    const gltf = await new GLTFLoader().parseAsync(glb, '');
    gltf.scene.updateMatrixWorld(true);
    const position: number[] = [], uv: number[] = [];
    let map: THREE.Texture | null = null;
    const v = new THREE.Vector3();
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const g = mesh.geometry, p = g.getAttribute('position'), t = g.getAttribute('uv');
      const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
      if (!t || !mat?.map) return;
      map ??= mat.map;
      const n = g.index ? g.index.count : p.count;
      for (let i = 0; i < n; i++) {
        const k = g.index ? g.index.getX(i) : i;
        v.fromBufferAttribute(p, k).applyMatrix4(mesh.matrixWorld);
        position.push(v.x, v.y, v.z);
        uv.push(t.getX(k), t.getY(k));
      }
    });
    if (!map || !position.length) throw new Error('the textured part has no texture');
    const ours = partMesh(this.level!.geometry, label);
    const match = matchCorners(ours.position, position);
    const theirs = new Float32Array(ours.uv.length);
    for (let i = 0; i < match.corner.length; i++) { theirs[2 * i] = uv[2 * match.corner[i]]; theirs[2 * i + 1] = uv[2 * match.corner[i] + 1]; }
    const tex = map as THREE.Texture;
    tex.colorSpace = THREE.NoColorSpace;   // the level's texture keeps sRGB values as they are
    tex.needsUpdate = true;
    // The part's own texture has the right detail but not the room's tone (it was lit by nothing, and the model
    // chose its own shade): bring its mean colour to the mean of what the views painted of this part, and use it
    // only where no view painted. A part no view painted at all is taken as it came.
    const atlas = this.engine!.atlas;
    const n = 512;
    const { data } = atlas.readBytes([0.5, 0.5, 0.5], n);
    const quality = atlas.cellQuality(n), cells = atlas.texelGeometry(n);
    this.seenAt512 ??= seenCells(cells.pos, cells.nrm, this.level!.bvh, samplePlayerPoints(this.level!, { ...DEFAULT_PLAN, spacing: 1.5 }));
    const painted = [0, 0, 0];
    let count = 0, seen = 0, seenUnpainted = 0;
    for (let i = 0; i < n * n; i++) {
      if (Math.round(cells.pos[4 * i + 3]) - 1 !== label) continue;
      // painted by a view: the finishing fill and an earlier part texture don't count
      const byView = quality[i] > PAINTED && Math.abs(quality[i] - PART_QUALITY) > 1e-4;
      if (this.seenAt512[i]) { seen++; if (!byView) seenUnpainted++; }
      if (!byView) continue;
      for (let k = 0; k < 3; k++) painted[k] += data[4 * i + k] / 255;
      count++;
    }
    const whole = mode === 'whole' || (mode === 'auto' && seen > 0 && seenUnpainted / seen > 0.15);
    let gain: [number, number, number] = [1, 1, 1];
    if (count >= 30) {
      const mean = atlas.bakePart(ours.uv, theirs, tex, 0, [1, 1, 1], true);
      gain = [0, 1, 2].map((k) => THREE.MathUtils.clamp(painted[k] / count / Math.max(mean[k], 0.02), 0.25, 4)) as [number, number, number];
    }
    atlas.bakePart(ours.uv, theirs, tex, whole ? Infinity : PAINTED, gain);
    tex.dispose();
    return { exact: match.exact, worst: match.worst, gain, paintedCells: count, whole };
  }

  /**
   * The finishing fill (core/finish.ts): give what no view painted its own part's colours, so nothing a player sees
   * is left as bare clay. Filled texels remain targets for any later view. No model call.
   */
  finish() {
    const e = this.engine;
    if (!e || !this.record) throw new Error('paint or load a run first');
    const n = Math.min(1024, e.atlas.size);
    const { data } = e.atlas.readBytes([0.5, 0.5, 0.5], n);
    const quality = e.atlas.cellQuality(n);
    const cells = e.atlas.texelGeometry(n);
    const label = new Int16Array(n * n), painted = new Uint8Array(n * n);
    let island = 0;
    for (let i = 0; i < n * n; i++) {
      label[i] = cells.nrm[4 * i + 3] > 0.5 ? Math.round(cells.pos[4 * i + 3]) - 1 : -1;
      painted[i] = quality[i] > PAINTED ? 1 : 0;
      if (label[i] >= 0) island++;
    }
    const f = fillColours(data, painted, label, n);
    e.atlas.fillUnpainted(f.rgba, n);
    this.record.finished = true;
    this.viewer?.setMode('textured');
    return { filled: island ? f.filled / island : 0, fromNeighbours: f.filled ? f.near / f.filled : 0 };
  }

  async exportGlb(): Promise<ArrayBuffer> {
    if (!this.engine) throw new Error('nothing to export');
    return exportGlb(this.engine);
  }

  private async put(id: string, file: string, body: Blob | string) {
    const res = await fetch(`/api/runs/${encodeURIComponent(id)}/${file}`, { method: 'POST', body });
    if (!res.ok) throw new Error(`saving ${file} failed: ${res.status}`);
  }

  private meta(r: RunRecord, partial = false) {
    return {
      level: r.level, options: r.options, viewSize: this.engine!.size, atlasSize: this.engine!.atlas.pageSize,
      projection: { minCos: this.engine!.options.minCos, edgeGuard: this.engine!.options.edgeGuard, frameMargin: this.engine!.options.frameMargin }, lighting: this.engine!.clay.lighting, cost: r.cost, seconds: r.seconds,
      ...(partial ? { partial: true } : {}), ...(r.pbr ? { pbr: r.pbr } : {}),
      ...(this.level?.shapes ? { parts: [...this.level.labels] } : {}),
      ...(r.finished ? { finished: true } : {}),
      ...(r.ground ? { ground: r.ground } : {}),
      ...(r.groundNotes?.length ? { groundNotes: r.groundNotes } : {}),
      ...(r.partPass?.length ? { partPass: r.partPass } : {}),
      ...(this.viewer?.floorDetailSettings ? { floorDetail: this.viewer.floorDetailSettings } : {}),
      materialPresets: { ...this.engine!.materialPresets },
      ...(this.level?.playArea ? { area: [...this.level.playArea.min.toArray(), ...this.level.playArea.max.toArray(), ...(this.level.spots ?? []).flatMap((p) => p.toArray())] } : {}),
      ...(this.level?.unwrap ? { unwrap: { hash: this.level.unwrap.hash, reason: this.level.unwrap.reason } } : {}),
      ...(this.level?.layout?.applied ? { layout: { kind: this.level.layout.kind ?? 'seen', hash: this.level.layout.hash, gain: this.level.layout.gain } } : {}),
      ...(this.level?.pages ? { pages: { count: this.engine!.atlas.pageCount, size: this.engine!.atlas.pageSize, hash: this.level.pages.hash, gain: this.level.pages.gain } } : {}),
      ...(this.engine!.ao ? { ao: { size: this.engine!.ao.size, rays: this.engine!.ao.rays, radius: this.engine!.ao.radius } } : {}),
      plan: { points: r.plan.points.map((p) => p.toArray()), views: r.plan.views, waves: r.plan.waves, predicted: r.plan.predicted },
      views: r.views.map(({ clay: _c, state: _s, edit: _e, gen: _g, comp: _p, ...rest }) => rest),
    };
  }

  private async saveView(id: string, v: ViewRecord) {
    if (!v.state.length) return;   // already on disk: saved as it was painted, or loaded for a top-up
    const S = this.engine!.size;
    await this.put(id, `view_${v.index}_clay.jpg`, await toBlob(v.clay, S, S, 'image/jpeg', 0.92));
    await this.put(id, `view_${v.index}_state.jpg`, await toBlob(v.state, S, S, 'image/jpeg', 0.92));
    await this.put(id, `view_${v.index}_gen.jpg`, await toBlob(v.gen, S, S, 'image/jpeg', 0.92));
    await this.put(id, `view_${v.index}_comp.png`, await toBlob(v.comp, S, S, 'image/png'));
  }

  /** Save a run (metadata + every view's images + texture + maps + GLB) through the dev server. */
  async saveRun(id: string, onProgress?: (msg: string) => void) {
    const r = this.record;
    if (!r || !this.engine) throw new Error('no run to save');
    await this.saving;   // views written as they were painted
    for (const v of r.views) {
      if (!v.state.length) continue;
      onProgress?.(`view ${v.index}`);
      await this.saveView(id, v);
    }
    onProgress?.('texture');
    const atlas = this.engine.atlas;
    if (atlas.pageCount > 1) {
      // each page as it is (texture_0.png is the first: row by row), and all of them side by side, smaller, to look at
      for (let k = 0; k < atlas.pageCount; k++) {
        await this.put(id, `texture_${k}.png`, await toBlob(atlas.pageBytes(k), atlas.pageSize, atlas.pageSize, 'image/png'));
      }
    }
    const { data, size } = atlas.readBytes([0.5, 0.5, 0.5], atlas.pageCount > 1 ? Math.min(atlas.size, 4096) : atlas.size);
    await this.put(id, 'texture.png', await toBlob(data, size, size, 'image/png'));
    const sky = this.viewer!.sky;
    await this.put(id, 'sky.jpg', await toBlob(sky.data, sky.width, sky.height, 'image/jpeg', 0.92));
    const { pbr, ao } = this.engine;
    if (ao) {
      onProgress?.('ambient occlusion');
      await this.put(id, 'ao.png', await toBlob(aoImage(ao), ao.size, ao.size, 'image/png'));
    }
    if (pbr) {
      onProgress?.('normal and roughness maps');
      await this.put(id, 'normal.png', await toBlob(pbr.normal, pbr.size, pbr.size, 'image/png'));
      // the saved ORM map carries the occlusion too, as the exported material's does
      await this.put(id, 'orm.png', await toBlob(ao ? withOcclusion(pbr.orm, pbr.size, ao) : pbr.orm, pbr.size, pbr.size, 'image/png'));
      for (const channel of ['height', 'normal', 'roughness'] as const) {
        const pixels = pbr.source?.[channel];
        if (pixels) await this.put(id, `pbr_source_${channel}.png`, await toBlob(pixels, pbr.size, pbr.size, 'image/png'));
      }
    }
    onProgress?.('glb');
    await this.put(id, 'level_textured.glb', new Blob([await this.exportGlb()], { type: 'model/gltf-binary' }));
    await this.put(id, 'run.json', JSON.stringify(this.meta(r), null, 1));   // last: a run.json without `partial` is a whole run
  }

  /** Load a saved run and rebuild its texture (no model calls). Returns the view records without images. */
  async loadRun(id: string) {
    if (!this.engine || !this.viewer) throw new Error('load the level first');
    const meta = await (await fetch(`/runs/${id}/run.json`)).json();
    // replay under the projection rules the run was painted with (runs from before they were recorded: the old ones)
    if (!this.projectionSet) {
      this.engine.options.minCos = meta.projection?.minCos ?? 0.08;
      this.engine.options.edgeGuard = meta.projection?.edgeGuard ?? 0;
      this.engine.options.frameMargin = meta.projection?.frameMargin ?? 0;
    }
    const S = this.engine.size;
    const views: ViewRecord[] = [];
    for (const v of meta.views) {
      const comp = await urlToRGBA(`/runs/${id}/view_${v.index}_comp.png`, S, S);
      views.push({ ...v, comp, clay: new Uint8ClampedArray(0), state: new Uint8ClampedArray(0),
        edit: new Uint8Array(0), gen: new Uint8ClampedArray(0) });
    }
    // a level without part names takes the names its shapes had in this run
    if (this.level?.shapes && Array.isArray(meta.parts) && meta.parts.length === this.level.labels.length) {
      for (let k = 0; k < meta.parts.length; k++) this.level.labels[k] = String(meta.parts[k] ?? '');
    }
    const points = (meta.plan.points as number[][]).map((p) => new THREE.Vector3(...p));
    this.engine.materialPresets = validateMaterialAssignments(meta.materialPresets ?? {}, this.level!.labels);
    this.plan = { ...meta.plan, points } as Plan;
    this.record = { level: meta.level, options: meta.options, plan: this.plan!, views, cost: meta.cost, seconds: meta.seconds,
      pbr: sameLayoutAs(meta, this.level) ? meta.pbr : undefined };
    await this.viewer.setFloorDetail();
    this.engine.replay(views);
    // the ground laid from tiles goes back first: it reads the ground as the views alone painted it
    this.groundTiles = undefined;
    if (meta.ground?.files?.length) {
      const g = meta.ground as NonNullable<RunRecord['ground']>;
      this.groundTiles = await Promise.all(g.files.map((f) => urlToRGBA(`/runs/${id}/${f}`, g.size, g.size)));
      this.record.ground = g;
      this.layGround();
    }
    this.groundNoteComps.clear();
    for (const n of (meta.groundNotes ?? []) as NonNullable<RunRecord['groundNotes']>) {
      this.groundNoteComps.set(n.file, await urlToRGBA(`/runs/${id}/${n.file}`, S, S));
      (this.record.groundNotes ??= []).push(n);
    }
    this.paintGroundNotes();
    // parts textured on their own go back on, in the order they were made, then the fill (neither is a view)
    for (const p of (meta.partPass ?? []) as NonNullable<RunRecord['partPass']>) {
      const label = this.level!.labels.indexOf(p.name);
      const res = label >= 0 ? await fetch(`/runs/${id}/${p.file}`) : null;
      if (!res?.ok) continue;
      await this.applyPart(label, await res.arrayBuffer(), p.still ? 'auto' : 'gaps');
      (this.record.partPass ??= []).push(p);
    }
    if (meta.finished) this.finish();
    this.viewer.sky.reset();
    for (const v of views) this.addSky(v);
    this.viewer.sky.finish();
    // The views are projected again, so a run fits any layout; the maps saved with it only fit the layout they were made on.
    const sameLayout = sameLayoutAs(meta, this.level);
    if (!sameLayout && (meta.pbr || meta.ao)) meta.mapsSkipped = true;
    this.engine.pbr = undefined;
    if (meta.pbr && sameLayout) {
      const s = meta.pbr.size as number;
      this.engine.pbr = { ...meta.pbr, normal: await urlToRGBA(`/runs/${id}/normal.png`, s, s),
        orm: await urlToRGBA(`/runs/${id}/orm.png`, s, s) };
      if (meta.pbr.source) {
        const source: AlignedMapSource = { ...meta.pbr.source, height: undefined, normal: undefined, roughness: undefined };
        for (const channel of ['height', 'normal', 'roughness'] as const) if (meta.pbr.source[channel])
          source[channel] = await urlToRGBA(`/runs/${id}/pbr_source_${channel}.png`, s, s);
        validateAlignedSource(source);
        if (source.layoutHash !== layoutHash(this.level!.geometry.getAttribute('uv').array)) throw new Error('Saved material sources use a different UV layout');
        this.engine.pbr!.source = source;
      }
    }
    this.viewer.setPbr(this.engine.pbr);
    this.engine.ao = undefined;
    if (meta.ao && sameLayout) {
      const s = meta.ao.size as number;
      const rgba = await urlToRGBA(`/runs/${id}/ao.png`, s, s);
      const data = new Uint8ClampedArray(s * s);
      for (let i = 0; i < data.length; i++) data[i] = rgba[4 * i];
      this.engine.ao = { ...meta.ao, size: s, data, seconds: 0 };
    }
    this.viewer.setAo(this.engine.ao);
    if (meta.floorDetail) {
      try {
        if (typeof meta.floorDetail.paintHash !== 'string') throw new Error('The saved material has no paint fingerprint');
        await this.viewer.setFloorDetail(meta.floorDetail.spec, meta.floorDetail.paintHash);
        this.viewer.setFloorDetailEnabled(meta.floorDetail.enabled !== false);
      } catch (e) {
        meta.floorDetailSkipped = String((e as Error).message);
        console.warn(`Floor detail skipped: ${meta.floorDetailSkipped}`);
      }
    }
    return meta;
  }
}

/** Whether the maps saved with a run were made on the layout the level has now. */
function sameLayoutAs(meta: { unwrap?: { hash?: string }; layout?: { hash?: string }; pages?: { hash?: string } }, level?: Level): boolean {
  return meta.unwrap?.hash === level?.unwrap?.hash && meta.layout?.hash === (level?.layout?.applied ? level.layout.hash : undefined) && meta.pages?.hash === level?.pages?.hash;
}

export { INDOOR, OUTDOOR };
