/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import * as THREE from 'three';
import { LIGHTING, type Session } from './session';
import { DEFAULT_PIPELINE, falPlanes, generateView, loadStyleImages, prepareView, promptText, quote, siteFor, type PipelineEvent, type PipelineOptions } from './core/pipeline';
import { MODELS } from './providers/models';
import type { AoOptions } from './core/ao';
import type { PbrOptions } from './core/pbr';
import type { PlanOptions } from './core/planner';
import { configureFal } from './providers/fal';
import { DEFAULT_PLAN, plan as makePlan, planStats, samplePlayerPoints } from './core/planner';
import { seenCells } from './core/layout';
import { PAINTED } from './core/atlas';
import type { GroundOptions } from './core/ground';
import type { Note } from './core/notes';
import { bitmapToRGBA, toDataUrl, urlToRGBA } from './core/image';
import { checkView, GRID } from './core/fidelity';
import { frameUse, sampling, summarise, type RunMetrics, type ViewMetrics } from './core/metrics';
import { loadSegmenter } from './providers/sam';
import { maskImage } from './core/composite';
import { Demo } from './demo';
import type { FloorDetailSpec } from './core/floor-detail';
import { MATERIAL_PRESETS, type MaterialAssignments } from './core/material-presets';
import type { AlignedMapSource } from './core/aligned-maps';
import { validateViews } from './core/validation-engine';
import type { WeightOverlay } from './core/viewer';

/**
 * window.trompe: the same operations as the UI, for headless runs (scripts/texture.mjs) and the demo capture.
 * Progress is printed as `TROMPE {json}` console lines so the Node side can stream it.
 */
