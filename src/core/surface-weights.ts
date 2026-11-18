import * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import { hemisphere, openness as aoOpenness } from './ao';
import { OUTDOOR, sunDirection, type Lighting } from './clay';
import { uvIslands } from './layout';
import { suggestMaterialPreset, type MaterialAssignments, type MaterialPresetId } from './material-presets';
import { splitParts } from './parts';
import type { Level } from './scene';
import { looksLikeRoof, ROOF_MIN_NY, roofLabels } from './semantics';

/**
 * Facts about each face of a level that come from its geometry alone, used as weights by the layouts, the planner and
 * the material presets (no model call, no camera):
 * - openness (`faceOpenness`): how much of the space within 1.12 m in front of a face is free;
 * - curvature (`faceCurvature`): discrete convex turning per unit area across interior edges (normal-cycle mean curvature);
 * - static light (`faceLight`): direct key light plus sky and room bounce reaching each face;
 * - semantic class (`faceClass`): floor, wall, ceiling, roof, organic or hard-surface.
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

export interface FaceCurvature {
  /** Normalized convex curvature per triangle, 0 (flat or concave) to 1 (sharp ridge, thin column or small curved feature). */
  value: Float32Array;
  /** Raw convex normal-cycle mean curvature per triangle (1/m; equals 1/R on a smooth cylinder of radius R). */
  raw: Float32Array;
  /** Normalized concave curvature per triangle, 0 (flat or convex) to 1 (tight inside crease). */
  concave: Float32Array;
  /** Share of a face's turning that comes from smooth (< 63°) edges rather than sharp right-angle corners, 0 to 1. */
  smooth: Float32Array;
  seconds: number;
}

/**
 * Discrete curvature per triangle from the signed dihedral turning across shared interior edges (Cohen-Steiner &
 * Morvan's normal-cycle mean curvature integrated per face and divided by face area, in 1/m). A cylinder of radius R
 * gives 1/R regardless of tessellation; a wide flat wall gives near 0; a thin beam, column or statue ridge scores high.
 * @param scale curvature (1/m) mapped to 0.5 in `value` (default 1.5, about a 0.67 m column)
 */
