import * as THREE from 'three';
import { uvIslands } from './layout';
import { objectEyes } from './object-plan';
import { DEFAULT_PLAN, mulberry32 } from './planner';
import type { Level } from './scene';

/**
 * Player-path importance map (TODO item 6):
 * 1. Bake a capsule-cleared walkable navigation graph (`bakeNavGraph`) over `level.bvh`, finding entry/perimeter
 *    landmarks and walkable stair/corridor links without external WASM dependencies.
 * 2. Walk simulated bots (`walkBots`) along shortest routes between entry points/landmarks plus self-avoiding
 *    exploration walks (or turntable/spherical inspection orbits in `object` mode).
 * 3. Cast frustum gaze rays from each bot pose (`playerImportance`) and accumulate area-normalized score
 *    `hits × (1 / distance) × cos^1.35(θ)` per triangle, mapped into a continuous `[0, 1]` rank that drives UV island
 *    splitting & scaling (`splitUvByRank`, `pathLayoutScale`), planner cell weights, repair priority and a `'paths'`
 *    viewer debug overlay.
 */

export interface NavNode {
  /** Eye-height position `(x, floorY + eyeHeight, z)`. */
  eye: THREE.Vector3;
  floorY: number;
  /** Horizontal wall clearance (m, capped at 2.5 m). */
  clearance: number;
}

export interface NavGraph {
  nodes: NavNode[];
  /** Neighbour node indices and traversal costs per node. */
  edges: { to: number; cost: number }[][];
  /** Indices of entry points / extremities / landmarks spread across the walkable graph. */
  landmarks: number[];
  seconds: number;
}

export interface BotPose {
  eye: THREE.Vector3;
  /** Unit look direction. */
  dir: THREE.Vector3;
}

export interface PlayerImportance {
  /** Continuous importance rank per triangle in `[0, 1]` (`0` = never seen along any bot path, `1` = prime sightlines). */
  rank: Float32Array;
  /** Raw gaze-ray hit count per triangle. */
  hits: Uint32Array;
  /** Closest unobstructed bot-eye gaze distance (m) per triangle (`Infinity` when never hit). */
  minDist: Float32Array;
  nodes: number;
  poses: number;
  /** Share of total surface area seen at least once (`rank > 0`), and share in the high-rank tier (`rank >= 0.55`). */
  seenShare: number;
  highRankShare: number;
  seconds: number;
}

function stepWalkable(level: Pick<Level, 'bvh'>, a: NavNode, b: NavNode, eyeHeight: number): boolean {
  const ray = new THREE.Ray();
  const d = a.eye.distanceTo(b.eye);
  if (d < 1e-4) return true;
  ray.origin.copy(a.eye);
  ray.direction.subVectors(b.eye, a.eye).divideScalar(d);
  const los = level.bvh.raycastFirst(ray, THREE.DoubleSide, 0, d);
  if (los && los.distance < d - 0.06) return false;

  const steps = Math.max(1, Math.ceil(Math.hypot(b.eye.x - a.eye.x, b.eye.z - a.eye.z) / 0.35));
  let prev = a.floorY;
  const top = Math.max(a.eye.y, b.eye.y) + 0.2;
  ray.direction.set(0, -1, 0);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    ray.origin.set(a.eye.x + (b.eye.x - a.eye.x) * t, top, a.eye.z + (b.eye.z - a.eye.z) * t);
    const hit = level.bvh.raycastFirst(ray, THREE.DoubleSide);
    if (!hit) return false;
    const fy = hit.point.y;
    if (fy - prev > 0.65 || prev - fy > 1.35) return false;
    prev = fy;
  }
  return Math.abs(prev - b.floorY) < 0.32 && eyeHeight > 0;
}

