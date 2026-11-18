import * as THREE from 'three';
import { OUTDOOR, type Lighting } from './clay';
import { paintability } from './paintability';
import { cellDensity, pixelsPerMetre, probeCells, type CellList, type PlanOptions, type Surface } from './planner';
import type { Level } from './scene';
import { cellWeights, surfaceWeights } from './surface-weights';
import { lookAt, type ViewRenderer, type ViewSpec } from './views';
import type { Gpu } from './gpu';

/**
 * Adaptive, importance-driven camera planning (TODO item 8):
 * - surface geodesic distance from player spots (`geodesicDistance`, `geodesicWeight`), combined with item 7's
 *   per-triangle openness, convex curvature, static light and semantic class (`combinedPlanWeights`);
 * - concave Fisher-style log-resolution utility over UV cells (`fisherUtility`, `selectFisherViews`) with live
 *   painted-context `paintability`, so wide framing views paint context first and focused probes follow without
 *   over-polishing already-sharp walls or abandoning blurry important ones;
 * - iterative probe-and-select refinement (`adaptiveGroundViews`): coarse initial sweep, deficit clustering around
 *   under-covered important / curved / named regions (`deficitTargets`), targeted adaptive-FOV probes
 *   (`adaptiveLookViews`), and joint final selection;
 * - spend & bottleneck guidance (`budgetAdvice`): recommended view count knee, whether extra views or layout are the
 *   limit, tail views suited to a local/cheap model, and sparse PBR height-tile gating.
 */

/**
 * Surface geodesic distance (m) per triangle from the walkable player spots, propagated across shared welded corners
 * plus short proximity bridges (`bridge` m) so kitbashed props, columns and trim resting on a floor or wall inherit
 * finite surface distance without needing manifold booleans.
 */
