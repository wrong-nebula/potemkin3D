import * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import { uvIslands } from './layout';

/**
 * Facts about each face of a level that come from its geometry alone, used as weights by the layouts and the
 * planner (no model call, no camera). The first is openness: how much of the space in front of a face is free. A
 * face deep in a crease, a slot or a recess is one no player and no camera gets close to, and it sits in shadow;
 * it needs fewer texels than an open wall of the same size.
 *
 * Openness is the measure Fast SDF AO (https://github.com/wrong-nebula/Fast-SDF-AO) is scored against: the share of
 * cosine-weighted directions with nothing within 1.12 m. Per face it is estimated from a few short rays at each of
 * several points, each point's rays turned against the last, so the face's mean is good though each point's is
 * coarse. Measured on the samples against 256 rays at the same points, the per-face error is 0.018-0.025 with 4
 * rays a point. Fast SDF AO's four-tap formula (`openness4`, four distance reads along the normal) costs the same
 * per point here but errs by 0.07-0.15 per face: it reads a thin bar beside the face (a grille, a lamp cord) as a
 * wall, and it is made for a GPU reading a baked field per pixel, not for exact queries averaged over a face.
 */

/** Tap distances along the normal (m) and their weights, as in Fast SDF AO's four-tap formula. */
export const TAPS = [0.16, 0.48, 0.8, 1.12];
const WEIGHTS = TAPS.map((_, i) => 1 - (0.55 * i) / 3);
const WEIGHT_SUM = WEIGHTS.reduce((a, b) => a + b, 0);
const BIAS = 0.045, STRENGTH = 0.92;

const tap = new THREE.Vector3();
const hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
const along = new THREE.Ray();

/**
 * Openness of one surface point, 0 (enclosed) to 1 (nothing within 1.12 m in front of it).
 *
 * The baked field of Fast SDF AO is signed, so a tap that ends up inside a solid reads as fully occluded. Blockouts
 * are rarely closed, so this field can't be signed; instead one ray along the normal finds the first surface in
 * front, and a tap beyond it (behind a slab overhead, or a face buried inside another box) counts as occluded.
 */
export function openness4(bvh: MeshBVH, p: THREE.Vector3, n: THREE.Vector3): number {
  along.origin.copy(p);
  along.direction.copy(n);
  const front = bvh.raycastFirst(along, THREE.DoubleSide, 0, TAPS[TAPS.length - 1]);
  const wall = front ? front.distance : Infinity;
  let occ = 0;
  for (let i = 0; i < TAPS.length; i++) {
    const r = TAPS[i];
    if (r >= wall) { occ += WEIGHTS[i]; continue; }
    tap.copy(p).addScaledVector(n, r);
    // nothing nearer than r: this tap is open, so the search can stop at r
    const found = bvh.closestPointToPoint(tap, hit, 0, r);
    const d = found ? found.distance : r;
    occ += WEIGHTS[i] * Math.min(1, Math.max(0, (r - d - BIAS) / r));
  }
  return 1 - (STRENGTH * occ) / WEIGHT_SUM;
}

/** Points spread over a triangle's inside (barycentric, never on an edge), more on a larger face. */
const SPREAD: [number, number][] = [
  [1 / 3, 1 / 3], [0.6, 0.2], [0.2, 0.6], [0.2, 0.2], [0.45, 0.45], [0.1, 0.45], [0.45, 0.1], [0.7, 0.1], [0.1, 0.7],
  [0.3, 0.55], [0.55, 0.3], [0.15, 0.15], [0.8, 0.1], [0.1, 0.8], [0.35, 0.1], [0.1, 0.35],
];

