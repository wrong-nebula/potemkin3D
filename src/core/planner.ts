/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import * as THREE from 'three';
import { floatTarget, type Gpu } from './gpu';
import { viewFaces } from './fidelity';
import { sampling, type Sampling } from './metrics';
import { paintability } from './paintability';
import { forEachTriangle, type Level } from './scene';
import { looksLikeRoof, ROOF_MIN_NY, roofLabels } from './semantics';
import { cellWeights } from './surface-weights';
import { adaptiveGroundViews, budgetAdvice, combinedPlanWeights, selectFisherViews, type BudgetAdvice } from './adaptive-plan';
import type { ViewRenderer, ViewSpec } from './views';
import { lookAt, makeCamera } from './views';

/**
 * Camera planning: sample where a player can stand, render cheap low-res probes from candidate cameras there,
 * then greedily keep the cameras that capture the most texture at good quality (a set cover over UV cells).
 */
export interface PlanOptions {
  eyeHeight: number;
  spacing: number;        // min distance between player sample points (m)
  fov: number;
  yaws: number;           // candidate headings per point
  pitchDeg: number;
  downYaws: number;       // extra candidates per point looking down at the floor (0 = none; models add clutter)
  downPitchDeg: number;
  maxViews: number;
  targetCoverage: number; // stop when this share of reachable cells is captured well
  probeSize: number;      // probe render size (px)
  grid: number;           // UV cells per side
  goodRatio: number;      // a cell counts as captured at >= this share of its best possible quality...
  goodAbs: number;        // ...or at this absolute quality (cos / distance; 0.12 = head-on from ~8 m)
  maxParallel: number;    // views per wave (1 = each view sees everything painted before it; best seams)
  aerial: number;         // cameras per ring around the level (outer walls, tops of props); up to 2x this are used; 0 = none
  roofs: number;          // max close cameras over the roofs, painted with a roof prompt (0 = none)
  roofDistance: number;   // m from a roof camera to the roof it looks at
  /**
   * Max views in the floor pass: cameras looking straight down at the ground players walk on, painted before the
   * players' views. From eye height the ground is seen at a graze and comes out stretched; from above it doesn't.
   */
  floors: number;
  /** How far above the ground a floor camera hangs (m); lower under a ceiling. With its 90° lens it sees twice that across. */
  floorHeight: number;
  holes: number;          // max views in the final pass over texels nothing painted (behind props, tops of props)
  /**
   * Max views in the clean-up pass: cameras aimed at what players can see that is still unpainted or was captured
   * poorly (from far off, or at a low angle), painting only that (core/defects.ts).
   */
  cleanup: number;
  seed: number;
  /**
   * What the players' views are picked for. 'coverage': the most new texture cells seen well. 'sharpness': the
   * texture detail each adds, in view pixels per texel capped at 1, times how likely a model is to paint the view
   * faithfully; it needs the texture's layout (`Surface`). 'fisher': concave log-resolution utility over weighted
   * cells with live painted-context paintability (core/adaptive-plan.ts).
   */
  objective: 'sharpness' | 'coverage' | 'fisher';
  /** Extra candidates aimed at each patch of surface from this many of the nearest player spots (0 = none). */
  lookAt: number;
  /** Iterative importance-driven probe refinement around under-covered important / curved / named regions (TODO item 8). */
  adaptive?: boolean;
  /** Weight cell importance by surface geodesic distance from player spots (default true when `adaptive` is on). */
  geodesic?: boolean;
  /** Atlas resolution along a side (px), for sparse PBR height-tile budget advice. */
  atlasSize?: number;
}

export const DEFAULT_PLAN: PlanOptions = {
  eyeHeight: 1.65, spacing: 4, fov: 90, yaws: 8, pitchDeg: 6, downYaws: 0, downPitchDeg: -40, maxViews: 36, targetCoverage: 0.97,
  probeSize: 96, grid: 256, goodRatio: 0.5, goodAbs: 0.12, maxParallel: 1, aerial: 0, roofs: 0, roofDistance: 15, floors: 0, floorHeight: 3.5, holes: 0, cleanup: 0, seed: 7,
  objective: 'coverage', lookAt: 0, adaptive: false,
};

export interface Plan {
  points: THREE.Vector3[];          // player eye positions
  views: ViewSpec[];                // ordered for painting
  waves: number[][];                // indices into views; a wave is painted in parallel
  viewCells: CellList[];            // per ordered view
  qBest: Float32Array;
  grid: number;
  reachableCells: number;
  predicted: number[];              // predicted coverage after each ordered view
  /** How sharply the planned views would sample what they cover, if every one is painted as planned. */
  sharpness?: Sampling;
  /**
   * What the texture's layout means for these cameras: the share of the texture any candidate camera can see at
   * all. The rest is resolution spent on undersides and hidden faces.
   */
  texture?: { seen: number };
  /** Spend & bottleneck report from adaptive / Fisher planning (core/adaptive-plan.ts). */
  budget?: BudgetAdvice;
}

/** The texture cells a camera sees with the best quality per cell, and (when asked for) what its frame holds. */
export interface CellList { cells: Int32Array; q: Float32Array; shape?: { sky: number; faces: number; maxFace: number } }

/**
 * The texture's layout, for planning by sharpness: world position and normal under each of grid x grid cells (a of
 * the normal is 0 where no triangle covers the cell), and how many texels run along one cell.
 */
export interface Surface { pos: Float32Array; nrm: Float32Array; texelsPerCell: number; weight?: Float32Array }

/** The layout of a texture, read from its atlas. */
export function surfaceOf(atlas: { size: number; texelGeometry(size: number): { pos: Float32Array; nrm: Float32Array } }, grid: number): Surface {
  return { ...atlas.texelGeometry(grid), texelsPerCell: atlas.size / grid };
}

