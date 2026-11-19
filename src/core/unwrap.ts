import { packBoxes, uvIslands } from './layout';

/**
 * Texture coordinates made from scratch, for a level whose own are missing or can't hold a painting. Painting gives
 * every texel one colour, so each face needs a place in the texture of its own: UVs that are missing, collapsed to
 * a point, repeat outside the square (tiling) or put two faces on the same texels (mirrored or stacked islands)
 * leave faces sharing paint. Here such a level is cut into charts and laid out again by xatlas
 * (https://github.com/jpcy/xatlas, through the xatlasjs WebAssembly build): charts follow the level's creases
 * (normal deviation, straight seams), are flattened with as little stretch as it can manage (LSCM, then a
 * piecewise fix where that folds), and packed into one square. Every part is a mesh of its own, so no chart spans
 * two parts. Positions are in metres in the world, so every part gets the same texels per metre; the layouts that
 * run after this (core/layout.ts: `seen`, `near`, pages) then weight them as for any other file.
 */

/** What is wrong with a set of texture coordinates, as shares of the level's surface (by world area). */
export interface UvHealth {
  /** The file had no texture coordinates at all (or every corner at one point). */
  missing: boolean;
  /** Faces whose texture triangle has (next to) no area. */
  degenerate: number;
  /** Faces with a corner outside the unit square: tiling UVs, which repeat the same texels. */
  outside: number;
  /** Of the texels the faces cover, the share covered by more than one island (mirrored or stacked UVs). */
  overlap: number;
  /** Set when the UVs can't hold a painting: what fails. */
  problem?: string;
}

export const HEALTH_LIMITS = { degenerate: 0.02, outside: 0.02, overlap: 0.02 };

/**
 * How fit a level's texture coordinates are to be painted on.
 * @param position world-space corners of non-indexed triangles (9 numbers each)
 * @param uv 2 numbers per corner
 * @param grid the texture is checked for overlaps at this many cells along each side
 */
