/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import { distanceTo } from './composite';

/**
 * Did the painter respect the blockout? Image models like to repaint the scene instead of the surfaces: a prop
 * becomes paving, a flat wall becomes an alley with sky. Projected onto the level, that reads as a wrong texture.
 *
 * The geometry buffer says exactly which faces a view shows (regions bounded by silhouettes and creases). For each
 * face the view is about to paint, a segmentation model is clicked once at the face's innermost point on the
 * *generated* image and returns masks at three scales (part, object, whole). If the painting shows the face as a
 * surface of its own, one of them matches the face. If none does, the model painted over it, in one of two ways:
 *
 * - **replaced**: no mask even contains the face. Something else was painted there (sky, a street, two unrelated
 *   materials). That never goes onto the level.
 * - **merged**: one mask contains the face but reaches well beyond it. The model carried a neighbour's surface
 *   across it (a bollard painted as more paving, a porch as more wall). The texture is at least one coherent
 *   surface, so it is only held back while the view still has another go coming, and accepted after that.
 *
 * Whatever is held back stays unpainted, for the view's second go or for the hole pass.
 *
 * One kind of scene gets past the masks: a single painted object that happens to fill a face, like a corner
 * building painted across a flat wall. For that there is a second, optional test on flat faces (`Planes`): a
 * geometry model predicts surface normals from the painted image, and a face that is flat in the level must be a
 * flat surface facing the same way in the painting. Where most of it isn't (a corner building, a row of houses
 * receding down a street, sky), the face counts as replaced.
 */

/** Faces are found and scored on a GRID x GRID grid over the view (the mask size of the segmentation model). */
export const GRID = 256;

export interface Face {
  /** Value of this face's cells in `ViewFaces.labels` (1-based). */
  id: number;
  /** Size in grid cells. */
  cells: number;
  /** The cell deepest inside the face: where to click. */
  point: [number, number];
  /** The face is flat in the level (one normal throughout): the plane test applies to it. */
  flat: boolean;
  /** The face's average normal in world space. */
  normal: [number, number, number];
}

export interface ViewFaces {
  /** GRID x GRID (smaller for an image under GRID px), row-major, top-down: face id per cell, 0 = sky, an edge, or a face too small to check. */
  labels: Int16Array;
  /** Cells per side of `labels`. */
  grid: number;
  faces: Face[];
}

export interface FaceOptions {
  /** Faces under this share of the frame are not checked (a click on them says little). */
  minShare: number;
  /** Neighbouring pixels belong to different faces when their normals differ by more than this (cosine)... */
  crease: number;
  /** ...or their distances to the camera differ by more than this share of the distance (plus 2 cm). */
  depthJump: number;
  /** Cells per side the faces are found on; never more than the image has pixels. */
  grid: number;
}

export const DEFAULT_FACES: FaceOptions = { minShare: 0.004, crease: 0.85, depthJump: 0.03, grid: GRID };

/**
 * The level's faces as one view sees them.
 * @param pos RGBA float per pixel: world position xyz, a = distance to the camera; top-down
 * @param nrm RGBA float per pixel: world normal xyz, a > 0.5 where there is geometry; top-down
 */