/** Texels per metre of surface at each cell (the median where a cell has no neighbour on its own island). */
export function cellDensity(s: Surface, grid: number): Float32Array {
  const out = new Float32Array(grid * grid);
  const metres = (i: number, j: number) => Math.hypot(s.pos[4 * j] - s.pos[4 * i], s.pos[4 * j + 1] - s.pos[4 * i + 1], s.pos[4 * j + 2] - s.pos[4 * i + 2]);
  const known: number[] = [];
  for (let y = 0; y < grid; y++) {
    for (let x = 0; x < grid; x++) {
      const i = y * grid + x;
      if (s.nrm[4 * i + 3] < 0.5) continue;
      let m = Infinity;
      for (const j of [x + 1 < grid ? i + 1 : -1, y + 1 < grid ? i + grid : -1, x > 0 ? i - 1 : -1, y > 0 ? i - grid : -1]) {
        if (j < 0 || s.nrm[4 * j + 3] < 0.5) continue;
        const d = metres(i, j);
        if (d > 1e-4 && d < 5) m = Math.min(m, d);   // further apart: two islands side by side
      }
      if (m < Infinity) { out[i] = s.texelsPerCell / m; known.push(out[i]); }
    }
  }
  known.sort((a, b) => a - b);
  const median = known.length ? known[known.length >> 1] : 0;
  for (let i = 0; i < out.length; i++) if (!out[i] && s.nrm[4 * i + 3] > 0.5) out[i] = median;
  return out;
}

/** View pixels across one metre seen head-on from 1 m, for a view of `size` px with a `fov` degree lens. */
export const pixelsPerMetre = (size: number, fov: number) => size / 2 / Math.tan(THREE.MathUtils.degToRad(fov) / 2);

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Points on walkable surfaces with headroom, thinned to `spacing`, restricted to the main reachable areas. */
export const planStats: Record<string, number> = {};

export function samplePlayerPoints(level: Level, o: PlanOptions): THREE.Vector3[] {
  const rnd = mulberry32(o.seed);
  const cand: THREE.Vector3[] = [];
  const perArea = 4 / (o.spacing * o.spacing);
  const up = new THREE.Vector3(0, 1, 0);
  const ray = new THREE.Ray();
  forEachTriangle(level, (a, b, c, n, area) => {
    if (n.y < 0.7) return;
    let k = area * perArea;
    const count = Math.floor(k) + (rnd() < k - Math.floor(k) ? 1 : 0);
    for (let i = 0; i < count; i++) {
      let r1 = rnd(), r2 = rnd();
      if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
      cand.push(new THREE.Vector3().copy(a).addScaledVector(new THREE.Vector3().subVectors(b, a), r1)
        .addScaledVector(new THREE.Vector3().subVectors(c, a), r2));
    }
  });
  planStats.candidates = cand.length;
  const ok: THREE.Vector3[] = [];
  for (const p of cand) {
    ray.origin.copy(p).addScaledVector(up, 0.05);
    ray.direction.copy(up);
    const hit = level.bvh.raycastFirst(ray, THREE.DoubleSide);
    if (hit && hit.distance < o.eyeHeight + 0.3) continue;              // no headroom
    const eye = p.clone().addScaledVector(up, o.eyeHeight);
    if (level.playArea && !level.playArea.containsPoint(eye)) continue;   // floor, but not where players go
    ray.origin.copy(eye);
    ray.direction.set(0, -1, 0);
    const down = level.bvh.raycastFirst(ray, THREE.DoubleSide);
    if (!down || Math.abs(down.distance - o.eyeHeight) > 0.1) continue;  // something between eye and floor
    ok.push(eye);
  }
  planStats.standable = ok.length;
  const open = enclosed(level, ok);
  planStats.enclosed = open.length;
  // Poisson-disk thinning with a hash grid.
  const order = open.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const cell = o.spacing;
  const hash = new Map<string, THREE.Vector3[]>();
  const key = (x: number, z: number) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
  const kept: THREE.Vector3[] = [];
  for (const i of order) {
    const p = open[i];
    const cx = Math.floor(p.x / cell), cz = Math.floor(p.z / cell);
    let clash = false;
    for (let dx = -1; dx <= 1 && !clash; dx++) {
      for (let dz = -1; dz <= 1 && !clash; dz++) {
        for (const q of hash.get(`${cx + dx},${cz + dz}`) ?? []) {
          if (Math.hypot(q.x - p.x, q.z - p.z) < o.spacing && Math.abs(q.y - p.y) < 2) { clash = true; break; }
        }
      }
    }
    if (clash) continue;
    kept.push(p);
    const k = key(p.x, p.z);
    if (!hash.has(k)) hash.set(k, []);
    hash.get(k)!.push(p);
  }
  planStats.thinned = kept.length;
  const main = mainAreas(level, kept, o);
  planStats.main = main.length;
  // spots given by hand, where the joining above cannot climb (Level.spots)
  planStats.byHand = level.spots?.length ?? 0;
  return level.spots?.length ? [...main, ...level.spots.map((p) => p.clone())] : main;
}

/**
 * Playable spaces are enclosed: from eye height, most horizontal directions hit a wall within 30 m. Rooftops and
 * prop tops look out over everything, so they drop out here. Relaxes when nothing qualifies (open terrain).
 */
function enclosed(level: Level, pts: THREE.Vector3[]): THREE.Vector3[] {
  const ray = new THREE.Ray();
  const inside = new Uint8Array(pts.length);
  const hits = pts.map((p, i) => {
    let n = 0, back = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      ray.origin.copy(p);
      ray.direction.set(Math.sin(a), 0, Math.cos(a));
      const h = level.bvh.raycastFirst(ray, THREE.DoubleSide);
      if (!h || h.distance >= 30) continue;
      if (h.face && h.face.normal.dot(ray.direction) > 0) back++;   // seeing a face from behind: inside a solid
      else n++;
    }
    if (back >= 3) inside[i] = 1;
    return n;
  });
  planStats.inside = inside.reduce((a, b) => a + b, 0);
  for (const min of [5, 3, 0]) {
    const keep = pts.filter((_, i) => !inside[i] && hits[i] >= min);
    if (keep.length >= Math.max(3, 0.25 * pts.length) || min === 0) return keep;
  }
  return pts;
}