export function faceCurvature(position: ArrayLike<number>, opts: { scale?: number; weld?: number } = {}): FaceCurvature {
  const scale = opts.scale ?? 1.5, weld = opts.weld ?? 1e-3;
  const t0 = performance.now();
  const tris = Math.floor(position.length / 9);
  const normals = new Float32Array(tris * 3), centres = new Float32Array(tris * 3), areas = new Float32Array(tris);
  const vertOf = new Int32Array(tris * 3), vertPos: number[] = [];
  const vertMap = new Map<string, number>();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    for (let v = 0; v < 3; v++) {
      const p = 9 * t + 3 * v;
      const x = position[p], y = position[p + 1], z = position[p + 2];
      const key = `${Math.round(x / weld)},${Math.round(y / weld)},${Math.round(z / weld)}`;
      let id = vertMap.get(key);
      if (id === undefined) { id = vertPos.length / 3; vertMap.set(key, id); vertPos.push(x, y, z); }
      vertOf[3 * t + v] = id;
    }
    a.fromArray(position, 9 * t); b.fromArray(position, 9 * t + 3); c.fromArray(position, 9 * t + 6);
    centres[3 * t] = (a.x + b.x + c.x) / 3;
    centres[3 * t + 1] = (a.y + b.y + c.y) / 3;
    centres[3 * t + 2] = (a.z + b.z + c.z) / 3;
    n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
    const area = n.length() / 2;
    areas[t] = area;
    if (area >= 1e-9) { n.divideScalar(2 * area); normals[3 * t] = n.x; normals[3 * t + 1] = n.y; normals[3 * t + 2] = n.z; }
  }
  // Undirected manifold edges between welded vertices.
  const edges = new Map<string, number[]>();
  for (let t = 0; t < tris; t++) {
    if (areas[t] < 1e-9) continue;
    for (let e = 0; e < 3; e++) {
      const u = vertOf[3 * t + e], v = vertOf[3 * t + ((e + 1) % 3)];
      if (u === v) continue;
      const key = u < v ? `${u}|${v}` : `${v}|${u}`;
      const list = edges.get(key);
      if (list) list.push(t); else edges.set(key, [t]);
    }
  }
  const convexTurn = new Float64Array(tris), concaveTurn = new Float64Array(tris), smoothTurn = new Float64Array(tris);
  for (const [key, adj] of edges) {
    if (adj.length !== 2) continue;   // boundary or non-manifold T-junction where separate boxes touch
    const t1 = adj[0], t2 = adj[1];
    const dot = Math.max(-1, Math.min(1, normals[3 * t1] * normals[3 * t2] + normals[3 * t1 + 1] * normals[3 * t2 + 1] + normals[3 * t1 + 2] * normals[3 * t2 + 2]));
    if (dot > 0.9999 || dot < -0.985) continue;   // coplanar, or a zero-thickness two-sided card
    const sep = key.indexOf('|');
    const u = +key.slice(0, sep), v = +key.slice(sep + 1);
    const ux = vertPos[3 * u], uy = vertPos[3 * u + 1], uz = vertPos[3 * u + 2];
    const vx = vertPos[3 * v], vy = vertPos[3 * v + 1], vz = vertPos[3 * v + 2];
    const len = Math.hypot(vx - ux, vy - uy, vz - uz);
    const mx = (ux + vx) / 2, my = (uy + vy) / 2, mz = (uz + vz) / 2;
    // On a convex ridge, each face's centre lies behind the other face's plane ((c2 - m)·n1 < 0).
    const sign = (centres[3 * t2] - mx) * normals[3 * t1] + (centres[3 * t2 + 1] - my) * normals[3 * t1 + 1] + (centres[3 * t2 + 2] - mz) * normals[3 * t1 + 2]
      + (centres[3 * t1] - mx) * normals[3 * t2] + (centres[3 * t1 + 1] - my) * normals[3 * t2 + 1] + (centres[3 * t1 + 2] - mz) * normals[3 * t2 + 2];
    if (Math.abs(sign) <= 1e-5) continue;
    const theta = Math.acos(dot);
    const turn = 0.5 * len * theta;
    if (sign < 0) {
      convexTurn[t1] += turn; convexTurn[t2] += turn;
      if (theta < 1.1) { smoothTurn[t1] += turn; smoothTurn[t2] += turn; }
    } else {
      concaveTurn[t1] += turn; concaveTurn[t2] += turn;
    }
  }
  const value = new Float32Array(tris), raw = new Float32Array(tris), concave = new Float32Array(tris), smooth = new Float32Array(tris);
  for (let t = 0; t < tris; t++) {
    if (areas[t] < 1e-9) continue;
    const kp = convexTurn[t] / areas[t], kn = concaveTurn[t] / areas[t];
    raw[t] = kp;
    value[t] = kp / (kp + scale);
    concave[t] = kn / (kn + scale);
    const allTurn = convexTurn[t] + concaveTurn[t];
    smooth[t] = allTurn > 1e-9 ? smoothTurn[t] / allTurn : 0;
  }
  return { value, raw, concave, smooth, seconds: (performance.now() - t0) / 1000 };
}

export interface FaceLight {
  /** Static light importance per triangle, 0 (deep shadow) to 1 (open sun and sky). */
  value: Float32Array;
  points: number;
  seconds: number;
}

/**
 * Static light reaching each face from the scene's sun, sky hemisphere and room bounce (no pathfinding, no model call).
 * Outdoor faces in direct sun and open sky approach 1; indoor faces lit through windows or room bounce sit in the
 * middle; deep shadow under furniture, behind lockers or inside crevices drops toward 0.
 */