export function viewFaces(pos: Float32Array, nrm: Float32Array, size: number, opts: Partial<FaceOptions> = {}): ViewFaces {
  const o = { ...DEFAULT_FACES, ...opts };
  const G = Math.min(o.grid, size);   // the faces' own grid: the check's, or the image's when that is smaller (planning probes)
  const k = size / G;
  // per cell: is most of it geometry, and does a silhouette or crease run through it?
  const geo = new Uint16Array(G * G), edge = new Uint8Array(G * G), total = new Uint16Array(G * G);
  const normal = new Float32Array(G * G * 3);   // summed normals per cell
  for (let y = 0; y < size; y++) {
    const cy = Math.min(G - 1, Math.floor(y / k));
    for (let x = 0; x < size; x++) {
      const i = 4 * (y * size + x), c = cy * G + Math.min(G - 1, Math.floor(x / k));
      total[c]++;
      if (nrm[i + 3] < 0.5) continue;
      geo[c]++;
      normal[3 * c] += nrm[i]; normal[3 * c + 1] += nrm[i + 1]; normal[3 * c + 2] += nrm[i + 2];
      const d0 = pos[i + 3];
      for (let n = 0; n < 2; n++) {
        const xx = n === 0 ? x + 1 : x, yy = n === 0 ? y : y + 1;
        if (xx >= size || yy >= size) continue;
        const j = 4 * (yy * size + xx);
        const dot = nrm[i] * nrm[j] + nrm[i + 1] * nrm[j + 1] + nrm[i + 2] * nrm[j + 2];
        if (nrm[j + 3] < 0.5 || Math.abs(d0 - pos[j + 3]) > o.depthJump * d0 + 0.02 || dot < o.crease) { edge[c] = 1; break; }
      }
    }
  }
  const open = new Uint8Array(G * G);
  for (let c = 0; c < open.length; c++) open[c] = 2 * geo[c] > total[c] && !edge[c] ? 1 : 0;
  // connected regions of open cells (4-neighbours)
  const labels = new Int16Array(G * G);
  const stack = new Int32Array(G * G);
  const regions: number[][] = [];
  for (let start = 0; start < open.length; start++) {
    if (!open[start] || labels[start]) continue;
    const id = regions.length + 1;
    const cells: number[] = [];
    let top = 0;
    stack[top++] = start;
    labels[start] = id;
    while (top) {
      const c = stack[--top];
      cells.push(c);
      const x = c % G;
      for (const n of [x > 0 ? c - 1 : -1, x < G - 1 ? c + 1 : -1, c - G, c + G]) {
        if (n < 0 || n >= open.length || !open[n] || labels[n]) continue;
        labels[n] = id;
        stack[top++] = n;
      }
    }
    regions.push(cells);
  }
  // keep the faces big enough to check, renumbered from 1; the click goes where the face is deepest
  const closed = new Uint8Array(G * G);
  for (let c = 0; c < closed.length; c++) closed[c] = open[c] ? 0 : 1;
  const depth = distanceTo(closed, G, G);
  const faces: Face[] = [];
  const min = o.minShare * G * G;
  for (const cells of regions) {
    const id = cells.length >= min ? faces.length + 1 : 0;
    let best = cells[0];
    for (const c of cells) {
      labels[c] = id;
      // deepest cell; cells on the frame's border count as deep as they are from the face's own edge
      if (depth[c] > depth[best]) best = c;
    }
    if (!id) continue;
    // flat: every cell's normal within about 8 degrees of the face's average
    let mx = 0, my = 0, mz = 0;
    for (const c of cells) { mx += normal[3 * c]; my += normal[3 * c + 1]; mz += normal[3 * c + 2]; }
    const ml = Math.hypot(mx, my, mz) || 1;
    let flat = true;
    for (const c of cells) {
      const l = Math.hypot(normal[3 * c], normal[3 * c + 1], normal[3 * c + 2]) || 1;
      if ((normal[3 * c] * mx + normal[3 * c + 1] * my + normal[3 * c + 2] * mz) / (l * ml) < 0.99) { flat = false; break; }
    }
    faces.push({ id, cells: cells.length, point: [best % G, Math.floor(best / G)], flat, normal: [mx / ml, my / ml, mz / ml] });
  }
  return { labels, faces, grid: G };
}

/** Faces a view is about to paint: those with at least `minUnknown` of their cells still unpainted. */
export function facesToPaint(f: ViewFaces, unknown: Uint8Array, size: number, minUnknown = 0.15): Face[] {
  const k = size / GRID;
  const count = new Float64Array(f.faces.length + 1);
  for (let cy = 0; cy < GRID; cy++) {
    for (let cx = 0; cx < GRID; cx++) {
      const id = f.labels[cy * GRID + cx];
      // the cell's centre pixel stands for the cell
      if (id && unknown[Math.min(size - 1, Math.floor((cy + 0.5) * k)) * size + Math.min(size - 1, Math.floor((cx + 0.5) * k))]) count[id]++;
    }
  }
  return f.faces.filter((face) => count[face.id] >= minUnknown * face.cells);
}

/** Intersection over union of a face with a mask on the grid (1 = inside). */
export function faceIou(labels: Int16Array, id: number, mask: Uint8Array): number {
  let inter = 0, union = 0;
  for (let c = 0; c < labels.length; c++) {
    const a = labels[c] === id, b = mask[c] > 0;
    if (a && b) inter++;
    if (a || b) union++;
  }
  return union ? inter / union : 0;
}