/** Group points into areas a player can walk between (close, similar height, clear line of sight). */
/**
 * Can a player walk from a to b? Follows the floor in 0.4 m steps: no step up higher than 0.65 m (stairs are
 * fine, crates and walls are not), no drop over 1.5 m, and a clear line of sight at eye height.
 */
function walkable(level: Level, a: THREE.Vector3, b: THREE.Vector3, eye: number): boolean {
  const ray = new THREE.Ray();
  const d = a.distanceTo(b);
  ray.origin.copy(a);
  ray.direction.subVectors(b, a).normalize();
  const los = level.bvh.raycastFirst(ray, THREE.DoubleSide);
  if (los && los.distance < d - 0.05) return false;
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.4));
  let prev = a.y - eye;
  const top = Math.max(a.y, b.y) + 0.2;
  ray.direction.set(0, -1, 0);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    ray.origin.set(a.x + (b.x - a.x) * t, top, a.z + (b.z - a.z) * t);
    const hit = level.bvh.raycastFirst(ray, THREE.DoubleSide);
    if (!hit) return false;
    const floor = hit.point.y;
    if (floor - prev > 0.65 || prev - floor > 1.5) return false;
    prev = floor;
  }
  return Math.abs(prev - (b.y - eye)) < 0.3;
}

/** Group points into areas a player can walk between and keep the main play area (plus any comparable ones). */
function mainAreas(level: Level, pts: THREE.Vector3[], o: PlanOptions): THREE.Vector3[] {
  const parent = pts.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const reach = o.spacing * 2.5;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i], b = pts[j];
      if (a.distanceTo(b) > reach || Math.abs(a.y - b.y) > 3) continue;
      if (find(i) === find(j)) continue;
      if (walkable(level, a, b, o.eyeHeight)) parent[find(i)] = find(j);
    }
  }
  const size = new Map<number, number>();
  for (let i = 0; i < pts.length; i++) size.set(find(i), (size.get(find(i)) ?? 0) + 1);
  const best = Math.max(0, ...size.values());
  planStats.clusters = size.size;
  planStats.largest = best;
  return pts.filter((_, i) => (size.get(find(i)) ?? 0) >= Math.max(2, 0.3 * best));
}

export function candidateViews(points: THREE.Vector3[], o: PlanOptions): ViewSpec[] {
  const rnd = mulberry32(o.seed + 1);
  const out: ViewSpec[] = [];
  for (const p of points) {
    const offset = rnd() * (2 * Math.PI / o.yaws);
    for (let k = 0; k < o.yaws; k++) {
      out.push({ id: out.length, position: [p.x, p.y, p.z], yaw: offset + (2 * Math.PI * k) / o.yaws,
        pitch: THREE.MathUtils.degToRad(o.pitchDeg), fov: o.fov });
    }
    for (let k = 0; k < o.downYaws; k++) {
      out.push({ id: out.length, position: [p.x, p.y, p.z], yaw: offset + (2 * Math.PI * (k + 0.5)) / o.downYaws,
        pitch: THREE.MathUtils.degToRad(o.downPitchDeg), fov: o.fov });
    }
  }
  return out;
}

/**
 * Cameras around the level for surfaces no player sees: a high ring looking down into it (tops of props, ground
 * behind them) and a low ring just outside it facing the outer walls.
 */
export function aerialViews(level: Level, o: PlanOptions, startId: number): ViewSpec[] {
  const b = level.bounds;
  const c = b.getCenter(new THREE.Vector3());
  const size = b.getSize(new THREE.Vector3());
  const r = 0.5 * Math.hypot(size.x, size.z);
  const out: ViewSpec[] = [];
  const look = (p: THREE.Vector3, at: THREE.Vector3, fov: number) => {
    const d = at.clone().sub(p).normalize();
    out.push({ id: startId + out.length, position: [p.x, p.y, p.z], yaw: Math.atan2(-d.x, -d.z), pitch: Math.asin(d.y), fov, kind: 'aerial' });
  };
  for (let k = 0; k < o.aerial; k++) {
    const a = (2 * Math.PI * k) / o.aerial + 0.3;
    look(new THREE.Vector3(c.x + Math.sin(a) * r * 0.9, b.max.y + r * 0.55, c.z + Math.cos(a) * r * 0.9), new THREE.Vector3(c.x, b.min.y, c.z), 70);
  }
  const low = b.min.y + Math.min(12, 0.45 * size.y);
  for (let k = 0; k < 2 * o.aerial; k++) {
    const a = (2 * Math.PI * k) / (2 * o.aerial);
    look(new THREE.Vector3(c.x + Math.sin(a) * r * 1.05, low, c.z + Math.cos(a) * r * 1.05), new THREE.Vector3(c.x, b.min.y + 3, c.z), 70);
  }
  return out;
}

/** Roof test per surface point: by part label when the level names its roofs, else by slope and height. */
export function roofTest(level: Level): (label: number, ny: number, y: number) => boolean {
  const byLabel = roofLabels(level.labels, !level.shapes);
  const ground = (level.playArea ?? level.bounds).min.y;
  return byLabel ? (label, ny) => !!byLabel[label] && ny > ROOF_MIN_NY : (_, ny, y) => looksLikeRoof(ny, y, ground);
}

/**
 * Close cameras over the roofs, drone-style: for points spread over the roof surfaces, look back at the slope
 * from the side it faces, `roofDistance` away and 50° down (flat roofs get four headings).
 */