/** Bake a walkable 2.5D navigation graph with capsule wall clearance and landmark selection. */
export function bakeNavGraph(level: Level, opts: {
  spacing?: number;
  eyeHeight?: number;
  radius?: number;
  seed?: number;
  maxLandmarks?: number;
} = {}): NavGraph {
  const t0 = performance.now();
  const box = level.playArea ?? level.bounds;
  const spanXZ = Math.hypot(box.max.x - box.min.x, box.max.z - box.min.z);
  const spacing = opts.spacing ?? Math.max(1.35, spanXZ / 50);
  const eyeHeight = opts.eyeHeight ?? DEFAULT_PLAN.eyeHeight;
  const radius = opts.radius ?? 0.32;
  const rnd = mulberry32(opts.seed ?? 11);

  if (level.mode === 'object') {
    return { nodes: [], edges: [], landmarks: [], seconds: (performance.now() - t0) / 1000 };
  }

  const step = Math.max(0.45, spacing * 0.6);
  const nx = Math.max(1, Math.ceil((box.max.x - box.min.x) / step));
  const nz = Math.max(1, Math.ceil((box.max.z - box.min.z) / step));
  const cand: THREE.Vector3[] = [];
  const probeRay = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      const jx = rnd() * 0.5 + 0.25, jz = rnd() * 0.5 + 0.25;
      const px = box.min.x + (ix + jx) * step;
      const pz = box.min.z + (iz + jz) * step;
      let yTop = level.bounds.max.y + 0.5;
      for (let layer = 0; layer < 8 && yTop >= box.min.y - 0.05; layer++) {
        probeRay.origin.set(px, yTop, pz);
        const hit = level.bvh.raycastFirst(probeRay, THREE.DoubleSide, 0, yTop - box.min.y + 1);
        if (!hit) break;
        if (hit.face && hit.face.normal.y >= 0.7) cand.push(hit.point.clone());
        yTop = hit.point.y - 0.15;
      }
    }
  }

  const ray = new THREE.Ray();
  const up = new THREE.Vector3(0, 1, 0);
  const rawNodes: NavNode[] = [];
  for (const p of cand) {
    ray.origin.copy(p).addScaledVector(up, 0.05);
    ray.direction.copy(up);
    const overhead = level.bvh.raycastFirst(ray, THREE.DoubleSide, 0, eyeHeight + 0.3);
    if (overhead) continue;
    const eye = p.clone().addScaledVector(up, eyeHeight);
    if (level.playArea && !level.playArea.containsPoint(eye)) continue;
    ray.origin.copy(eye);
    ray.direction.set(0, -1, 0);
    const down = level.bvh.raycastFirst(ray, THREE.DoubleSide, 0, eyeHeight + 0.15);
    if (!down || Math.abs(down.distance - eyeHeight) > 0.12) continue;

    // Capsule clearance & interior check at waist/chest height.
    let minClear = 2.5, backHits = 0, nearHits = 0;
    ray.origin.set(p.x, p.y + 0.95, p.z);
    for (let d = 0; d < 8; d++) {
      const ang = (d / 8) * Math.PI * 2;
      ray.direction.set(Math.sin(ang), 0, Math.cos(ang));
      const h = level.bvh.raycastFirst(ray, THREE.DoubleSide, 0, 30);
      if (!h) continue;
      if (h.face && h.face.normal.dot(ray.direction) > 0) backHits++;
      else nearHits++;
      if (h.distance < minClear) minClear = h.distance;
    }
    if (backHits >= 3 || minClear < radius) continue;
    if (nearHits === 0 && !level.playArea) {
      // Still keep open courtyards, only track enclosure to filter exposed rooftops below.
    }
    rawNodes.push({ eye, floorY: p.y, clearance: minClear });
  }

  // Filter exposed rooftops the same way `enclosed` does in `planner.ts`: prefer nodes with walls within 30 m when available.
  const enclosedCount = rawNodes.map((n) => {
    let hits = 0;
    ray.origin.copy(n.eye);
    for (let d = 0; d < 8; d++) {
      const ang = (d / 8) * Math.PI * 2;
      ray.direction.set(Math.sin(ang), 0, Math.cos(ang));
      const h = level.bvh.raycastFirst(ray, THREE.DoubleSide, 0, 30);
      if (h && (!h.face || h.face.normal.dot(ray.direction) <= 0)) hits++;
    }
    return hits;
  });
  let pool = rawNodes;
  for (const minHits of [4, 2, 0]) {
    const keep = rawNodes.filter((_, i) => enclosedCount[i] >= minHits);
    if (keep.length >= Math.max(4, 0.25 * rawNodes.length) || minHits === 0) { pool = keep; break; }
  }

  // Poisson-disk spatial thinning preferring higher-clearance corridor centers.
  pool.sort((a, b) => b.clearance - a.clearance);
  const grid = new Map<string, NavNode[]>();
  const thinned: NavNode[] = [];
  for (const n of pool) {
    const gx = Math.floor(n.eye.x / spacing), gz = Math.floor(n.eye.z / spacing);
    let clash = false;
    for (let dx = -1; dx <= 1 && !clash; dx++) {
      for (let dz = -1; dz <= 1 && !clash; dz++) {
        for (const q of grid.get(`${gx + dx},${gz + dz}`) ?? []) {
          if (Math.hypot(q.eye.x - n.eye.x, q.eye.z - n.eye.z) < spacing && Math.abs(q.floorY - n.floorY) < 1.8) {
            clash = true;
            break;
          }
        }
      }
    }
    if (clash) continue;
    thinned.push(n);
    const key = `${gx},${gz}`;
    const list = grid.get(key);
    if (list) list.push(n); else grid.set(key, [n]);
  }
  for (const spot of level.spots ?? []) {
    thinned.push({ eye: spot.clone(), floorY: spot.y - eyeHeight, clearance: 1.5 });
  }
  if (!thinned.length) {
    return { nodes: [], edges: [], landmarks: [], seconds: (performance.now() - t0) / 1000 };
  }

  // Build walkable edges within 2.5 * spacing via spatial bucket lookup and keep main connected components.
  const reach = spacing * 2.5;
  const rawEdges: { to: number; cost: number }[][] = thinned.map(() => []);
  const parent = thinned.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < thinned.length; i++) {
    const bx = Math.floor(thinned[i].eye.x / reach), bz = Math.floor(thinned[i].eye.z / reach);
    const key = `${bx},${bz}`;
    const list = buckets.get(key);
    if (list) list.push(i); else buckets.set(key, [i]);
  }
  for (let i = 0; i < thinned.length; i++) {
    const a = thinned[i];
    const bx = Math.floor(a.eye.x / reach), bz = Math.floor(a.eye.z / reach);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const j of buckets.get(`${bx + dx},${bz + dz}`) ?? []) {
          if (j <= i) continue;
          const b = thinned[j];
          const d = a.eye.distanceTo(b.eye);
          if (d > reach || Math.abs(a.floorY - b.floorY) > 2.2) continue;
          if (!stepWalkable(level, a, b, eyeHeight)) continue;
          const clearPenalty = 1 + 0.3 * Math.max(0, 1 - Math.min(a.clearance, b.clearance));
          const cost = d * clearPenalty;
          rawEdges[i].push({ to: j, cost });
          rawEdges[j].push({ to: i, cost });
          parent[find(i)] = find(j);
        }
      }
    }
  }
  const compSize = new Map<number, number>();
  for (let i = 0; i < thinned.length; i++) compSize.set(find(i), (compSize.get(find(i)) ?? 0) + 1);
  const largest = Math.max(0, ...compSize.values());
  const spotStart = thinned.length - (level.spots?.length ?? 0);
  const spotRoots = new Set<number>();
  for (let i = spotStart; i < thinned.length; i++) spotRoots.add(find(i));

  const oldToNew = new Int32Array(thinned.length).fill(-1);
  const nodes: NavNode[] = [];
  for (let i = 0; i < thinned.length; i++) {
    const r = find(i);
    if ((compSize.get(r) ?? 0) >= Math.max(2, 0.25 * largest) || spotRoots.has(r)) {
      oldToNew[i] = nodes.length;
      nodes.push(thinned[i]);
    }
  }
  const edges: { to: number; cost: number }[][] = nodes.map(() => []);
  for (let i = 0; i < thinned.length; i++) {
    const u = oldToNew[i];
    if (u < 0) continue;
    for (const e of rawEdges[i]) {
      const v = oldToNew[e.to];
      if (v >= 0) edges[u].push({ to: v, cost: e.cost });
    }
  }

  // Farthest-point landmark selection starting from the most extreme perimeter entry node.
  const maxLandmarks = Math.min(nodes.length, opts.maxLandmarks ?? 10);
  const landmarks: number[] = [];
  if (nodes.length) {
    const cx = nodes.reduce((s, n) => s + n.eye.x, 0) / nodes.length;
    const cz = nodes.reduce((s, n) => s + n.eye.z, 0) / nodes.length;
    let first = 0, bestR = -1;
    for (let i = 0; i < nodes.length; i++) {
      const r = Math.hypot(nodes[i].eye.x - cx, nodes[i].eye.z - cz);
      if (r > bestR) { bestR = r; first = i; }
    }
    landmarks.push(first);
    const minDist = new Float32Array(nodes.length).fill(Infinity);
    while (landmarks.length < maxLandmarks) {
      const last = nodes[landmarks[landmarks.length - 1]].eye;
      let pick = -1, far = -1;
      for (let i = 0; i < nodes.length; i++) {
        minDist[i] = Math.min(minDist[i], nodes[i].eye.distanceTo(last));
        if (minDist[i] > far) { far = minDist[i]; pick = i; }
      }
      if (pick < 0 || far < spacing * 1.2) break;
      landmarks.push(pick);
    }
  }

  return { nodes, edges, landmarks, seconds: (performance.now() - t0) / 1000 };
}

