/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import * as THREE from 'three';
import { detailOf, GEOMETRY_MODEL, MODELS, priceOf, prompts, type EditModel, type PromptContext, type PromptSetting } from '../providers/models';
import { runGeometry } from '../providers/fal';
import { isLocalRoute, mergeProviderOptions, routeEdit, type LocalBackend, type ProviderFallback, type ProviderKind, type ProviderOptions } from '../providers/router';
import { loadSegmenter } from '../providers/sam';
import { colorCorrect, dilate, editMask, featherComposite, fraction, keepOnly, maskImage, masksFromState, paintedFromState, untouched,
  type ViewMasks } from './composite';
import type { Engine } from './engine';
import { checkView, GRID, viewFaces, type Planes, type Segment, type ViewFaces } from './fidelity';
import { bitmapToRGBA, resizeRGBA, toDataUrl } from './image';
import { paintability } from './paintability';
import { defectMap, fullDetail } from './defects';
import { DEFAULT_PLAN, FLOOR_BAND, cellDensity, holeLookViews, holeTargets, holeViews, lookViews, pixelsPerMetre, plan as makePlan, samplePlayerPoints, surfaceOf, type Plan, type PlanOptions } from './planner';
import { nameParts } from './naming';
import { classifyView, describeView } from './semantics';
import { cellWeights } from './surface-weights';
import { swatchSheet, wantsSwatches } from './swatches';
import { makeCamera, ViewRenderer, type ViewSpec } from './views';

export interface PipelineOptions {
  /** The look, as materials only: anything named here (a fountain, a stall) gets painted onto walls. */
  style: string;
  /** Roof material for the roof passes. */
  roofStyle: string;
  /** What the ground is made of, for the floor pass: the ground only, as it looks from straight above. */
  floorStyle: string;
  /**
   * How many earlier views of the same place a gap-filling view is sent as reference pictures, with a model that takes
   * several images (core/references.ts). One to three help; more pull the picture away from the view. 0: none.
   */
  references: number;
  /** The model for hole and clean-up views, when it is not the fill model (a faster one, for small touch-ups). */
  holeModel?: string;
  /**
   * Hole and clean-up views carry notes that name their biggest gaps (core/notes.ts `gapNotes`), with a model that
   * reads notes: the gap is outlined on the render and labelled with its part's name.
   */
  gapNotes: boolean;
  /** Things to add at spots in the level, drawn as notes onto the renders of the views that see them (core/notes.ts). */
  notes?: Note[];
  /** Hole and clean-up views continue the surfaces around a gap and add no windows or doors of their own. */
  plainFills: boolean;
  /** Paint surface colour only, with no shading (a diffuse pass), as a base for normal, roughness and occlusion maps. */
  diffuse: boolean;
  /** How the picture is described to a caption-style model: unset (a photorealistic photo), 'photo', 'aaa' or 'scout' (see PromptContext). */
  wording?: 'photo' | 'aaa' | 'scout' | 'retro' | 'remaster' | 'survey' | 'cel' | 'transfer' | 'production';
  /** How the place is worded when the standard wording (walls with windows and shutters, plaster, market stalls) does not fit it. */
  setting?: PromptSetting;
  /**
   * Photos of the real place the level is built after, as URLs: every view is sent them beside its render, as many
   * as its model takes (EditModel.maxStyle), for what the surfaces are like: material, colour, carving, wear. They
   * take the place of the sample sheet (`styleReference`). Close shots of surfaces serve best; a wide shot of the
   * place is the kind of picture a model hands back in place of the view.
   */
  styleImages?: string[];
  /**
   * How many of them a view is sent, when not as many as its model takes by default (EditModel.maxStyle: three or
   * four, set where the references are photos of surfaces). A look that is a film's and not a material's is carried
   * by more pictures: its machines, its rooms, its decks. MiniMax H3 takes up to 16 images, FLUX 3 Klein ten.
   */
  styleMax?: number;
  firstModel: string;
  fillModel: string;
  /** Views with more than this share of unpainted geometry use the first-view model. */
  mostlyNew: number;
  feather: number;
  seed: number;
  plan: Partial<PlanOptions>;
  /**
   * Check every painted view against the blockout (core/fidelity.ts) and hold back faces the model painted over:
   * what it replaced with something else never goes onto the level, what it merged into a neighbour waits for the
   * view's second go.
   */
  check: boolean;
  /** A face was painted over when no mask the segmentation model offers for it overlaps it by this much (IoU). */
  checkThreshold: number;
  /**
   * Second goes per view: when a view has faces held back, the same camera paints again once the planned views
   * are done, only what is still unpainted, with a prompt that says the shapes are parts of their own (one more
   * fill-model call). 0: merged faces are accepted at once, and only replaced ones are held back.
   */
  checkRetries: number;
  /** A second go is worth a call when more than this share of the frame was held back. */
  retryAbove: number;
  /**
   * A hole view or a second go is only paid for when it can turn at least this share of its frame into texture
   * (unpainted level seen at a usable angle). By the time such a view comes up, others have often painted its part.
   */
  minFresh: number;
  /**
   * Also test big flat faces with a geometry model (one MoGe-2 call per view that has one): a face that is flat in
   * the level must be flat in the painting. Catches a scene painted as one object across a wall, which the masks
   * alone let through.
   */
  checkPlanes: boolean;
  /** With the plane test: also hold back, cell by cell, patches of a flat face painted as some other surface. */
  checkCells: boolean;
  /**
   * Show mostly-unpainted views a sheet of material samples from the texture so far, so they match its paving and
   * plaster instead of inventing their own (core/swatches.ts). Off by default: measured on five cameras it brought
   * colours only a little closer, and a view with too little in it can come back as the sheet itself.
   */
  styleReference: boolean;
  /**
   * For a level that came without part names: have a vision model name its shapes before painting, so the prompts
   * can say what each gray shape is (core/naming.ts). Does nothing when the file names its parts or they are
   * already named.
   */
  nameParts: boolean;
  /** Primary inference route per job: 'fal' (cloud default), 'local' ($0 local endpoint), or 'auto' (local if reachable, else fal). */
  provider?: ProviderKind;
  /** Fallback route when the primary provider fails or is unreachable ('none' by default so local runs stay offline/free). */
  providerFallback?: ProviderFallback;
  /** Local backend protocol: 'auto' probes ComfyUI (:8188), diffusers (:8000) and Hunyuan3D-Paint (:8081). */
  localBackend?: LocalBackend;
  /** Base URL of the local inference endpoint (e.g. 'http://127.0.0.1:8188'). */
  localUrl?: string;
  /** Optional local checkpoint / model identifier override. */
  localModel?: string;
  /** Optional custom ComfyUI API workflow JSON template. */
  localWorkflow?: Record<string, unknown>;
  /** Route diminishing-return tail views (`plan.budget.localModelTailViews`) to local while keeping hero views on cloud. */
  localTail?: boolean;
}