export function faceLight(position: ArrayLike<number>, bvh: MeshBVH, lighting: Lighting = OUTDOOR,
  opts: { perPoint?: number; rays?: number; skyRadius?: number } = {}): FaceLight {
  const perPoint = opts.perPoint ?? 1.0, rays = opts.rays ?? 4, skyRadius = opts.skyRadius ?? 80;
  const t0 = performance.now();
  const tris = Math.floor(position.length / 9);
  const value = new Float32Array(tris);
  const toSun = sunDirection(lighting).negate();   // from the surface towards the sun
  const directSun = !lighting.overcast && !lighting.indirect;
  const refSun = lighting.indirect ? 0 : lighting.sunIntensity * Math.max(0.25, toSun.y);
  const refTotal = Math.max(0.1, refSun + lighting.skyIntensity);
  const roomBounce = lighting.indirect ? 0.35 + 0.35 * lighting.bounce : 0.22 * (lighting.bounce + 0.25);

  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3(), tg = new THREE.Vector3(), bt = new THREE.Vector3();
  const ray = new THREE.Ray();
  let points = 0;
  for (let t = 0; t < tris; t++) {
    a.fromArray(position, 9 * t); b.fromArray(position, 9 * t + 3); c.fromArray(position, 9 * t + 6);
    ab.subVectors(b, a); ac.subVectors(c, a);
    n.crossVectors(ab, ac);
    const area = n.length() / 2;
    if (area < 1e-9) { value[t] = 0.5; continue; }
    n.normalize();
    tg.set(Math.abs(n.y) < 0.99 ? 0 : 1, Math.abs(n.y) < 0.99 ? 1 : 0, 0).cross(n).normalize();
    bt.crossVectors(n, tg);
    const k = Math.max(1, Math.min(8, Math.round(area / perPoint)));
    const ndotl = Math.max(0, n.dot(toSun));
    let lit = 0;
    for (let i = 0; i < k; i++) {
      const [u, v] = SPREAD[i];
      ray.origin.copy(a).addScaledVector(ab, u).addScaledVector(ac, v).addScaledVector(n, 0.005);
      let direct = 0;
      if (directSun && ndotl > 0.01) {
        ray.direction.copy(toSun);
        if (!bvh.raycastFirst(ray, THREE.DoubleSide, 0, skyRadius)) direct = lighting.sunIntensity * ndotl;
      }
      let sky = 0;
      for (let j = 0; j < rays; j++) {
        const m = j * k + i, total = k * rays;
        const s = (m + 0.5) / total, phi = m * GOLDEN + 0.029, r = Math.sqrt(s);
        ray.direction.set(0, 0, 0).addScaledVector(tg, r * Math.cos(phi)).addScaledVector(bt, r * Math.sin(phi)).addScaledVector(n, Math.sqrt(1 - s));
        const blocked = bvh.raycastFirst(ray, THREE.DoubleSide, 0, skyRadius);
        if (!blocked) {
          sky += 0.65 + 0.35 * Math.max(0, ray.direction.y);
        } else {
          sky += roomBounce * Math.min(1, blocked.distance / 4);
        }
      }
      const skyFrac = sky / rays;
      const overcastKey = lighting.overcast ? lighting.sunIntensity * ndotl * skyFrac : 0;
      lit += (direct + overcastKey + lighting.skyIntensity * skyFrac) / refTotal;
    }
    value[t] = Math.min(1, Math.max(0, lit / k));
    points += k;
  }
  return { value, points, seconds: (performance.now() - t0) / 1000 };
}

export const FACE_CLASSES = ['floor', 'wall', 'ceiling', 'roof', 'organic', 'hard-surface'] as const;
export type FaceClass = (typeof FACE_CLASSES)[number];

/** Material response guidance and repair strategy per semantic class (TODO item 7). */
export const CLASS_PROFILES: Record<FaceClass, { roughness: [number, number]; preset?: MaterialPresetId; repair: 'tile' | 'continue' | 'part' }> = {
  floor: { roughness: [0.55, 0.92], repair: 'tile' },
  wall: { roughness: [0.75, 0.95], preset: 'limestone', repair: 'continue' },
  ceiling: { roughness: [0.82, 0.96], repair: 'continue' },
  roof: { roughness: [0.65, 0.9], repair: 'continue' },
  organic: { roughness: [0.65, 0.92], preset: 'organic', repair: 'part' },
  'hard-surface': { roughness: [0.35, 0.68], preset: 'hard-surface', repair: 'part' },
};

const ORGANIC_RE = /\b(statues?|coloss\w*|kings?|sphinx\w*|trees?|plants?|bush\w*|foliage|shrubs?|vines?|ivy|moss|rocks?|boulders?|cliff|cloth|tarp\w*|canop\w*|curtains?|drapes?|cushions?|fabric|organic|charact\w*|figure|person|animal)\b/i;
const HARD_RE = /\b(robots?|labors?|machines?|machinery|trucks?|vehicles?|cars?|cranes?|gantr\w*|consoles?|monitors?|cabinets?|lockers?|drums?|barrels?|crates?|boxes|pipes?|bollards?|lamps?|lights?|floodlights?|benches|desks?|chairs?|tables?|trolleys?|carts?|doors?|shutters?|gates?|windows?|frames?|grilles?|vents?|hatches|rails?|handrails?|ladders?|beams?|truss\w*|columns?|pillars?|obelisks?|altars?|fountains?|antennas?|hoses?|cables?)\b/i;
const CEILING_RE = /\b(ceilings?|soffits?|vaults?)\b/i;
const FLOOR_RE = /\b(ground|floors?|paving|pavement|apron|decks?|streets?|roads?|paths?|courtyards?|terraces?|steps?|stairs?|ramps?)\b/i;
const WALL_RE = /\b(walls?|pylons?|facades?|parapets?|arch(es|ways?)?|partitions?|plinths?|piers?|buttress\w*)\b/i;