export function geodesicDistance(position: ArrayLike<number>, spots: THREE.Vector3[],
  opts: { eyeHeight?: number; seedRadius?: number; bridge?: number; weld?: number } = {}): Float32Array {
  const eyeHeight = opts.eyeHeight ?? 1.65, seedRadius = opts.seedRadius ?? 2.4, bridge = opts.bridge ?? 0.45, weld = opts.weld ?? 1e-3;
  const tris = Math.floor(position.length / 9);
  const dist = new Float32Array(tris).fill(Infinity);
  if (!tris || !spots.length) return dist;

  const cx = new Float32Array(tris), cy = new Float32Array(tris), cz = new Float32Array(tris);
  const vertTris = new Map<string, number[]>();
  const bridgeGrid = new Map<string, number[]>();
  const bCell = Math.max(0.25, bridge);

  for (let t = 0; t < tris; t++) {
    const p = 9 * t;
    const x = (position[p] + position[p + 3] + position[p + 6]) / 3;
    const y = (position[p + 1] + position[p + 4] + position[p + 7]) / 3;
    const z = (position[p + 2] + position[p + 5] + position[p + 8]) / 3;
    cx[t] = x; cy[t] = y; cz[t] = z;
    for (let v = 0; v < 3; v++) {
      const q = p + 3 * v;
      const vk = `${Math.round(position[q] / weld)},${Math.round(position[q + 1] / weld)},${Math.round(position[q + 2] / weld)}`;
      const vl = vertTris.get(vk);
      if (vl) vl.push(t); else vertTris.set(vk, [t]);
    }
    const bk = `${Math.floor(x / bCell)},${Math.floor(y / bCell)},${Math.floor(z / bCell)}`;
    const bl = bridgeGrid.get(bk);
    if (bl) bl.push(t); else bridgeGrid.set(bk, [t]);
  }

  // Adjacency list per triangle: welded-vertex neighbours + nearby spatial-bridge centroids (capped per cell so dense grids stay O(N)).
  const adj: number[][] = Array.from({ length: tris }, () => []);
  for (const list of vertTris.values()) {
    if (list.length < 2 || list.length > 32) continue;
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const v = list[j];
        adj[u].push(v); adj[v].push(u);
      }
    }
  }
  const bridge2 = bridge * bridge;
  for (let t = 0; t < tris; t++) {
    const gx = Math.floor(cx[t] / bCell), gy = Math.floor(cy[t] / bCell), gz = Math.floor(cz[t] / bCell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const cell = bridgeGrid.get(`${gx + dx},${gy + dy},${gz + dz}`);
      if (!cell) continue;
      for (let k = 0; k < cell.length && k < 8; k++) {
        const u = cell[k];
        if (u <= t) continue;
        const d2 = (cx[u] - cx[t]) ** 2 + (cy[u] - cy[t]) ** 2 + (cz[u] - cz[t]) ** 2;
        if (d2 <= bridge2) { adj[t].push(u); adj[u].push(t); }
      }
    }
  }

  // Binary min-heap Dijkstra seeded from walkable foot positions.
  const heapT: number[] = [], heapD: number[] = [];
  const push = (t: number, d: number) => {
    let i = heapT.length;
    heapT.push(t); heapD.push(d);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapD[p] <= d) break;
      heapT[i] = heapT[p]; heapD[i] = heapD[p];
      i = p;
    }
    heapT[i] = t; heapD[i] = d;
  };
  const pop = (): [number, number] => {
    const topT = heapT[0], topD = heapD[0];
    const lastT = heapT.pop()!, lastD = heapD.pop()!;
    if (heapT.length) {
      let i = 0;
      const n = heapT.length;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        if (l >= n) break;
        const m = r < n && heapD[r] < heapD[l] ? r : l;
        if (lastD <= heapD[m]) break;
        heapT[i] = heapT[m]; heapD[i] = heapD[m];
        i = m;
      }
      heapT[i] = lastT; heapD[i] = lastD;
    }
    return [topT, topD];
  };

  const feet = spots.map((s) => [s.x, s.y - eyeHeight, s.z] as const);
  const seedR2 = seedRadius * seedRadius;
  for (let t = 0; t < tris; t++) {
    let best = Infinity;
    for (const [fx, fy, fz] of feet) {
      const dy = cy[t] - fy;
      if (dy < -0.8 || dy > 2.8) continue;
      const d2 = (cx[t] - fx) ** 2 + (cz[t] - fz) ** 2;
      if (d2 <= seedR2) best = Math.min(best, Math.hypot(Math.sqrt(d2), Math.max(0, dy)));
    }
    if (best < Infinity) { dist[t] = best; push(t, best); }
  }

  while (heapT.length) {
    const [u, du] = pop();
    if (du > dist[u] + 1e-6) continue;
    for (const v of adj[u]) {
      const step = Math.hypot(cx[v] - cx[u], cy[v] - cy[u], cz[v] - cz[u]);
      const nd = du + step;
      if (nd < dist[v] - 1e-6) { dist[v] = nd; push(v, nd); }
    }
  }
  return dist;
}

/** Map surface geodesic distance (m) from player paths into an importance multiplier in `[minWeight, 1]`. */
export function geodesicWeight(dist: ArrayLike<number>,
  opts: { fullWithin?: number; decay?: number; minWeight?: number } = {}): Float32Array {
  const fullWithin = opts.fullWithin ?? 3.5, decay = opts.decay ?? 14, minWeight = opts.minWeight ?? 0.28;
  const out = new Float32Array(dist.length);
  for (let i = 0; i < dist.length; i++) {
    const d = dist[i];
    out[i] = Number.isFinite(d) ? minWeight + (1 - minWeight) * Math.exp(-Math.max(0, d - fullWithin) / decay) : minWeight;
  }
  return out;
}

/**
 * Combined per-cell importance weights on the planner's `grid` x `grid` UV space: item 7's surface weights (openness,
 * convex curvature, static light, semantic class), boosted on distinct named parts and weighted by surface geodesic
 * distance from `points`.
 */