/** Shortest path of node indices from `start` to `goal` on `nav` (`[]` when disconnected). */
export function navShortestPath(nav: NavGraph, start: number, goal: number): number[] {
  const n = nav.nodes.length;
  if (start < 0 || goal < 0 || start >= n || goal >= n) return [];
  if (start === goal) return [start];
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const seen = new Uint8Array(n);
  dist[start] = 0;
  for (let step = 0; step < n; step++) {
    let u = -1, best = Infinity;
    for (let i = 0; i < n; i++) if (!seen[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u < 0 || u === goal) break;
    seen[u] = 1;
    for (const e of nav.edges[u]) {
      const nd = dist[u] + e.cost;
      if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = u; }
    }
  }
  if (!Number.isFinite(dist[goal])) return [];
  const path: number[] = [];
  for (let cur = goal; cur >= 0; cur = prev[cur]) path.push(cur);
  return path.reverse();
}

/**
 * Walk simulated bots along landmark-to-landmark routes and exploration paths, returning eye poses and gaze directions.
 * For discrete objects (`level.mode === 'object'` or empty nav graph), generates turntable + spherical inspection poses.
 */
export function walkBots(level: Pick<Level, 'bounds' | 'bvh' | 'mode'>, nav: NavGraph,
  opts: { bots?: number; stepsPerBot?: number; seed?: number } = {}): BotPose[] {
  const bots = opts.bots ?? 8, stepsPerBot = opts.stepsPerBot ?? 28;
  const rnd = mulberry32(opts.seed ?? 23);
  const poses: BotPose[] = [];

  if (level.mode === 'object' || !nav.nodes.length) {
    const centre = level.bounds.getCenter(new THREE.Vector3());
    // Dense frontal/three-quarter turntable ring + spherical inspection shell.
    for (const eye of [...objectEyes(level, 40, 2.2), ...objectEyes(level, 24, 1.65)]) {
      const relY = (eye.y - centre.y) / Math.max(1e-4, eye.distanceTo(centre));
      const dir = centre.clone().sub(eye).normalize();
      poses.push({ eye, dir });
      // Extra turntable weight on upper/equatorial angles where viewers inspect props and characters most.
      if (relY > -0.35 && relY < 0.7) poses.push({ eye: eye.clone(), dir: dir.clone() });
    }
    return poses;
  }

  const lm = nav.landmarks.length >= 2 ? nav.landmarks : nav.nodes.map((_, i) => i);
  const visitCount = new Uint16Array(nav.nodes.length);

  const recordWalk = (seq: number[]) => {
    for (let i = 0; i < seq.length; i++) {
      const u = seq[i];
      visitCount[u]++;
      const eye = nav.nodes[u].eye;
      const next = seq[Math.min(seq.length - 1, i + 1)];
      const prev = seq[Math.max(0, i - 1)];
      const move = new THREE.Vector3().subVectors(nav.nodes[next].eye, nav.nodes[prev].eye);
      if (move.lengthSq() < 1e-6) {
        const yaw = rnd() * Math.PI * 2;
        move.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      } else {
        move.y *= 0.35;   // keep gaze mostly horizontal on stairs
        move.normalize();
      }
      const baseYaw = Math.atan2(-move.x, -move.z);
      // Forward travel gaze + natural left/right visual scan as a player walks through a space.
      for (const [dYaw, pitch] of [[0, -0.04], [0.42, 0.03], [-0.42, 0.03], [(rnd() - 0.5) * 1.4, -0.14]] as const) {
        const yaw = baseYaw + dYaw;
        const cp = Math.cos(pitch);
        poses.push({
          eye,
          dir: new THREE.Vector3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp),
        });
      }
    }
  };

  // 1. Landmark-to-landmark routes (entry points, plazas, stair landings).
  const routeCount = Math.max(bots, Math.min(18, lm.length * 2));
  for (let r = 0; r < routeCount; r++) {
    const a = lm[r % lm.length];
    const b = lm[(r + 1 + Math.floor(rnd() * Math.max(1, lm.length - 1))) % lm.length];
    if (a === b) continue;
    const path = navShortestPath(nav, a, b);
    if (path.length >= 2) recordWalk(path);
  }

  // 2. Self-avoiding curiosity exploration bots preferring less-visited connected nodes and forward momentum.
  for (let b = 0; b < bots; b++) {
    let cur = lm[b % lm.length] ?? Math.floor(rnd() * nav.nodes.length);
    let prev = -1;
    const seq = [cur];
    for (let s = 0; s < stepsPerBot; s++) {
      const nbrs = nav.edges[cur];
      if (!nbrs.length) break;
      let best = nbrs[0].to, bestScore = -Infinity;
      const fwd = prev >= 0 ? new THREE.Vector3().subVectors(nav.nodes[cur].eye, nav.nodes[prev].eye).normalize() : null;
      for (const e of nbrs) {
        let score = -visitCount[e.to] * 1.2 + rnd() * 0.9;
        if (e.to === prev) score -= 2.5;
        if (fwd) {
          const stepDir = new THREE.Vector3().subVectors(nav.nodes[e.to].eye, nav.nodes[cur].eye).normalize();
          score += 0.65 * fwd.dot(stepDir);
        }
        if (score > bestScore) { bestScore = score; best = e.to; }
      }
      prev = cur;
      cur = best;
      seq.push(cur);
    }
    recordWalk(seq);
  }

  return poses;
}