export interface FaceClasses {
  /** Class index into `FACE_CLASSES` per triangle. */
  cls: Uint8Array;
  /** Surface-area share of each semantic class, summing to 1. */
  shares: Record<FaceClass, number>;
  /** Estimated walkable floor height (m). */
  floorY: number;
  seconds: number;
}

/**
 * Tag every triangle as floor, wall, ceiling, roof, organic or hard-surface from its normal, height above the walkable
 * floor, connected-component size, curvature smoothness and (when present) part name.
 */
export function faceClass(position: ArrayLike<number>, labels: string[] = [], labelAttr?: ArrayLike<number>,
  opts: { floorY?: number; curvature?: FaceCurvature; bvh?: MeshBVH } = {}): FaceClasses {
  const t0 = performance.now();
  const tris = Math.floor(position.length / 9);
  const curv = opts.curvature ?? faceCurvature(position);
  const split = splitParts(position);
  const fromFile = labels.length > 1 && labels.some(Boolean);
  const roofOf = roofLabels(labels, fromFile);

  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  const ny = new Float32Array(tris), midY = new Float32Array(tris), areas = new Float32Array(tris);
  let minY = Infinity, maxY = -Infinity, totalArea = 0;
  for (let t = 0; t < tris; t++) {
    a.fromArray(position, 9 * t); b.fromArray(position, 9 * t + 3); c.fromArray(position, 9 * t + 6);
    const y = (a.y + b.y + c.y) / 3;
    midY[t] = y;
    minY = Math.min(minY, a.y, b.y, c.y);
    maxY = Math.max(maxY, a.y, b.y, c.y);
    n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
    const area = n.length() / 2;
    areas[t] = area;
    totalArea += area;
    if (area >= 1e-9) ny[t] = n.y / (2 * area);
  }

  // Estimate walkable floor height from the largest upward horizontal band in the lower half of the level.
  let floorY = opts.floorY;
  if (floorY === undefined) {
    const bands = new Map<number, number>();
    const midSpan = minY + 0.6 * (maxY - minY);
    for (let t = 0; t < tris; t++) {
      if (ny[t] < 0.75 || midY[t] > midSpan) continue;
      const bin = Math.round(midY[t] * 2) / 2;
      bands.set(bin, (bands.get(bin) ?? 0) + areas[t]);
    }
    let bestBin = Number.isFinite(minY) ? minY : 0, bestArea = -1;
    for (const [bin, area] of bands) if (area > bestArea) { bestArea = area; bestBin = bin; }
    floorY = bestBin;
  }

  // Per connected component: mean convex curvature and smoothness share, to tell unnamed props and organic shapes from walls.
  const compCurv = new Float64Array(split.parts.length), compSmooth = new Float64Array(split.parts.length), compCurvedArea = new Float64Array(split.parts.length);
  for (let t = 0; t < tris; t++) {
    const k = split.of[t], w = areas[t];
    compCurv[k] += w * curv.value[t];
    if (curv.value[t] > 0.08) { compSmooth[k] += w * curv.smooth[t]; compCurvedArea[k] += w; }
  }

  const cls = new Uint8Array(tris);
  const sums = new Float64Array(FACE_CLASSES.length);
  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, 1, 0));

  for (let t = 0; t < tris; t++) {
    const lab = labelAttr ? Math.round(labelAttr[3 * t]) : 0;
    const name = labels[lab] ?? '';
    const comp = split.of[t], compArea = split.parts[comp]?.area ?? 0;
    const meanCurv = compArea > 1e-9 ? compCurv[comp] / compArea : 0;
    const smoothShare = compCurvedArea[comp] > 1e-9 ? compSmooth[comp] / compCurvedArea[comp] : 0;
    let id: number;

    if (name && ORGANIC_RE.test(name)) id = 4;
    else if (name && HARD_RE.test(name)) id = 5;
    else if (roofOf?.[lab] && ny[t] > ROOF_MIN_NY) id = 3;
    else if (name && CEILING_RE.test(name) && ny[t] < -0.2) id = 2;
    else if (name && FLOOR_RE.test(name) && ny[t] > 0.5) id = 0;
    else if (name && WALL_RE.test(name) && Math.abs(ny[t]) <= 0.75) id = 1;
    else if (compArea < Math.min(20, 0.08 * totalArea) && meanCurv > 0.25 && split.parts[comp]!.triangles >= 8) {
      id = smoothShare > 0.6 && split.parts[comp]!.triangles >= 20 ? 4 : 5;
    } else if (ny[t] < -0.7 && midY[t] > floorY + 1.8) id = 2;
    else if (ny[t] > 0.7 && Math.abs(midY[t] - floorY) < 1.2) id = 0;
    else if (!fromFile && looksLikeRoof(ny[t], midY[t], floorY)) {
      // Without roof labels, an elevated upward face is a roof when open sky is above it (else an upper floor deck).
      let underCeiling = false;
      if (opts.bvh) {
        a.fromArray(position, 9 * t); b.fromArray(position, 9 * t + 3); c.fromArray(position, 9 * t + 6);
        ray.origin.set((a.x + b.x + c.x) / 3, midY[t] + 0.05, (a.z + b.z + c.z) / 3);
        const above = opts.bvh.raycastFirst(ray, THREE.DoubleSide, 0, 20);
        if (above) underCeiling = true;
      }
      id = underCeiling ? 0 : 3;
    } else if (ny[t] > 0.7) id = 0;
    else if (curv.value[t] > 0.65 && compArea < 30) id = 5;
    else id = 1;

    cls[t] = id;
    sums[id] += areas[t];
  }
  const shares = Object.fromEntries(FACE_CLASSES.map((k, i) => [k, totalArea > 0 ? +(sums[i] / totalArea).toFixed(4) : 0])) as Record<FaceClass, number>;
  return { cls, shares, floorY, seconds: (performance.now() - t0) / 1000 };
}