export function roofViews(level: Level, o: PlanOptions, startId: number): ViewSpec[] {
  const isRoof = roofTest(level);
  const g = level.geometry;
  const pos = g.getAttribute('position'), lab = g.getAttribute('label');
  const rnd = mulberry32(o.seed + 2);
  const spacing = o.roofDistance * 0.55;
  const pts: { p: THREE.Vector3; n: THREE.Vector3 }[] = [];
  const tri = new THREE.Triangle();
  const n = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < pos.count / 3; t++) {
    tri.setFromAttributeAndIndices(pos, 3 * t, 3 * t + 1, 3 * t + 2);
    tri.getNormal(n);
    tri.getMidpoint(c);
    if (!isRoof(lab ? Math.round(lab.getX(3 * t)) : 0, n.y, c.y)) continue;
    const k = (4 * tri.getArea()) / (spacing * spacing);
    const count = Math.floor(k) + (rnd() < k - Math.floor(k) ? 1 : 0);
    for (let i = 0; i < count; i++) {
      let r1 = rnd(), r2 = rnd();
      if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
      const p = tri.a.clone().addScaledVector(new THREE.Vector3().subVectors(tri.b, tri.a), r1)
        .addScaledVector(new THREE.Vector3().subVectors(tri.c, tri.a), r2);
      if (pts.every((q) => q.p.distanceTo(p) >= spacing)) pts.push({ p, n: n.clone() });
    }
  }
  const pitch = THREE.MathUtils.degToRad(-50);
  const ray = new THREE.Ray();
  const out: ViewSpec[] = [];
  for (const { p, n: nn } of pts) {
    const h = Math.hypot(nn.x, nn.z);
    const base = Math.atan2(nn.x, nn.z);
    const yaws = h < 0.2 ? [0, 0.5, 1, 1.5].map((f) => base + f * Math.PI) : [base, base - 0.7, base + 0.7];
    for (const yaw of yaws) {
      const dir = new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
      const eye = p.clone().addScaledVector(dir, -o.roofDistance);
      ray.origin.copy(p).addScaledVector(nn, 0.05);
      ray.direction.copy(dir).negate();
      const hit = level.bvh.raycastFirst(ray, THREE.DoubleSide);
      if (hit && hit.distance < o.roofDistance) continue;   // something (a taller roof, the tower) is in the way
      out.push({ id: startId + out.length, position: [eye.x, eye.y, eye.z], yaw, pitch, fov: 60, kind: 'roof' });
    }
  }
  return out;
}

/** Ground a player walks on: facing up, at the height of the floor under one of the player spots. */
export function floorTest(points: THREE.Vector3[], eyeHeight: number): (label: number, ny: number, y: number) => boolean {
  const heights = [...new Set(points.map((p) => Math.round((p.y - eyeHeight) * 4) / 4))];
  return (_, ny, y) => ny > 0.7 && heights.some((h) => Math.abs(y - h) < FLOOR_BAND);
}

/** A surface this close (m) to the floor's height is part of the floor: kerbs and thresholds, not steps or crates. */
export const FLOOR_BAND = 0.4;

/**
 * Cameras for the floor pass: over each player spot, looking straight down from `floorHeight` (lower where
 * something hangs over the spot; none where there is under 2 m of room).
 */
export function floorViews(level: Level, o: PlanOptions, points: THREE.Vector3[]): ViewSpec[] {
  const out: ViewSpec[] = [];
  const ray = new THREE.Ray();
  const pitch = THREE.MathUtils.degToRad(-88);   // not quite -90: the camera needs an up direction
  for (const p of points) {
    const floor = p.y - o.eyeHeight;
    ray.origin.set(p.x, floor + 0.1, p.z);
    ray.direction.set(0, 1, 0);
    const hit = level.bvh.raycastFirst(ray, THREE.DoubleSide);
    const h = Math.min(o.floorHeight, hit ? hit.distance - 0.2 : Infinity);
    if (h < 2) continue;
    out.push({ id: out.length, position: [p.x, floor + h, p.z], yaw: 0, pitch, fov: 90, kind: 'floor', floor });
  }
  return out;
}

/**
 * Candidates for the final hole pass: looking down from 5 m above where players stand (ground hidden behind props
 * from eye height) and from the high ring (tops of props). The pass picks among them by the unpainted pixels each
 * actually sees.
 */
export function holeViews(level: Level, o: PlanOptions, points: THREE.Vector3[]): ViewSpec[] {
  const out: ViewSpec[] = [];
  const pitch = THREE.MathUtils.degToRad(-55);
  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
  for (const p of points) {
    ray.origin.copy(p);
    const above = level.bvh.raycastFirst(ray, THREE.DoubleSide);
    if (above && above.distance < 5.5) continue;   // under a roof or an arch: the camera would sit in it
    for (let k = 0; k < 4; k++) {
      out.push({ id: out.length, position: [p.x, p.y + 5, p.z], yaw: (k * Math.PI) / 2 + 0.4, pitch, fov: 75, kind: 'fill' });
    }
  }
  for (const v of aerialViews(level, { ...o, aerial: Math.max(o.aerial, 8) }, out.length).slice(0, Math.max(o.aerial, 8))) {
    out.push({ ...v, id: out.length, kind: 'fill' });
  }
  return out;
}

/** A patch of surface nothing has painted: where it is, which way it faces, and how many texture cells it holds. */
export interface HoleTarget { center: THREE.Vector3; normal: THREE.Vector3; cells: number }

/**
 * Unpainted surface gathered into patches about `cell` metres across, largest first.
 * @param pos world position per texture cell (xyz + anything), row-major
 * @param nrm world normal per cell, a > 0.5 where a triangle covers it
 * @param quality capture quality per cell, 0 = unpainted
 */
export function holeTargets(pos: ArrayLike<number>, nrm: ArrayLike<number>, quality: ArrayLike<number>, cell = 3, max = 24,
  weight?: ArrayLike<number>): HoleTarget[] {
  const groups = new Map<string, { sum: THREE.Vector3; normal: THREE.Vector3; cells: number; score: number }>();
  for (let i = 0; i < quality.length; i++) {
    if (nrm[4 * i + 3] < 0.5 || quality[i] > 0) continue;
    const x = pos[4 * i], y = pos[4 * i + 1], z = pos[4 * i + 2];
    // patches are kept apart by which way they face, so the two sides of a wall don't average out
    const key = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)},${Math.round(nrm[4 * i])},${Math.round(nrm[4 * i + 1])},${Math.round(nrm[4 * i + 2])}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { sum: new THREE.Vector3(), normal: new THREE.Vector3(), cells: 0, score: 0 }));
    g.sum.x += x; g.sum.y += y; g.sum.z += z;
    g.normal.x += nrm[4 * i]; g.normal.y += nrm[4 * i + 1]; g.normal.z += nrm[4 * i + 2];
    g.cells++;
    g.score += weight && weight[i] > 0 ? weight[i] : 1;
  }
  return [...groups.values()].sort((a, b) => b.score - a.score).slice(0, max)
    .map((g) => ({ center: g.sum.divideScalar(g.cells), normal: g.normal.normalize(), cells: g.cells }));
}