export function uvHealth(position: ArrayLike<number>, uv: ArrayLike<number>, grid = 512, missing = false): UvHealth {
  const tris = Math.floor(position.length / 9);
  let total = 0, degenerate = 0, outside = 0;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  const area = new Float64Array(tris);
  const off = new Uint8Array(tris);
  for (let t = 0; t < tris; t++) {
    const p = 9 * t;
    const ax = position[p + 3] - position[p], ay = position[p + 4] - position[p + 1], az = position[p + 5] - position[p + 2];
    const bx = position[p + 6] - position[p], by = position[p + 7] - position[p + 1], bz = position[p + 8] - position[p + 2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    const world = Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
    area[t] = world;
    total += world;
    const q = 6 * t;
    for (let c = 0; c < 3; c++) {
      const u = uv[q + 2 * c], v = uv[q + 2 * c + 1];
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      if (u < -1e-4 || u > 1 + 1e-4 || v < -1e-4 || v > 1 + 1e-4) off[t] = 1;
    }
    const tex = Math.abs((uv[q + 2] - uv[q]) * (uv[q + 5] - uv[q + 1]) - (uv[q + 4] - uv[q]) * (uv[q + 3] - uv[q + 1])) / 2;
    if (world > 0 && tex < 1e-11) degenerate += world;
    if (off[t]) outside += world;
  }
  if (!missing && tris && u1 - u0 < 1e-9 && v1 - v0 < 1e-9) missing = true;
  if (missing || !total) return { missing: true, degenerate: 1, outside: 0, overlap: 0, problem: 'no texture coordinates' };

  // Overlap: draw every island into a grid of cells (a cell is drawn when its centre is inside a triangle) and
  // count the cells two islands reach. Triangles of one island don't count against each other (a fold within a
  // chart isn't what this is about), nor do faces outside the square, which are counted above.
  const { of } = uvIslands(position, uv);
  const owner = new Int32Array(grid * grid).fill(-1);
  const shared = new Uint8Array(grid * grid);
  for (let t = 0; t < tris; t++) {
    if (off[t] || !area[t]) continue;
    const q = 6 * t;
    const x0 = uv[q] * grid, y0 = uv[q + 1] * grid, x1 = uv[q + 2] * grid, y1 = uv[q + 3] * grid, x2 = uv[q + 4] * grid, y2 = uv[q + 5] * grid;
    const d = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(d) < 1e-12) continue;
    const ia = Math.max(0, Math.floor(Math.min(x0, x1, x2))), ib = Math.min(grid - 1, Math.ceil(Math.max(x0, x1, x2)));
    const ja = Math.max(0, Math.floor(Math.min(y0, y1, y2))), jb = Math.min(grid - 1, Math.ceil(Math.max(y0, y1, y2)));
    const k = of[t];
    for (let j = ja; j <= jb; j++) {
      const py = j + 0.5;
      for (let i = ia; i <= ib; i++) {
        const px = i + 0.5;
        const w1 = ((px - x0) * (y2 - y0) - (x2 - x0) * (py - y0)) / d;
        const w2 = ((x1 - x0) * (py - y0) - (px - x0) * (y1 - y0)) / d;
        if (w1 < 0 || w2 < 0 || w1 + w2 > 1) continue;
        const cell = j * grid + i;
        if (owner[cell] < 0) owner[cell] = k;
        else if (owner[cell] !== k) shared[cell] = 1;
      }
    }
  }
  let covered = 0, overlapped = 0;
  for (let c = 0; c < owner.length; c++) { if (owner[c] >= 0) covered++; if (shared[c]) overlapped++; }
  const h: UvHealth = { missing: false, degenerate: degenerate / total, outside: outside / total, overlap: covered ? overlapped / covered : 0 };
  const fails: string[] = [];
  if (h.degenerate > HEALTH_LIMITS.degenerate) fails.push(`${pct(h.degenerate)} of the surface has collapsed UVs`);
  if (h.outside > HEALTH_LIMITS.outside) fails.push(`${pct(h.outside)} of the surface has UVs outside the square (tiling)`);
  if (h.overlap > HEALTH_LIMITS.overlap) fails.push(`${pct(h.overlap)} of the texture is shared by overlapping islands`);
  if (fails.length) h.problem = fails.join('; ');
  return h;
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

/** One mesh handed to xatlas: corners welded into vertices (16-bit indices, as the WebAssembly build takes). */
export interface AtlasMesh {
  vertices: Float32Array;
  index: Uint16Array;
  /** The level's triangle for each of this mesh's triangles. */
  triangles: Uint32Array;
}

/** What xatlas hands back for one mesh: new vertices (split along seams), their UVs in [0, 1], and the faces. */
export interface AtlasMeshResult {
  index: ArrayLike<number>;
  coords: ArrayLike<number>;
  vertexCount: number;
}

export interface AtlasResult {
  width: number;
  height: number;
  atlasCount: number;
  meshes: AtlasMeshResult[];
}

export interface UnwrapOptions {
  /** Gap round each chart, in texels of a `resolution` px texture. */
  padding: number;
  /** The texture size the padding is reckoned at. */
  resolution: number;
  /** Lower: more, flatter charts (xatlas `maxCost`). */
  maxCost: number;
  /** Welded vertices per mesh at most. The WebAssembly build reads 16-bit indices and hands back as many, so the
   * vertices split along seams must stay under 65,536 too: this leaves room for that. */
  maxVertices: number;
  /** Existing corner UVs (2 floats per corner) when preserving valid artist-authored UV seams/charts on partial unwraps. */
  uv?: ArrayLike<number>;
  /** When `uv` is supplied, keep valid non-overlapping low-stretch charts intact and run xatlas only on unhealthy parts (default true). */
  preserveSeams?: boolean;
  /** Maximum area-weighted singular-value stretch (`sigma_max / sigma_min`) for an authored chart to be pinned (default 2.5). */
  maxAnisotropy?: number;
}

export const DEFAULT_UNWRAP: UnwrapOptions = { padding: 4, resolution: 2048, maxCost: 2, maxVertices: 24000 };

/** Runs xatlas over meshes packed into one texture (`xatlasBrowser` in the page; the tests run it under Node). */
export type XatlasRunner = (meshes: AtlasMesh[], o: UnwrapOptions) => Promise<AtlasResult>;

/**
 * The level's triangles as meshes for xatlas: one per part (`label`), corners at the same place joined so charts
 * can span faces, and a part with more vertices than a mesh can take split into runs of triangles in file order.
 * When `onlyTriangles` is given (`0` = skip, `1` = include), only included triangles are emitted.
 */
export function atlasMeshes(
  position: ArrayLike<number>,
  label: ArrayLike<number> | undefined,
  maxVertices = DEFAULT_UNWRAP.maxVertices,
  onlyTriangles?: ArrayLike<number>,
): AtlasMesh[] {
  const tris = Math.floor(position.length / 9);
  const byPart = new Map<number, number[]>();
  for (let t = 0; t < tris; t++) {
    if (onlyTriangles && !onlyTriangles[t]) continue;
    const k = label ? label[3 * t] : 0;
    let list = byPart.get(k);
    if (!list) byPart.set(k, (list = []));
    list.push(t);
  }
  const out: AtlasMesh[] = [];
  for (const k of [...byPart.keys()].sort((a, b) => a - b)) {
    const list = byPart.get(k)!;
    let at = 0;
    while (at < list.length) {
      const ids = new Map<string, number>();
      const verts: number[] = [], index: number[] = [], own: number[] = [];
      while (at < list.length) {
        const t = list[at];
        const keys: string[] = [];
        let fresh = 0;
        for (let c = 0; c < 3; c++) {
          const p = 9 * t + 3 * c;
          const key = `${Math.round(position[p] * 1e4)},${Math.round(position[p + 1] * 1e4)},${Math.round(position[p + 2] * 1e4)}`;
          keys.push(key);
          if (!ids.has(key) && keys.indexOf(key) === c) fresh++;
        }
        if (ids.size + fresh > maxVertices && own.length) break;
        for (let c = 0; c < 3; c++) {
          let id = ids.get(keys[c]);
          if (id === undefined) {
            id = ids.size;
            ids.set(keys[c], id);
            const p = 9 * t + 3 * c;
            verts.push(position[p], position[p + 1], position[p + 2]);
          }
          index.push(id);
        }
        own.push(t);
        at++;
      }
      out.push({ vertices: Float32Array.from(verts), index: Uint16Array.from(index), triangles: Uint32Array.from(own) });
    }
  }
  return out;
}

/**
 * xatlas's output as texture coordinates for the level's corners (2 per corner). It hands back UVs in [0, 1] of a
 * texture `width` x `height` texels; ours is square, so they are scaled to the longer side, which keeps a texel
 * square on the surface.
 */
export function cornerUVs(tris: number, meshes: AtlasMesh[], result: AtlasResult): Float32Array {
  if (result.meshes.length !== meshes.length) throw new Error(`xatlas returned ${result.meshes.length} meshes for ${meshes.length}`);
  const side = Math.max(result.width, result.height) || 1;
  const su = result.width / side, sv = result.height / side;
  const uv = new Float32Array(tris * 6);
  for (let m = 0; m < meshes.length; m++) {
    const mesh = meshes[m], r = result.meshes[m];
    if (r.index.length !== mesh.index.length) throw new Error(`xatlas changed the faces of mesh ${m}`);
    if (r.vertexCount >= 65536) throw new Error(`mesh ${m} split into ${r.vertexCount} vertices, over what 16-bit indices hold`);
    for (let f = 0; f < mesh.triangles.length; f++) {
      const t = mesh.triangles[f];
      for (let c = 0; c < 3; c++) {
        const v = r.index[3 * f + c];
        uv[6 * t + 2 * c] = r.coords[2 * v] * su;
        uv[6 * t + 2 * c + 1] = r.coords[2 * v + 1] * sv;
      }
    }
  }
  return uv;
}

export interface ChartPartition {
  /** 1 per triangle belonging to a valid artist-authored UV chart whose seams are preserved; 0 when sent to xatlas. */
  pinnedTriangle: Uint8Array;
  /** Number of artist-authored UV charts preserved intact. */
  preservedCharts: number;
  /** Number of charts sent to xatlas for re-charting. */
  unwrappedCharts: number;
  /** Share of total world surface area whose authored seams were preserved (0 to 1). */
  preservedSurface: number;
}

/**
 * Partition existing UV charts into valid artist-authored charts (non-degenerate, inside `[0, 1]²`, consistent winding,
 * bounded singular-value stretch `sigma_max / sigma_min <= maxAnisotropy`, and free of intra-part stacking) versus
 * unhealthy charts that require `xatlas` re-charting.
 */
export function partitionUvCharts(
  position: ArrayLike<number>,
  uv: ArrayLike<number>,
  label: ArrayLike<number> | undefined,
  opts: { maxAnisotropy?: number; grid?: number } = {},
): ChartPartition {
  const maxAniso = opts.maxAnisotropy ?? 2.5;
  const grid = opts.grid ?? 256;
  const tris = Math.floor(position.length / 9);
  if (!tris || uv.length < tris * 6) {
    return { pinnedTriangle: new Uint8Array(tris), preservedCharts: 0, unwrappedCharts: 0, preservedSurface: 0 };
  }

  const part = new Int32Array(tris);
  for (let t = 0; t < tris; t++) part[t] = label ? Math.round(label[3 * t]) : 0;
  const { of: chartOf, count: chartCount } = uvIslands(position, uv, part);

  const chartPart = new Int32Array(chartCount);
  const chartWorld = new Float64Array(chartCount);
  const chartDegen = new Float64Array(chartCount);
  const chartOutside = new Float64Array(chartCount);
  const chartPosWinding = new Float64Array(chartCount);
  const chartNegWinding = new Float64Array(chartCount);
  const chartAnisoSum = new Float64Array(chartCount);
  const chartMinU = new Float64Array(chartCount).fill(Infinity);
  const chartMaxU = new Float64Array(chartCount).fill(-Infinity);
  const chartMinV = new Float64Array(chartCount).fill(Infinity);
  const chartMaxV = new Float64Array(chartCount).fill(-Infinity);
  const triWorld = new Float64Array(tris);
  const triOff = new Uint8Array(tris);

  let totalSurface = 0;

  for (let t = 0; t < tris; t++) {
    const k = chartOf[t];
    chartPart[k] = part[t];
    const p = 9 * t;
    const e1x = position[p + 3] - position[p], e1y = position[p + 4] - position[p + 1], e1z = position[p + 5] - position[p + 2];
    const e2x = position[p + 6] - position[p], e2y = position[p + 7] - position[p + 1], e2z = position[p + 8] - position[p + 2];
    const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
    const world = 0.5 * Math.hypot(cx, cy, cz);
    triWorld[t] = world;
    totalSurface += world;
    chartWorld[k] += world;

    const q = 6 * t;
    for (let c = 0; c < 3; c++) {
      const u = uv[q + 2 * c], v = uv[q + 2 * c + 1];
      chartMinU[k] = Math.min(chartMinU[k], u);
      chartMaxU[k] = Math.max(chartMaxU[k], u);
      chartMinV[k] = Math.min(chartMinV[k], v);
      chartMaxV[k] = Math.max(chartMaxV[k], v);
      if (u < -1e-4 || u > 1 + 1e-4 || v < -1e-4 || v > 1 + 1e-4) triOff[t] = 1;
    }
    if (triOff[t]) chartOutside[k] += world;

    const s1 = uv[q + 2] - uv[q], t1 = uv[q + 3] - uv[q + 1];
    const s2 = uv[q + 4] - uv[q], t2 = uv[q + 5] - uv[q + 1];
    const det2 = s1 * t2 - s2 * t1;
    const tex = 0.5 * Math.abs(det2);
    if (world > 0 && tex < 1e-11) {
      chartDegen[k] += world;
      continue;
    }
    if (det2 > 0) chartPosWinding[k] += world;
    else if (det2 < 0) chartNegWinding[k] += world;

    if (world > 1e-10 && Math.abs(det2) > 1e-12) {
      const inv = 1 / det2;
      const ssx = (e1x * t2 - e2x * t1) * inv, ssy = (e1y * t2 - e2y * t1) * inv, ssz = (e1z * t2 - e2z * t1) * inv;
      const stx = (e2x * s1 - e1x * s2) * inv, sty = (e2y * s1 - e1y * s2) * inv, stz = (e2z * s1 - e1z * s2) * inv;
      const a = ssx * ssx + ssy * ssy + ssz * ssz;
      const b = ssx * stx + ssy * sty + ssz * stz;
      const c = stx * stx + sty * sty + stz * stz;
      const disc = Math.sqrt(Math.max(0, (a - c) * (a - c) + 4 * b * b));
      const sigMax2 = 0.5 * (a + c + disc);
      const sigMin2 = Math.max(1e-18, 0.5 * (a + c - disc));
      const aniso = Math.min(50, Math.sqrt(sigMax2 / sigMin2));
      chartAnisoSum[k] += world * aniso;
    }
  }

  const keepChart = new Uint8Array(chartCount).fill(1);
  for (let k = 0; k < chartCount; k++) {
    const w = chartWorld[k];
    if (w <= 1e-10) { keepChart[k] = 0; continue; }
    if (chartDegen[k] / w > HEALTH_LIMITS.degenerate) { keepChart[k] = 0; continue; }
    if (chartOutside[k] / w > HEALTH_LIMITS.outside) { keepChart[k] = 0; continue; }
    if (Math.min(chartPosWinding[k], chartNegWinding[k]) / w > 0.02) { keepChart[k] = 0; continue; }
    if (chartAnisoSum[k] / w > maxAniso) { keepChart[k] = 0; continue; }
  }

  // Evict stacked identical-bbox charts within the same part (e.g. default BoxGeometry faces or mirrored shells).
  const byPartCharts = new Map<number, number[]>();
  for (let k = 0; k < chartCount; k++) {
    if (!keepChart[k]) continue;
    let list = byPartCharts.get(chartPart[k]);
    if (!list) byPartCharts.set(chartPart[k], (list = []));
    list.push(k);
  }
  for (const list of byPartCharts.values()) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (
          Math.abs(chartMinU[a] - chartMinU[b]) < 2e-3 &&
          Math.abs(chartMaxU[a] - chartMaxU[b]) < 2e-3 &&
          Math.abs(chartMinV[a] - chartMinV[b]) < 2e-3 &&
          Math.abs(chartMaxV[a] - chartMaxV[b]) < 2e-3
        ) {
          keepChart[a] = 0;
          keepChart[b] = 0;
        }
      }
    }
  }

  // Intra-part raster overlap check (two distinct parts occupying [0,1]^2 independently are allowed and repacked).
  const trisByChart: number[][] = Array.from({ length: chartCount }, () => []);
  for (let t = 0; t < tris; t++) if (!triOff[t] && triWorld[t] > 0) trisByChart[chartOf[t]].push(t);

  const owner = new Int32Array(grid * grid);
  for (const list of byPartCharts.values()) {
    // Greedily evict overlapping charts within the same part until remaining charts in this part do not collide.
    while (true) {
      const active = list.filter((k) => keepChart[k]);
      if (active.length <= 1) break;
      owner.fill(-1);
      const covered = new Int32Array(chartCount);
      const collided = new Int32Array(chartCount);
      for (const k of active) {
        for (const t of trisByChart[k]) {
          const q = 6 * t;
          const x0 = uv[q] * grid, y0 = uv[q + 1] * grid, x1 = uv[q + 2] * grid, y1 = uv[q + 3] * grid, x2 = uv[q + 4] * grid, y2 = uv[q + 5] * grid;
          const d = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
          if (Math.abs(d) < 1e-12) continue;
          const ia = Math.max(0, Math.floor(Math.min(x0, x1, x2))), ib = Math.min(grid - 1, Math.ceil(Math.max(x0, x1, x2)));
          const ja = Math.max(0, Math.floor(Math.min(y0, y1, y2))), jb = Math.min(grid - 1, Math.ceil(Math.max(y0, y1, y2)));
          for (let j = ja; j <= jb; j++) {
            const py = j + 0.5;
            for (let i = ia; i <= ib; i++) {
              const px = i + 0.5;
              const w1 = ((px - x0) * (y2 - y0) - (x2 - x0) * (py - y0)) / d;
              const w2 = ((x1 - x0) * (py - y0) - (px - x0) * (y1 - y0)) / d;
              if (w1 < 0 || w2 < 0 || w1 + w2 > 1) continue;
              const cell = j * grid + i;
              covered[k]++;
              const prev = owner[cell];
              if (prev < 0) owner[cell] = k;
              else if (prev !== k) {
                collided[k]++;
                collided[prev]++;
              }
            }
          }
        }
      }
      let worst = -1, worstShare = HEALTH_LIMITS.overlap;
      for (const k of active) {
        const share = covered[k] > 0 ? collided[k] / covered[k] : 0;
        if (share > worstShare || (share === worstShare && worst >= 0 && chartWorld[k] < chartWorld[worst])) {
          worstShare = share;
          worst = k;
        }
      }
      if (worst < 0) break;
      keepChart[worst] = 0;
    }
  }

  const pinnedTriangle = new Uint8Array(tris);
  let preservedCharts = 0, unwrappedCharts = 0, preservedArea = 0;
  for (let k = 0; k < chartCount; k++) {
    if (keepChart[k]) {
      preservedCharts++;
      preservedArea += chartWorld[k];
    } else if (chartWorld[k] > 0) {
      unwrappedCharts++;
    }
  }
  for (let t = 0; t < tris; t++) if (keepChart[chartOf[t]]) pinnedTriangle[t] = 1;

  return {
    pinnedTriangle,
    preservedCharts,
    unwrappedCharts,
    preservedSurface: totalSurface > 0 ? preservedArea / totalSurface : 0,
  };
}