export interface FaceOpenness {
  /** Openness per triangle (mean over its sample points), 0 to 1. */
  value: Float32Array;
  points: number;
  seconds: number;
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/**
 * Openness of every face.
 * @param position world-space corners of non-indexed triangles (9 numbers each)
 * @param perPoint square metres of face per sample point (1 to 16 points a face)
 * @param rays cosine-weighted rays a point, out to `radius` m
 */
export function faceOpenness(position: ArrayLike<number>, bvh: MeshBVH, opts: { perPoint?: number; rays?: number; radius?: number } = {}): FaceOpenness {
  const perPoint = opts.perPoint ?? 0.5, rays = opts.rays ?? 4, radius = opts.radius ?? 1.12;
  const t0 = performance.now();
  const tris = Math.floor(position.length / 9);
  const value = new Float32Array(tris);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3(), tg = new THREE.Vector3(), bt = new THREE.Vector3();
  const ray = new THREE.Ray();
  let points = 0;
  for (let t = 0; t < tris; t++) {
    a.fromArray(position, 9 * t); b.fromArray(position, 9 * t + 3); c.fromArray(position, 9 * t + 6);
    ab.subVectors(b, a); ac.subVectors(c, a);
    n.crossVectors(ab, ac);
    const area = n.length() / 2;
    if (area < 1e-9) { value[t] = 1; continue; }
    n.normalize();
    tg.set(Math.abs(n.y) < 0.99 ? 0 : 1, Math.abs(n.y) < 0.99 ? 1 : 0, 0).cross(n).normalize();
    bt.crossVectors(n, tg);
    const k = Math.max(1, Math.min(SPREAD.length, Math.round(area / perPoint)));
    let open = 0;
    for (let i = 0; i < k; i++) {
      const [u, v] = SPREAD[i];
      // a hair off the face, so its rays don't hit the face itself
      ray.origin.copy(a).addScaledVector(ab, u).addScaledVector(ac, v).addScaledVector(n, 0.002);
      for (let j = 0; j < rays; j++) {
        // all of a face's rays together cover the hemisphere: point i takes every k-th of k * rays directions
        const m = j * k + i, total = k * rays;
        const s = (m + 0.5) / total, phi = m * GOLDEN + 0.013, r = Math.sqrt(s);
        ray.direction.set(0, 0, 0).addScaledVector(tg, r * Math.cos(phi)).addScaledVector(bt, r * Math.sin(phi)).addScaledVector(n, Math.sqrt(1 - s));
        if (!bvh.raycastFirst(ray, THREE.DoubleSide, 0, radius)) open++;
      }
    }
    value[t] = open / (k * rays);
    points += k;
  }
  return { value, points, seconds: (performance.now() - t0) / 1000 };
}

/**
 * The reference openness Fast SDF AO is scored against (benchmark/reference.py): the share of cosine-weighted
 * directions with nothing within `radius`. Slow; for tests and measurements.
 */
export function tracedOpenness(bvh: MeshBVH, p: THREE.Vector3, n: THREE.Vector3, rays = 256, radius = 1.12): number {
  const tg = new THREE.Vector3(Math.abs(n.y) < 0.99 ? 0 : 1, Math.abs(n.y) < 0.99 ? 1 : 0, 0).cross(n).normalize();
  const bt = new THREE.Vector3().crossVectors(n, tg);
  const ray = new THREE.Ray(p.clone().addScaledVector(n, 0.002), new THREE.Vector3());
  let open = 0;
  for (let i = 0; i < rays; i++) {
    const u = (i + 0.5) / rays, phi = i * Math.PI * (3 - Math.sqrt(5)) + 0.013, r = Math.sqrt(u);
    ray.direction.set(0, 0, 0).addScaledVector(tg, r * Math.cos(phi)).addScaledVector(bt, r * Math.sin(phi)).addScaledVector(n, Math.sqrt(1 - u));
    if (!bvh.raycastFirst(ray, THREE.DoubleSide, 0, radius)) open++;
  }
  return open / rays;
}

/**
 * Per island, how much smaller to draw it for being enclosed: its faces' openness averaged by area, mapped from
 * `closed` (or less: drawn at `minScale`) to `open` (or more: full size). Islands are scaled whole, so a big wall
 * that meets the floor in a crease keeps its size (most of it is open); what shrinks is what sits in a recess, a
 * slot or a tight corner.
 * @returns a scale per triangle (the same for every triangle of an island), for `nearScaled`'s `weight`
 */
export function cavityScale(position: ArrayLike<number>, uv: ArrayLike<number>, open: ArrayLike<number>,
  opts: { minScale?: number; closed?: number; open?: number } = {}): Float32Array {
  const minScale = opts.minScale ?? 0.7, lo = opts.closed ?? 0.45, hi = opts.open ?? 0.8;
  const tris = Math.floor(position.length / 9);
  const { of, count } = uvIslands(position, uv);
  const sum = new Float64Array(count), area = new Float64Array(count);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    a.fromArray(position, 9 * t); b.fromArray(position, 9 * t + 3); c.fromArray(position, 9 * t + 6);
    const w = b.sub(a).cross(c.sub(a)).length() / 2 + 1e-12;
    sum[of[t]] += w * open[t]; area[of[t]] += w;
  }
  const out = new Float32Array(tris);
  for (let t = 0; t < tris; t++) {
    const o = sum[of[t]] / area[of[t]];
    const f = hi > lo ? Math.min(1, Math.max(0, (o - lo) / (hi - lo))) : o >= hi ? 1 : 0;
    out[t] = minScale + (1 - minScale) * f;
  }
  return out;
}