export function combinedPlanWeights(level: Level, points: THREE.Vector3[], grid: number,
  opts: { eyeHeight?: number; geodesic?: boolean; lighting?: Lighting } = {}): Float32Array {
  const g = level.geometry;
  const pos = g.getAttribute('position').array, uv = g.getAttribute('uv').array, label = g.getAttribute('label')?.array;
  const tris = Math.floor(pos.length / 9);
  const sw = level.surfaceWeights && level.surfaceWeights.importance.length === tris
    ? level.surfaceWeights
    : (level.surfaceWeights = surfaceWeights(level, opts.lighting ?? OUTDOOR));
  const geo = opts.geodesic !== false ? geodesicWeight(geodesicDistance(pos, points, { eyeHeight: opts.eyeHeight })) : null;

  // Distinct named non-shell parts (covering < 12% of the level's area each: statues, columns, arches, machines, props).
  const partArea = new Float64Array(Math.max(1, level.labels.length));
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  if (label && level.labels.length > 1) {
    for (let t = 0; t < tris; t++) {
      a.fromArray(pos, 9 * t); b.fromArray(pos, 9 * t + 3); c.fromArray(pos, 9 * t + 6);
      const l = Math.round(label[3 * t]);
      if (l >= 0 && l < partArea.length) partArea[l] += b.sub(a).cross(c.sub(a)).length() / 2;
    }
  }
  const namedFeature = level.labels.map((name, k) => !!name && level.surfaceArea > 0 && partArea[k] > 0 && partArea[k] < 0.12 * level.surfaceArea);

  const triW = new Float32Array(tris);
  for (let t = 0; t < tris; t++) {
    const l = label ? Math.round(label[3 * t]) : 0;
    const feat = 1 + 0.35 * sw.curvature[t] * sw.openness[t] + (namedFeature[l] ? 0.15 : 0);
    triW[t] = sw.importance[t] * feat * (geo ? geo[t] : 1);
  }
  return cellWeights(uv, triW, grid);
}

/**
 * Concave Fisher-style log-information utility over normalized cell resolution `r` in `[0, 1]`:
 * `r = 0 -> 0`, `r = 0.25 -> 0.38` (at-least-once coverage pull), `r = 0.75 -> 0.84` (strong pull to sharpen blurry
 * important surfaces), `r = 1 -> 1` (diminishing return once a cell approaches atlas capacity).
 */
export function fisherUtility(r: number, alpha = 4.0): number {
  if (!(r > 0)) return 0;
  return Math.log(1 + alpha * Math.min(1, r)) / Math.log(1 + alpha);
}

/**
 * Greedy Fisher-utility camera selection with live painted-context `paintability`. Wide multi-face framing views win
 * early when nothing is painted (`context = 0`), and focused probes unlock automatically once surrounding views have
 * painted >= 30% of their frame.
 */
