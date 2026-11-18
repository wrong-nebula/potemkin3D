import * as THREE from 'three';
import type { Gpu } from './gpu';
import { sampling, type Sampling } from './metrics';
import { splitParts } from './parts';
import { cellDensity, DEFAULT_PLAN, pixelsPerMetre, planStats, probeCells, selectViews, type CellList, type Plan, type PlanOptions, type Surface } from './planner';
import type { Level } from './scene';
import { cellWeights, faceCurvature, faceOpenness } from './surface-weights';
import { lookAt, type ViewRenderer, type ViewSpec } from './views';

/**
 * Object mode camera planning (TODO item 5): for discrete assets (props, weapons, characters, statues, vehicles) that
 * have no walkable floor. Places an enclosing Fibonacci-sphere camera shell plus an oblique turntable ring around the
 * bounding box, adds close-up probes on high convex curvature, sharp silhouette creases and user-tagged parts
 * (`focusParts`), and runs a pocket-refinement round so exterior and recessed surfaces reach full coverage without a
 * separate hole pass.
 */

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Enclosing Fibonacci-sphere viewpoints around `level.bounds`, used both for visibility layouts (`seen` / `near`) and planning. */
export function objectEyes(level: Pick<Level, 'bounds' | 'bvh'>, count = 48, distanceScale = 2.3): THREE.Vector3[] {
  const centre = level.bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(0.1, level.bounds.getSize(new THREE.Vector3()).length() / 2);
  const dist = Math.max(0.25, radius * distanceScale);
  const out: THREE.Vector3[] = [];
  const dir = new THREE.Vector3(), ray = new THREE.Ray();
  for (let i = 0; i < count; i++) {
    // Clamp y slightly inside (-1, 1) so `lookAt` with +Y up never hits gimbal lock at the exact poles.
    const y = (1 - (2 * (i + 0.5)) / count) * 0.985;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * GOLDEN_ANGLE;
    dir.set(r * Math.cos(phi), y, r * Math.sin(phi)).normalize();
    // Ensure the viewpoint sits outside any protruding geometry along `dir`.
    ray.origin.copy(centre).addScaledVector(dir, radius * 4);
    ray.direction.copy(dir).negate();
    const hit = level.bvh.raycastFirst(ray, THREE.DoubleSide, 0, radius * 4);
    const surfaceR = hit ? radius * 4 - hit.distance : radius;
    const d = Math.max(dist, surfaceR + Math.max(0.15, 0.45 * radius));
    out.push(centre.clone().addScaledVector(dir, d));
  }
  return out;
}

/** Enclosing Fibonacci-sphere + oblique turntable cameras framing the whole asset cleanly. */
export function fibonacciSphereViews(level: Pick<Level, 'bounds' | 'bvh'>, count = 40, startId = 0): ViewSpec[] {
  const centre = level.bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(0.1, level.bounds.getSize(new THREE.Vector3()).length() / 2);
  const eyes = objectEyes(level, count, 2.35);
  const out: ViewSpec[] = [];
  for (const eye of eyes) {
    const d = eye.distanceTo(centre);
    const fov = Math.round(THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan((1.18 * radius) / d)), 38, 68));
    out.push(lookAt(eye, centre, fov, startId + out.length));
  }
  // Closer oblique turntable ring (±24° elevation) for chins, fenders, overhangs and undersides.
  const ringEyes = objectEyes(level, 16, 1.75);
  for (const eye of ringEyes) {
    const relY = (eye.y - centre.y) / Math.max(1e-4, eye.distanceTo(centre));
    if (Math.abs(relY) > 0.65) continue;
    const d = eye.distanceTo(centre);
    const fov = Math.round(THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan((0.95 * radius) / d)), 42, 72));
    out.push(lookAt(eye, centre, fov, startId + out.length));
  }
  return out;
}

interface FeatureTarget {
  center: THREE.Vector3;
  normal: THREE.Vector3;
  radius: number;
  priority: number;
  /** True when `center` is a 3D component's interior centre rather than a single surface patch. */
  wholePart?: boolean;
}

/**
 * Close-up probes aimed at high convex curvature, exposed silhouette creases and user-tagged parts (`focusParts`,
 * matched case-insensitively as substrings of `level.labels`).
 */