export interface SurfaceWeightsSummary {
  seconds: number;
  classes: Record<FaceClass, number>;
  mean: { openness: number; curvature: number; light: number; importance: number };
}

export interface SurfaceWeights extends SurfaceWeightsSummary {
  openness: Float32Array;
  curvature: Float32Array;
  light: Float32Array;
  faceClass: Uint8Array;
  /** Combined importance per triangle (around 1 on an open, lit wall; lower in dark recesses; higher on exposed convex features). */
  importance: Float32Array;
  /** Optional simulated player-path gaze rank per triangle in `[0, 1]` (core/player-paths.ts). */
  paths?: Float32Array;
}

const CLASS_IMPORTANCE = [1.0, 1.0, 0.85, 0.9, 1.1, 1.05];

/**
 * Run all four geometry prepasses on `level` and combine them into a per-triangle importance weight.
 */
export function surfaceWeights(level: Pick<Level, 'geometry' | 'bvh' | 'labels' | 'playArea' | 'bounds'>, lighting: Lighting = OUTDOOR,
  opts: { minScale?: number; floorY?: number } = {}): SurfaceWeights {
  const t0 = performance.now();
  const minScale = opts.minScale ?? 0.65;
  const g = level.geometry;
  const position = g.getAttribute('position').array;
  const labelAttr = g.getAttribute('label')?.array;
  const tris = Math.floor(position.length / 9);

  const open = faceOpenness(position, level.bvh);
  const curv = faceCurvature(position);
  const lit = faceLight(position, level.bvh, lighting);
  const fc = faceClass(position, level.labels, labelAttr, {
    floorY: opts.floorY ?? (level.playArea ? level.playArea.min.y : undefined),
    curvature: curv,
    bvh: level.bvh,
  });

  const importance = new Float32Array(tris);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let areaSum = 0, mOpen = 0, mCurv = 0, mLight = 0, mImp = 0;
  for (let t = 0; t < tris; t++) {
    const o = open.value[t], cv = curv.value[t], l = lit.value[t], cl = fc.cls[t];
    const openF = Math.min(1, Math.max(0, (o - 0.45) / (0.8 - 0.45)));
    const wOpen = minScale + (1 - minScale) * openF;
    const lightF = Math.min(1, Math.max(0, (l - 0.08) / (0.45 - 0.08)));
    const wLight = 0.72 + 0.28 * lightF;
    const wCurv = 1 + 0.35 * cv * o;
    const imp = wOpen * wLight * wCurv * CLASS_IMPORTANCE[cl];
    importance[t] = imp;

    a.fromArray(position, 9 * t); b.fromArray(position, 9 * t + 3); c.fromArray(position, 9 * t + 6);
    const w = b.sub(a).cross(c.sub(a)).length() / 2;
    areaSum += w;
    mOpen += w * o; mCurv += w * cv; mLight += w * l; mImp += w * imp;
  }
  const inv = areaSum > 0 ? 1 / areaSum : 0;
  return {
    openness: open.value,
    curvature: curv.value,
    light: lit.value,
    faceClass: fc.cls,
    importance,
    classes: fc.shares,
    mean: {
      openness: +(mOpen * inv).toFixed(3),
      curvature: +(mCurv * inv).toFixed(3),
      light: +(mLight * inv).toFixed(3),
      importance: +(mImp * inv).toFixed(3),
    },
    seconds: +((performance.now() - t0) / 1000).toFixed(3),
  };
}