export function selectFisherViews(lists: CellList[], specs: ViewSpec[], o: PlanOptions, opts: {
  density: ArrayLike<number>;
  weights?: ArrayLike<number>;
  existing?: Float32Array;
  ppmExisting?: number;
  skip?: Uint8Array;
  aerial?: boolean[];
  minMarginal?: number;
  viewSize?: number;
}) {
  const G2 = o.grid * o.grid;
  const viewSize = opts.viewSize ?? 2048;
  const ppm = specs.map((v) => pixelsPerMetre(viewSize, v.fov));
  const ppmExisting = opts.ppmExisting ?? pixelsPerMetre(viewSize, o.fov);
  const minMarginal = opts.minMarginal ?? 0.003;

  const qBest = new Float32Array(G2);
  for (let k = 0; k < lists.length; k++) {
    const l = lists[k], scale = ppm[k] / ppmExisting;
    for (let i = 0; i < l.cells.length; i++) qBest[l.cells[i]] = Math.max(qBest[l.cells[i]], l.q[i] * scale);
  }
  if (opts.skip) for (let c = 0; c < G2; c++) if (opts.skip[c]) qBest[c] = 0;

  let reachable = 0;
  for (let c = 0; c < G2; c++) if (qBest[c] > 0) reachable++;
  if (!reachable || !lists.length) {
    return { order: [] as number[], waves: [] as number[][], qBest, reachable, predicted: [] as number[],
      haveR: new Float32Array(G2), marginalShares: [] as number[], weightedCoverage: 0 };
  }

  // Normalize weights over reachable cells to mean 1, tempered by surface footprint (`medianDensity / density`) so
  // tiny densely-packed trim slivers don't starve large visible walls and courtyard floors.
  const knownD: number[] = [];
  for (let c = 0; c < G2; c++) if (qBest[c] > 0 && opts.density[c] > 0) knownD.push(opts.density[c]);
  knownD.sort((a, b) => a - b);
  const medDensity = knownD.length ? knownD[knownD.length >> 1] : 0;

  const cellW = new Float32Array(G2);
  let wSum = 0;
  for (let c = 0; c < G2; c++) {
    if (!(qBest[c] > 0)) continue;
    const base = opts.weights && opts.weights[c] > 0 ? opts.weights[c] : 1;
    const areaMod = medDensity > 0 && opts.density[c] > 0
      ? Math.min(2.2, Math.max(0.55, medDensity / opts.density[c]))
      : 1;
    const w = base * areaMod;
    cellW[c] = w;
    wSum += w;
  }
  const wNorm = wSum > 0 ? reachable / wSum : 1;
  for (let c = 0; c < G2; c++) if (qBest[c] > 0) cellW[c] *= wNorm;

  const fallbackDensity = ppmExisting * Math.max(o.goodAbs, 0.2);
  const resOf = (c: number, ppmK: number, q: number) => {
    const d = opts.density[c] > 0 ? opts.density[c] : fallbackDensity;
    return Math.min(1, (ppmK * q) / d);
  };

  const haveR = new Float32Array(G2), haveU = new Float32Array(G2);
  let totalU = 0;
  if (opts.existing) {
    for (let c = 0; c < G2; c++) {
      if (!(qBest[c] > 0) || !(opts.existing[c] > 0)) continue;
      haveR[c] = resOf(c, ppmExisting, opts.existing[c]);
      haveU[c] = cellW[c] * fisherUtility(haveR[c]);
      totalU += haveU[c];
    }
  }

  const used = new Uint8Array(lists.length);
  const chosen: number[] = [];
  const marginalShares: number[] = [];

  while (chosen.length < o.maxViews && totalU / reachable < o.targetCoverage) {
    let bestK = -1, bestScore = 0, bestRawGain = 0;
    for (let k = 0; k < lists.length; k++) {
      if (used[k]) continue;
      const l = lists[k];
      if (!l.cells.length) continue;
      let rawGain = 0, paintedInView = 0;
      for (let i = 0; i < l.cells.length; i++) {
        const c = l.cells[i];
        if (haveR[c] > 0.05) paintedInView++;
        if (!(qBest[c] > 0)) continue;
        const r = resOf(c, ppm[k], l.q[i]);
        if (r > haveR[c]) rawGain += cellW[c] * fisherUtility(r) - haveU[c];
      }
      if (rawGain <= 0) continue;
      const ctx = paintedInView / l.cells.length;
      // On roofless outdoor scenes a level 90° horizon shot naturally has ~50% sky; only penalize sky-heavy >60% frames.
      const sky = l.shape && l.shape.sky <= 0.6 ? Math.min(l.shape.sky, 0.44) : l.shape?.sky ?? 0;
      const p = l.shape ? paintability({ pitch: specs[k].pitch, ...l.shape, sky, context: ctx }) : 1;
      const score = rawGain * p * (opts.aerial?.[k] ? 0.5 : 1);
      if (score > bestScore) { bestScore = score; bestK = k; bestRawGain = rawGain; }
    }
    if (bestK < 0 || bestRawGain < Math.max(4, reachable * minMarginal)) break;
    used[bestK] = 1;
    chosen.push(bestK);
    marginalShares.push(bestRawGain / reachable);
    const l = lists[bestK];
    for (let i = 0; i < l.cells.length; i++) {
      const c = l.cells[i];
      if (!(qBest[c] > 0)) continue;
      const r = resOf(c, ppm[bestK], l.q[i]);
      if (r > haveR[c]) {
        const nu = cellW[c] * fisherUtility(r);
        totalU += nu - haveU[c];
        haveR[c] = r;
        haveU[c] = nu;
      }
    }
  }

  if (!chosen.length) {
    return { order: [] as number[], waves: [] as number[][], qBest, reachable, predicted: [] as number[],
      haveR, marginalShares, weightedCoverage: totalU / reachable };
  }

  // Paint order: start from the first chosen framing view, then maximize overlap with painted cells while respecting rank.
  const painted = new Uint8Array(G2);
  if (opts.existing) for (let c = 0; c < G2; c++) if (opts.existing[c] > 0) painted[c] = 1;
  const overlap = (k: number) => { let n = 0; for (const c of lists[k].cells) if (painted[c]) n++; return n; };
  const mark = (k: number) => { for (const c of lists[k].cells) painted[c] = 1; };
  const ground = chosen.filter((k) => !opts.aerial?.[k]);
  const air = chosen.filter((k) => opts.aerial?.[k]);
  const order: number[] = [ground[0] ?? air[0]];
  mark(order[0]);
  const rest = new Set((ground.length ? ground : air).slice(1));
  while (rest.size) {
    let best = -1, bestScore = -1;
    for (const k of rest) {
      const ov = overlap(k) / Math.max(1, lists[k].cells.length);
      const score = ov > 0.08 ? 1 + ov * 0.1 + (1 - chosen.indexOf(k) / chosen.length) : ov;
      if (score > bestScore) { bestScore = score; best = k; }
    }
    order.push(best);
    mark(best);
    rest.delete(best);
  }
  if (ground.length) for (const k of air) order.push(k);

  // Parallel waves (identical overlap/clash safety rules as `selectViews`).
  const waves: number[][] = [];
  const done = new Uint8Array(G2);
  if (opts.existing) for (let c = 0; c < G2; c++) if (opts.existing[c] > 0) done[c] = 1;
  const pending = order.map((_, i) => i);
  while (pending.length) {
    if (opts.aerial?.[order[pending[0]]]) {
      const vi = pending.shift()!;
      waves.push([vi]);
      for (const c of lists[order[vi]].cells) done[c] = 1;
      continue;
    }
    const wave: number[] = [];
    const inWave = new Uint8Array(G2);
    for (let p = 0; p < pending.length && wave.length < o.maxParallel; p++) {
      const vi = pending[p];
      if (opts.aerial?.[order[vi]]) break;
      const l = lists[order[vi]];
      let touchesDone = 0, clash = 0;
      for (const c of l.cells) { if (done[c]) touchesDone++; if (inWave[c]) clash++; }
      const first = waves.length === 0 && wave.length === 0;
      if (!first && waves.length === 0 && !opts.existing) break;
      if (!first && touchesDone < 0.05 * l.cells.length && wave.length) continue;
      if (clash > 0.02 * l.cells.length) continue;
      wave.push(vi);
      for (const c of l.cells) inWave[c] = 1;
    }
    if (!wave.length) wave.push(pending[0]);
    for (const vi of wave) { pending.splice(pending.indexOf(vi), 1); for (const c of lists[order[vi]].cells) done[c] = 1; }
    waves.push(wave);
  }

  // Standard reachable-cell predicted coverage curve for direct comparison across planners.
  const good = (k: number, i: number) => {
    const c = lists[k].cells[i], scale = ppm[k] / ppmExisting;
    return qBest[c] > 0 && lists[k].q[i] * scale >= Math.min(o.goodRatio * qBest[c], o.goodAbs);
  };
  const cov = new Uint8Array(G2);
  let covCount = 0;
  if (opts.existing) {
    for (let c = 0; c < G2; c++) if (qBest[c] > 0 && opts.existing[c] >= Math.min(o.goodRatio * qBest[c], o.goodAbs)) { cov[c] = 1; covCount++; }
  }
  const predicted = order.map((k) => {
    const l = lists[k];
    for (let i = 0; i < l.cells.length; i++) if (!cov[l.cells[i]] && good(k, i)) { cov[l.cells[i]] = 1; covCount++; }
    return covCount / reachable;
  });

  return { order, waves, qBest, reachable, predicted, haveR, marginalShares, weightedCoverage: totalU / reachable };
}