export const DEFAULT_PIPELINE: PipelineOptions = {
  style: 'a Mediterranean hill village: weathered limestone and ochre plaster walls, wooden doors and shutters, worn cobblestone paving',
  roofStyle: 'old terracotta clay roof tiles: curved Mediterranean tiles in neat rows running down the slope, weathered and slightly uneven, with patches of lichen',
  floorStyle: 'worn cobblestone paving: rounded stones in warm beige and gray, tightly set',
  plainFills: true, diffuse: false, references: 2, gapNotes: false,
  firstModel: 'flux3-klein', fillModel: 'flux3-klein', mostlyNew: 0.75, feather: 10, seed: 7, plan: {},
  check: true, checkCells: false, checkThreshold: 0.5, checkRetries: 1, retryAbove: 0.01, minFresh: 0.01, checkPlanes: true, styleReference: false, nameParts: true,
};

import { NOTE_OPEN, drawNotes, gapNotes, notesInView, pinNotes, type Note, type NoteInView, type PinnedNote } from './notes';
import { focusOf, pickReferences } from './references';

export interface ViewRecord {
  index: number;
  wave: number;
  spec: ViewSpec;
  model: string;
  /** Which inference backend actually painted this view ('fal' or 'local'). */
  provider?: 'fal' | 'local';
  first: boolean;
  unknownFraction: number;
  /** The prompt text sent with this view. */
  prompt?: string;
  /** Share of the area to paint that the model handed back unpainted (left out of the projection). */
  left?: number;
  /** Share of the area to paint in faces the model painted over and that were held back; unset when the view wasn't checked. */
  ignored?: number;
  /** Share of the area to paint in faces the model merged into a neighbour, held back or accepted. */
  merged?: number;
  /** The notes this view was sent and asked to carry out (core/notes.ts), by their words. */
  notes?: string[];
  /** The earlier views this one was sent as reference pictures of the place (core/references.ts), by index. */
  references?: number[];
  /** The view was shown the sheet of material samples (core/swatches.ts). */
  swatches?: boolean;
  /** How many photos of the real place the view was sent (PipelineOptions.styleImages). */
  site?: number;
  seconds: number;
  price: number;
  /** Under 1 when the model painted smaller than the view and its image was scaled up: the share of real detail along a side. */
  detail?: number;
  /** top-down RGBA at view size */
  clay: Uint8ClampedArray;
  state: Uint8ClampedArray;
  edit: Uint8Array;
  gen: Uint8ClampedArray;
  comp: Uint8ClampedArray;
  coverage: number;   // painted share of the texture after this view
  predicted: number;  // planner's share of reachable surface captured after this view
}

export interface RunRecord {
  level: string;
  /** Names of the level's shapes as this run used them, when the file itself named nothing. */
  parts?: string[];
  options: PipelineOptions;
  plan: Plan;
  views: ViewRecord[];
  /** What the image models cost (the PBR maps, when made, are counted in `pbr`). */
  cost: number;
  seconds: number;
  /** The finishing fill was applied (core/finish.ts): what no view painted carries its part's colours. */
  finished?: boolean;
  /** Parts textured on their own (core/partpass.ts), in the order they were applied; `file` is the textured GLB in the run's folder. */
  partPass?: { name: string; file: string; price: number; exact: boolean; /** Made to match a still of the part in the painted room. */ still?: boolean }[];
  /** The ground laid from tiles (core/ground.ts); `files` are the tiles in the run's folder. */
  ground?: { files: string[]; size: number; style: string; span: number; cell: number; turn: number; dirt: number; seed: number; only?: string[]; price: number;
    /** With `only`: every face of those parts, not just the ones facing up. */
    any?: boolean;
    /** 'mirror': the tile repeated and mirrored at its edges (a material with a grain); default: random patches. */
    lay?: 'patches' | 'mirror';
    /** False: the tiles keep their own tone; they are not brought to the tone the views gave the surface (a new material). */
    match?: boolean };
  /** Notes carried out on the ground after it was laid (Session.groundNotes); `file` is the picture in the run's folder. */
  groundNotes?: { text: string; spec: ViewSpec; file: string; price: number }[];
  /** Texture-space multi-view seam consolidation applied after view projection (core/consolidate.ts). */
  consolidated?: { size: number; flow?: boolean; lambda?: number; before: import('./consolidate').SeamScore; after: import('./consolidate').SeamScore };
  /** Paint3D-style UV-space inpainting + intrinsic delighting & importance-gated sharpening (core/uv-refine.ts). */
  uvRefined?: { size: number; delight?: number; sharpen?: number; importanceGate?: number; unpaintedBefore: number; unpaintedAfter: number;
    bakedShadingBefore: import('./uv-refine').BakedShadingScore; bakedShadingAfter: import('./uv-refine').BakedShadingScore };
  /** Normal and roughness maps made for this run's texture (core/pbr.ts). */
  pbr?: import('./pbr').PbrMetadata;
}

export type PipelineEvent =
  | { type: 'planned'; plan: Plan; options: PipelineOptions }
  /** News from the blockout check: the model loading, or why views are painted without it. */
  | { type: 'check'; message: string }
  /** News from naming the level's shapes; `names` once they are in. */
  | { type: 'parts'; message: string; names?: string[] }
  | { type: 'view-start'; index: number; wave: number; model: string; state: Uint8ClampedArray }
  | { type: 'view-done'; view: ViewRecord; cost: number; elapsed: number }
  | { type: 'error'; index: number; message: string }
  | { type: 'done'; record: RunRecord };