/**
 * Per-island layout scale from the geometry weights: enclosed, shadowed islands shrink down to `minScale`, while open,
 * well-lit convex features grow up to `maxScale`. Every triangle of one UV island gets the same scale.
 */
export function weightScale(position: ArrayLike<number>, uv: ArrayLike<number>, weights: Pick<SurfaceWeights, 'importance'>,
  opts: { minScale?: number; maxScale?: number } = {}): Float32Array {
  const minScale = opts.minScale ?? 0.7, maxScale = opts.maxScale ?? 1.25;
  const tris = Math.floor(position.length / 9);
  const { of, count } = uvIslands(position, uv);
  const sum = new Float64Array(count), area = new Float64Array(count);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    a.fromArray(position, 9 * t); b.fromArray(position, 9 * t + 3); c.fromArray(position, 9 * t + 6);
    const w = b.sub(a).cross(c.sub(a)).length() / 2 + 1e-12;
    sum[of[t]] += w * weights.importance[t];
    area[of[t]] += w;
  }
  const out = new Float32Array(tris);
  for (let t = 0; t < tris; t++) {
    const k = of[t];
    out[t] = Math.min(maxScale, Math.max(minScale, sum[k] / area[k]));
  }
  return out;
}

/** Write a per-triangle scalar array onto `geometry` as a 1-float-per-corner `weight` attribute alongside `label`. */
export function writeWeightAttribute(geometry: THREE.BufferGeometry, triWeight: ArrayLike<number>): Float32Array {
  const tris = triWeight.length;
  const arr = new Float32Array(tris * 3);
  for (let t = 0; t < tris; t++) arr[3 * t] = arr[3 * t + 1] = arr[3 * t + 2] = triWeight[t];
  geometry.setAttribute('weight', new THREE.BufferAttribute(arr, 1));
  return arr;
}

/**
 * Project per-triangle weights onto the planner's `grid` x `grid` UV cell space (matching `probeCells`'s `cy * grid + cx`
 * indexing). Cells with no triangle stay 0; small sub-cell islands stamp their centroid cell so props still register.
 */