export interface DeficitPatch {
  center: THREE.Vector3;
  normal: THREE.Vector3;
  radius: number;
  density: number;
  cells: number;
  deficit: number;
}

/**
 * Gather currently under-covered important UV cells (`w * (1 - fisherUtility(haveR))`) into 3D surface patches,
 * highest weighted deficit first, so refinement only spawns probes where important detail is actually missing.
 */
export function deficitTargets(pos: ArrayLike<number>, nrm: ArrayLike<number>, haveR: ArrayLike<number>,
  opts: { weights?: ArrayLike<number>; density?: ArrayLike<number>; skip?: Uint8Array; cell?: number; max?: number } = {}): DeficitPatch[] {
  const cell = opts.cell ?? 2.5, max = opts.max ?? 32;
  const groups = new Map<string, {
    sum: THREE.Vector3; normal: THREE.Vector3; min: THREE.Vector3; max: THREE.Vector3;
    densitySum: number; cells: number; deficit: number;
  }>();
  for (let i = 0; i < haveR.length; i++) {
    if (nrm[4 * i + 3] < 0.5 || opts.skip?.[i]) continue;
    const rem = 1 - fisherUtility(haveR[i]);
    if (rem < 0.12) continue;   // already sharp enough
    const w = opts.weights && opts.weights[i] > 0 ? opts.weights[i] : 1;
    const def = w * rem;
    if (def < 0.15) continue;
    const x = pos[4 * i], y = pos[4 * i + 1], z = pos[4 * i + 2];
    const key = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)},${Math.round(nrm[4 * i])},${Math.round(nrm[4 * i + 1])},${Math.round(nrm[4 * i + 2])}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        sum: new THREE.Vector3(), normal: new THREE.Vector3(),
        min: new THREE.Vector3(Infinity, Infinity, Infinity), max: new THREE.Vector3(-Infinity, -Infinity, -Infinity),
        densitySum: 0, cells: 0, deficit: 0,
      };
      groups.set(key, g);
    }
    g.sum.x += x; g.sum.y += y; g.sum.z += z;
    g.normal.x += nrm[4 * i]; g.normal.y += nrm[4 * i + 1]; g.normal.z += nrm[4 * i + 2];
    g.min.min(new THREE.Vector3(x, y, z));
    g.max.max(new THREE.Vector3(x, y, z));
    g.densitySum += opts.density?.[i] ?? 64;
    g.cells++;
    g.deficit += def;
  }
  return [...groups.values()]
    .sort((a, b) => b.deficit - a.deficit)
    .slice(0, max)
    .map((g) => ({
      center: g.sum.divideScalar(g.cells),
      normal: g.normal.normalize(),
      radius: Math.max(0.75, g.min.distanceTo(g.max) * 0.5),
      density: g.densitySum / g.cells,
      cells: g.cells,
      deficit: g.deficit,
    }));
}