export function objectFeatureViews(level: Level, opts: {
  focusParts?: string[];
  curvature?: Float32Array;
  openness?: Float32Array;
  maxTargets?: number;
  startId?: number;
} = {}): ViewSpec[] {
  const g = level.geometry;
  const pos = g.getAttribute('position').array;
  const labelAttr = g.getAttribute('label')?.array;
  const tris = Math.floor(pos.length / 9);
  const boundsSize = level.bounds.getSize(new THREE.Vector3());
  const objRadius = Math.max(0.1, boundsSize.length() / 2);
  const curv = opts.curvature ?? faceCurvature(pos, { scale: 1.5 / Math.max(0.25, Math.min(2, objRadius)) }).value;
  const open = opts.openness ?? faceOpenness(pos, level.bvh, { radius: Math.max(0.25, 0.8 * objRadius) }).value;

  const focusQueries = (opts.focusParts ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const isFocusLabel = level.labels.map((l) => {
    const low = (l ?? '').toLowerCase();
    return low.length > 0 && focusQueries.some((q) => low.includes(q));
  });

  const targets: FeatureTarget[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();

  // 1. User-tagged parts (`focusParts`): each connected component of a tagged part gets dedicated close-up probes.
  const objCentre = level.bounds.getCenter(new THREE.Vector3());
  if (labelAttr && isFocusLabel.some(Boolean)) {
    for (let lab = 0; lab < level.labels.length; lab++) {
      if (!isFocusLabel[lab]) continue;
      const partPos: number[] = [];
      for (let t = 0; t < tris; t++) {
        if (Math.round(labelAttr[3 * t]) !== lab) continue;
        for (let k = 0; k < 9; k++) partPos.push(pos[9 * t + k]);
      }
      if (!partPos.length) continue;
      const split = splitParts(partPos);
      for (const comp of split.parts) {
        const cPos = new THREE.Vector3(...comp.center);
        const outward = cPos.clone().sub(objCentre);
        const dir = outward.lengthSq() > 1e-6 ? outward.normalize() : new THREE.Vector3(0, 0.3, 1).normalize();
        targets.push({
          center: cPos,
          normal: dir,
          radius: Math.max(0.06 * objRadius, comp.radius),
          priority: 100 + comp.area,
          wholePart: true,
        });
      }
    }
  }

  // 2. High convex curvature & silhouette ridges, clustered on a scale-proportional spatial grid.
  const cell = Math.max(0.08, 0.35 * objRadius);
  const clusters = new Map<string, { sum: THREE.Vector3; nrm: THREE.Vector3; min: THREE.Vector3; max: THREE.Vector3; score: number; count: number }>();
  for (let t = 0; t < tris; t++) {
    const score = curv[t] * (0.35 + 0.65 * open[t]);
    if (score < 0.28) continue;
    a.fromArray(pos, 9 * t); b.fromArray(pos, 9 * t + 3); c.fromArray(pos, 9 * t + 6);
    n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
    const area = n.length() / 2;
    if (area < 1e-9) continue;
    n.divideScalar(2 * area);
    const mx = (a.x + b.x + c.x) / 3, my = (a.y + b.y + c.y) / 3, mz = (a.z + b.z + c.z) / 3;
    const key = `${Math.floor(mx / cell)},${Math.floor(my / cell)},${Math.floor(mz / cell)},${Math.round(n.x)},${Math.round(n.y)},${Math.round(n.z)}`;
    let cl = clusters.get(key);
    if (!cl) {
      cl = { sum: new THREE.Vector3(), nrm: new THREE.Vector3(), min: new THREE.Vector3(Infinity, Infinity, Infinity), max: new THREE.Vector3(-Infinity, -Infinity, -Infinity), score: 0, count: 0 };
      clusters.set(key, cl);
    }
    cl.sum.x += mx; cl.sum.y += my; cl.sum.z += mz;
    cl.nrm.addScaledVector(n, area);
    cl.min.min(a).min(b).min(c);
    cl.max.max(a).max(b).max(c);
    cl.score += score * Math.sqrt(area + 1e-6);
    cl.count++;
  }
  for (const cl of [...clusters.values()].sort((x, y) => y.score - x.score).slice(0, opts.maxTargets ?? 20)) {
    if (cl.nrm.lengthSq() < 1e-10) continue;
    targets.push({
      center: cl.sum.divideScalar(cl.count),
      normal: cl.nrm.normalize(),
      radius: Math.max(0.08 * objRadius, cl.min.distanceTo(cl.max) * 0.5),
      priority: cl.score,
    });
  }

  return probesForTargets(level, targets, objRadius, opts.startId ?? 0);
}

/** Place unobstructed close-up cameras over the outward hemisphere of each target patch. */
function probesForTargets(level: Pick<Level, 'bounds' | 'bvh'>, targets: FeatureTarget[], objRadius: number, startId: number): ViewSpec[] {
  const out: ViewSpec[] = [];
  const centre = level.bounds.getCenter(new THREE.Vector3());
  const ray = new THREE.Ray(), tg = new THREE.Vector3(), bt = new THREE.Vector3(), dir = new THREE.Vector3(), eye = new THREE.Vector3();
  const seen = new Set<string>();
  const step = Math.max(0.05, 0.18 * objRadius);

  for (const t of targets.sort((a, b) => b.priority - a.priority)) {
    const n = t.normal;
    tg.set(Math.abs(n.y) < 0.95 ? 0 : 1, Math.abs(n.y) < 0.95 ? 1 : 0, 0).cross(n).normalize();
    bt.crossVectors(n, tg);
    const dist = Math.max(0.2, Math.min(2.1 * objRadius, Math.max(0.85 * objRadius, 2.3 * t.radius)));
    // Try straight along the patch normal first, then 35°-tilted offsets around it to peek past occluders (wheel arches, limbs).
    const offsets: [number, number, number][] = [[0, 0, 1], [0.55, 0, 0.835], [-0.55, 0, 0.835], [0, 0.55, 0.835], [0, -0.55, 0.835]];
    const maxPer = t.wholePart ? 3 : 2;
    const slack = (t.wholePart ? t.radius : 0) + 0.04 * objRadius;
    let placed = 0;
    for (const [ox, oy, oz] of offsets) {
      if (placed >= maxPer) break;
      dir.set(0, 0, 0).addScaledVector(tg, ox).addScaledVector(bt, oy).addScaledVector(n, oz).normalize();
      if (Math.abs(dir.y) > 0.985) { dir.x += 0.18; dir.normalize(); }
      eye.copy(t.center).addScaledVector(dir, dist);
      // Cast from `eye` inward to `t.center`: hitting the target's own front surface within `slack` is fine; earlier hits are occluders.
      ray.origin.copy(eye);
      ray.direction.copy(dir).negate();
      const hitIn = level.bvh.raycastFirst(ray, THREE.DoubleSide, 0, dist);
      if (hitIn && hitIn.distance < dist - slack) continue;
      // Check camera isn't buried inside another closed shell of the asset by casting further outward.
      ray.origin.copy(eye);
      const outward = eye.clone().sub(centre).normalize();
      ray.direction.copy(outward);
      const shell = level.bvh.raycastFirst(ray, THREE.DoubleSide, 0, objRadius * 3);
      if (shell && shell.face && shell.face.normal.dot(outward) > 0) continue;

      const key = `${Math.round(eye.x / step)},${Math.round(eye.y / step)},${Math.round(eye.z / step)},${Math.round(t.center.x / step)},${Math.round(t.center.y / step)},${Math.round(t.center.z / step)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const fov = Math.round(THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan((1.9 * t.radius) / dist)), 42, 68));
      out.push(lookAt(eye, t.center, fov, startId + out.length));
      placed++;
    }
  }
  return out;
}

/**
 * Plan cameras for a discrete 3D object (`mode === 'object'`): enclosing Fibonacci sphere + curvature/tagged-part
 * close-up probes + pocket refinement over any remaining uncovered UV cells, selected with `probeCells` + `selectViews`.
 */
export function planObject(gpu: Gpu, level: Level, views: ViewRenderer, opts: Partial<PlanOptions> = {}, existing?: Float32Array,
  surface?: Surface): Plan {
  const o: PlanOptions = { ...DEFAULT_PLAN, targetCoverage: 0.995, goodRatio: 0.35, goodAbs: 0.18, ...opts };
  const G2 = o.grid * o.grid;
  const g = level.geometry;
  const pos = g.getAttribute('position').array, uv = g.getAttribute('uv').array, labelAttr = g.getAttribute('label')?.array;
  const tris = Math.floor(pos.length / 9);
  const objRadius = Math.max(0.1, level.bounds.getSize(new THREE.Vector3()).length() / 2);

  // Per-cell importance weights: openness + convex curvature boost + 2x focus on user-tagged parts.
  const curv = faceCurvature(pos, { scale: 1.5 / Math.max(0.25, Math.min(2, objRadius)) }).value;
  const open = faceOpenness(pos, level.bvh, { radius: Math.max(0.25, 0.8 * objRadius) }).value;
  const focusQueries = (o.focusParts ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const focusLabel = level.labels.map((l) => {
    const low = (l ?? '').toLowerCase();
    return low.length > 0 && focusQueries.some((q) => low.includes(q));
  });
  const triW = new Float32Array(tris);
  for (let t = 0; t < tris; t++) {
    const lab = labelAttr ? Math.round(labelAttr[3 * t]) : 0;
    triW[t] = (0.45 + 0.55 * open[t]) * (1 + 0.55 * curv[t]) * (focusLabel[lab] ? 2.0 : 1.0);
  }
  const weights = cellWeights(uv, triW, o.grid);

  const sphere = fibonacciSphereViews(level, 42, 0);
  const features = objectFeatureViews(level, {
    focusParts: o.focusParts, curvature: curv, openness: open, maxTargets: 22, startId: sphere.length,
  });
  const candidates: ViewSpec[] = [...sphere, ...features];
  const lists: CellList[] = probeCells(gpu, views, candidates, o);

  // Scale probe qualities to equivalent quality at `o.fov` so narrow close-up lenses are credited fairly in `selectViews`.
  const basePpm = pixelsPerMetre(views.size, o.fov);
  const scaledLists: CellList[] = lists.map((l, k) => {
    const scale = pixelsPerMetre(views.size, candidates[k].fov) / basePpm;
    if (Math.abs(scale - 1) < 1e-4) return l;
    const q = new Float32Array(l.q.length);
    for (let i = 0; i < q.length; i++) q[i] = l.q[i] * scale;
    return { cells: l.cells, q, shape: l.shape };
  });

  // Pocket refinement: if any reachable/surface UV patches remain uncovered after a tentative pass, aim pocket probes straight at them.
  if (surface) {
    const interim = selectViews(scaledLists, { ...o, maxViews: Math.max(6, Math.ceil(o.maxViews * 0.7)) }, [], existing, undefined, undefined, weights);
    const coveredNow = new Uint8Array(G2);
    if (existing) for (let c = 0; c < G2; c++) if (existing[c] > 0) coveredNow[c] = 1;
    for (const k of interim.order) for (const c of scaledLists[k].cells) coveredNow[c] = 1;

    const pCell = Math.max(0.06, 0.25 * objRadius);
    const pockets = new Map<string, { sum: THREE.Vector3; nrm: THREE.Vector3; cells: number }>();
    for (let i = 0; i < G2; i++) {
      if (surface.nrm[4 * i + 3] < 0.5 || coveredNow[i]) continue;
      const x = surface.pos[4 * i], y = surface.pos[4 * i + 1], z = surface.pos[4 * i + 2];
      const nx = surface.nrm[4 * i], ny = surface.nrm[4 * i + 1], nz = surface.nrm[4 * i + 2];
      const key = `${Math.floor(x / pCell)},${Math.floor(y / pCell)},${Math.floor(z / pCell)},${Math.round(nx)},${Math.round(ny)},${Math.round(nz)}`;
      let p = pockets.get(key);
      if (!p) { p = { sum: new THREE.Vector3(), nrm: new THREE.Vector3(), cells: 0 }; pockets.set(key, p); }
      p.sum.x += x; p.sum.y += y; p.sum.z += z;
      p.nrm.x += nx; p.nrm.y += ny; p.nrm.z += nz;
      p.cells++;
    }
    const pocketTargets: FeatureTarget[] = [...pockets.values()]
      .sort((a, b) => b.cells - a.cells)
      .slice(0, 16)
      .filter((p) => p.nrm.lengthSq() > 1e-8)
      .map((p) => ({
        center: p.sum.divideScalar(p.cells),
        normal: p.nrm.normalize(),
        radius: Math.max(0.06 * objRadius, pCell * 0.8),
        priority: p.cells,
      }));
    if (pocketTargets.length) {
      const extra = probesForTargets(level, pocketTargets, objRadius, candidates.length);
      if (extra.length) {
        const start = candidates.length;
        candidates.push(...extra);
        const extraLists = probeCells(gpu, views, extra, o);
        for (let k = 0; k < extraLists.length; k++) {
          const l = extraLists[k], scale = pixelsPerMetre(views.size, candidates[start + k].fov) / basePpm;
          const q = new Float32Array(l.q.length);
          for (let i = 0; i < q.length; i++) q[i] = l.q[i] * scale;
          lists.push(l);
          scaledLists.push({ cells: l.cells, q, shape: l.shape });
        }
      }
    }
  }

  let sharp = undefined;
  if (o.objective === 'sharpness' && surface) {
    sharp = {
      density: cellDensity(surface, o.grid),
      ppm: candidates.map(() => basePpm),   // lens scale is already folded into `scaledLists`
      ppmExisting: basePpm,
      paint: candidates.map(() => 1),
    };
  }
  const sel = selectViews(scaledLists, o, [], existing, undefined, sharp, weights);
  const picked = sel.order.map((k) => ({ spec: candidates[k], cells: lists[k], scaled: scaledLists[k] }));
  const points = picked.map((p) => new THREE.Vector3(...p.spec.position));

  const qAll = new Float32Array(G2);
  for (const l of scaledLists) for (let i = 0; i < l.cells.length; i++) qAll[l.cells[i]] = Math.max(qAll[l.cells[i]], l.q[i]);
  const good = (c: number, q: number) => q >= Math.min(o.goodRatio * qAll[c], o.goodAbs);
  const cov = new Uint8Array(G2);
  let reachable = 0, n = 0;
  for (let c = 0; c < G2; c++) {
    if (!(qAll[c] > 0)) continue;
    reachable++;
    if (existing && good(c, existing[c])) { cov[c] = 1; n++; }
  }
  const predicted = picked.map(({ scaled: l }) => {
    for (let i = 0; i < l.cells.length; i++) if (!cov[l.cells[i]] && good(l.cells[i], l.q[i])) { cov[l.cells[i]] = 1; n++; }
    return reachable ? n / reachable : 0;
  });

  let sharpness: Sampling | undefined;
  let texture: Plan['texture'];
  if (surface) {
    const best = existing ? existing.slice() : new Float32Array(G2);
    for (const { scaled: l } of picked) {
      for (let i = 0; i < l.cells.length; i++) best[l.cells[i]] = Math.max(best[l.cells[i]], l.q[i]);
    }
    const coveredCells = new Uint8Array(G2);
    for (let c = 0; c < G2; c++) coveredCells[c] = surface.nrm[4 * c + 3] > 0.5 ? 1 : 0;
    sharpness = sampling(best, surface.pos, coveredCells, o.grid, surface.texelsPerCell, basePpm);
    let island = 0, seen = 0;
    for (let c = 0; c < G2; c++) if (coveredCells[c]) { island++; if (sel.qBest[c] > 0) seen++; }
    texture = { seen: island ? seen / island : 0 };
  }

  planStats.mode = 1;
  planStats.groundCandidates = candidates.length;
  planStats.floorViews = 0;
  planStats.roofViews = 0;
  planStats.aerialViews = 0;
  return {
    points,
    views: picked.map((p, i) => ({ ...p.spec, id: i })),
    waves: sel.waves,
    viewCells: picked.map((p) => p.cells),
    qBest: qAll,
    grid: o.grid,
    reachableCells: reachable,
    predicted,
    sharpness,
    texture,
    mode: 'object',
  };
}