export function cellWeights(uv: ArrayLike<number>, triWeight: ArrayLike<number>, grid: number): Float32Array {
  const tris = Math.min(Math.floor(uv.length / 6), triWeight.length);
  const sum = new Float64Array(grid * grid), wSum = new Float64Array(grid * grid);
  for (let t = 0; t < tris; t++) {
    const w = triWeight[t];
    if (!(w > 0)) continue;
    const q = 6 * t;
    const u0 = uv[q], v0 = uv[q + 1], u1 = uv[q + 2], v1 = uv[q + 3], u2 = uv[q + 4], v2 = uv[q + 5];
    const det = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
    const area = Math.abs(det) * 0.5 + 1e-12;
    // Always stamp the centroid cell so islands smaller than a cell still weight the cell they sit in.
    const cx = Math.min(grid - 1, Math.max(0, Math.floor(((u0 + u1 + u2) / 3) * grid)));
    const cy = Math.min(grid - 1, Math.max(0, Math.floor(((v0 + v1 + v2) / 3) * grid)));
    const cc = cy * grid + cx;
    sum[cc] += w * area; wSum[cc] += area;
    if (Math.abs(det) < 1e-10) continue;
    const x0 = Math.max(0, Math.floor(Math.min(u0, u1, u2) * grid));
    const x1 = Math.min(grid - 1, Math.floor(Math.max(u0, u1, u2) * grid));
    const y0 = Math.max(0, Math.floor(Math.min(v0, v1, v2) * grid));
    const y1 = Math.min(grid - 1, Math.floor(Math.max(v0, v1, v2) * grid));
    if (x0 === x1 && y0 === y1) continue;
    const invDet = 1 / det;
    for (let y = y0; y <= y1; y++) {
      const py = (y + 0.5) / grid - v0;
      for (let x = x0; x <= x1; x++) {
        const px = (x + 0.5) / grid - u0;
        const l1 = (px * (v2 - v0) - py * (u2 - u0)) * invDet;
        if (l1 < -1e-5) continue;
        const l2 = ((u1 - u0) * py - (v1 - v0) * px) * invDet;
        if (l2 < -1e-5 || l1 + l2 > 1 + 1e-5) continue;
        const idx = y * grid + x;
        sum[idx] += w * area; wSum[idx] += area;
      }
    }
  }
  const out = new Float32Array(grid * grid);
  for (let i = 0; i < out.length; i++) if (wSum[i] > 0) out[i] = sum[i] / wSum[i];
  return out;
}

/**
 * Suggest material presets per named part using `suggestMaterialPreset(label)` first and falling back to each part's
 * dominant semantic class when unambiguous (e.g. metal/hard-surface props or stone walls/statues).
 */
export function suggestPresetsFromWeights(labels: string[], labelAttr: ArrayLike<number>, faceCls: ArrayLike<number>): MaterialAssignments {
  const out: MaterialAssignments = {};
  const counts: Float64Array[] = labels.map(() => new Float64Array(FACE_CLASSES.length));
  const tris = faceCls.length;
  for (let t = 0; t < tris; t++) {
    const l = Math.round(labelAttr[3 * t]);
    if (counts[l]) counts[l][faceCls[t]]++;
  }
  labels.forEach((label, k) => {
    if (!label) return;
    const byName = suggestMaterialPreset(label);
    if (byName) { out[label] = byName; return; }
    let dom = 0;
    for (let c = 1; c < FACE_CLASSES.length; c++) if (counts[k][c] > counts[k][dom]) dom = c;
    const cls = FACE_CLASSES[dom];
    if (/\b(cloth|fabric|canvas|tarp\w*|curtains?|drapes?|cushions?|linen|wool|leather|strap)\b/i.test(label)) {
      out[label] = 'fabric';
    } else if (/\b(bare|polished|brushed|forged|stainless|chrome|brass|bronze|copper)\b.*\b(metal|steel|iron|blade|barrel|brass|bronze|copper)\b|\b(blade|chrome|brass|bronze)\b/i.test(label)) {
      out[label] = 'metal';
    } else if (cls === 'hard-surface' && /\b(metal|steel|iron|robot|machine|crane|gantry|pipe|bollard|locker|cabinet|console|frame|grille|rail|beam|truss|shutter)\b/i.test(label)) {
      out[label] = 'painted-metal';
    } else if ((cls === 'wall' || cls === 'organic') && /\b(stone|masonry|sandstone|ashlar|pylon|colonnade|arch|plaster|brick|concrete|statue|coloss\w*|sphinx\w*)\b/i.test(label)) {
      out[label] = 'limestone';
    } else if (cls === 'organic' && /\b(skin|face|body|bark|leaf|leaves|foliage|plant|tree|moss|flesh|creature|organic)\b/i.test(label)) {
      out[label] = 'organic';
    } else if (cls === 'hard-surface' && /\b(polymer|plastic|armour|armor|visor|casing|housing|grip|stock|chassis|hull|wheel|tyre|tire)\b/i.test(label)) {
      out[label] = 'hard-surface';
    }
  });
  return out;
}

export type WeightOverlayKind = 'openness' | 'curvature' | 'light' | 'class' | 'importance' | 'paths';

/** Semantic class palette (sRGB 0..1): floor, wall, ceiling, roof, organic, hard-surface. */
const CLASS_COLOURS: [number, number, number][] = [
  [0.42, 0.50, 0.58],   // floor: cool slate
  [0.83, 0.74, 0.58],   // wall: warm sand
  [0.48, 0.68, 0.86],   // ceiling: sky blue
  [0.78, 0.40, 0.28],   // roof: terracotta
  [0.36, 0.72, 0.45],   // organic: sage green
  [0.92, 0.62, 0.20],   // hard-surface: amber copper
];