/**
 * Targeted refinement cameras aimed at high-deficit patches from the nearest unobstructed player spots, choosing an
 * adaptive lens (`58°` to `82°`) that matches the texture's local texel density while keeping surrounding room context
 * in frame (`maxFace <= ~0.45`).
 */
export function adaptiveLookViews(level: Level, targets: DeficitPatch[], points: THREE.Vector3[], viewSize: number,
  opts: { per?: number; minDist?: number; maxDist?: number; minFov?: number; maxFov?: number; existing?: ViewSpec[] } = {}): ViewSpec[] {
  const per = opts.per ?? 2, minDist = opts.minDist ?? 1.5, maxDist = opts.maxDist ?? 15;
  const minFov = opts.minFov ?? 62, maxFov = opts.maxFov ?? 84;
  const out: ViewSpec[] = [];
  const ray = new THREE.Ray(), to = new THREE.Vector3();
  const maxPitch = THREE.MathUtils.degToRad(19.5);   // stays within paintability's full-score <= 20° tilt band
  const step = THREE.MathUtils.degToRad(10);
  const seen = new Set<string>();
  const keyOf = (pos: [number, number, number], yaw: number, pitch: number, fov: number) =>
    `${Math.round(pos[0])},${Math.round(pos[1])},${Math.round(pos[2])},${Math.round(yaw / step)},${Math.round(pitch / step)},${Math.round(fov / 10)}`;
  for (const v of opts.existing ?? []) seen.add(keyOf(v.position, v.yaw, v.pitch, v.fov));

  for (const t of targets) {
    let added = 0;
    const sorted = [...points].sort((a, b) => a.distanceToSquared(t.center) - b.distanceToSquared(t.center));
    for (const p of sorted) {
      if (added >= per) break;
      const dist = to.subVectors(t.center, p).length();
      if (dist < minDist) continue;
      if (dist > maxDist) break;
      const cos = -t.normal.dot(to) / dist;
      if (cos < 0.25) continue;
      ray.origin.copy(p);
      ray.direction.copy(to).divideScalar(dist);
      const hit = level.bvh.raycastFirst(ray, THREE.DoubleSide);
      if (hit && hit.distance < dist - 0.3) continue;

      // Match the lens to the texture's local texel density, and when tight also offer a wide 86° framing candidate aimed at the patch.
      const fovForDensity = t.density > 0
        ? THREE.MathUtils.radToDeg(2 * Math.atan((viewSize * cos) / (2 * dist * t.density)))
        : 65;
      const tight = Math.round(THREE.MathUtils.clamp(fovForDensity, minFov, maxFov));
      const fovs = tight < 76 ? [tight, 86] : [tight];
      added++;
      for (const fov of fovs) {
        const spec = lookAt(p, t.center, fov, out.length);
        const pitch = THREE.MathUtils.clamp(spec.pitch, -maxPitch, maxPitch);
        const key = keyOf(spec.position, spec.yaw, pitch, fov);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...spec, pitch });
      }
    }
  }
  return out;
}