async function withRetry<T>(fn: (attempt: number) => Promise<T>, tries = 2): Promise<T> {
  let last: unknown;
  for (let a = 0; a < tries; a++) {
    try {
      return await fn(a);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** One view rendered against the current texture, with what to ask the model for. */
export interface PreparedView {
  spec: ViewSpec;
  clay: Uint8ClampedArray;
  state: Uint8ClampedArray;
  /** What the model is sent when that is not `state` as it is: the state with this view's notes drawn on it. */
  sent?: Uint8ClampedArray;
  /** The notes this view carries out. */
  notes?: NoteInView[];
  /** Where the view's unpainted surface is (its mean position), to find earlier views that look at it. */
  focus?: [number, number, number];
  /** The earlier views sent with it as reference pictures, by index. */
  refs?: number[];
  /** Masks the model's answer is composited with (roof passes leave unpainted non-roof pixels out of them). */
  masks: ViewMasks;
  /** 1 wherever the view shows the level, whatever the pass. */
  geometry: Uint8Array;
  /** The level's faces in this view, for the blockout check. */
  faces: ViewFaces;
  /** Per pixel, the cosine between the surface normal and the direction to the camera (0 off the level). */
  cos: Float32Array;
  /** Share of the frame this view can turn into texture: level not painted yet, seen at a usable angle. */
  fresh: number;
  edit: Uint8Array;
  /** Only these pixels are projected (roof and hole passes); everything when undefined. */
  keep?: Uint8Array;
  unknownFraction: number;
  isFirst: boolean;
  skip: boolean;
  model: EditModel;
  prompt: PromptContext;
}

/**
 * @param cap for a clean-up view: the capture quality at which the texture holds all the detail it can
 *   (core/defects.ts `fullDetail`); texels captured that well are left alone
 * @param roofsByPass the run has roof passes: other views leave unpainted roofs alone (from the street the models
 *   see them at a graze and paint them as walls or sky, and a roof pass rarely sees them enough better to replace it)
 */
export function prepareView(engine: Engine, spec: ViewSpec, o: PipelineOptions, startOfRun: boolean,
  roofsByPass = false, cap?: number): PreparedView {
  const first = MODELS[o.firstModel], fill = MODELS[o.fillModel], hole = MODELS[o.holeModel ?? o.fillModel];
  if (!first || !fill || !hole) throw new Error(`unknown model ${!first ? o.firstModel : !fill ? o.fillModel : o.holeModel}`);
  const S = engine.size;
  // hole views keep everything painted, however poor, so the model sees it as it is
  const { state, mask, clay } = engine.renderView(spec, spec.kind === 'fill' ? 0 : undefined, spec.kind === 'clean' ? cap : undefined);
  const { pos, nrm } = engine.readGeometry();
  const labels = engine.level.labels;
  // the ground roofs are judged against: the play area's floor when the level says where players are (a loft's
  // neighbours reach far below it), else the lowest point of the level
  const cls = classifyView(nrm, pos, labels, (engine.level.playArea ?? engine.level.bounds).min.y, !engine.level.shapes);
  let masks = masksFromState(mask);
  const geometry = masks.geometry;
  const roofPass = spec.kind === 'roof';
  const fillPass = spec.kind === 'fill';
  const floorPass = spec.kind === 'floor';
  const cleanPass = spec.kind === 'clean';
  // the ground under a floor view: facing up, at the floor's height (not the tops of steps, crates or wells)
  const ground = floorPass ? cls.floor.map((_, i) => (nrm[4 * i + 3] > 0.5 && nrm[4 * i + 1] > 0.7 && Math.abs(pos[4 * i + 1] - (spec.floor ?? 0)) < FLOOR_BAND ? 1 : 0)) : undefined;
  let keep: Uint8Array | undefined;
  if (roofPass) {
    // Paint roofs only. Unpainted walls and ground in view are left out entirely (not targets, not references).
    keep = cls.roof;
    masks = { geometry: masks.geometry.map((g, i) => g & (masks.known[i] | cls.roof[i])), known: masks.known };
  } else if (fillPass) {
    // Paint only what nothing has painted yet; everything else in view is reference, however poor.
    const painted = paintedFromState(mask);
    masks = { geometry: masks.geometry, known: masks.geometry.map((g, i) => g & painted[i]) };
    keep = dilate(masks.geometry.map((g, i) => g & (1 - painted[i])), S, S, 2);
  } else if (ground) {
    // Paint the ground only. From above, walls are slivers flaring out to the frame's edges: not targets, not references.
    keep = ground;
    masks = { geometry: masks.geometry.map((g, i) => g & (masks.known[i] | ground[i])), known: masks.known };
  } else if (cleanPass) {
    // Paint only what this camera would capture clearly better than the texture has it (or has nothing for);
    // everything else in view is reference and stays as it is.
    keep = dilate(masks.geometry.map((g, i) => g & (1 - masks.known[i])), S, S, 2);
  } else if (roofsByPass) {
    // Roofs wait for their own passes: unpainted roofs are neither targets nor references here.
    masks = { geometry: masks.geometry.map((g, i) => g & (masks.known[i] | (1 - cls.roof[i]))), known: masks.known };
    keep = geometry.map((g, i) => g & (1 - cls.roof[i]));
  }
  const unknown = masks.geometry.map((g, i) => (g && !masks.known[i] ? 1 : 0));
  const unknownAll = fraction(unknown, roofPass ? cls.roof : ground ?? masks.geometry);   // over what this pass may paint
  // After a floor pass the ground in a player's view is already painted. Which model paints the view goes by how
  // much of the rest is unpainted: a view of bare walls over a painted floor is still a blank view.
  let unknownFraction = unknownAll;
  if (!roofPass && !fillPass && !floorPass && (o.plan.floors ?? 0) > 0) {
    unknownFraction = fraction(unknown, masks.geometry.map((g, i) => g & (1 - (cls.floor[i] & masks.known[i]))));
  }
  const isFirst = !roofPass && !fillPass && !floorPass && !cleanPass && (startOfRun || unknownAll > 0.97);
  // How much of the frame this view can turn into texture: unpainted level seen at a usable angle.
  const cos = new Float32Array(S * S);
  let freshPx = 0;
  for (let i = 0; i < S * S; i++) {
    if (!geometry[i]) continue;
    const dx = spec.position[0] - pos[4 * i], dy = spec.position[1] - pos[4 * i + 1], dz = spec.position[2] - pos[4 * i + 2];
    cos[i] = Math.abs(nrm[4 * i] * dx + nrm[4 * i + 1] * dy + nrm[4 * i + 2] * dz) / (Math.hypot(dx, dy, dz) || 1);
    if (unknown[i] && cos[i] >= 0.3) freshPx++;
  }
  const fresh = freshPx / (S * S);
  // No model call when nearly everything in view is already good, or (hole views and second goes, which paint only
  // what is unpainted) when what is left wouldn't fill `minFresh` of the frame.
  const skip = fillPass || cleanPass ? fresh < o.minFresh : !isFirst && unknownFraction < 0.03;
  const model = fillPass || cleanPass ? hole : roofPass ? fill : floorPass || isFirst || unknownFraction > o.mostlyNew ? first : fill;
  const edit = editMask(masks, S, S, Math.round(3 * S / 1024));
  // one shape that holds over 40% of the level's surface is a shell: a whole room or building, floor included
  const shapes = engine.level.shapes;
  const shells = shapes?.map((p) => p.area > 0.4 * engine.level.surfaceArea);
  const desc = describeView(cls, labels, S, isFirst ? undefined : edit, shells);
  const prompt: PromptContext = { look: o.style, roofLook: o.roofStyle, parts: desc.parts,
    mode: roofPass ? 'roof' : floorPass ? 'floor' : isFirst ? 'first' : 'fill', floor: engine.level.mode !== 'object' && desc.floorShare > 0.5,
    overcast: !!engine.clay.lighting.overcast, indirect: !!engine.clay.lighting.indirect,
    ...(engine.level.mode === 'object' ? { object: true } : {}) };
  if (floorPass) {
    let known = 0, all = 0;
    for (let i = 0; i < S * S; i++) { all += geometry[i]; known += geometry[i] & masks.known[i]; }
    prompt.floorLook = o.floorStyle;
    prompt.context = all > 0 && known / all > 0.05;
    prompt.span = 2 * (spec.position[1] - (spec.floor ?? 0)) * Math.tan(THREE.MathUtils.degToRad(spec.fov) / 2);
  }
  // Notes pinned to the level: this view carries out those it sees well and that nothing has painted yet; around
  // those it sees badly it paints nothing, so the spot is still bare when a view that sees it well comes.
  let sent: Uint8ClampedArray | undefined;
  const carried: NoteInView[] = [];
  if (o.notes?.length && model.readsNotes && !roofPass && !floorPass) {
    const open = notesInView(pinned(engine, o.notes), makeCamera(spec), pos, nrm, masks.known, S).filter((n) => n.open >= NOTE_OPEN);
    let reserve: Uint8Array | undefined;
    for (const n of open) {
      if (n.well) { carried.push(n); continue; }
      reserve ??= new Uint8Array(S * S);
      for (let i = 0; i < reserve.length; i++) reserve[i] |= n.footprint[i];
    }
    if (reserve) {
      const around = dilate(reserve, S, S, Math.round(6 * S / 1024));
      keep = (keep ?? geometry).map((g, i) => g & (1 - around[i]));
    }
  }
  // A view that fills gaps is told what its biggest gaps are, by notes on the render.
  if (o.gapNotes && model.readsNotes && (fillPass || cleanPass)) {
    const big = scenery(engine);
    carried.push(...gapNotes(cls.label, unknown, labels, S, 3, 0.004, undefined, 0.3, (l) => big[l]));
  }
  if (carried.length) {
    prompt.notes = carried.map((n) => n.note.text).join('; ');
    sent = drawNotes(state, S, carried);
  }
  if (spec.again) prompt.shapes = true;
  if (o.diffuse) prompt.diffuse = true;
  if (o.wording) prompt.wording = o.wording;
  if (o.setting) prompt.setting = o.setting;
  if ((fillPass || cleanPass) && o.plainFills && !carried.length) prompt.plain = true;   // a note asks for more than bare wall
  return { spec, clay, state, ...(sent ? { sent, notes: carried } : {}), focus: focusOf(pos, unknown, cos), masks, geometry, faces: viewFaces(pos, nrm, S), cos, fresh, edit, keep, unknownFraction, isFirst, skip, model, prompt };
}

/** Which parts are scenery: over 2% of the level's surface each (walls, floor, ceiling), as the part pass counts them. */
const sceneryBy = new WeakMap<Engine, boolean[]>();
function scenery(engine: Engine): boolean[] {
  let have = sceneryBy.get(engine);
  if (have) return have;
  const g = engine.level.geometry, pos = g.getAttribute('position'), lab = g.getAttribute('label'), index = g.index;
  const area = new Float64Array(engine.level.labels.length);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const tris = (index ? index.count : pos.count) / 3;
  for (let t = 0; t < tris; t++) {
    const v = (k: number) => (index ? index.getX(3 * t + k) : 3 * t + k);
    a.fromBufferAttribute(pos, v(0)); b.fromBufferAttribute(pos, v(1)); c.fromBufferAttribute(pos, v(2));
    area[Math.round(lab.getX(v(0)))] += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  have = [...area].map((x) => x > 0.02 * engine.level.surfaceArea);
  sceneryBy.set(engine, have);
  return have;
}

/** A run's notes snapped onto its level, worked out once. */
const pinnedBy = new WeakMap<Engine, { notes: Note[]; pinned: PinnedNote[] }>();
function pinned(engine: Engine, notes: Note[]): PinnedNote[] {
  const have = pinnedBy.get(engine);
  if (have?.notes === notes) return have.pinned;
  const made = pinNotes(notes, engine.level.geometry, engine.level.bvh);
  pinnedBy.set(engine, { notes, pinned: made });
  return made;
}

/**
 * The photos of the real place (PipelineOptions.styleImages), fetched once and brought down to a size worth
 * sending: a megapixel says all a model takes from a reference.
 */
export async function loadStyleImages(urls: string[] | undefined, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  for (const url of urls ?? []) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`reference image ${url}: ${res.status}`);
    const bmp = await createImageBitmap(await res.blob());
    const k = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
    out.push(toDataUrl(bitmapToRGBA(bmp, w, h), w, h, 'image/jpeg', 0.9));
  }
  return out;
}

/**
 * The photos of the real place one view is sent: as many as its model takes, none for roof and floor passes (their
 * prompts are about one material seen from above). Notes them on the view's prompt, which must say what they are.
 */
export function siteFor(p: Pick<PreparedView, 'model' | 'prompt' | 'spec'>, images: string[], max?: number): string[] {
  const sent = p.spec.kind === 'roof' || p.spec.kind === 'floor' ? [] : images.slice(0, p.model.maxStyle ? max ?? p.model.maxStyle : 0);
  p.prompt.site = sent.length || undefined;
  return sent;
}

/** What a view costs: its model's price at this size, and what the photos sent beside the render add. */
export const viewPrice = (p: Pick<PreparedView, 'model' | 'prompt'>, size: number) =>
  priceOf(p.model, size) + (p.prompt.site ?? 0) * (p.model.imagePrice ?? 0);

export const promptText = (p: Pick<PreparedView, 'model' | 'prompt'>) =>
  p.model.text?.(p.prompt) ?? (p.model.key === 'flux3-klein' ? prompts.caption(p.prompt) : prompts.instruction(p.prompt));

/** What the blockout check needs: something that segments, how strict to be, and (optionally) the plane test. */
export interface Check { segment: Segment; threshold: number; planes?: Planes; onPlanes?: () => void; cells?: boolean }

/** The plane test's geometry model for one camera: MoGe-2 on fal, its maps brought down to the check's grid. */
/** The plane test sends the geometry model at most this many pixels a side (it is charged per megapixel). */
const PLANE_SIZE = 1024;
const planePrice = (viewSize: number) => (GEOMETRY_MODEL.price * Math.min(viewSize, PLANE_SIZE) ** 2) / 1e6;

export function falPlanes(fov: number, signal?: AbortSignal): Planes {
  return async (image, size) => {
    // flatness and facing are read on a 256 grid, so a megapixel is plenty whatever the view's size
    const s = Math.min(size, PLANE_SIZE);
    const r = await runGeometry(toDataUrl(resizeRGBA(image, size, size, s), s, s, 'image/jpeg', 0.92), fov, signal);
    const normals = bitmapToRGBA(r.normals, GRID, GRID);
    const mask = bitmapToRGBA(r.valid, GRID, GRID);
    const valid = new Uint8Array(GRID * GRID);
    for (let c = 0; c < valid.length; c++) valid[c] = mask[4 * c] > 127 ? 1 : 0;
    return { normals, valid };
  };
}

/**
 * Ask the model for one prepared view and composite its answer next to the known texture. With `check`, faces of
 * the level the model replaced with something else are left out of `comp`; `strict` also leaves out the faces it
 * merged into a neighbour, for a view that will have a second go at them (see core/fidelity.ts).
 */
export async function generateView(p: PreparedView, size: number, seed: number, feather: number, signal?: AbortSignal, check?: Check,
  swatchUrl?: string, refUrls?: string[], styleUrls?: string[], providerOpts?: ProviderOptions) {
  const r = await routeEdit(p.model, {
    imageUrl: toDataUrl(p.sent ?? p.state, size, size, 'image/jpeg', 0.95), swatchUrl, refUrls, ...(styleUrls?.length ? { styleUrls } : {}),
    maskUrl: p.model.mask ? toDataUrl(maskImage(p.edit, p.model.mask === 'black'), size, size) : undefined,
    prompt: p.prompt, seed, size,
  }, signal, providerOpts);
  const gen = bitmapToRGBA(r.image, size, size);
  const k = size / 1024;   // pixel radii below are tuned at 1024 px views
  const corrected = colorCorrect(p.state, gen, p.masks, size, size, { band: 6 * k, blur: Math.round(8 * k), falloff: 120 * k });
  const comp = featherComposite(p.state, corrected, p.masks, size, size, feather * k);
  // Whatever the model left as gray clay stays unpainted, so a later view (or the hole pass) gets another go at it.
  const unknown = p.masks.geometry.map((g, i) => (g && !p.masks.known[i] ? 1 : 0));
  const leftOver = untouched(p.state, gen, unknown, size, size);
  let nLeft = 0, nUnknown = 0;
  for (let i = 0; i < unknown.length; i++) { nLeft += leftOver[i]; nUnknown += unknown[i]; }
  // Faces of the level the model painted over (a prop turned into paving, a wall into an alley) stay unpainted too.
  const withheld = (extra?: Uint8Array) => {
    const drop = nLeft && extra ? leftOver.map((v, i) => v | extra[i]) : nLeft ? leftOver : extra;
    const keep = drop ? (p.keep ?? p.geometry).map((v, i) => v & (1 - drop[i])) : p.keep;
    return keep ? keepOnly(comp, keep, p.geometry) : comp;
  };
  const out = { gen, seconds: r.seconds, expanded: r.expanded, left: nUnknown ? nLeft / nUnknown : 0, providerUsed: r.providerUsed };
  if (check && nUnknown) {
    try {
      const planes: Planes | undefined = check.planes && (async (image, s) => { check.onPlanes?.(); return check.planes!(image, s); });
      const c = await checkView(check.segment, gen, size, p.faces, unknown, check.threshold, planes, { yaw: p.spec.yaw, pitch: p.spec.pitch, cells: !!check.cells });
      return { ...out, comp: withheld(c.replaced > 0 ? c.drop : undefined), ignored: c.replaced, merged: c.merged, heldOfFrame: c.heldOfFrame,
        strict: c.merged > 0 ? { comp: withheld(c.dropMerged), ignored: c.replaced + c.merged } : undefined };
    } catch (e) {
      console.warn(`blockout check failed on view ${p.spec.id}: ${(e as Error).message}`);   // paint it unchecked
    }
  }
  return { ...out, comp: withheld(), ignored: undefined, merged: undefined, heldOfFrame: 0, strict: undefined };
}

/**
 * The most a planned run can cost, and roughly how long it takes. Which model paints a view is only known once the
 * views before it are painted (mostly-unpainted views go to the first-view model), so every view after the first
 * is counted at the dearer of the two; roof and hole views always use the fill model. About 10 s a wave. With the
 * blockout check, every view but the roof views may come back for `secondGoes` more fill-model calls: `again` is
 * that part of the cost, counted as if every one of them did, and `planes` what the plane test adds at most.
 */
export function quote(plan: Pick<Plan, 'views' | 'waves'>, o: { firstModel: string; fillModel: string; holes?: number; secondGoes?: number;
  planes?: boolean; viewSize?: number; provider?: ProviderKind; providerFallback?: ProviderFallback }) {
  const size = o.viewSize ?? 1024;
  const eff = mergeProviderOptions({ provider: o.provider, providerFallback: o.providerFallback });
  const price = (key: string) => {
    const m = MODELS[key];
    if (!m || isLocalRoute(eff, m)) return 0;
    return priceOf(m, size);
  };
  const first = price(o.firstModel), fill = price(o.fillModel);
  const holes = o.holes ?? 0;
  let baseCost = holes * fill;
  plan.views.forEach((v, i) => { baseCost += i === 0 || v.kind === 'floor' ? first : v.kind === 'roof' || v.kind === 'fill' ? fill : Math.max(first, fill); });
  const goes = (o.secondGoes ?? 0) * plan.views.filter((v) => v.kind !== 'roof' && v.kind !== 'floor').length;
  const again = goes * fill;
  const paint = baseCost + again;
  // Strict local runs without cloud fallback skip hosted MoGe-2 unless cloud fallback is enabled.
  const strictLocal = eff.provider === 'local' && eff.providerFallback !== 'fal';
  const planes = o.planes && !strictLocal ? (plan.views.length + holes + goes) * planePrice(size) : 0;
  return { views: plan.views.length + holes, cost: paint + planes, paint, again, planes,
    seconds: 10 * (plan.waves.length + holes + goes), provider: eff.provider ?? 'fal' };
}

/** A run being extended (top-up): its views stay as they are and new views continue its numbering. */
export interface Continuation { views: ViewRecord[]; cost: number; seconds: number; plan: Plan }

export async function runPipeline(engine: Engine, opts: Partial<PipelineOptions>, onEvent: (e: PipelineEvent) => void,
  signal?: AbortSignal, existingPlan?: Plan, cont?: Continuation): Promise<RunRecord> {
  const o: PipelineOptions = { ...DEFAULT_PIPELINE, ...opts, plan: { ...DEFAULT_PIPELINE.plan, ...opts.plan } };
  const t0 = performance.now();
  const plan = existingPlan ?? makePlan(engine.gpu, engine.level, engine.views, o.plan, undefined,
    surfaceOf(engine.atlas, o.plan.grid ?? DEFAULT_PLAN.grid));
  onEvent({ type: 'planned', plan, options: o });
  const jobProvider = mergeProviderOptions({
    provider: o.provider,
    providerFallback: o.providerFallback,
    localBackend: o.localBackend,
    localUrl: o.localUrl,
    localModel: o.localModel,
    localWorkflow: o.localWorkflow,
    localTail: o.localTail,
  });
  const strictLocal = jobProvider.provider === 'local' && jobProvider.providerFallback !== 'fal';
  const S = engine.size;
  const views: ViewRecord[] = [];
  let cost = 0;
  // A level that names nothing gets its shapes named first: the prompts then say what each gray shape is.
  // In strict local mode on ComfyUI / Hunyuan3D / procedural image backends, skip cloud part naming so $0 runs stay fast and offline.
  const localHasVlm = jobProvider.localBackend === 'diffusers' && !!jobProvider.localUrl;
  const level = engine.level;
  if (o.nameParts && (!strictLocal || localHasVlm) && level.shapes && level.labels.every((l) => !l) && !signal?.aborted) {
    try {
      onEvent({ type: 'parts', message: `naming the level's ${level.shapes.length} shapes` });
      const named = await nameParts(engine, o.style, {}, undefined, signal, jobProvider);
      cost += named.cost;
      const list = [...new Set(named.names.filter(Boolean))];
      onEvent({ type: 'parts', names: named.names, message: `named ${named.names.filter(Boolean).length} shapes ($${named.cost.toFixed(2)}): ${list.join(', ')}` });
    } catch (e) {
      onEvent({ type: 'parts', message: `painting without part names: ${(e as Error)?.message ?? e}` });
    }
  }
  // The blockout check runs in the page. Where its model can't be fetched or run, views are painted without it.
  let check: Check | undefined;
  if (o.check && !signal?.aborted) {
    try {
      const seg = await loadSegmenter((message) => onEvent({ type: 'check', message }));
      check = { segment: seg.segment, threshold: o.checkThreshold };
      onEvent({ type: 'check', message: `checking each view against the blockout (${seg.device})` });
    } catch (e) {
      onEvent({ type: 'check', message: `painting without the blockout check: ${(e as Error)?.message ?? e}` });
    }
  }
  // Second goes left per planned view. Roof views get none: a second go paints whatever is unpainted in view, and
  // from a roof camera that is walls at a graze.
  const goesLeft: number[] = plan.views.map((v) => (check && v.kind !== 'roof' && v.kind !== 'floor' ? o.checkRetries : 0));
  // the plane test asks the geometry model once per view that has a big flat face; fal lists it per megapixel
  const planeCall = () => { cost += planePrice(S); };
  // Photos of the real place, when the run has them: sent with every view, in place of the sample sheet.
  let siteImages: string[] = [];
  if (o.styleImages?.length && !signal?.aborted) {
    try {
      siteImages = await loadStyleImages(o.styleImages, signal);
      onEvent({ type: 'check', message: `painting from ${siteImages.length} photo${siteImages.length === 1 ? '' : 's'} of the real place` });
    } catch (e) {
      onEvent({ type: 'check', message: `painting without reference photos: ${(e as Error)?.message ?? e}` });
    }
  }
  // The sample sheet is fixed once the texture has four materials to show, so every later view matches the same ones.
  let sheet: string | null = null;
  const reference = (p: PreparedView): string | undefined => {
    if (p.prompt.site) return undefined;
    // only views painted whole by a model that takes a second image (those are the mostly-unpainted ones), once
    // something is painted, and with enough in them
    if (!o.styleReference || p.model.mask || p.spec.kind === 'roof' || p.spec.kind === 'floor' || (views.length === 0 && !cont)) return undefined;
    if (!wantsSwatches(p.faces.faces.map((f) => f.cells / (GRID * GRID)))) return undefined;
    sheet ??= swatchSheet(engine.atlas);
    if (sheet) p.prompt.swatches = true;
    return sheet ?? undefined;
  };
  // Small copies of the views painted so far, to send as reference pictures of a place to views that fill gaps there.
  const painted: { index: number; spec: ViewSpec; url: string }[] = [];
  const remember = (index: number, spec: ViewSpec, gen: Uint8ClampedArray) => {
    const n = Math.min(1024, S);
    painted.push({ index, spec, url: toDataUrl(resizeRGBA(gen, S, S, n), n, n, 'image/jpeg', 0.85) });
  };
  const tailStart = jobProvider.localTail && plan.budget?.localModelTailViews
    ? Math.max(1, plan.views.length - plan.budget.localModelTailViews)
    : Infinity;
  const usePlanes = o.checkPlanes && !strictLocal;
  const generate = (p: PreparedView, index: number, vi?: number) => {
    const site = siteFor(p, siteImages, o.styleMax);
    const swatches = reference(p);
    const refs = p.prompt.mode === 'fill' && p.focus && p.model.maxRefs && o.references > 0
      ? pickReferences(p.focus, painted, Math.min(o.references, p.model.maxRefs), engine.level.bvh) : [];
    p.prompt.references = refs.length || undefined;
    p.refs = refs.map((r) => r.index);
    const callProvider: ProviderOptions = vi !== undefined && vi >= tailStart
      ? { ...jobProvider, provider: 'local', providerFallback: jobProvider.providerFallback === 'none' ? 'fal' : jobProvider.providerFallback }
      : jobProvider;
    // A floor view isn't checked against the blockout: the ground is one face of one material, and the check's
    // segmenter picks out single stones. Only ground pixels of it are projected.
    return withRetry((attempt) => generateView(p, S, o.seed + 1000 * attempt + index, o.feather, signal,
      p.spec.kind !== 'floor' && check ? { ...check, planes: usePlanes ? falPlanes(p.spec.fov, signal) : undefined, onPlanes: planeCall, cells: o.checkCells } : undefined,
      swatches, refs.map((r) => r.url), site, callProvider));
  };
  /**
   * What of a checked view goes onto the level. If enough of it was held back and the view has a second go left,
   * the same camera is queued again after everything planned, and the faces the model merged into a neighbour wait
   * for that. Otherwise they are accepted now.
   */
  const settle = (vi: number, r: Awaited<ReturnType<typeof generateView>>) => {
    if (!goesLeft[vi] || r.heldOfFrame <= o.retryAbove) return { comp: r.comp, ignored: r.ignored };
    const n = plan.views.length;
    plan.views.push({ ...plan.views[vi], id: n, kind: 'fill', again: true });
    plan.waves.push([n]);
    plan.viewCells.push({ cells: new Int32Array(0), q: new Float32Array(0) });
    plan.predicted.push(plan.predicted[plan.predicted.length - 1] ?? 0);
    goesLeft.push(goesLeft[vi] - 1);
    return r.strict ?? { comp: r.comp, ignored: r.ignored };
  };
  const roofsByPass = (o.plan.roofs ?? 0) > 0 || !!cont?.views.some((v) => v.spec.kind === 'roof');
  const indexBase = cont ? Math.max(-1, ...cont.views.map((v) => v.index)) + 1 : 0;
  const waveBase = cont ? Math.max(-1, ...cont.views.map((v) => v.wave)) + 1 : 0;
  for (let w = 0; w < plan.waves.length; w++) {
    if (signal?.aborted) break;
    const prepared = plan.waves[w].map((vi) => {
      const p = { vi, ...prepareView(engine, { ...plan.views[vi], id: indexBase + vi }, o, vi === 0 && !cont, roofsByPass) };
      if (!p.skip) onEvent({ type: 'view-start', index: indexBase + vi, wave: waveBase + w, model: p.model.key, state: p.state });
      return p;
    });
    const todo = prepared.filter((p) => !p.skip);
    const results = await Promise.all(todo.map((p) => generate(p, indexBase + p.vi, p.vi)
      .then((r) => ({ ok: true as const, r }), (e) => ({ ok: false as const, e }))));
    for (let k = 0; k < todo.length; k++) {
      const p = todo[k];
      const res = results[k];
      if (!res.ok) {
        onEvent({ type: 'error', index: indexBase + p.vi, message: String((res.e as Error)?.message ?? res.e) });
        continue;
      }
      const kept = settle(p.vi, res.r);
      engine.paint(p.spec, kept.comp, detailOf(p.model, S));
      const paidPrice = res.r.providerUsed === 'local' ? 0 : viewPrice(p, S);
      cost += paidPrice;
      const view: ViewRecord = {
        index: indexBase + p.vi, wave: waveBase + w, spec: p.spec, model: p.model.key, provider: res.r.providerUsed, first: p.isFirst, unknownFraction: p.unknownFraction,
        prompt: promptText(p), left: res.r.left, ignored: kept.ignored, merged: res.r.merged, swatches: p.prompt.swatches, ...(p.prompt.site ? { site: p.prompt.site } : {}), seconds: res.r.seconds,
        ...(p.notes?.length ? { notes: p.notes.map((n) => n.note.text) } : {}), ...(p.refs?.length ? { references: p.refs } : {}),
        price: paidPrice, ...(detailOf(p.model, S) < 1 ? { detail: detailOf(p.model, S) } : {}), clay: p.clay, state: p.sent ?? p.state, edit: p.edit,
        gen: res.r.gen, comp: kept.comp, coverage: engine.atlas.coverage(), predicted: plan.predicted[p.vi],
      };
      views.push(view);
      remember(view.index, p.spec, res.r.gen);
      onEvent({ type: 'view-done', view, cost, elapsed: (performance.now() - t0) / 1000 });
    }
  }
  // Hole pass: texels nothing painted (ground behind props, tops of props, what the planned views missed), from
  // the views that see the most of them and that a model can be expected to paint.
  // Clean-up pass, after it: what players can see that is unpainted or poorly captured (core/defects.ts), from
  // cameras aimed at it out of spots denser than the planned cameras', painting only that.
  for (const pass of ['holes', 'clean'] as const) {
   const holeBudget = (pass === 'holes' ? o.plan.holes : o.plan.cleanup) ?? 0;
   if (holeBudget > 0 && !signal?.aborted) {
    // Candidates: level cameras at eye height aimed at the unpainted patches, then cameras looking steeply down
    // from above (the only ones that see the tops of props, but models rarely paint those views faithfully).
    const cells = engine.atlas.texelGeometry(256);
    const wAttr = engine.level.geometry.getAttribute('weight');
    let repairW: Float32Array | undefined;
    if (wAttr) {
      const triW = new Float32Array(Math.floor(wAttr.count / 3));
      for (let t = 0; t < triW.length; t++) triW[t] = wAttr.getX(3 * t);
      repairW = cellWeights(engine.level.geometry.getAttribute('uv').array, triW, 256);
    }
    let cands: ViewSpec[];
    let full = Infinity;
    if (pass === 'holes') {
      const targets = holeTargets(cells.pos, cells.nrm, engine.atlas.cellQuality(256), 3, 24, repairW);
      cands = [...holeLookViews(engine.level, targets, plan.points), ...holeViews(engine.level, { ...DEFAULT_PLAN, ...o.plan }, plan.points)];
    } else {
      const eyes = samplePlayerPoints(engine.level, { ...DEFAULT_PLAN, ...o.plan, spacing: Math.min(2, o.plan.spacing ?? DEFAULT_PLAN.spacing) });
      // what counts as captured well enough: a view pixel per texel, whatever closer look a player could take
      const detail = fullDetail(cellDensity({ ...cells, texelsPerCell: engine.atlas.size / 256 }, 256), pixelsPerMetre(S, 75));
      full = detail.median;
      const defects = defectMap(cells.pos, cells.nrm, engine.atlas.cellQuality(256), engine.level.bvh, eyes, engine.options.qualityRatio, 60, detail.cells);
      onEvent({ type: 'check', message: `clean-up: of what players can see, ${(100 * defects.unpainted / Math.max(1, defects.seen)).toFixed(1)}% is unpainted and ` +
        `${(100 * defects.poor / Math.max(1, defects.seen)).toFixed(1)}% poorly captured` });
      // a defect cell counts as a hole to aim at; everything else (fine, or seen by nobody) as painted
      const targets = holeTargets(cells.pos, cells.nrm, defects.cls.map((c) => (c ? 0 : 1)), 3, 60, repairW);
      cands = lookViews(engine.level, targets, eyes, 3, 'clean');
    }
    const PROBE = 256;
    const probe = new ViewRenderer(engine.gpu, engine.level, PROBE);
    const shape: ({ sky: number; faces: number; maxFace: number } | undefined)[] = cands.map(() => undefined);
    const used = new Set<number>();
    // How each kind of camera has fared so far in this run, as the share of its work the check let through.
    const trust = { level: 1, steep: 1 };
    const kindOf = (c: ViewSpec) => (Math.abs(c.pitch) > THREE.MathUtils.degToRad(35) ? 'steep' : 'level');
    let paid = 0;
    while (paid < holeBudget && used.size < cands.length && !signal?.aborted) {
      let best = -1, bestScore = 0;
      cands.forEach((c, k) => {
        if (used.has(k)) return;
        probe.renderGeometry(makeCamera(c));
        const { mask } = probe.renderState(null, engine.atlas, engine.options.qualityRatio, full);
        let holes = 0, geo = 0;
        // holes: unpainted pixels; clean-up: pixels this camera would capture clearly better than the texture has them
        const ch = pass === 'holes' ? 2 : 1;
        for (let i = 0; i < mask.length; i += 4) if (mask[i] > 127) { geo++; if (mask[i + ch] < 128) holes++; }
        if (holes < 0.004 * PROBE * PROBE) return;   // under 0.4% of the frame: not worth a call
        let sh = shape[k];
        if (!sh) {   // what doesn't change about a camera: its faces and its sky
          const f = viewFaces(engine.gpu.readF32(probe.geometryTarget, 0), engine.gpu.readF32(probe.geometryTarget, 1), PROBE);
          const shares = f.faces.map((face) => face.cells / (GRID * GRID));
          sh = shape[k] = { sky: 1 - geo / (PROBE * PROBE), faces: shares.length, maxFace: Math.max(0, ...shares) };
        }
        const score = holes * paintability({ pitch: c.pitch, ...sh, context: geo ? 1 - holes / geo : 0 }) * trust[kindOf(c)];
        if (score < 0.03 * PROBE * PROBE) return;    // expected to turn under 3% of a frame into texture: not worth a call
        if (score > bestScore) { bestScore = score; best = k; }
      });
      if (best < 0) break;
      used.add(best);
      const vi = plan.views.length;
      const p = prepareView(engine, { ...cands[best], id: indexBase + vi }, o, false, false, pass === 'clean' ? full : undefined);
      if (p.skip) continue;   // too little of it is paintable at a usable angle: not paid for, and not counted
      plan.views.push({ ...cands[best], id: vi });
      plan.waves.push([vi]);
      plan.viewCells.push({ cells: new Int32Array(0), q: new Float32Array(0) });
      plan.predicted.push(plan.predicted[plan.predicted.length - 1] ?? 0);
      goesLeft.push(0);   // hole views accept merged faces at once; what they replace stays a hole for the next one
      paid++;
      const wave = waveBase + plan.waves.length - 1;
      onEvent({ type: 'view-start', index: indexBase + vi, wave, model: p.model.key, state: p.state });
      try {
        const r = await generate(p, indexBase + vi, vi);
        engine.paint(p.spec, r.comp, detailOf(p.model, S));
        const paidPrice = r.providerUsed === 'local' ? 0 : viewPrice(p, S);
        cost += paidPrice;
        const kind = kindOf(p.spec);
        trust[kind] = 0.5 * trust[kind] + 0.5 * (1 - (r.ignored ?? 0));
        const view: ViewRecord = {
          index: indexBase + vi, wave, spec: p.spec, model: p.model.key, provider: r.providerUsed, first: false, unknownFraction: p.unknownFraction,
          prompt: promptText(p), left: r.left, ignored: r.ignored, merged: r.merged, ...(p.prompt.site ? { site: p.prompt.site } : {}), seconds: r.seconds, price: paidPrice,
          ...(p.notes?.length ? { notes: p.notes.map((n) => n.note.text) } : {}), ...(p.refs?.length ? { references: p.refs } : {}), ...(detailOf(p.model, S) < 1 ? { detail: detailOf(p.model, S) } : {}),
          clay: p.clay, state: p.sent ?? p.state, edit: p.edit,
          gen: r.gen, comp: r.comp, coverage: engine.atlas.coverage(), predicted: plan.predicted[vi],
        };
        views.push(view);
        remember(view.index, p.spec, r.gen);
        onEvent({ type: 'view-done', view, cost, elapsed: (performance.now() - t0) / 1000 });
      } catch (e) {
        onEvent({ type: 'error', index: indexBase + vi, message: String((e as Error)?.message ?? e) });
      }
    }
    probe.geometryTarget.dispose();
    probe.stateTarget.dispose();
   }
  }
  const seconds = (performance.now() - t0) / 1000;
  const record: RunRecord = cont
    ? { level: engine.level.name, options: o, views: [...cont.views, ...views], cost: cont.cost + cost, seconds: cont.seconds + seconds,
        plan: { ...plan, points: plan.points, views: [...cont.plan.views, ...plan.views.map((v, i) => ({ ...v, id: indexBase + i }))],
          waves: [...cont.plan.waves, ...plan.waves.map((wv) => wv.map((vi) => vi + cont.plan.views.length))],
          viewCells: [...cont.plan.viewCells ?? [], ...plan.viewCells], predicted: [...cont.plan.predicted, ...plan.predicted] } }
    : { level: engine.level.name, options: o, plan, views, cost, seconds };
  onEvent({ type: 'done', record });
  return record;
}