function packCombinedCharts(
  position: ArrayLike<number>,
  uv: ArrayLike<number>,
  chartGroup: ArrayLike<number>,
  margin: number,
): { uv: Float32Array; charts: number; fill: number } {
  const tris = Math.floor(position.length / 9);
  const { of, count } = uvIslands(position, uv, chartGroup);
  const minU = new Float64Array(count).fill(Infinity), maxU = new Float64Array(count).fill(-Infinity);
  const minV = new Float64Array(count).fill(Infinity), maxV = new Float64Array(count).fill(-Infinity);
  const worldArea = new Float64Array(count), uvArea = new Float64Array(count);

  for (let t = 0; t < tris; t++) {
    const k = of[t];
    const p = 9 * t;
    const ax = position[p + 3] - position[p], ay = position[p + 4] - position[p + 1], az = position[p + 5] - position[p + 2];
    const bx = position[p + 6] - position[p], by = position[p + 7] - position[p + 1], bz = position[p + 8] - position[p + 2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    worldArea[k] += 0.5 * Math.hypot(cx, cy, cz);

    const q = 6 * t;
    for (let v = 0; v < 3; v++) {
      const u = uv[q + 2 * v], w = uv[q + 2 * v + 1];
      minU[k] = Math.min(minU[k], u); maxU[k] = Math.max(maxU[k], u);
      minV[k] = Math.min(minV[k], w); maxV[k] = Math.max(maxV[k], w);
    }
    uvArea[k] += 0.5 * Math.abs((uv[q + 2] - uv[q]) * (uv[q + 5] - uv[q + 1]) - (uv[q + 4] - uv[q]) * (uv[q + 3] - uv[q + 1]));
  }

  const relScale = new Float64Array(count);
  const bw = new Float64Array(count), bh = new Float64Array(count);
  let estBoxArea = 0;
  for (let k = 0; k < count; k++) {
    relScale[k] = uvArea[k] > 1e-12 && worldArea[k] > 1e-12 ? Math.sqrt(worldArea[k] / uvArea[k]) : 1;
    bw[k] = Math.max(1e-6, (maxU[k] - minU[k]) * relScale[k]);
    bh[k] = Math.max(1e-6, (maxV[k] - minV[k]) * relScale[k]);
    estBoxArea += bw[k] * bh[k];
  }

  const pad = Math.min(margin, 0.25 / Math.max(1, Math.ceil(Math.sqrt(count))));
  const w = new Float32Array(count), h = new Float32Array(count);
  const tryAt = (g: number) => {
    for (let k = 0; k < count; k++) {
      w[k] = bw[k] * g + pad;
      h[k] = bh[k] * g + pad;
    }
    return packBoxes(w, h);
  };

  const maxDim = Math.max(...bw, ...bh, 1e-6);
  let lo = 0, hi = Math.min((1 - pad) / maxDim, estBoxArea > 0 ? 2 / Math.sqrt(estBoxArea) : 1 / maxDim);
  let best: ReturnType<typeof packBoxes> | undefined;
  for (let i = 0; i < 30; i++) {
    const g = i === 0 ? hi * 0.05 : 0.5 * (lo + hi);
    const p = tryAt(g);
    if (p.height <= 1) {
      lo = g;
      best = { x: p.x.slice(), y: p.y.slice(), height: p.height };
    } else {
      hi = g;
    }
    if (i === 0 && !best) {
      const tiny = tryAt(hi * 1e-4);
      if (tiny.height <= 1) {
        lo = hi * 1e-4;
        best = { x: tiny.x.slice(), y: tiny.y.slice(), height: tiny.height };
      } else break;
    }
  }
  if (!best) throw new Error('could not pack combined UV charts into unit square');

  const out = new Float32Array(tris * 6);
  let fill = 0;
  for (let t = 0; t < tris; t++) {
    const k = of[t];
    const s = relScale[k] * lo;
    const q = 6 * t;
    for (let v = 0; v < 3; v++) {
      out[q + 2 * v] = Math.min(1, Math.max(0, best.x[k] + pad * 0.5 + (uv[q + 2 * v] - minU[k]) * s));
      out[q + 2 * v + 1] = Math.min(1, Math.max(0, best.y[k] + pad * 0.5 + (uv[q + 2 * v + 1] - minV[k]) * s));
    }
    fill += 0.5 * Math.abs((out[q + 2] - out[q]) * (out[q + 5] - out[q + 1]) - (out[q + 4] - out[q]) * (out[q + 3] - out[q + 1]));
  }
  return { uv: out, charts: count, fill };
}

export interface Unwrap {
  uv: Float32Array;
  meshes: number;
  /** Charts (UV islands) the new layout has. */
  charts: number;
  /** Share of the square the charts' texels fill. */
  fill: number;
  /** Artist-authored UV charts preserved intact when `opts.uv` was supplied. */
  preservedCharts?: number;
  /** Share of total world surface area whose authored UV seams were preserved (0 to 1). */
  preservedSurface?: number;
  seconds: number;
}

/** Unwrap a level's triangles (world space, non-indexed) with xatlas, optionally pinning healthy artist-authored UV charts. */
export async function unwrap(position: ArrayLike<number>, label: ArrayLike<number> | undefined, run: XatlasRunner,
  opts: Partial<UnwrapOptions> = {}): Promise<Unwrap> {
  const o = { ...DEFAULT_UNWRAP, ...opts };
  const t0 = performance.now();
  const tris = Math.floor(position.length / 9);

  if (o.uv && (o.preserveSeams ?? true)) {
    const part = partitionUvCharts(position, o.uv, label, { maxAnisotropy: o.maxAnisotropy });
    if (part.preservedCharts > 0) {
      const combined = Float32Array.from(o.uv);
      const needUnwrap = new Uint8Array(tris);
      let anyUnwrap = false;
      for (let t = 0; t < tris; t++) {
        if (!part.pinnedTriangle[t]) {
          needUnwrap[t] = 1;
          anyUnwrap = true;
        }
      }
      let meshCount = 0;
      if (anyUnwrap) {
        const meshes = atlasMeshes(position, label, o.maxVertices, needUnwrap);
        meshCount = meshes.length;
        const result = await run(meshes, o);
        if (result.atlasCount > 1) throw new Error(`xatlas made ${result.atlasCount} textures; expected one`);
        const xuv = cornerUVs(tris, meshes, result);
        for (let t = 0; t < tris; t++) {
          if (needUnwrap[t]) {
            for (let c = 0; c < 6; c++) combined[6 * t + c] = xuv[6 * t + c];
          }
        }
      }
      const group = new Int32Array(tris);
      for (let t = 0; t < tris; t++) group[t] = (label ? Math.round(label[3 * t]) : 0) * 2 + part.pinnedTriangle[t];
      const packed = packCombinedCharts(position, combined, group, (2 * o.padding) / o.resolution);
      return {
        uv: packed.uv,
        meshes: meshCount,
        charts: packed.charts,
        fill: packed.fill,
        preservedCharts: part.preservedCharts,
        preservedSurface: part.preservedSurface,
        seconds: (performance.now() - t0) / 1000,
      };
    }
  }

  const meshes = atlasMeshes(position, label, o.maxVertices);
  const result = await run(meshes, o);
  if (result.atlasCount > 1) throw new Error(`xatlas made ${result.atlasCount} textures; expected one`);
  const uv = cornerUVs(tris, meshes, result);
  let fill = 0;
  for (let t = 0; t < tris; t++) {
    const q = 6 * t;
    fill += Math.abs((uv[q + 2] - uv[q]) * (uv[q + 5] - uv[q + 1]) - (uv[q + 4] - uv[q]) * (uv[q + 3] - uv[q + 1])) / 2;
  }
  return {
    uv,
    meshes: meshes.length,
    charts: uvIslands(position, uv).count,
    fill,
    ...(o.uv && (o.preserveSeams ?? true) ? { preservedCharts: 0, preservedSurface: 0 } : {}),
    seconds: (performance.now() - t0) / 1000,
  };
}

/** xatlas chart and pack options for `UnwrapOptions`. */
export function xatlasOptions(o: UnwrapOptions) {
  return {
    chart: { maxCost: o.maxCost, fixWinding: false, useInputMeshUvs: false },
    // `resolution` 0 lets xatlas size the texture to the charts; the padding is then in its own texels, sized so
    // that the charts come out about `resolution` px across
    pack: { padding: o.padding, resolution: o.resolution, bilinear: true, blockAlign: false, bruteForce: false, rotateCharts: true, rotateChartsToAxis: true, createImage: false },
  };
}

/** The part of xatlasjs's `Api` this uses; its methods may return promises (through a worker) or not. */
export interface XatlasApi {
  createAtlas(): unknown;
  addMesh(index: Uint16Array, vertices: Float32Array, normals?: null, coords?: null, id?: unknown): unknown;
  generateAtlas(chart: object, pack: object, returnMeshes?: boolean): unknown;
  destroyAtlas(): unknown;
}

/** A runner over an xatlasjs `Api` (loaded in the page's worker, or directly under Node). */
export function apiRunner(api: XatlasApi | Promise<XatlasApi>): XatlasRunner {
  let queue: Promise<unknown> = Promise.resolve();
  return (meshes, o) => {
    // one atlas at a time: the module holds a single atlas
    const job = queue.then(async () => {
      const x = await api;
      const { chart, pack } = xatlasOptions(o);
      await x.createAtlas();
      try {
        for (let m = 0; m < meshes.length; m++) {
          const added = await x.addMesh(meshes[m].index, meshes[m].vertices, null, null, m);
          if (!added) throw new Error(`xatlas could not take mesh ${m}`);
        }
        const r = await x.generateAtlas(chart, pack, true) as { width: number; height: number; atlasCount: number;
          meshes: { index: ArrayLike<number>; vertex: { coords1: ArrayLike<number> }; vertexCount: number; mesh: unknown }[] };
        const order = r.meshes.map((m) => Number(m.mesh));
        const out: AtlasMeshResult[] = new Array(meshes.length);
        for (let i = 0; i < r.meshes.length; i++) out[order[i]] = { index: r.meshes[i].index, coords: r.meshes[i].vertex.coords1, vertexCount: r.meshes[i].vertexCount };
        return { width: r.width, height: r.height, atlasCount: r.atlasCount, meshes: out };
      } finally {
        await x.destroyAtlas();
      }
    });
    queue = job.catch(() => undefined);
    return job;
  };
}