export interface BudgetAdvice {
  /** Views before marginal weighted utility drops below 0.8% of the reachable weighted surface. */
  recommendedViews: number;
  /** Weighted Fisher coverage achieved in `[0, 1]`. */
  weightedCoverage: number;
  /** True when the last view still added >= 1% weighted utility and important detail remains uncapped. */
  extraViewsWorthIt: boolean;
  /** Whether surface sharpness is now limited mainly by view count/closeness or by atlas resolution. */
  bottleneck: 'views' | 'layout' | 'balanced';
  /** Tail views with marginal gain under 1.5%, suited to a local or cheaper fill model (TODO item 2). */
  localModelTailViews: number;
  /** 2048 px PBR tiles containing high-importance surface (`>= 0.85`) vs total covered tiles, for sparse height baking. */
  sparseHeightTiles: { active: number; total: number };
  /** Iterative refinement rounds and total candidate cameras probed. */
  rounds: number;
  probedCandidates: number;
}

export function budgetAdvice(opts: {
  marginalShares: number[];
  weightedCoverage: number;
  medianRatio: number;
  surface: Surface;
  weights: ArrayLike<number>;
  grid: number;
  atlasSize: number;
  rounds: number;
  probedCandidates: number;
}): BudgetAdvice {
  const { marginalShares, weightedCoverage, medianRatio, surface, weights, grid, atlasSize, rounds, probedCandidates } = opts;
  let recommended = marginalShares.length;
  for (let i = 0; i < marginalShares.length; i++) {
    if (marginalShares[i] < 0.008) { recommended = Math.max(1, i); break; }
  }
  const lastGain = marginalShares[marginalShares.length - 1] ?? 0;
  const extraViewsWorthIt = lastGain >= 0.01 && weightedCoverage < 0.9;
  const bottleneck = medianRatio >= 1.0 ? 'layout' : medianRatio < 0.65 ? 'views' : 'balanced';
  const localModelTailViews = marginalShares.filter((g) => g < 0.015).length;

  // Sparse height tile gating over `pbr.ts`'s 2048 px tile grid.
  const tileGrid = Math.max(1, Math.ceil(atlasSize / 2048));
  let total = 0, active = 0;
  for (let ty = 0; ty < tileGrid; ty++) {
    for (let tx = 0; tx < tileGrid; tx++) {
      const x0 = Math.floor((tx * grid) / tileGrid), x1 = Math.floor(((tx + 1) * grid) / tileGrid);
      const y0 = Math.floor((ty * grid) / tileGrid), y1 = Math.floor(((ty + 1) * grid) / tileGrid);
      let covered = 0, imp = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * grid + x;
          if (surface.nrm[4 * i + 3] < 0.5) continue;
          covered++;
          if (weights[i] >= 0.85) imp++;
        }
      }
      if (covered > 0) {
        total++;
        if (imp >= Math.max(4, 0.05 * covered)) active++;
      }
    }
  }
  return {
    recommendedViews: recommended,
    weightedCoverage: +weightedCoverage.toFixed(3),
    extraViewsWorthIt,
    bottleneck,
    localModelTailViews,
    sparseHeightTiles: { active, total },
    rounds,
    probedCandidates,
  };
}