// 9-ray frustum fan (center + inner ring + wider peripheral ring across ~72° FOV).
const FRUSTUM_RAYS: [number, number, number][] = [
  [0, 0, 1.0],
  [0.24, 0.14, 0.85], [-0.24, 0.14, 0.85], [0.24, -0.18, 0.85], [-0.24, -0.18, 0.85],
  [0.52, 0.05, 0.65], [-0.52, 0.05, 0.65], [0, 0.34, 0.72], [0, -0.36, 0.75],
];

/**
 * Compute per-triangle player-path importance in `[0, 1]` by walking bots and casting frustum gaze rays against `level.bvh`:
 * `flux[t] += weight_ray * cos^1.35(θ) / (max(dist, 0.75) * max(area_t, 0.04))`.
 */
export function playerImportance(level: Level, opts: {
  spacing?: number;
  bots?: number;
  stepsPerBot?: number;
  reach?: number;
  seed?: number;
  nav?: NavGraph;
} = {}): PlayerImportance {
  const t0 = performance.now();
  const reach = opts.reach ?? 55;
  const pos = level.geometry.getAttribute('position').array;
  const tris = Math.floor(pos.length / 9);
  const areas = new Float32Array(tris);
  const normals = new Float32Array(tris * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  let totalArea = 0;
  for (let t = 0; t < tris; t++) {
    a.fromArray(pos, 9 * t); b.fromArray(pos, 9 * t + 3); c.fromArray(pos, 9 * t + 6);
    n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
    const area = n.length() / 2;
    areas[t] = area;
    totalArea += area;
    if (area >= 1e-9) {
      normals[3 * t] = n.x / (2 * area);
      normals[3 * t + 1] = n.y / (2 * area);
      normals[3 * t + 2] = n.z / (2 * area);
    }
  }

  const nav = opts.nav ?? bakeNavGraph(level, { spacing: opts.spacing, seed: opts.seed });
  const poses = walkBots(level, nav, { bots: opts.bots, stepsPerBot: opts.stepsPerBot, seed: opts.seed });

  const idxAttr = level.geometry.getIndex();
  const idxArr = idxAttr ? idxAttr.array : null;
  const flux = new Float64Array(tris);
  const hits = new Uint32Array(tris);
  const minDist = new Float32Array(tris).fill(Infinity);
  const ray = new THREE.Ray();
  const right = new THREE.Vector3(), upCam = new THREE.Vector3(), worldUp = new THREE.Vector3(0, 1, 0);

  for (const pose of poses) {
    const fwd = pose.dir;
    right.crossVectors(fwd, worldUp);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0); else right.normalize();
    upCam.crossVectors(right, fwd).normalize();

    ray.origin.copy(pose.eye);
    for (const [rx, ry, rw] of FRUSTUM_RAYS) {
      ray.direction.copy(fwd).addScaledVector(right, rx).addScaledVector(upCam, ry).normalize();
      const h = level.bvh.raycastFirst(ray, THREE.DoubleSide, 0.08, reach);
      if (!h || h.faceIndex == null) continue;
      const t = idxArr ? Math.floor(idxArr[3 * h.faceIndex] / 3) : h.faceIndex;
      if (t < 0 || t >= tris) continue;
      const cos = Math.abs(normals[3 * t] * ray.direction.x + normals[3 * t + 1] * ray.direction.y + normals[3 * t + 2] * ray.direction.z);
      if (cos < 0.12) continue;
      hits[t]++;
      if (h.distance < minDist[t]) minDist[t] = h.distance;
      flux[t] += (rw * Math.pow(cos, 1.35)) / (Math.max(h.distance, 0.75) * Math.max(areas[t], 0.04));
    }
  }

  // Smooth log-quantile normalization into `[0, 1]` using the 85th area-weighted percentile of seen triangles.
  const positive: [number, number][] = [];
  let seenArea = 0;
  for (let t = 0; t < tris; t++) {
    if (flux[t] > 0) {
      positive.push([flux[t], areas[t]]);
      seenArea += areas[t];
    }
  }
  positive.sort((p, q) => p[0] - q[0]);
  let acc = 0, refFlux = 1;
  for (const [f, w] of positive) {
    acc += w;
    if (acc >= 0.85 * seenArea) { refFlux = Math.max(1e-6, f); break; }
  }

  const rank = new Float32Array(tris);
  let highArea = 0;
  const kScale = 10;
  const denom = Math.log1p(kScale);
  for (let t = 0; t < tris; t++) {
    if (!(flux[t] > 0)) continue;
    const r = Math.min(1, Math.log1p((kScale * flux[t]) / refFlux) / denom);
    rank[t] = r;
    if (r >= 0.55) highArea += areas[t];
  }

  return {
    rank,
    hits,
    minDist,
    nodes: nav.nodes.length,
    poses: poses.length,
    seenShare: totalArea > 0 ? +(seenArea / totalArea).toFixed(4) : 0,
    highRankShare: totalArea > 0 ? +(highArea / totalArea).toFixed(4) : 0,
    seconds: +((performance.now() - t0) / 1000).toFixed(3),
  };
}