export interface FaceScore {
  id: number;
  cells: number;
  /** Best overlap of the face with any mask offered for its click. */
  iou: number;
  /** Largest share of the face that lies inside one offered mask. */
  cover: number;
  /** ok: painted as a surface of its own; merged or replaced: painted over (see the top of this file). */
  kind: 'ok' | 'merged' | 'replaced';
  /** Plane test, where it ran: share of the face that the painting doesn't show as one flat surface. */
  offPlane?: number;
}

/** A face that lies this much inside one mask was merged into a neighbour rather than replaced. */
export const MERGED_COVER = 0.85;

/**
 * Score faces against the masks the segmentation model returned for a click on each.
 * @param masks per face (same order as `faces`): the candidate masks for its click, each GRID x GRID
 */
export function scoreFaces(f: ViewFaces, faces: Face[], masks: Uint8Array[][], threshold = 0.5): FaceScore[] {
  return faces.map((face, n) => {
    const iou = Math.max(0, ...masks[n].map((m) => faceIou(f.labels, face.id, m)));
    let cover = 0;
    for (const m of masks[n]) {
      let inside = 0;
      for (let c = 0; c < m.length; c++) if (m[c] && f.labels[c] === face.id) inside++;
      cover = Math.max(cover, inside / face.cells);
    }
    return { id: face.id, cells: face.cells, iou, cover, kind: iou >= threshold ? 'ok' : cover >= MERGED_COVER ? 'merged' : 'replaced' };
  });
}

/**
 * Pixels (size x size, 1 = drop) of the faces to hold back, grown by one cell so the silhouette around such a face
 * goes with it.
 * @param acceptMerged keep merged faces (only replaced ones are dropped)
 */
export function ignoredPixels(f: ViewFaces, scores: FaceScore[], size: number, acceptMerged = false): Uint8Array {
  const bad = new Set(scores.filter((s) => s.kind === 'replaced' || (s.kind === 'merged' && !acceptMerged)).map((s) => s.id));
  const out = new Uint8Array(size * size);
  if (!bad.size) return out;
  const cells = new Uint8Array(GRID * GRID);
  for (let cy = 0; cy < GRID; cy++) {
    for (let cx = 0; cx < GRID; cx++) {
      if (!bad.has(f.labels[cy * GRID + cx])) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx, y = cy + dy;
          // grow into edges and sky only: a neighbouring face that was painted well keeps its cells
          if (x >= 0 && y >= 0 && x < GRID && y < GRID && (f.labels[y * GRID + x] === 0 || bad.has(f.labels[y * GRID + x]))) cells[y * GRID + x] = 1;
        }
      }
    }
  }
  const k = size / GRID;
  for (let y = 0; y < size; y++) {
    const row = Math.min(GRID - 1, Math.floor(y / k)) * GRID;
    for (let x = 0; x < size; x++) out[y * size + x] = cells[row + Math.min(GRID - 1, Math.floor(x / k))];
  }
  return out;
}

/**
 * A world-space direction in the camera space the plane test works in: x right, y up, z towards the viewer.
 * Yaw and pitch as in a ViewSpec (yaw 0 looks down -Z, pitch up from the horizon).
 */
export function toCameraSpace(n: [number, number, number], yaw: number, pitch: number): [number, number, number] {
  const cp = Math.cos(pitch);
  const f = [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];   // forward
  let r = [-f[2], 0, f[0]];                                                // forward x up
  const rl = Math.hypot(r[0], r[2]) || 1;
  r = [r[0] / rl, 0, r[2] / rl];
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];   // right x forward
  return [n[0] * r[0] + n[1] * r[1] + n[2] * r[2], n[0] * u[0] + n[1] * u[1] + n[2] * u[2], -(n[0] * f[0] + n[1] * f[1] + n[2] * f[2])];
}

/**
 * Share of a face that a painting doesn't show as the flat surface it is: cells whose predicted normal is more
 * than `degrees` off the face's true normal, plus cells where the model saw no surface at all (sky).
 * @param normals RGBA, GRID x GRID: predicted camera-space normal as colour, (n + 1) / 2 per axis
 * @param valid GRID x GRID: 1 where the model predicted a surface
 * @param expected the face's true normal in the same camera space
 */