export function makeApi(session: Session) {
  const emit = (o: unknown) => console.log(`TROMPE ${JSON.stringify(o)}`);
  const forward = (e: PipelineEvent) => {
    if (e.type === 'planned') emit({ type: e.type, views: e.plan.views.length, waves: e.plan.waves.length,
      points: e.plan.points.length, predicted: e.plan.predicted[e.plan.predicted.length - 1] });
    else if (e.type === 'check' || e.type === 'parts') emit({ type: e.type, message: e.message });
    else if (e.type === 'view-start') emit({ type: e.type, index: e.index, wave: e.wave, model: e.model });
    else if (e.type === 'view-done') emit({ type: e.type, index: e.view.index, model: e.view.model,
      unknown: +e.view.unknownFraction.toFixed(3), left: +(e.view.left ?? 0).toFixed(3),
      ...(e.view.ignored !== undefined ? { ignored: +e.view.ignored.toFixed(3), merged: +(e.view.merged ?? 0).toFixed(3), again: !!e.view.spec.again } : {}),
      ...(e.view.swatches ? { swatches: true } : {}), seconds: +e.view.seconds.toFixed(1), coverage: +e.view.coverage.toFixed(3),
      predicted: +e.view.predicted.toFixed(3), cost: +e.cost.toFixed(3), elapsed: +e.elapsed.toFixed(1) });
    else if (e.type === 'error') emit({ type: e.type, index: e.index, message: e.message });
    else if (e.type === 'done') emit({ type: e.type, views: e.record.views.length, cost: e.record.cost, seconds: e.record.seconds });
  };
  return {
    session,
    /** Stable binary export for CLI/MCP adapters; does not trigger a browser download. */
    exportGlb: () => session.exportGlb(),
    /** Local estimate from bundled model prices, not a live quote or a spending limit. */
    quote(options: Partial<Parameters<typeof quote>[1]> = {}) {
      if (!session.plan || !session.engine) throw new Error('Plan cameras first');
      const opts = { firstModel: DEFAULT_PIPELINE.firstModel, fillModel: DEFAULT_PIPELINE.fillModel,
        viewSize: session.engine.size, ...options };
      if (!MODELS[opts.firstModel] || !MODELS[opts.fillModel]) throw new Error('Unknown image model');
      return { ...quote(session.plan, opts), currency: 'USD', estimateOnly: true,
        excludes: ['naming', 'reference-image surcharges', 'additional repair passes', 'PBR maps'],
        source: 'bundled model prices; verify current provider prices before generation' };
    },
    materialPresetOptions: MATERIAL_PRESETS,
    materialPresets: (assignments: MaterialAssignments) => session.setMaterialPresets(assignments),
    /** Import matching atlas maps without resizing them or inferring height from the painting. */
    async materialMaps(o: { size: number; layoutHash: string; heightUrl?: string; normalUrl?: string; roughnessUrl?: string; roughnessBase?: number }) {
      const engine = session.engine;
      if (!engine) throw new Error('Load a level first');
      const revision = engine.atlas.revision;
      if (!Number.isInteger(o.size) || o.size < 1 || o.size > engine.gpu.renderer.capabilities.maxTextureSize) throw new Error('Invalid material map size');
      const source: AlignedMapSource = { size: o.size, layoutHash: o.layoutHash,
        kind: o.heightUrl ? 'dedicated-height' : o.normalUrl ? 'legacy-normal' : 'flat', roughnessBase: o.roughnessBase ?? .88,
        roughnessMode: o.roughnessBase === undefined ? 'absolute' : 'relative' };
      for (const [channel, url] of [['height', o.heightUrl], ['normal', o.normalUrl], ['roughness', o.roughnessUrl]] as const) {
        if (!url) continue;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Material ${channel} image failed: ${response.status}`);
        const image = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        try {
          if (image.width !== o.size || image.height !== o.size) throw new Error(`Material ${channel} image must match the ${o.size} × ${o.size} aligned set`);
          source[channel] = bitmapToRGBA(image, o.size, o.size);
          if (channel === 'roughness') for (let i = 0; i < source[channel]!.length; i += 4) {
            const pixels = source[channel]!; pixels[i + 1] = pixels[i]; pixels[i] = pixels[i + 3] = 255; pixels[i + 2] = 0;
          }
        } finally { image.close(); }
      }
      if (session.engine !== engine || engine.atlas.revision !== revision) throw new Error('The painting changed while material maps were loading');
      session.setMaterialMapSource(source);
      return { size: o.size, source: source.kind };
    },
    /** Load the prepared Sento floor in the main renderer; no paid calls. */
    loadSentoFloor: () => session.loadSentoFloor(),
    /** Assign a reviewed material/mask to the current layout, or remove it. */
    async floorDetail(spec?: FloorDetailSpec) {
      if (!session.viewer) throw new Error('Load a level first');
      await session.viewer.setFloorDetail(spec);
      return session.viewer.floorDetailState;
    },
    floorDetailEnabled(enabled: boolean) {
      if (!session.viewer) throw new Error('Load a level first');
      session.viewer.setFloorDetailEnabled(enabled);
      return session.viewer.floorDetailState;
    },
    demo: new Demo(session),
    async load(url: string, opts: { lighting?: string; atlasSize?: number; viewSize?: number; name?: string; layout?: 'file' | 'seen' | 'near'; area?: number[]; pages?: number; unwrap?: 'auto' | 'always' | 'off'; cavity?: number; weights?: boolean } = {}) {
      const name = opts.name ?? url.split('/').pop()!.replace(/\.\w+$/, '');
      return session.load(url, name, LIGHTING[opts.lighting ?? 'outdoor'], opts.atlasSize ?? 4096, opts.viewSize ?? 2048, opts.layout ?? 'file', opts.area, opts.pages ?? 1, opts.unwrap ?? 'auto', opts.cavity ?? 0, !!opts.weights);
    },
    /** Compute the four geometry prepasses (openness, convex curvature, static light, semantic class) and optionally display a false-colour debug overlay. */
    weights(overlay?: WeightOverlay) {
      if (overlay) return session.setWeightOverlay(overlay);
      const sw = session.ensureWeights();
      return { triangles: sw.importance.length, seconds: sw.seconds, classes: sw.classes, mean: sw.mean };
    },
    /** How views are projected into the texture from here on (and when a run is loaded): see EngineOptions. */
    projection(o: { minCos?: number; edgeGuard?: number; frameMargin?: number }) {
      const e = session.engine;
      if (!e) throw new Error('load a level first');
      session.projectionSet = true;   // a run loaded after this keeps these rules, not the ones it was painted with
      if (o.minCos !== undefined) e.options.minCos = o.minCos;
      if (o.edgeGuard !== undefined) e.options.edgeGuard = o.edgeGuard;
      if (o.frameMargin !== undefined) e.options.frameMargin = o.frameMargin;
      return { minCos: e.options.minCos, edgeGuard: e.options.edgeGuard, frameMargin: e.options.frameMargin };
    },
    plan(opts: Partial<PlanOptions> = {}) {
      const p = session.makePlan(opts);
      return { views: p.views.length, points: p.points.length, waves: p.waves.map((w) => w.length),
        predicted: p.predicted[p.predicted.length - 1], sharpness: p.sharpness, texture: p.texture,
        ...(p.budget ? { budget: p.budget } : {}), stats: { ...planStats },
        pitch: p.views.map((v) => Math.round(THREE.MathUtils.radToDeg(v.pitch))), fov: p.views.map((v) => v.fov),
        // where the cameras stand (eye positions, to 0.1 m): shows at a glance whether a mezzanine or a yard was reached
        spots: p.points.map((q) => q.toArray().map((x) => Math.round(x * 10) / 10)) };
    },
    /** Paint the level. `saveAs`: write every view to runs/<saveAs>/ as it's painted, and the whole run at the end. */
    async run(opts: Partial<PipelineOptions>, falKey?: string, saveAs?: string) {
      configureFal(falKey);
      const record = await session.run(opts, forward, saveAs);
      return { views: record.views.length, cost: record.cost, seconds: record.seconds, coverage: record.views.at(-1)?.coverage ?? 0 };
    },
    /** Continue a loaded run where its texture is still missing or poor. */
    async topUp(opts: Partial<PipelineOptions>, falKey?: string, saveAs?: string) {
      configureFal(falKey);
      const record = await session.topUp(opts, forward, saveAs);
      return { views: record.views.length, cost: record.cost, seconds: record.seconds, coverage: record.views.at(-1)?.coverage ?? 0 };
    },
    /** Bake the level's ambient occlusion (no model call). */
    /** The part pass: texture the parts the painting left unpainted on their own (core/partpass.ts). One model call a part. */
    async parts(opts: { max?: number; minShare?: number; only?: string[] } = {}, falKey?: string, saveAs?: string) {
      configureFal(falKey);
      return session.partPass(opts, (message) => emit({ type: 'check', message }), saveAs);
    },
    /**
     * The ground pass: tiles of the ground's material painted from straight above and laid over all of the ground
     * (core/ground.ts). One cheap image a tile; with `reuse`, the run's tiles are laid again and nothing is painted.
     */
    async ground(opts: Partial<GroundOptions> & { style?: string; only?: string[]; seed?: number; reuse?: boolean } = {}, falKey?: string, saveAs?: string) {
      configureFal(falKey);
      return session.ground(opts, (message) => emit({ type: 'check', message }), saveAs);
    },
    /** Notes on ground that is already painted: each carried out from straight above its spot (core/notes.ts). One H3 image a note. */
    /** Paint regions that are painted wrongly again: each a box in the level, filled as a hole is (Session.repairRegions); the views join the run. */
    async repair(regions: { min: [number, number, number]; max: [number, number, number]; text?: string; from?: [number, number, number]; again?: number }[], falKey?: string, saveAs?: string, dry = false) {
      configureFal(falKey);
      return session.repairRegions(regions, (message) => emit({ type: 'check', message }), saveAs, dry);
    },
    async groundNotes(notes: Note[], falKey?: string, saveAs?: string) {
      configureFal(falKey);
      return session.groundNotes(notes, (message) => emit({ type: 'check', message }), saveAs);
    },
    /** The prop pass: props painted by H3 from a few cameras round each, with a note and reference pictures (core/proppass.ts). */
    async props(opts: { max?: number; only?: string[]; angles?: number; runId?: string; mode?: 'sheet' | 'sequence'; model?: string; split?: boolean; cels?: string[]; dry?: boolean;
      cameras?: Record<string, { position: [number, number, number]; target: [number, number, number]; fov?: number }[]> } = {}, falKey?: string, saveAs?: string) {
      configureFal(falKey);
      return session.propPass(opts, (message) => emit({ type: 'check', message }), saveAs);
    },
    /** The finishing fill: what no view painted takes its part's colours (core/finish.ts). No model call. */
    finish() {
      return session.finish();
    },
    async ao(opts: Partial<AoOptions> = {}) {
      const a = await session.bakeAo(opts, (done, total) => { if (done === total) emit({ type: 'ao', done, total }); });
      return { size: a.size, rays: a.rays, radius: a.radius, seconds: a.seconds };
    },
    /** Name the shapes of a level that came without part names; returns the names by shape. */
    async nameParts(look: string = DEFAULT_PIPELINE.style, falKey?: string) {
      configureFal(falKey);
      const r = await session.nameParts(look, (done, total) => emit({ type: 'parts', message: `naming shape ${done}/${total}` }));
      return { names: r.names, cost: r.cost, seconds: r.seconds };
    },
    /** Normal and roughness maps for the painted texture (one material-model call per tile). */
    async pbr(opts: Partial<PbrOptions> = {}, falKey?: string) {
      configureFal(falKey);
      const m = await session.makePbr(opts, (done, total) => emit({ type: 'pbr', done, total }));
      return { size: m.size, tiles: m.tiles, cost: m.cost, seconds: m.seconds };
    },
    /** Walk the level from the plan's point nearest `near` (or the first), for stills and tests; null to stop. */
    walk(o: { near?: [number, number, number]; yaw?: number } | null = {}) {
      const v = session.viewer!;
      if (!o) { v.stopWalk(); return null; }
      const w = v.startWalk(session.walkStart(o.near ? new THREE.Vector3(...o.near) : undefined), o.yaw ?? 0);
      return { feet: w.position.toArray(), onGround: w.onGround };
    },
    async save(id: string) {
      await session.saveRun(id, (msg) => emit({ type: 'save', msg }));
      return true;
    },
    /**
     * The point of the level under a pixel of a camera's picture, for pinning a note there: `x`, `y` from 0 to 1
     * across and down the picture a `snapshot` from the same camera gives. Null where the pixel shows no surface.
     */
    pick(o: { position: [number, number, number]; target: [number, number, number]; fov?: number; aspect?: number; x: number; y: number }) {
      const cam = new THREE.PerspectiveCamera(o.fov ?? 60, o.aspect ?? 1, 0.05, 2000);
      cam.position.set(...o.position);
      cam.lookAt(...o.target);
      cam.updateMatrixWorld(true);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(o.x * 2 - 1, 1 - o.y * 2), cam);
      const hit = session.level!.bvh.raycastFirst(ray.ray, THREE.DoubleSide);
      return hit ? (hit.point.toArray().map((n) => +n.toFixed(3)) as [number, number, number]) : null;
    },
    /** Render the viewer from a camera and return a JPEG data URL (debugging and stills). */
    snapshot(o: { position: [number, number, number]; target: [number, number, number]; fov?: number; width?: number;
      height?: number; mode?: 'clay' | 'textured' | 'lit'; overlay?: boolean; weights?: WeightOverlay }) {
      const v = session.viewer!;
      const w = o.width ?? 1280, h = o.height ?? 720;
      const prevWeights = v.weightOverlay;
      v.resize(w, h);
      v.camera.fov = o.fov ?? 60;
      v.camera.position.set(...o.position);
      v.camera.lookAt(...o.target);
      v.camera.updateProjectionMatrix();
      v.setMode(o.mode ?? 'clay');
      if (o.weights !== undefined) session.setWeightOverlay(o.weights);
      v.overlay.visible = o.overlay ?? true;
      v.render(v.camera);
      const dataUrl = session.canvas.toDataURL('image/jpeg', 0.92);
      if (o.weights !== undefined && prevWeights !== o.weights) session.setWeightOverlay(prevWeights);
      return dataUrl;
    },
    bounds() {
      const b = session.level!.bounds;
      return { min: b.min.toArray(), max: b.max.toArray() };
    },
    /** Exercise every GPU pass without calling any model: paints views with their own clay renders. */
    async selfTest(views = 4) {
      const e = session.engine!;
      const p = session.makePlan({ maxViews: views });
      const out: number[] = [];
      for (const spec of p.views.slice(0, views)) {
        const { clay } = e.renderView(spec);
        e.paint(spec, clay);
        out.push(e.atlas.coverage());
      }
      session.viewer!.setMode('textured');
      session.viewer!.render();
      session.viewer!.setMode('clay');
      session.viewer!.render();
      const glb = await session.exportGlb();
      const first = e.renderView(p.views[0]);
      return { coverage: out, glbBytes: glb.byteLength, clay: toDataUrl(first.clay, e.size, e.size, 'image/jpeg', 0.9) };
    },
    /**
     * Prompt A/B without a full run: re-paint chosen views of a saved run (texture rebuilt up to just before each)
     * with other options, and optionally paint `roofs` roof-pass views on top of the finished run. Nothing is saved.
     */
    async promptTest(o: { run: string; views: number[]; variants: { name: string; opts: Partial<PipelineOptions>; seeds?: number[] }[];
      roofs?: number; roofOpts?: Partial<PipelineOptions>; dry?: boolean; fresh?: boolean; falKey?: string }) {
      configureFal(o.falKey);
      const e = session.engine!;
      const S = e.size;
      await session.loadRun(o.run);
      const steps = session.record!.views;
      const jpg = (a: Uint8ClampedArray) => toDataUrl(a, S, S, 'image/jpeg', 0.9);
      const out: Record<string, unknown>[] = [];
      for (const n of o.views) {
        const at = steps.findIndex((v) => v.index === n);
        if (at < 0) continue;
        e.replay(steps, o.fresh ? 0 : at);   // fresh: every view starts from bare clay, as a first view
        for (const v of o.variants) {
          const opts = { ...DEFAULT_PIPELINE, ...v.opts };
          const photos = o.dry ? (opts.styleImages ?? []) : await loadStyleImages(opts.styleImages);
          for (const seed of v.seeds ?? [opts.seed + n]) {
            const p = prepareView(e, steps[at].spec, opts, o.fresh || at === 0);
            const site = siteFor(p, photos, opts.styleMax);
            const t = { view: n, variant: v.name, seed, model: p.model.key, mode: p.prompt.mode, unknown: +p.unknownFraction.toFixed(3),
              prompt: promptText(p), state: jpg(p.sent ?? p.state), ...(p.notes?.length ? { notes: p.notes.map((x) => x.note.text) } : {}) };
            if (o.dry) { out.push({ ...t, edit: jpg(maskImage(p.edit)) }); continue; }
            try {
              const r = await generateView(p, S, seed, opts.feather, undefined, undefined, undefined, undefined, site);
              out.push({ ...t, gen: jpg(r.gen), comp: jpg(r.comp), expanded: r.expanded });
            } catch (err) {
              out.push({ ...t, error: String((err as Error)?.message ?? err) });
            }
            emit({ type: 'ab', view: n, variant: v.name, seed });
          }
        }
      }
      if (o.roofs) {
        e.replay(steps, o.fresh ? 0 : steps.length);
        const opts = { ...DEFAULT_PIPELINE, ...o.roofOpts };
        const p = makePlan(e.gpu, e.level, e.views, { maxViews: 0, roofs: o.roofs });
        const roofSpecs = p.views.filter((v) => v.kind === 'roof');
        const shots: string[] = [];
        const shoot = () => {
          const b = e.level.bounds;
          const c = b.getCenter(new THREE.Vector3());
          for (const [pos, fov] of [[[c.x + 20, b.max.y + 10, c.z + 24], 50], [[c.x + 6, b.max.y - 4, c.z + 10], 60]] as const) {
            shots.push(this.snapshot({ position: [...pos], target: [c.x - 4, 2, c.z - 6], fov, width: 1280, height: 800,
              mode: 'textured', overlay: false }));
          }
        };
        shoot();
        for (const spec of roofSpecs) {
          const pr = prepareView(e, spec, opts, false);
          const t = { view: `roof${spec.id}`, variant: 'roof', model: pr.model.key, mode: pr.prompt.mode, unknown: +pr.unknownFraction.toFixed(3),
            prompt: promptText(pr), state: jpg(pr.state), spec };
          if (pr.skip || o.dry) { out.push({ ...t, skipped: pr.skip, edit: jpg(maskImage(pr.edit)) }); continue; }
          try {
            const r = await generateView(pr, S, opts.seed + spec.id, opts.feather);
            e.paint(spec, r.comp);
            out.push({ ...t, gen: jpg(r.gen), comp: jpg(r.comp), expanded: r.expanded });
          } catch (err) {
            out.push({ ...t, error: String((err as Error)?.message ?? err) });
          }
          emit({ type: 'ab', view: `roof${spec.id}` });
        }
        shoot();
        out.push({ view: 'roofs', before: shots[0], after: shots[2], stats: { ...planStats } });
        out.push({ view: 'roofs-close', before: shots[1], after: shots[3] });
      }
      return out;
    },
    /**
     * Run the blockout check over a saved run's generated images, without painting anything: per view, the faces
     * it was to paint with their scores. For tuning the check and for seeing what an old run got wrong.
     */
    async checkRun(id: string, threshold = DEFAULT_PIPELINE.checkThreshold, planes = false, cells = false) {
      const e = session.engine!;
      const S = e.size;
      await session.loadRun(id);
      const steps = session.record!.views;
      const opts = { ...DEFAULT_PIPELINE, ...session.record!.options };
      const roofsByPass = steps.some((v) => v.spec.kind === 'roof');
      const seg = await loadSegmenter((message) => emit({ type: 'check', message }));
      const out: Record<string, unknown>[] = [];
      for (let at = 0; at < steps.length; at++) {
        e.replay(steps, at);   // the texture as it was just before this view
        const p = prepareView(e, steps[at].spec, opts, at === 0, roofsByPass);
        const gen = await urlToRGBA(`/runs/${id}/view_${steps[at].index}_gen.jpg`, S, S);
        const unknown = p.masks.geometry.map((g, i) => (g && !p.masks.known[i] ? 1 : 0));
        const t0 = performance.now();
        const c = await checkView(seg.segment, gen, S, p.faces, unknown, threshold, planes ? falPlanes(steps[at].spec.fov) : undefined,
          { yaw: steps[at].spec.yaw, pitch: steps[at].spec.pitch, cells });
        out.push({ view: steps[at].index, offSurface: c.offSurface === undefined ? undefined : +c.offSurface.toFixed(3), faces: p.faces.faces.length, checked: c.scores.length, ignoredFaces: c.scores.filter((s) => s.kind !== 'ok').length,
          ignored: +(c.replaced + c.merged).toFixed(3), replaced: +c.replaced.toFixed(3), merged: +c.merged.toFixed(3), seconds: +((performance.now() - t0) / 1000).toFixed(2), scores: c.scores.map((s) => +s.iou.toFixed(2)), covers: c.scores.map((s) => +s.cover.toFixed(2)),
          offPlane: c.scores.map((s) => (s.offPlane === undefined ? null : +s.offPlane.toFixed(2))) });
      }
      e.replay(steps);
      return { device: seg.device, views: out };
    },
    /**
     * Measure what the loaded run's cameras delivered (core/metrics.ts): per view how the frame was spent, and over
     * the texture how sharply it is sampled. Replays the run step by step; no model call.
     */
    async validate(id: string, options: { size?: number; atlasSize?: number; heldOut?: boolean; limit?: number } = {}) {
      if (!/^[\w.-]+$/.test(id) || id === '.' || id === '..') throw new Error('Invalid saved run ID');
      const engine = session.engine, record = session.record;
      if (!engine || !record) throw new Error('Load the matching saved run first');
      const response = await fetch(`/runs/${id}/run.json`);
      if (!response.ok) throw new Error('Saved run metadata is unavailable');
      const saved = await response.json();
      if (saved.level !== record.level || (saved.viewSize ?? 1024) !== engine.size || saved.views.length !== record.views.length ||
        saved.views.some((v: { index: number; spec: unknown }, i: number) => v.index !== record.views[i].index || JSON.stringify(v.spec) !== JSON.stringify(record.views[i].spec)))
        throw new Error('Load this saved run at its recorded view resolution before validating it');
      const inputs = [];
      for (const view of record.views.slice(0, options.limit ?? record.views.length)) {
        inputs.push({ spec: view.spec, raw: await urlToRGBA(`/runs/${id}/view_${view.index}_gen.jpg`, engine.size, engine.size) });
      }
      return validateViews(engine, inputs, options);
    },
    async measure(): Promise<RunMetrics> {
      const e = session.engine!;
      const record = session.record;
      if (!record) throw new Error('load a run first');
      const S = e.size, steps = record.views;
      const opts = { ...DEFAULT_PIPELINE, ...record.options };
      const roofsByPass = steps.some((v) => v.spec.kind === 'roof');
      const views: ViewMetrics[] = [];
      e.replay(steps, 0);   // bare, then one view at a time: each is measured against the texture as it found it
      for (let at = 0; at < steps.length; at++) {
        const v = steps[at];
        const p = prepareView(e, v.spec, opts, at === 0, roofsByPass);
        const kept = new Uint8Array(S * S);
        for (let i = 0; i < kept.length; i++) kept[i] = v.comp[4 * i + 3] > 0 ? 1 : 0;
        const shares = p.faces.faces.map((f) => f.cells / (GRID * GRID));
        views.push({ index: v.index, kind: v.spec.again ? 'again' : v.spec.kind ?? 'ground', model: v.model, pitch: Math.round(THREE.MathUtils.radToDeg(v.spec.pitch)),
          ...frameUse(p.geometry, p.masks.known, p.cos, kept), faces: shares.length, maxFace: Math.max(0, ...shares), held: v.ignored, price: v.price });
        e.paint(v.spec, v.comp, v.detail);
      }
      await session.restoreExtras();   // the part textures and the finishing fill go back on
      const G = 512;
      const { pos, nrm } = e.atlas.texelGeometry(G);
      const covered = new Uint8Array(G * G);
      for (let i = 0; i < covered.length; i++) covered[i] = nrm[4 * i + 3] > 0.5 ? 1 : 0;
      // sharpness is of what views (and part textures) painted: the finishing fill has no detail to measure
      // `atlas.a` carries `lens = 1 / tan(fov / 2)` per view (`1` at 90°), so multiplying by `S / 2` gives exact view pixels per metre across mixed lenses.
      const captured = e.atlas.cellQuality(G).map((q) => (q > PAINTED ? q : 0));
      const s = sampling(captured, pos, covered, G, e.atlas.size / G, S / 2);
      // what a player can see, from spots much denser than the cameras', and how much of that is painted
      const V = 256;
      const cells = e.atlas.texelGeometry(V), quality = e.atlas.cellQuality(V);
      const eyes = samplePlayerPoints(e.level, { ...DEFAULT_PLAN, spacing: 1.5 });
      const visible = seenCells(cells.pos, cells.nrm, e.level.bvh, eyes);
      let island = 0, seen = 0, painted = 0, filled = 0;
      for (let i = 0; i < V * V; i++) {
        if (cells.nrm[4 * i + 3] < 0.5) continue;
        island++;
        if (visible[i]) { seen++; if (quality[i] > PAINTED) painted++; else if (quality[i] > 0) filled++; }
      }
      return { ...summarise(views, s, e.atlas.coverage(), record.cost), seen: { share: island ? seen / island : 0, painted: seen ? painted / seen : 0, filled: seen ? filled / seen : 0 } };
    },
    async loadRun(id: string) {
      const meta = await session.loadRun(id);
      session.viewer?.setMode('textured');
      return { views: meta.views.length, cost: meta.cost };
    },
  };
}