/**
 * Cameras a model can paint from, aimed at patches of surface: at a player's eye height, close to level, looking
 * at the patch from its front with nothing in the way. Up to `per` for each patch, nearest spots first. Cameras
 * from the same spot looking nearly the same way are given once.
 */
export function lookViews(level: Level, targets: HoleTarget[], points: THREE.Vector3[], per = 3, kind?: ViewSpec['kind'], fov = 75): ViewSpec[] {
  const out: ViewSpec[] = [];
  const ray = new THREE.Ray();
  const to = new THREE.Vector3();
  const maxPitch = THREE.MathUtils.degToRad(25);
  const seen = new Set<string>();
  const step = THREE.MathUtils.degToRad(12);
  for (const t of targets) {
    let n = 0;
    for (const p of [...points].sort((a, b) => a.distanceToSquared(t.center) - b.distanceToSquared(t.center))) {
      if (n >= per) break;
      const dist = to.subVectors(t.center, p).length();
      if (dist < 2.5) continue;
      if (dist > 14) break;                                             // further spots only get worse
      if (t.normal.dot(to) > -0.25 * dist) continue;                    // behind the surface, or at a graze
      ray.origin.copy(p);
      ray.direction.copy(to).normalize();
      const hit = level.bvh.raycastFirst(ray, THREE.DoubleSide);
      if (hit && hit.distance < dist - 0.3) continue;                   // something stands in the way
      const spec = lookAt(p, t.center, fov, out.length);
      const pitch = THREE.MathUtils.clamp(spec.pitch, -maxPitch, maxPitch);
      n++;
      const key = `${points.indexOf(p)},${Math.round(spec.yaw / step)},${Math.round(pitch / step)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...spec, pitch, ...(kind ? { kind } : {}) });
    }
  }
  return out;
}

/** Look-at cameras for the hole pass (they paint only what is unpainted). */
export const holeLookViews = (level: Level, targets: HoleTarget[], points: THREE.Vector3[], per = 3) => lookViews(level, targets, points, per, 'fill');

/**
 * Render each candidate at probe size and list the UV cells it sees with the best quality per cell. With `only`,
 * just the pixels it accepts count (part label, normal y, world y).
 */
export function probeCells(gpu: Gpu, views: ViewRenderer, specs: ViewSpec[], o: PlanOptions,
  only?: (label: number, ny: number, y: number) => boolean, withShape = false): CellList[] {
  const rt = floatTarget(o.probeSize, o.probeSize, { count: 3, depth: true });
  const G = o.grid;
  const scratch = new Float32Array(G * G);
  const out: CellList[] = [];
  for (const s of specs) {
    views.renderGeometry(makeCamera(s), rt);
    const px = gpu.readF32(rt, 2, false);
    const wp = only || withShape ? gpu.readF32(rt, 0, false) : null;
    const nr = only || withShape ? gpu.readF32(rt, 1, false) : null;
    let shape: CellList['shape'];
    if (withShape) {
      // what the frame holds: its faces and its sky (row order doesn't matter for either)
      const f = viewFaces(wp!, nr!, o.probeSize);
      const shares = f.faces.map((face) => face.cells / (f.grid * f.grid));
      let geo = 0;
      for (let i = 3; i < nr!.length; i += 4) if (nr![i] > 0.5) geo++;
      shape = { sky: 1 - geo / (o.probeSize * o.probeSize), faces: shares.length, maxFace: Math.max(0, ...shares) };
    }
    const touched: number[] = [];
    for (let i = 0; i < px.length; i += 4) {
      const q = px[i + 2];
      if (!(q > 0)) continue;
      if (only && !only(Math.round(nr![i + 3] - 1), nr![i + 1], wp![i + 1])) continue;
      const cx = Math.min(G - 1, Math.max(0, Math.floor(px[i] * G)));
      const cy = Math.min(G - 1, Math.max(0, Math.floor(px[i + 1] * G)));
      const c = cy * G + cx;
      if (scratch[c] === 0) touched.push(c);
      if (q > scratch[c]) scratch[c] = q;
    }
    const cells = Int32Array.from(touched);
    const q = new Float32Array(cells.length);
    for (let i = 0; i < cells.length; i++) { q[i] = scratch[cells[i]]; scratch[cells[i]] = 0; }
    out.push({ cells, q, shape });
  }
  rt.dispose();
  return out;
}

/** Greedy set cover, then an order where each view overlaps what's already painted, then parallel waves. */
export interface Sharp {
  /** Texels per metre at each cell. */
  density: Float32Array;
  /** Per candidate: view pixels per metre head-on at 1 m, and how likely a model is to paint the view faithfully. */
  ppm: number[];
  paint: number[];
  /** View pixels per metre of the views that painted `existing`. */
  ppmExisting: number;
}

/**
 * Greedy selection, then an order where each view overlaps what's already painted, then parallel waves.
 * Without `sharp` it is a set cover: a view is worth the cells it captures well that nothing has yet. With `sharp`
 * it is worth the detail it adds: over the cells it sees, the gain in view pixels per texel (capped at 1) over what
 * is already there, times its chance of being painted faithfully.
 */
export function selectViews(lists: CellList[], o: PlanOptions, aerial: boolean[] = [], existing?: Float32Array,
  skip?: Uint8Array, sharp?: Sharp, weights?: ArrayLike<number>) {
  const G2 = o.grid * o.grid;
  const qBest = new Float32Array(G2);
  for (const l of lists) for (let i = 0; i < l.cells.length; i++) qBest[l.cells[i]] = Math.max(qBest[l.cells[i]], l.q[i]);
  if (skip) for (let c = 0; c < G2; c++) if (skip[c]) qBest[c] = 0;   // another pass covers these (roofs)
  let reachable = 0;
  for (let c = 0; c < G2; c++) if (qBest[c] > 0) reachable++;
  // Normalize cell importance weights over reachable cells to mean 1, so targetCoverage and minimum-gain floors keep their scale.
  let cellW: Float32Array | null = null;
  if (weights && reachable > 0) {
    let wSum = 0;
    for (let c = 0; c < G2; c++) if (qBest[c] > 0) wSum += weights[c] > 0 ? weights[c] : 1;
    if (wSum > 0) {
      cellW = new Float32Array(G2);
      const norm = reachable / wSum;
      for (let c = 0; c < G2; c++) if (qBest[c] > 0) cellW[c] = (weights[c] > 0 ? weights[c] : 1) * norm;
    }
  }
  const covered = new Uint8Array(G2);
  const good = (l: CellList, i: number) => qBest[l.cells[i]] > 0 && l.q[i] >= Math.min(o.goodRatio * qBest[l.cells[i]], o.goodAbs);
  let have = 0;
  if (existing) {
    // top-up: cells the texture already captures well don't need new views
    for (let c = 0; c < G2; c++) {
      if (qBest[c] > 0 && existing[c] >= Math.min(o.goodRatio * qBest[c], o.goodAbs)) { covered[c] = 1; have += cellW ? cellW[c] : 1; }
    }
  }
  // Sharpness: what each cell already has, in view pixels per texel capped at 1.
  const haveU = sharp ? new Float32Array(G2) : null;
  const detail = (k: number, i: number) => {
    const d = sharp!.density[lists[k].cells[i]];
    return d > 0 ? Math.min(1, (sharp!.ppm[k] * lists[k].q[i]) / d) : 0;
  };
  if (sharp && existing) {
    have = 0;
    for (let c = 0; c < G2; c++) {
      if (!(qBest[c] > 0) || !(sharp.density[c] > 0)) continue;
      haveU![c] = Math.min(1, (sharp.ppmExisting * existing[c]) / sharp.density[c]);
      have += haveU![c] * (cellW ? cellW[c] : 1);
    }
  }
  const gain = (k: number) => {
    const l = lists[k];
    let g = 0;
    if (sharp) {
      for (let i = 0; i < l.cells.length; i++) {
        const c = l.cells[i];
        if (qBest[c] > 0) g += Math.max(0, detail(k, i) - haveU![c]) * (cellW ? cellW[c] : 1);
      }
      g *= sharp.paint[k];
    } else {
      for (let i = 0; i < l.cells.length; i++) {
        const c = l.cells[i];
        if (!covered[c] && good(l, i)) g += cellW ? cellW[c] : 1;
      }
    }
    return aerial[k] ? g * 0.5 : g;   // prefer what players see; aerial views pick up the rest
  };
  const base = covered.slice();     // what the existing texture already covers (top-up runs)
  // Lazy greedy: gains only shrink as coverage grows.
  const heap = lists.map((_, k) => ({ k, g: gain(k) })).sort((a, b) => b.g - a.g);
  const chosen: number[] = [];
  while (chosen.length < o.maxViews && heap.length && have / reachable < o.targetCoverage) {
    const top = heap.shift()!;
    top.g = gain(top.k);
    if (heap.length && top.g < heap[0].g) {
      let lo = 0, hi = heap.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (heap[mid].g > top.g) lo = mid + 1; else hi = mid; }
      heap.splice(lo, 0, top);
      continue;
    }
    if (top.g < Math.max(8, reachable * 0.002)) break;
    chosen.push(top.k);
    const l = lists[top.k];
    if (sharp) {
      for (let i = 0; i < l.cells.length; i++) {
        const c = l.cells[i], u = detail(top.k, i);
        if (qBest[c] > 0 && u > haveU![c]) { have += (u - haveU![c]) * (cellW ? cellW[c] : 1); haveU![c] = u; }
      }
    } else {
      for (let i = 0; i < l.cells.length; i++) {
        const c = l.cells[i];
        if (good(l, i) && !covered[c]) { covered[c] = 1; have += cellW ? cellW[c] : 1; }
      }
    }
  }
  if (!chosen.length) return { order: [] as number[], waves: [] as number[][], qBest, reachable, predicted: [] as number[] };
  // Order: start from the biggest view, then always take the one overlapping the painted area most.
  const painted = new Uint8Array(G2);
  if (existing) for (let c = 0; c < G2; c++) if (existing[c] > 0) painted[c] = 1;
  const overlap = (k: number) => { let n = 0; for (const c of lists[k].cells) if (painted[c]) n++; return n; };
  const paint = (k: number) => { for (const c of lists[k].cells) painted[c] = 1; };
  const ground = chosen.filter((k) => !aerial[k]);
  const air = chosen.filter((k) => aerial[k]);
  const order: number[] = [ground[0] ?? air[0]];
  paint(order[0]);
  const rest = new Set((ground.length ? ground : air).slice(1));
  while (rest.size) {
    let best = -1, bestScore = -1;
    for (const k of rest) {
      const ov = overlap(k) / Math.max(1, lists[k].cells.length);
      const score = ov > 0.08 ? 1 + ov * 0.1 + (1 - chosen.indexOf(k) / chosen.length) : ov;
      if (score > bestScore) { bestScore = score; best = k; }
    }
    order.push(best);
    paint(best);
    rest.delete(best);
  }
  if (ground.length) for (const k of air) order.push(k);   // aerial views paint last, one at a time
  // Waves: views in a wave must not overlap each other, and (after the first) must touch painted texture.
  const waves: number[][] = [];
  const done = new Uint8Array(G2);
  if (existing) for (let c = 0; c < G2; c++) if (existing[c] > 0) done[c] = 1;
  const pending = order.map((_, i) => i);
  while (pending.length) {
    if (aerial[order[pending[0]]]) {
      const vi = pending.shift()!;
      waves.push([vi]);
      for (const c of lists[order[vi]].cells) done[c] = 1;
      continue;
    }
    const wave: number[] = [];
    const inWave = new Uint8Array(G2);
    for (let p = 0; p < pending.length && wave.length < o.maxParallel; p++) {
      const vi = pending[p];
      if (aerial[order[vi]]) break;
      const l = lists[order[vi]];
      let touchesDone = 0, clash = 0;
      for (const c of l.cells) { if (done[c]) touchesDone++; if (inWave[c]) clash++; }
      const first = waves.length === 0 && wave.length === 0;
      if (!first && waves.length === 0 && !existing) break;          // the very first view paints alone
      if (!first && touchesDone < 0.05 * l.cells.length && wave.length) continue;
      if (clash > 0.02 * l.cells.length) continue;
      wave.push(vi);
      for (const c of l.cells) inWave[c] = 1;
    }
    if (!wave.length) wave.push(pending[0]);
    for (const vi of wave) { pending.splice(pending.indexOf(vi), 1); for (const c of lists[order[vi]].cells) done[c] = 1; }
    waves.push(wave);
  }
  // Predicted coverage curve in paint order.
  const cov = base.slice();
  let n = 0;
  for (let c = 0; c < G2; c++) n += cov[c];
  const predicted = order.map((k) => {
    const l = lists[k];
    for (let i = 0; i < l.cells.length; i++) if (!cov[l.cells[i]] && good(l, i)) { cov[l.cells[i]] = 1; n++; }
    return n / reachable;
  });
  return { order, waves, qBest, reachable, predicted };
}

export function plan(gpu: Gpu, level: Level, views: ViewRenderer, opts: Partial<PlanOptions> = {}, existing?: Float32Array,
  surface?: Surface): Plan {
  const o = { ...DEFAULT_PLAN, ...opts };
  const G2 = o.grid * o.grid;
  const points = samplePlayerPoints(level, o);
  if (!points.length) throw new Error('found nowhere to stand: is the level Y-up with walkable floors?');
  const byAdaptive = !!o.adaptive && !!surface;
  const byFisher = (byAdaptive || o.objective === 'fisher') && !!surface;
  const bySharpness = !byFisher && o.objective === 'sharpness' && !!surface;
  // Per-triangle geometry importance weights (`weight` attribute riding alongside `label`), or combined item 7 + geodesic weights when adaptive.
  const wAttr = level.geometry.getAttribute('weight');
  let weights = surface?.weight;
  if (byAdaptive || o.geodesic) {
    weights = combinedPlanWeights(level, points, o.grid, { eyeHeight: o.eyeHeight, geodesic: o.geodesic ?? true });
  } else if (!weights && wAttr) {
    const triW = new Float32Array(Math.floor(wAttr.count / 3));
    for (let t = 0; t < triW.length; t++) triW[t] = wAttr.getX(3 * t);
    weights = cellWeights(level.geometry.getAttribute('uv').array, triW, o.grid);
  }
  // The floor pass: straight down over the ground, chosen over ground surfaces only and painted first.
  const floorCands = o.floors > 0 ? floorViews(level, o, points) : [];
  const floorLists = probeCells(gpu, views, floorCands, o, floorTest(points, o.eyeHeight));
  const floorSel = floorCands.length ? selectViews(floorLists, { ...o, maxViews: o.floors, targetCoverage: 0.98, maxParallel: 1 }, [], existing) : null;
  const roofCands = o.roofs > 0 ? roofViews(level, o, 0) : [];
  const roofLists = probeCells(gpu, views, roofCands, o, roofTest(level));
  const air = o.aerial > 0 ? aerialViews(level, o, 0) : [];
  const airLists = probeCells(gpu, views, air, o);
  let roofCells: Uint8Array | undefined;
  if (roofCands.length) {
    roofCells = new Uint8Array(G2);
    for (const l of roofLists) for (const c of l.cells) roofCells[c] = 1;
  }
  // what the roof and floor passes paint is left to them: the players' views are picked for the rest
  let passCells = roofCells;
  if (floorSel?.order.length) {
    passCells = roofCells ? roofCells.slice() : new Uint8Array(G2);
    for (const k of floorSel.order) for (const c of floorLists[k].cells) passCells[c] = 1;
  }

  let ground: ViewSpec[];
  let groundLists: CellList[];
  let sel: { order: number[]; waves: number[][]; qBest: Float32Array; reachable: number; predicted: number[] };
  let fisherMeta: { marginalShares: number[]; weightedCoverage: number; rounds: number } | undefined;

  if (byAdaptive) {
    const coarse = candidateViews(points, { ...o, yaws: Math.min(o.yaws, 8) });
    const ad = adaptiveGroundViews(gpu, level, views, points, o, surface!, {
      existing, skip: passCells, coarseSpecs: coarse, weights: weights!,
    });
    ground = ad.specs;
    groundLists = ad.lists;
    sel = ad.sel;
    fisherMeta = { marginalShares: ad.sel.marginalShares, weightedCoverage: ad.sel.weightedCoverage, rounds: ad.rounds };
    planStats.groundCandidates = ground.length;
    planStats.adaptiveRounds = ad.rounds;
  } else {
    ground = candidateViews(points, o);
    if (surface && o.lookAt > 0) {
      const patches = holeTargets(surface.pos, surface.nrm, new Float32Array(G2), 3, 400, weights);
      for (const v of lookViews(level, patches, points, o.lookAt)) ground.push({ ...v, id: ground.length });
    }
    groundLists = probeCells(gpu, views, ground, o, undefined, bySharpness || byFisher);
    planStats.groundCandidates = ground.length;
    if (byFisher) {
      const fsel = selectFisherViews(groundLists, ground, o, {
        density: cellDensity(surface!, o.grid), weights, existing, skip: passCells, viewSize: views.size,
      });
      sel = fsel;
      fisherMeta = { marginalShares: fsel.marginalShares, weightedCoverage: fsel.weightedCoverage, rounds: 1 };
    } else {
      let sharp: Sharp | undefined;
      if (bySharpness) {
        sharp = { density: cellDensity(surface!, o.grid), ppm: ground.map((v) => pixelsPerMetre(views.size, v.fov)), ppmExisting: pixelsPerMetre(views.size, o.fov),
          // nothing is painted when the plan is made, so each view is judged as if it had no context
          paint: ground.map((v, k) => paintability({ pitch: v.pitch, ...groundLists[k].shape!, context: 0 })) };
      }
      sel = selectViews(groundLists, o, [], existing, passCells, sharp, weights);
    }
  }
  const roofSel = roofCands.length
    ? selectViews(roofLists, { ...o, maxViews: o.roofs, targetCoverage: 0.98 }, roofCands.map(() => true), existing) : null;
  // the aerial ring only fills in after the players' views
  const basePpm = pixelsPerMetre(views.size, o.fov);
  const have = existing ? existing.slice() : new Float32Array(G2);
  for (const k of sel.order) {
    const l = groundLists[k], scale = pixelsPerMetre(views.size, ground[k].fov) / basePpm;
    for (let i = 0; i < l.cells.length; i++) have[l.cells[i]] = Math.max(have[l.cells[i]], l.q[i] * scale);
  }
  const airSel = air.length ? selectViews(airLists, { ...o, maxViews: 2 * o.aerial }, air.map(() => true), have, roofCells) : null;
  const picked = [
    ...(floorSel?.order.map((k) => ({ spec: floorCands[k], cells: floorLists[k] })) ?? []),
    ...sel.order.map((k) => ({ spec: ground[k], cells: groundLists[k] })),
    ...(roofSel?.order.map((k) => ({ spec: roofCands[k], cells: roofLists[k] })) ?? []),
    ...(airSel?.order.map((k) => ({ spec: air[k], cells: airLists[k] })) ?? []),
  ];
  // Paint order as listed; floor, roof and aerial views each paint alone.
  const nFloor = floorSel?.order.length ?? 0, nPlay = nFloor + sel.order.length;
  const waves = [...picked.slice(0, nFloor).map((_, j) => [j]), ...sel.waves.map((w) => w.map((i) => i + nFloor)),
    ...picked.slice(nPlay).map((_, j) => [nPlay + j])];
  // Predicted coverage over everything any candidate sees well, in paint order.
  const qAll = new Float32Array(G2);
  const addQ = (specs: ViewSpec[], lists: CellList[]) => {
    for (let k = 0; k < lists.length; k++) {
      const l = lists[k], scale = pixelsPerMetre(views.size, specs[k].fov) / basePpm;
      for (let i = 0; i < l.cells.length; i++) qAll[l.cells[i]] = Math.max(qAll[l.cells[i]], l.q[i] * scale);
    }
  };
  addQ(floorCands, floorLists); addQ(ground, groundLists); addQ(roofCands, roofLists); addQ(air, airLists);
  const good = (c: number, q: number) => q >= Math.min(o.goodRatio * qAll[c], o.goodAbs);
  const cov = new Uint8Array(G2);
  let reachable = 0, n = 0;
  for (let c = 0; c < G2; c++) {
    if (!(qAll[c] > 0)) continue;
    reachable++;
    if (existing && good(c, existing[c])) { cov[c] = 1; n++; }
  }
  const predicted = picked.map(({ spec, cells: l }) => {
    const scale = pixelsPerMetre(views.size, spec.fov) / basePpm;
    for (let i = 0; i < l.cells.length; i++) if (!cov[l.cells[i]] && good(l.cells[i], l.q[i] * scale)) { cov[l.cells[i]] = 1; n++; }
    return reachable ? n / reachable : 0;
  });
  // How sharply the plan would sample the texture, if every view is painted as planned.
  let sharpness: Sampling | undefined;
  let texture: Plan['texture'];
  let budget: BudgetAdvice | undefined;
  if (surface) {
    const best = existing ? existing.slice() : new Float32Array(G2);
    for (const { spec, cells: l } of picked) {
      const scale = pixelsPerMetre(views.size, spec.fov) / basePpm;   // as quality at the default lens
      for (let i = 0; i < l.cells.length; i++) best[l.cells[i]] = Math.max(best[l.cells[i]], l.q[i] * scale);
    }
    const coveredCells = new Uint8Array(G2);
    for (let c = 0; c < G2; c++) coveredCells[c] = surface.nrm[4 * c + 3] > 0.5 ? 1 : 0;
    sharpness = sampling(best, surface.pos, coveredCells, o.grid, surface.texelsPerCell, basePpm);
    let island = 0, seen = 0;
    for (let c = 0; c < G2; c++) if (coveredCells[c]) { island++; if (sel.qBest[c] > 0 || (passCells && passCells[c])) seen++; }
    texture = { seen: island ? seen / island : 0 };
    if (fisherMeta && weights) {
      budget = budgetAdvice({
        marginalShares: fisherMeta.marginalShares,
        weightedCoverage: fisherMeta.weightedCoverage,
        medianRatio: sharpness.p50,
        surface,
        weights,
        grid: o.grid,
        atlasSize: o.atlasSize ?? Math.round(surface.texelsPerCell * o.grid),
        rounds: fisherMeta.rounds,
        probedCandidates: ground.length,
      });
    }
  }
  planStats.floorViews = nFloor;
  planStats.roofCandidates = roofCands.length;
  planStats.roofViews = roofSel?.order.length ?? 0;
  planStats.aerialViews = airSel?.order.length ?? 0;
  return { points, views: picked.map((p, i) => ({ ...p.spec, id: i })), waves, viewCells: picked.map((p) => p.cells), qBest: qAll,
    grid: o.grid, reachableCells: reachable, predicted, sharpness, texture, ...(budget ? { budget } : {}) };
}