export function offPlane(labels: Int16Array, id: number, normals: Uint8ClampedArray, valid: Uint8Array,
  expected: [number, number, number], degrees = 35): number {
  const cos = Math.cos((degrees * Math.PI) / 180);
  let n = 0, off = 0;
  for (let c = 0; c < labels.length; c++) {
    if (labels[c] !== id) continue;
    n++;
    if (!valid[c]) { off++; continue; }
    const x = normals[4 * c] / 127.5 - 1, y = normals[4 * c + 1] / 127.5 - 1, z = normals[4 * c + 2] / 127.5 - 1;
    if ((x * expected[0] + y * expected[1] + z * expected[2]) / (Math.hypot(x, y, z) || 1) < cos) off++;
  }
  return n ? off / n : 0;
}

/**
 * Cells of the flat faces that a painting doesn't show as the surface they are: where its predicted normal is more
 * than `degrees` off the face's own, or the model saw no surface. Only patches of at least `minCells` cells count:
 * single cells are the geometry model's noise, a patch is something painted there that isn't in the level.
 * @returns GRID x GRID, 1 = off
 */
export function offCells(f: ViewFaces, normals: Uint8ClampedArray, valid: Uint8Array, yaw: number, pitch: number,
  degrees = 35, minCells = 12, skip?: Set<number>): Uint8Array {
  const G = f.grid, cos = Math.cos((degrees * Math.PI) / 180);
  const expected = new Map<number, [number, number, number]>();
  for (const face of f.faces) if (face.flat && !skip?.has(face.id)) expected.set(face.id, toCameraSpace(face.normal, yaw, pitch));
  const off = new Uint8Array(G * G);
  for (let c = 0; c < off.length; c++) {
    const e = expected.get(f.labels[c]);
    if (!e) continue;
    if (!valid[c]) { off[c] = 1; continue; }
    const x = normals[4 * c] / 127.5 - 1, y = normals[4 * c + 1] / 127.5 - 1, z = normals[4 * c + 2] / 127.5 - 1;
    if ((x * e[0] + y * e[1] + z * e[2]) / (Math.hypot(x, y, z) || 1) < cos) off[c] = 1;
  }
  // keep patches only
  const seen = new Uint8Array(G * G), stack: number[] = [];
  for (let c0 = 0; c0 < off.length; c0++) {
    if (!off[c0] || seen[c0]) continue;
    const patch = [c0];
    seen[c0] = 1;
    stack.push(c0);
    while (stack.length) {
      const c = stack.pop()!, x = c % G, y = (c - x) / G;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, n = ny * G + nx;
        if (nx < 0 || ny < 0 || nx >= G || ny >= G || !off[n] || seen[n]) continue;
        seen[n] = 1;
        patch.push(n);
        stack.push(n);
      }
    }
    if (patch.length < minCells) for (const c of patch) off[c] = 0;
  }
  return off;
}

/**
 * Predicted surface normals for a painted image, on the GRID, in camera space with x right, y up and z towards the
 * viewer (see `offPlane`). MoGe-2's normal map on fal is in that space; another model's adapter must convert.
 */
export type Planes = (image: Uint8ClampedArray, size: number) => Promise<{ normals: Uint8ClampedArray; valid: Uint8Array }>;

export interface PlaneOptions {
  /** Flat faces at least this share of the frame get the plane test. */
  minShare: number;
  /** A face fails when more than this share of it isn't the flat surface it is in the painting. */
  maxOff: number;
  /** The view's camera, to bring each face's true normal into camera space. */
  yaw: number;
  pitch: number;
  /**
   * Also hold back, cell by cell, the patches of any flat face that the painting doesn't show as that surface
   * (`offCells`), where the face as a whole passes.
   */
  cells: boolean;
}

export const DEFAULT_PLANES: PlaneOptions = { minShare: 0.1, maxOff: 0.5, yaw: 0, pitch: 0, cells: false };

/** Click each point on an image and return candidate masks per point (see providers/sam.ts). */
export type Segment = (image: Uint8ClampedArray, size: number, points: [number, number][]) => Promise<{ grid: number; masks: Uint8Array[][] }>;