/** Exposure tier for strip grouping and island splitting: `0` unseen, `1` glimpsed, `2` walked context, `3` prime sightline. */
export function rankTier(r: number, lowCut = 0.28, highCut = 0.55): 0 | 1 | 2 | 3 {
  return !(r > 0) ? 0 : r < lowCut ? 1 : r < highCut ? 2 : 3;
}

/**
 * Split single-chart UV islands across player-exposure tiers (`0..3` from `rankTier`) and break hollow ring/frame
 * remnants (`uvTriArea / bboxArea < 0.48`) at their UV midpoint so welded architectural shells (such as Hall's walls +
 * roof) pack tightly without wasting atlas space on empty interior voids, while solid wall strips stay whole.
 */
export function splitUvByRank(position: ArrayLike<number>, uv: ArrayLike<number>, rank: ArrayLike<number>,
  lowCut = 0.28, highCut = 0.55): Float32Array {
  const tris = rank.length;
  const out = Float32Array.from(uv);
  let span = 2;
  for (let i = 0; i < out.length; i++) if (Number.isFinite(out[i])) span = Math.max(span, Math.abs(out[i]) + 2);
  for (let t = 0; t < tris; t++) {
    const tier = rankTier(rank[t], lowCut, highCut);
    if (tier === 3) continue;
    const shift = (3 - tier) * span;
    for (let c = 0; c < 3; c++) out[6 * t + 2 * c] += shift;
  }

  for (let pass = 0; pass < 2; pass++) {
    const { of, count } = uvIslands(position, out);
    const minU = new Float64Array(count).fill(Infinity), minV = new Float64Array(count).fill(Infinity);
    const maxU = new Float64Array(count).fill(-Infinity), maxV = new Float64Array(count).fill(-Infinity);
    const triArea = new Float64Array(count), cnt = new Int32Array(count);
    for (let t = 0; t < tris; t++) {
      const k = of[t], q = 6 * t;
      const u0 = out[q], v0 = out[q + 1], u1 = out[q + 2], v1 = out[q + 3], u2 = out[q + 4], v2 = out[q + 5];
      triArea[k] += Math.abs((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0)) * 0.5;
      cnt[k]++;
      minU[k] = Math.min(minU[k], u0, u1, u2); maxU[k] = Math.max(maxU[k], u0, u1, u2);
      minV[k] = Math.min(minV[k], v0, v1, v2); maxV[k] = Math.max(maxV[k], v0, v1, v2);
    }
    let nextShift = 0;
    for (let i = 0; i < out.length; i++) if (Number.isFinite(out[i])) nextShift = Math.max(nextShift, Math.abs(out[i]) + 2);
    const hollow = new Uint8Array(count);
    let any = false;
    for (let k = 0; k < count; k++) {
      if (cnt[k] < 4) continue;
      const box = (maxU[k] - minU[k]) * (maxV[k] - minV[k]);
      if (box > 1e-10 && triArea[k] / box < 0.48) { hollow[k] = 1; any = true; }
    }
    if (!any) break;
    for (let t = 0; t < tris; t++) {
      const k = of[t];
      if (!hollow[k]) continue;
      const q = 6 * t;
      const cu = (out[q] + out[q + 2] + out[q + 4]) / 3;
      const cv = (out[q + 1] + out[q + 3] + out[q + 5]) / 3;
      const midU = 0.5 * (minU[k] + maxU[k]), midV = 0.5 * (minV[k] + maxV[k]);
      const quad = (cu >= midU ? 1 : 0) + (cv >= midV ? 2 : 0);
      if (quad === 0) continue;
      for (let c = 0; c < 3; c++) out[q + 2 * c] += quad * nextShift;
    }
  }
  return out;
}