/**
 * Iterative probe-and-select ground camera planning:
 * 1. Coarse wide yaw sweep (`<= 6` headings/spot) probed and tentatively selected with `selectFisherViews`.
 * 2. Up to two targeted refinement rounds spawning adaptive-FOV cameras around the highest remaining weighted deficits.
 * 3. Final joint Fisher selection over all probed candidates so redundant early views yield to sharper targeted ones.
 */
export function adaptiveGroundViews(gpu: Gpu, level: Level, views: ViewRenderer, points: THREE.Vector3[], o: PlanOptions,
  surface: Surface, opts: { existing?: Float32Array; skip?: Uint8Array; coarseSpecs: ViewSpec[]; weights: Float32Array }) {
  const density = cellDensity(surface, o.grid);
  const allSpecs: ViewSpec[] = opts.coarseSpecs.map((s, id) => ({ ...s, id }));
  const allLists: CellList[] = probeCells(gpu, views, allSpecs, o, undefined, true);
  let rounds = 1;

  const maxRounds = o.maxViews >= 8 ? 3 : 2;
  for (let r = 1; r < maxRounds; r++) {
    const roundBudget = Math.max(2, Math.ceil(o.maxViews * (r === 1 ? 0.5 : 0.85)));
    const interim = selectFisherViews(allLists, allSpecs, { ...o, maxViews: roundBudget }, {
      density, weights: opts.weights, existing: opts.existing, skip: opts.skip, viewSize: views.size,
    });
    const patches = deficitTargets(surface.pos, surface.nrm, interim.haveR, {
      weights: opts.weights, density, skip: opts.skip, cell: r === 1 ? 2.6 : 1.8, max: r === 1 ? 36 : 24,
    });
    if (!patches.length) break;
    const extra = adaptiveLookViews(level, patches, points, views.size, {
      per: r === 1 ? 3 : 2, existing: allSpecs,
    });
    if (!extra.length) break;
    const start = allSpecs.length;
    for (let i = 0; i < extra.length; i++) allSpecs.push({ ...extra[i], id: start + i });
    allLists.push(...probeCells(gpu, views, allSpecs.slice(start), o, undefined, true));
    rounds++;
  }

  const sel = selectFisherViews(allLists, allSpecs, o, {
    density, weights: opts.weights, existing: opts.existing, skip: opts.skip, viewSize: views.size,
  });
  return { specs: allSpecs, lists: allLists, sel, rounds };
}