export interface ViewCheck {
  scores: FaceScore[];
  /** size x size, 1 = belongs to a replaced face: never to be projected. */
  drop: Uint8Array;
  /** The same with merged faces held back too, for a view that has a second go coming. */
  dropMerged: Uint8Array;
  /** Shares of the area the view was to paint: in replaced faces, and in merged ones. */
  replaced: number;
  merged: number;
  /** Replaced and merged together, as a share of the whole frame: is a second go worth a call? */
  heldOfFrame: number;
  /** Share of the area to paint held back cell by cell for showing another surface than the level's (`PlaneOptions.cells`). */
  offSurface?: number;
}

/**
 * Check one generated view against the faces it was to paint.
 * @param gen the model's image, top-down RGBA, size x size
 * @param unknown 1 where the view is to paint (geometry not painted yet)
 */
export async function checkView(segment: Segment, gen: Uint8ClampedArray, size: number, f: ViewFaces, unknown: Uint8Array,
  threshold = 0.5, planes?: Planes, planeOpts: Partial<PlaneOptions> = {}): Promise<ViewCheck> {
  const faces = facesToPaint(f, unknown, size);
  const none = new Uint8Array(size * size);
  if (!faces.length) return { scores: [], drop: none, dropMerged: none, replaced: 0, merged: 0, heldOfFrame: 0 };
  const k = size / GRID;
  const res = await segment(gen, size, faces.map((face) => [(face.point[0] + 0.5) * k, (face.point[1] + 0.5) * k]));
  const masks = res.grid === GRID ? res.masks : res.masks.map((per) => per.map((m) => {
    const out = new Uint8Array(GRID * GRID), r = res.grid / GRID;   // another mask size: nearest sample
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) out[y * GRID + x] = m[Math.floor((y + 0.5) * r) * res.grid + Math.floor((x + 0.5) * r)];
    return out;
  }));
  const scores = scoreFaces(f, faces, masks, threshold);
  // The plane test, for big flat faces the masks let through: one call to the geometry model per view, and only
  // when the view has such a face.
  const po = { ...DEFAULT_PLANES, ...planeOpts };
  const big = planes ? faces.filter((face, n) => face.flat && face.cells >= po.minShare * GRID * GRID && scores[n].kind !== 'replaced') : [];
  let patches: Uint8Array | undefined;
  if (planes && (big.length || (po.cells && faces.some((face) => face.flat)))) {
    const p = await planes(gen, size).catch(() => null);   // no answer from the geometry model: the masks' verdict stands
    for (const face of p ? big : []) {
      const s = scores[faces.indexOf(face)];
      s.offPlane = offPlane(f.labels, face.id, p!.normals, p!.valid, toCameraSpace(face.normal, po.yaw, po.pitch));
      if (s.offPlane > po.maxOff) s.kind = 'replaced';
    }
    if (p && po.cells) {
      // within the faces that pass: the patches that show something else
      const failed = new Set(scores.filter((s) => s.kind === 'replaced').map((s) => s.id));
      patches = offCells(f, p.normals, p.valid, po.yaw, po.pitch, 35, 12, failed);
    }
  }
  const drop = ignoredPixels(f, scores, size, true);
  const dropMerged = ignoredPixels(f, scores, size);
  let off = 0;
  if (patches) {
    const k = size / GRID;
    for (let y = 0; y < size; y++) {
      const row = Math.min(GRID - 1, Math.floor(y / k)) * GRID;
      for (let x = 0; x < size; x++) {
        if (!patches[row + Math.min(GRID - 1, Math.floor(x / k))]) continue;
        const i = y * size + x;
        if (unknown[i] && !drop[i]) off++;
        drop[i] = dropMerged[i] = 1;
      }
    }
  }
  let n = 0, replaced = 0, held = 0;
  for (let i = 0; i < unknown.length; i++) { n += unknown[i]; replaced += unknown[i] & drop[i]; held += unknown[i] & dropMerged[i]; }
  return { scores, drop, dropMerged, replaced: n ? replaced / n : 0, merged: n ? (held - replaced) / n : 0, heldOfFrame: held / unknown.length,
    ...(patches ? { offSurface: n ? off / n : 0 } : {}) };
}