/** Perceptual heatmap ramp (0 = deep indigo, 0.35 = teal, 0.7 = amber, 1 = bright pale gold). */
function ramp(x: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, x));
  const stops: [number, [number, number, number]][] = [
    [0.0, [0.11, 0.10, 0.32]],
    [0.35, [0.13, 0.48, 0.56]],
    [0.7, [0.88, 0.58, 0.18]],
    [1.0, [0.99, 0.94, 0.68]],
  ];
  for (let i = 0; i + 1 < stops.length; i++) {
    const [t0, c0] = stops[i], [t1, c1] = stops[i + 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return stops[stops.length - 1][1];
}

/** Per-vertex RGB array (9 floats per triangle) colouring `weights` for the 3D debug overlay. */
export function weightOverlayColors(kind: WeightOverlayKind, weights: SurfaceWeights): Float32Array {
  const tris = weights.importance.length;
  const out = new Float32Array(tris * 9);
  for (let t = 0; t < tris; t++) {
    const [r, g, b] = kind === 'class'
      ? CLASS_COLOURS[weights.faceClass[t]] ?? CLASS_COLOURS[1]
      : kind === 'importance'
        ? ramp((weights.importance[t] - 0.45) / (1.35 - 0.45))
        : kind === 'paths'
          ? ramp(weights.paths ? weights.paths[t] : 0)
          : ramp(weights[kind][t]);
    const p = 9 * t;
    out[p] = out[p + 3] = out[p + 6] = r;
    out[p + 1] = out[p + 4] = out[p + 7] = g;
    out[p + 2] = out[p + 5] = out[p + 8] = b;
  }
  return out;
}

/**
 * Measure the per-face `faceOpenness` prepass against `ao.ts`'s 24-ray distance-faded `openness` evaluated at the same
 * face sample points: time taken by each, mean absolute difference and Pearson correlation across faces.
 */
export function compareAoPrepass(position: ArrayLike<number>, bvh: MeshBVH, opts: { perPoint?: number; aoRays?: number; aoRadius?: number } = {}) {
  const perPoint = opts.perPoint ?? 0.5, aoRays = opts.aoRays ?? 24, aoRadius = opts.aoRadius ?? 2.5;
  const fast = faceOpenness(position, bvh, { perPoint });
  const t0 = performance.now();
  const dirs = hemisphere(aoRays);
  const tris = Math.floor(position.length / 9);
  const aoFace = new Float32Array(tris);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3(), p = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    a.fromArray(position, 9 * t); b.fromArray(position, 9 * t + 3); c.fromArray(position, 9 * t + 6);
    ab.subVectors(b, a); ac.subVectors(c, a);
    n.crossVectors(ab, ac);
    const area = n.length() / 2;
    if (area < 1e-9) { aoFace[t] = 1; continue; }
    n.normalize();
    const k = Math.max(1, Math.min(SPREAD.length, Math.round(area / perPoint)));
    let sum = 0;
    for (let i = 0; i < k; i++) {
      p.copy(a).addScaledVector(ab, SPREAD[i][0]).addScaledVector(ac, SPREAD[i][1]);
      sum += aoOpenness(bvh, p, n, dirs, aoRadius, ((t * 31 + i) * 2654435761 >>> 0) / 4294967296 * 2 * Math.PI);
    }
    aoFace[t] = sum / k;
  }
  const aoSeconds = (performance.now() - t0) / 1000;
  let diffSum = 0, mx = 0, my = 0;
  for (let t = 0; t < tris; t++) { diffSum += Math.abs(fast.value[t] - aoFace[t]); mx += fast.value[t]; my += aoFace[t]; }
  mx /= Math.max(1, tris); my /= Math.max(1, tris);
  let cov = 0, vx = 0, vy = 0;
  for (let t = 0; t < tris; t++) {
    const dx = fast.value[t] - mx, dy = aoFace[t] - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  const correlation = vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 1;
  return {
    prepassSeconds: fast.seconds,
    aoFaceSeconds: aoSeconds,
    speedup: aoSeconds / Math.max(1e-6, fast.seconds),
    meanAbsDiff: tris ? diffSum / tris : 0,
    correlation,
    aoValues: aoFace,
  };
}