/**
 * Per-island layout scale from `playerImportance.rank`: unseen islands (`rank = 0`) get `unseenScale`, low-rank glimpsed
 * islands scale down toward `lowScale`, and prime walked sightlines (`rank -> 1`) grow up to `highScale`.
 */
export function pathLayoutScale(position: ArrayLike<number>, uv: ArrayLike<number>, rank: ArrayLike<number>,
  opts: { unseenScale?: number; lowScale?: number; highScale?: number } = {}): Float32Array {
  const unseenScale = opts.unseenScale ?? 0.3, lowScale = opts.lowScale ?? 0.42, highScale = opts.highScale ?? 1.42;
  const tris = Math.floor(position.length / 9);
  const { of, count } = uvIslands(position, uv);
  const sum = new Float64Array(count), area = new Float64Array(count), maxR = new Float32Array(count);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    const k = of[t];
    a.fromArray(position, 9 * t); b.fromArray(position, 9 * t + 3); c.fromArray(position, 9 * t + 6);
    const w = b.sub(a).cross(c.sub(a)).length() / 2 + 1e-12;
    sum[k] += w * rank[t];
    area[k] += w;
    if (rank[t] > maxR[k]) maxR[k] = rank[t];
  }
  const out = new Float32Array(tris);
  for (let t = 0; t < tris; t++) {
    const k = of[t];
    if (!(maxR[k] > 0)) { out[t] = unseenScale; continue; }
    const meanR = sum[k] / area[k];
    out[t] = lowScale + (highScale - lowScale) * Math.pow(meanR, 1.15);
  }
  return out;
}
