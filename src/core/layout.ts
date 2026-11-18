import * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';

/**
 * A texture layout weighted by what players can see. A level's own UVs usually give every face the same share of
 * the texture for its size: the underside of a crate as much as the wall beside the door. Here the triangles no
 * player can see are cut out into islands of their own and shrunk, and everything is packed again, so the faces
 * players look at get the texels. The seams this adds run between a face that is seen and one that isn't.
 *
 * The islands keep their shape and their size relative to each other, so a layout whose author gave the important
 * parts more room keeps that. Only translation and one scale per island change.
 */
export interface LayoutOptions {
  /** How much smaller (along each axis) the islands nobody sees are drawn. 0.3 leaves them 9% of their texels. */
  unseenScale: number;
  /** Gap between islands, as a share of the texture's width. */
  margin: number;
  /** The furthest a surface counts as seen from (m). */
  reach: number;
  /** Sample points on a triangle are at most this far apart (m). */
  step: number;
  /** Keep the file's layout unless the seen faces get at least this much denser along each axis. */
  minGain: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = { unseenScale: 0.3, margin: 0.003, reach: 60, step: 1.5, minGain: 1.1 };

/**
 * Which triangles a player can see: 1 where some point on the triangle has a clear line to some eye, not at a graze.
 * @param position world-space corners of non-indexed triangles (9 numbers each)
 * @param eyes where players' eyes can be
 */
export function seenTriangles(position: ArrayLike<number>, bvh: MeshBVH, eyes: THREE.Vector3[], opts: Partial<LayoutOptions> = {}): Uint8Array {
  const o = { ...DEFAULT_LAYOUT, ...opts };
  const tris = Math.floor(position.length / 9);
  const seen = new Uint8Array(tris);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), s = new THREE.Vector3(), centre = new THREE.Vector3();
  const ray = new THREE.Ray();
  const reach2 = o.reach * o.reach;
  for (let t = 0; t < tris; t++) {
    a.fromArray(position, 9 * t);
    b.fromArray(position, 9 * t + 3);
    c.fromArray(position, 9 * t + 6);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    n.crossVectors(ab, ac);
    if (n.lengthSq() < 1e-12) continue;   // no area: nothing to see
    n.normalize();
    centre.copy(a).add(b).add(c).divideScalar(3);
    const longest = Math.max(ab.length(), ac.length(), b.distanceTo(c));
    const size = longest / 2;
    // the eyes that could see it at all: near enough, and not looking along the face
    const near = eyes.filter((e) => {
      const d2 = e.distanceToSquared(centre);
      if (d2 > (o.reach + size) * (o.reach + size)) return false;
      return Math.abs(n.dot(s.subVectors(e, centre))) > 0.1 * Math.sqrt(d2) - size;
    }).sort((p, q) => p.distanceToSquared(centre) - q.distanceToSquared(centre));
    if (!near.length) continue;
    const k = THREE.MathUtils.clamp(Math.ceil(longest / o.step), 1, 8);
    search: for (let i = 0; i < k; i++) {
      for (let j = 0; i + j < k; j++) {
        s.copy(a).addScaledVector(ab, (i + 1 / 3) / k).addScaledVector(ac, (j + 1 / 3) / k);
        for (const e of near) {
          const d2 = e.distanceToSquared(s);
          if (d2 > reach2 || d2 < 0.01) continue;
          const dist = Math.sqrt(d2);
          ray.origin.copy(e);
          ray.direction.subVectors(s, e).divideScalar(dist);
          if (Math.abs(n.dot(ray.direction)) < 0.15) continue;              // at a graze
          const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
          if (!hit || hit.distance > dist - 0.05) { seen[t] = 1; break search; }
        }
      }
    }
  }
  return seen;
}

/**
 * Which texture cells a player can see: 1 where the cell's point on the level has a clear line to some eye, not
 * at a graze. The same test as `seenTriangles`, per cell of the texture rather than per triangle.
 * @param pos world position per cell (xyz + anything)
 * @param nrm world normal per cell (a = 0 where no triangle covers the cell)
 */
export function seenCells(pos: ArrayLike<number>, nrm: ArrayLike<number>, bvh: MeshBVH, eyes: THREE.Vector3[], opts: Partial<LayoutOptions> = {}): Uint8Array {
  const o = { ...DEFAULT_LAYOUT, ...opts };
  const n = pos.length / 4;
  const seen = new Uint8Array(n);
  const p = new THREE.Vector3(), normal = new THREE.Vector3();
  const ray = new THREE.Ray();
  const reach2 = o.reach * o.reach;
  for (let i = 0; i < n; i++) {
    if (nrm[4 * i + 3] < 0.5) continue;
    p.set(pos[4 * i], pos[4 * i + 1], pos[4 * i + 2]);
    normal.set(nrm[4 * i], nrm[4 * i + 1], nrm[4 * i + 2]);
    for (const e of eyes) {
      const d2 = e.distanceToSquared(p);
      if (d2 > reach2 || d2 < 0.01) continue;
      const dist = Math.sqrt(d2);
      ray.origin.copy(e);
      ray.direction.subVectors(p, e).divideScalar(dist);
      if (Math.abs(normal.dot(ray.direction)) < 0.15) continue;
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
      if (!hit || hit.distance > dist - 0.05) { seen[i] = 1; break; }
    }
  }
  return seen;
}

/**
 * UV islands: triangles that share a corner (same place on the level and in the texture) and are of the same class.
 * @param cls a class per triangle; triangles of different classes never share an island
 */
export function uvIslands(position: ArrayLike<number>, uv: ArrayLike<number>, cls?: ArrayLike<number>): { of: Int32Array; count: number } {
  const tris = Math.floor(position.length / 9);
  const parent = new Int32Array(tris);
  for (let t = 0; t < tris; t++) parent[t] = t;
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const first = new Map<string, number>();
  for (let t = 0; t < tris; t++) {
    for (let v = 0; v < 3; v++) {
      const p = 9 * t + 3 * v, q = 6 * t + 2 * v;
      const key = `${cls ? cls[t] : 0}|${Math.round(position[p] * 1e3)},${Math.round(position[p + 1] * 1e3)},${Math.round(position[p + 2] * 1e3)}|` +
        `${Math.round(uv[q] * 1e5)},${Math.round(uv[q + 1] * 1e5)}`;
      const other = first.get(key);
      if (other === undefined) first.set(key, t);
      else parent[find(t)] = find(other);
    }
  }
  const of = new Int32Array(tris);
  const ids = new Map<number, number>();
  for (let t = 0; t < tris; t++) {
    const r = find(t);
    if (!ids.has(r)) ids.set(r, ids.size);
    of[t] = ids.get(r)!;
  }
  return { of, count: ids.size };
}

/**
 * Pack boxes into a strip one unit wide, each as low as it will go and then as far left (a skyline packer).
 * Returns where each box's corner goes and the height used; a box wider than the strip makes the height Infinity.
 */
export function packBoxes(w: ArrayLike<number>, h: ArrayLike<number>): { x: Float32Array; y: Float32Array; height: number } {
  const n = w.length;
  const x = new Float32Array(n), y = new Float32Array(n);
  const order = Array.from({ length: n }, (_, i) => i).sort((p, q) => h[q] - h[p] || w[q] - w[p]);
  let sky: { x: number; w: number; y: number }[] = [{ x: 0, w: 1, y: 0 }];
  let height = 0;
  for (const i of order) {
    if (w[i] > 1 + 1e-9) return { x, y, height: Infinity };
    let bestY = Infinity, bestX = 0;
    for (let s = 0; s < sky.length; s++) {
      const x0 = sky[s].x;
      if (x0 + w[i] > 1 + 1e-9) break;
      let top = 0;
      for (let k = s; k < sky.length && sky[k].x < x0 + w[i] - 1e-9; k++) top = Math.max(top, sky[k].y);
      if (top < bestY - 1e-9) { bestY = top; bestX = x0; }
    }
    x[i] = bestX;
    y[i] = bestY;
    height = Math.max(height, bestY + h[i]);
    // the skyline with this box on it
    const x1 = bestX + w[i];
    const next: typeof sky = [];
    for (const s of sky) {
      const e = s.x + s.w;
      if (e <= bestX + 1e-9 || s.x >= x1 - 1e-9) { next.push(s); continue; }
      if (s.x < bestX) next.push({ x: s.x, w: bestX - s.x, y: s.y });
      if (e > x1) next.push({ x: x1, w: e - x1, y: s.y });
    }
    next.push({ x: bestX, w: w[i], y: bestY + h[i] });
    sky = next.sort((p, q) => p.x - q.x);
  }
  return { x, y, height };
}

export interface Layout {
  /** The new texture coordinates (2 per corner), or the file's own when the gain was too small to bother. */
  uv: Float32Array;
  applied: boolean;
  /** How much denser the seen faces are than in the file's layout, along each axis. */
  gain: number;
  /** Share of the level's surface, and of the file's texture, that players can see. */
  seenSurface: number;
  seenTexture: number;
  islands: number;
}

/**
 * The layout weighted by what is seen.
 * @param position world-space corners of non-indexed triangles
 * @param uv the file's texture coordinates, 2 per corner
 * @param seen 1 per triangle a player can see (`seenTriangles`)
 * @param opts.weight a further scale per triangle for the seen islands, as in `nearScaled`
 */
export function seenLayout(position: ArrayLike<number>, uv: ArrayLike<number>, seen: ArrayLike<number>,
  opts: Partial<LayoutOptions> & { weight?: ArrayLike<number> } = {}): Layout {
  const o = { ...DEFAULT_LAYOUT, ...opts };
  const tris = Math.floor(position.length / 9);
  const { of, count } = uvIslands(position, uv, seen);
  const minU = new Float32Array(count).fill(Infinity), minV = new Float32Array(count).fill(Infinity);
  const maxU = new Float32Array(count).fill(-Infinity), maxV = new Float32Array(count).fill(-Infinity);
  const scale = new Float32Array(count);
  let surface = 0, surfaceSeen = 0, texture = 0, textureSeen = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    const k = of[t];
    scale[k] = seen[t] ? 1 : o.unseenScale;
    for (let v = 0; v < 3; v++) {
      const u = uv[6 * t + 2 * v], w = uv[6 * t + 2 * v + 1];
      minU[k] = Math.min(minU[k], u); maxU[k] = Math.max(maxU[k], u);
      minV[k] = Math.min(minV[k], w); maxV[k] = Math.max(maxV[k], w);
    }
    a.fromArray(position, 9 * t); b.fromArray(position, 9 * t + 3); c.fromArray(position, 9 * t + 6);
    const world = b.sub(a).cross(c.sub(a)).length() / 2;
    const q = 6 * t;
    const tex = Math.abs((uv[q + 2] - uv[q]) * (uv[q + 5] - uv[q + 1]) - (uv[q + 4] - uv[q]) * (uv[q + 3] - uv[q + 1])) / 2;
    surface += world; texture += tex;
    if (seen[t]) { surfaceSeen += world; textureSeen += tex; }
  }
  const seenIsland = new Float32Array(count);
  for (let t = 0; t < tris; t++) if (seen[t]) seenIsland[of[t]] = 1;
  applyWeight(scale, of, opts.weight, seenIsland);
  const bw = new Float32Array(count), bh = new Float32Array(count);
  let area = 0;
  for (let k = 0; k < count; k++) {
    bw[k] = (maxU[k] - minU[k]) * scale[k];
    bh[k] = (maxV[k] - minV[k]) * scale[k];
    area += (bw[k] + o.margin) * (bh[k] + o.margin);
  }
  // The largest overall scale at which every island still fits in the square.
  const w = new Float32Array(count), h = new Float32Array(count);
  const tryAt = (g: number) => {
    for (let k = 0; k < count; k++) { w[k] = bw[k] * g + o.margin; h[k] = bh[k] * g + o.margin; }
    return packBoxes(w, h);
  };
  let lo = 0, hi = area > 0 ? 2 / Math.sqrt(area) : 1;
  let best: ReturnType<typeof packBoxes> | undefined;
  for (let i = 0; i < 28; i++) {
    const g = i === 0 ? hi / 16 : (lo + hi) / 2;
    const p = tryAt(g);
    if (p.height <= 1) { lo = g; best = { x: p.x.slice(), y: p.y.slice(), height: p.height }; } else hi = g;
    if (i === 0 && !best) break;   // doesn't fit even tiny: margins alone fill the square
  }
  const seenSurface = surface ? surfaceSeen / surface : 0, seenTexture = texture ? textureSeen / texture : 0;
  if (!best || lo < o.minGain) return { uv: Float32Array.from(uv), applied: false, gain: best ? lo : 0, seenSurface, seenTexture, islands: count };
  const out = new Float32Array(tris * 6);
  for (let t = 0; t < tris; t++) {
    const k = of[t], s = scale[k] * lo;
    for (let v = 0; v < 3; v++) {
      const q = 6 * t + 2 * v;
      out[q] = best.x[k] + o.margin / 2 + (uv[q] - minU[k]) * s;
      out[q + 1] = best.y[k] + o.margin / 2 + (uv[q + 1] - minV[k]) * s;
    }
  }
  return { uv: out, applied: true, gain: lo, seenSurface, seenTexture, islands: count };
}

/** Multiply each island's scale by the lowest weight of its triangles, on the islands where `on` is 1. */
function applyWeight(scale: Float32Array, of: Int32Array, weight: ArrayLike<number> | undefined, on: ArrayLike<number>) {
  if (!weight) return;
  const w = new Float32Array(scale.length).fill(Infinity);
  for (let t = 0; t < of.length; t++) w[of[t]] = Math.min(w[of[t]], weight[t]);
  for (let k = 0; k < scale.length; k++) if (on[k] && Number.isFinite(w[k])) scale[k] *= w[k];
}

/**
 * How near a player's eye gets to each triangle with a clear line to it (m): the distance from the nearest of
 * `eyes` that sees some point of it, not at a graze. Infinity where none does. The same test as `seenTriangles`.
 */
export function seenDistance(position: ArrayLike<number>, bvh: MeshBVH, eyes: THREE.Vector3[], opts: Partial<LayoutOptions> = {}): Float32Array {
  const o = { ...DEFAULT_LAYOUT, ...opts };
  const tris = Math.floor(position.length / 9);
  const out = new Float32Array(tris).fill(Infinity);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), s = new THREE.Vector3(), centre = new THREE.Vector3();
  const ray = new THREE.Ray();
  for (let t = 0; t < tris; t++) {
    a.fromArray(position, 9 * t);
    b.fromArray(position, 9 * t + 3);
    c.fromArray(position, 9 * t + 6);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    n.crossVectors(ab, ac);
    if (n.lengthSq() < 1e-12) continue;
    n.normalize();
    centre.copy(a).add(b).add(c).divideScalar(3);
    const longest = Math.max(ab.length(), ac.length(), b.distanceTo(c));
    const near = eyes.filter((e) => e.distanceToSquared(centre) <= (o.reach + longest) * (o.reach + longest))
      .sort((p, q) => p.distanceToSquared(centre) - q.distanceToSquared(centre));
    const k = THREE.MathUtils.clamp(Math.ceil(longest / o.step), 1, 8);
    let best = Infinity;
    for (let i = 0; i < k; i++) {
      for (let j = 0; i + j < k; j++) {
        s.copy(a).addScaledVector(ab, (i + 1 / 3) / k).addScaledVector(ac, (j + 1 / 3) / k);
        for (const e of near) {
          const dist = e.distanceTo(s);
          if (dist >= best || dist > o.reach || dist < 0.1) continue;
          ray.origin.copy(e);
          ray.direction.subVectors(s, e).divideScalar(dist);
          if (Math.abs(n.dot(ray.direction)) < 0.15) continue;              // at a graze
          const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
          if (!hit || hit.distance > dist - 0.05) best = dist;
        }
      }
    }
    out[t] = best;
  }
  return out;
}

export interface StripLayout {
  /** Texture coordinates with the joined faces laid out as one island each; not packed (islands may overlap). */
  uv: Float32Array;
  /** Islands before, and after joining. */
  before: number;
  islands: number;
  /** How many strips were made, and how many of the old islands went into them. */
  strips: number;
  joined: number;
}

/**
 * Faces joined into strips. A level's own layout often has every flat face as an island of its own: the four sides
 * of a window bar are four slivers, each with its own gap round it, and in a level built of boxes the gaps come to
 * a sixth of the texture. Here a rectangular face is joined to the face it shares a whole edge with, and that one
 * to the next, the way a box's sides unfold into one band: the strip is a rectangle again, nothing is stretched
 * (each face keeps its size), and the faces meet in the texture as they meet on the level. Only faces of the same
 * part and the same scale are joined, and no strip grows past `maxSize`.
 * @param position world-space corners of non-indexed triangles
 * @param uv the layout to start from, 2 per corner
 * @param part a part per triangle (optional)
 * @param maxSize the longest a strip may get, in the layout's units; by default as long as its longest island is now
 */
export function stripLayout(position: ArrayLike<number>, uv: ArrayLike<number>, part?: ArrayLike<number>, maxSize?: number): StripLayout {
  const tris = Math.floor(position.length / 9);
  const { of, count } = uvIslands(position, uv);
  const members: number[][] = Array.from({ length: count }, () => []);
  for (let t = 0; t < tris; t++) members[of[t]].push(t);
  interface Rect { corners: THREE.Vector3[]; w: number; h: number; scale: number; part: number; minU: number; minV: number }
  const P = (i: number) => new THREE.Vector3(position[i], position[i + 1], position[i + 2]);
  let longest = 0;
  // an island that is one flat rectangle, drawn to scale: its corners on the level
  const rectOf = (list: number[]): Rect | undefined => {
    let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity, area = 0, big = -1, bigArea = 0;
    for (const t of list) {
      const q = 6 * t;
      for (let v = 0; v < 3; v++) {
        minU = Math.min(minU, uv[q + 2 * v]); maxU = Math.max(maxU, uv[q + 2 * v]);
        minV = Math.min(minV, uv[q + 2 * v + 1]); maxV = Math.max(maxV, uv[q + 2 * v + 1]);
      }
      const a = Math.abs((uv[q + 2] - uv[q]) * (uv[q + 5] - uv[q + 1]) - (uv[q + 4] - uv[q]) * (uv[q + 3] - uv[q + 1])) / 2;
      area += a;
      if (a > bigArea) { bigArea = a; big = t; }
    }
    const bw = maxU - minU, bh = maxV - minV;
    longest = Math.max(longest, bw, bh);
    if (big < 0 || bw <= 0 || bh <= 0 || area < 0.998 * bw * bh) return undefined;
    // where a place in the texture is on the level, from its largest triangle
    const q = 6 * big, A = P(9 * big), AB = P(9 * big + 3).sub(A), AC = P(9 * big + 6).sub(A);
    const du1 = uv[q + 2] - uv[q], dv1 = uv[q + 3] - uv[q + 1], du2 = uv[q + 4] - uv[q], dv2 = uv[q + 5] - uv[q + 1];
    const det = du1 * dv2 - dv1 * du2;
    if (Math.abs(det) < 1e-14) return undefined;
    const Du = AB.clone().multiplyScalar(dv2 / det).addScaledVector(AC, -dv1 / det);
    const Dv = AC.clone().multiplyScalar(du1 / det).addScaledVector(AB, -du2 / det);
    const lu = Du.length(), lv = Dv.length();
    if (!(lu > 0) || Math.abs(lu - lv) > 0.02 * Math.max(lu, lv) || Math.abs(Du.dot(Dv)) > 0.02 * lu * lv) return undefined;   // stretched or sheared
    const at = (u: number, v: number) => A.clone().addScaledVector(Du, u - uv[q]).addScaledVector(Dv, v - uv[q + 1]);
    // every corner of the island lies where that says: one plane, one scale
    for (const t of list) {
      for (let v = 0; v < 3; v++) {
        if (at(uv[6 * t + 2 * v], uv[6 * t + 2 * v + 1]).distanceTo(P(9 * t + 3 * v)) > 0.002) return undefined;
      }
    }
    return { corners: [at(minU, minV), at(maxU, minV), at(maxU, maxV), at(minU, maxV)], w: bw * lu, h: bh * lv, scale: 1 / lu,
      part: part ? part[list[0]] : 0, minU, minV };
  };
  const rects = members.map(rectOf);
  const cap = maxSize ?? longest;
  // which rectangles have an edge between the same two points
  const point = (p: THREE.Vector3) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)},${Math.round(p.z * 1000)}`;
  const edgeKey = (r: Rect, j: number) => { const a = point(r.corners[j]), b = point(r.corners[(j + 1) % 4]); return a < b ? `${a}|${b}` : `${b}|${a}`; };
  const edges = new Map<string, { k: number; j: number }[]>();
  rects.forEach((r, k) => {
    if (!r) return;
    for (let j = 0; j < 4; j++) { const key = edgeKey(r, j); const l = edges.get(key); if (l) l.push({ k, j }); else edges.set(key, [{ k, j }]); }
  });
  const used = new Uint8Array(count);
  const across = (r: Rect, inEdge: number) => (inEdge % 2 === 0 ? r.h : r.w);   // edges 0 and 2 run along its width
  const out = Float32Array.from(uv);
  let strips = 0, joined = 0;
  const order = [...rects.keys()].filter((k) => rects[k]).sort((p, q) => Math.max(rects[q]!.w, rects[q]!.h) - Math.max(rects[p]!.w, rects[p]!.h));
  for (const seed of order) {
    if (used[seed]) continue;
    const r0 = rects[seed]!;
    // through its longer edges first: that saves the most gap
    for (const exit of r0.w >= r0.h ? [2, 1] : [1, 2]) {
      const strip: { k: number; in: number }[] = [{ k: seed, in: (exit + 2) % 4 }];
      const inStrip = new Set([seed]);
      let extent = across(r0, strip[0].in);
      const neighbour = (k: number, j: number) => (edges.get(edgeKey(rects[k]!, j)) ?? []).find((c) => c.k !== k && !used[c.k] && !inStrip.has(c.k)
        && rects[c.k]!.part === r0.part && Math.abs(rects[c.k]!.scale - r0.scale) <= 0.02 * r0.scale);
      for (;;) {   // onwards from the last face's far edge
        const last = strip[strip.length - 1];
        const c = neighbour(last.k, (last.in + 2) % 4);
        if (!c || (extent + across(rects[c.k]!, c.j)) * r0.scale > cap) break;
        extent += across(rects[c.k]!, c.j);
        strip.push({ k: c.k, in: c.j });
        inStrip.add(c.k);
      }
      for (;;) {   // and back from the first face's near edge
        const first = strip[0];
        const c = neighbour(first.k, first.in);
        if (!c || (extent + across(rects[c.k]!, c.j)) * r0.scale > cap) break;
        extent += across(rects[c.k]!, c.j);
        strip.unshift({ k: c.k, in: (c.j + 2) % 4 });
        inStrip.add(c.k);
      }
      if (strip.length < 2) continue;
      // lay the faces out one after the other: along the shared edges, and across them
      let from: THREE.Vector3 | undefined, offset = 0;
      for (const e of strip) {
        const r = rects[e.k]!, C = r.corners, j = e.in;
        let Ea = C[j], Eb = C[(j + 1) % 4], Fa = C[(j + 3) % 4];
        if (from && Ea.distanceTo(from) > 0.002) { Ea = C[(j + 1) % 4]; Eb = C[j]; Fa = C[(j + 2) % 4]; }
        const along = Eb.clone().sub(Ea).normalize(), over = Fa.clone().sub(Ea), depth = over.length();
        over.divideScalar(depth);
        for (const t of members[e.k]) {
          for (let v = 0; v < 3; v++) {
            const d = P(9 * t + 3 * v).sub(Ea);
            out[6 * t + 2 * v] = r0.minU + d.dot(along) * r0.scale;
            out[6 * t + 2 * v + 1] = r0.minV + (offset + d.dot(over)) * r0.scale;
          }
        }
        offset += depth;
        from = Fa;
        used[e.k] = 1;
      }
      strips++;
      joined += strip.length;
      break;
    }
  }
  return { uv: out, before: count, islands: count - joined + strips, strips, joined };
}

/**
 * Each island drawn at the size its nearest onlooker needs. A face a player can walk up to needs every texel; a
 * ceiling six metres over their head shows half as many across, however sharp it is. An island keeps its full size
 * when some eye gets within `near` metres of it, and from there shrinks as that distance grows, down to `farScale`;
 * islands no eye sees are drawn at `unseenScale`. Not packed: the islands keep their corners where they were.
 * @param dist how near an eye gets to each triangle (`seenDistance`)
 * @param opts.weight a further scale per triangle for the islands players see (the lowest of an island's
 *   triangles counts), such as `cavityScale` (core/surface-weights.ts): enclosed islands drawn smaller
 */
export function nearScaled(position: ArrayLike<number>, uv: ArrayLike<number>, dist: ArrayLike<number>,
  opts: { near?: number; farScale?: number; unseenScale?: number; weight?: ArrayLike<number> } = {}): { uv: Float32Array; islands: number; full: number; unseen: number } {
  const near = opts.near ?? 3, farScale = opts.farScale ?? 0.3, unseenScale = opts.unseenScale ?? DEFAULT_LAYOUT.unseenScale;
  const tris = Math.floor(position.length / 9);
  const { of, count } = uvIslands(position, uv);
  const d = new Float32Array(count).fill(Infinity), minU = new Float32Array(count).fill(Infinity), minV = new Float32Array(count).fill(Infinity);
  for (let t = 0; t < tris; t++) {
    const k = of[t];
    d[k] = Math.min(d[k], dist[t]);
    for (let v = 0; v < 3; v++) { minU[k] = Math.min(minU[k], uv[6 * t + 2 * v]); minV[k] = Math.min(minV[k], uv[6 * t + 2 * v + 1]); }
  }
  const scale = Float32Array.from(d, (x) => (Number.isFinite(x) ? Math.min(1, Math.max(farScale, near / x)) : unseenScale));
  applyWeight(scale, of, opts.weight, Float32Array.from(d, (x) => (Number.isFinite(x) ? 1 : 0)));
  const out = new Float32Array(tris * 6);
  for (let t = 0; t < tris; t++) {
    const k = of[t];
    for (let v = 0; v < 3; v++) {
      out[6 * t + 2 * v] = minU[k] + (uv[6 * t + 2 * v] - minU[k]) * scale[k];
      out[6 * t + 2 * v + 1] = minV[k] + (uv[6 * t + 2 * v + 1] - minV[k]) * scale[k];
    }
  }
  let full = 0, unseen = 0;
  for (let k = 0; k < count; k++) { if (scale[k] >= 1) full++; if (!Number.isFinite(d[k])) unseen++; }
  return { uv: out, islands: count, full, unseen };
}

/** The share of the level's surface, and of a layout's texture, on triangles some eye sees (`dist` from `seenDistance`). */
export function seenShare(position: ArrayLike<number>, uv: ArrayLike<number>, dist: ArrayLike<number>): { surface: number; texture: number } {
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let surface = 0, surfaceSeen = 0, texture = 0, textureSeen = 0;
  for (let t = 0; t < dist.length; t++) {
    a.fromArray(position, 9 * t); b.fromArray(position, 9 * t + 3); c.fromArray(position, 9 * t + 6);
    const world = b.sub(a).cross(c.sub(a)).length() / 2;
    const q = 6 * t;
    const tex = Math.abs((uv[q + 2] - uv[q]) * (uv[q + 5] - uv[q + 1]) - (uv[q + 4] - uv[q]) * (uv[q + 3] - uv[q + 1])) / 2;
    surface += world; texture += tex;
    if (Number.isFinite(dist[t])) { surfaceSeen += world; textureSeen += tex; }
  }
  return { surface: surface ? surfaceSeen / surface : 0, texture: texture ? textureSeen / texture : 0 };
}

export interface CutIslands {
  /** The level's triangles again, the cut faces as more of them: corners (3 numbers), normals (3), texture coordinates (2), and a label a corner. */
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  label: Float32Array;
  /** Optional per-corner importance weight carried alongside `label`. */
  weight?: Float32Array;
  /** A class per triangle: the piece it belongs to. Pieces of one face meet in the texture, but are islands of their own. */
  cls: Int32Array;
  /** Islands that were cut, and the pieces they are now. */
  cut: number;
  pieces: number;
  /** The longest an island may be, in the layout's units. */
  limit: number;
}

/**
 * Islands too long for a page, cut into pieces. However many pages a texture has, no island can be drawn larger
 * than one of them: a hall's floor in one piece sets the scale for every bench and bar. Here an island longer than
 * `limit` is cut into equal pieces along straight lines of the texture, each piece an island of its own. A face
 * the line crosses is cut in two there, so the level gets a few more triangles; the surface they make is the same.
 * Both sides of a cut are painted from the same views, each with its gap filled from its own edge, so the cut does
 * not show: it is the same kind of edge a wall has where a window divides it.
 * @param position world-space corners of non-indexed triangles, with `normal`, `uv` (2 a corner) and `label` (1 a corner)
 * @param limit the longest an island may be along either axis, in the layout's units
 */
export function cutIslands(position: ArrayLike<number>, normal: ArrayLike<number>, uv: ArrayLike<number>, label: ArrayLike<number>,
  limit: number, weight?: ArrayLike<number>): CutIslands {
  const tris = Math.floor(position.length / 9);
  const { of, count } = uvIslands(position, uv);
  const minU = new Float64Array(count).fill(Infinity), minV = new Float64Array(count).fill(Infinity);
  const maxU = new Float64Array(count).fill(-Infinity), maxV = new Float64Array(count).fill(-Infinity);
  for (let t = 0; t < tris; t++) {
    const k = of[t];
    for (let v = 0; v < 3; v++) {
      const u = uv[6 * t + 2 * v], w = uv[6 * t + 2 * v + 1];
      minU[k] = Math.min(minU[k], u); maxU[k] = Math.max(maxU[k], u);
      minV[k] = Math.min(minV[k], w); maxV[k] = Math.max(maxV[k], w);
    }
  }
  const nx = new Int32Array(count), ny = new Int32Array(count), base = new Int32Array(count);
  let classes = 0, cut = 0, pieces = 0;
  for (let k = 0; k < count; k++) {
    nx[k] = Math.max(1, Math.ceil((maxU[k] - minU[k]) / limit - 1e-6));
    ny[k] = Math.max(1, Math.ceil((maxV[k] - minV[k]) / limit - 1e-6));
    base[k] = classes;
    classes += nx[k] * ny[k];
    if (nx[k] * ny[k] > 1) { cut++; pieces += nx[k] * ny[k]; }
  }
  const P: number[] = [], N: number[] = [], U: number[] = [], L: number[] = [], W: number[] = [], C: number[] = [];
  // a corner: u, v, then its place and its normal
  type Corner = number[];
  const corner = (t: number, v: number): Corner => [uv[6 * t + 2 * v], uv[6 * t + 2 * v + 1],
    position[9 * t + 3 * v], position[9 * t + 3 * v + 1], position[9 * t + 3 * v + 2], normal[9 * t + 3 * v], normal[9 * t + 3 * v + 1], normal[9 * t + 3 * v + 2]];
  const push = (a: Corner, b: Corner, c: Corner, l: number, w: number, cl: number) => {
    for (const x of [a, b, c]) { U.push(x[0], x[1]); P.push(x[2], x[3], x[4]); N.push(x[5], x[6], x[7]); L.push(l); if (weight) W.push(w); }
    C.push(cl);
  };
  // what of a polygon lies on one side of a line of the texture (axis 0: u, 1: v)
  const clip = (poly: Corner[], axis: number, at: number, keepBelow: boolean): Corner[] => {
    const out: Corner[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const da = keepBelow ? at - a[axis] : a[axis] - at, db = keepBelow ? at - b[axis] : b[axis] - at;
      if (da >= 0) out.push(a);
      if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
        const f = da / (da - db);
        const x = a.map((v, j) => v + (b[j] - v) * f);
        x[axis] = at;   // exactly on the line, for both pieces
        out.push(x);
      }
    }
    return out;
  };
  for (let t = 0; t < tris; t++) {
    const k = of[t], l = label[3 * t], w = weight ? weight[3 * t] : 1;
    const tri = [corner(t, 0), corner(t, 1), corner(t, 2)];
    if (nx[k] * ny[k] === 1) { push(tri[0], tri[1], tri[2], l, w, base[k]); continue; }
    const cw = (maxU[k] - minU[k]) / nx[k], ch = (maxV[k] - minV[k]) / ny[k];
    const cell = (x: number, lo: number, size: number, n: number) => Math.min(n - 1, Math.max(0, Math.floor((x - lo) / size + 1e-9)));
    const i0 = cell(Math.min(tri[0][0], tri[1][0], tri[2][0]), minU[k], cw, nx[k]), i1 = cell(Math.max(tri[0][0], tri[1][0], tri[2][0]) - 1e-12, minU[k], cw, nx[k]);
    const j0 = cell(Math.min(tri[0][1], tri[1][1], tri[2][1]), minV[k], ch, ny[k]), j1 = cell(Math.max(tri[0][1], tri[1][1], tri[2][1]) - 1e-12, minV[k], ch, ny[k]);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        let poly: Corner[] = tri;
        if (i > 0) poly = clip(poly, 0, minU[k] + i * cw, false);
        if (i < nx[k] - 1) poly = clip(poly, 0, minU[k] + (i + 1) * cw, true);
        if (j > 0) poly = clip(poly, 1, minV[k] + j * ch, false);
        if (j < ny[k] - 1) poly = clip(poly, 1, minV[k] + (j + 1) * ch, true);
        for (let q = 1; q + 1 < poly.length; q++) {
          const a = poly[0], b = poly[q], c = poly[q + 1];
          if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) < 1e-14) continue;   // a sliver with no area
          push(a, b, c, l, w, base[k] + j * nx[k] + i);
        }
      }
    }
  }
  return { position: Float32Array.from(P), normal: Float32Array.from(N), uv: Float32Array.from(U), label: Float32Array.from(L),
    ...(weight ? { weight: Float32Array.from(W) } : {}), cls: Int32Array.from(C), cut, pieces, limit };
}

/**
 * The longest an island should be for `pagedLayout` over `grid` x `grid` pages: `share` of a page's side, at the
 * scale the islands would be drawn at if they filled the pages. Islands longer than this are worth cutting.
 */
export function islandLimit(position: ArrayLike<number>, uv: ArrayLike<number>, grid: number, share = 0.5): number {
  const tris = Math.floor(position.length / 9);
  const { of, count } = uvIslands(position, uv);
  const box = new Float64Array(count * 4);
  for (let k = 0; k < count; k++) { box[4 * k] = box[4 * k + 1] = Infinity; box[4 * k + 2] = box[4 * k + 3] = -Infinity; }
  for (let t = 0; t < tris; t++) {
    const k = of[t];
    for (let v = 0; v < 3; v++) {
      const u = uv[6 * t + 2 * v], w = uv[6 * t + 2 * v + 1];
      box[4 * k] = Math.min(box[4 * k], u); box[4 * k + 1] = Math.min(box[4 * k + 1], w);
      box[4 * k + 2] = Math.max(box[4 * k + 2], u); box[4 * k + 3] = Math.max(box[4 * k + 3], w);
    }
  }
  let area = 0;
  for (let k = 0; k < count; k++) area += (box[4 * k + 2] - box[4 * k]) * (box[4 * k + 3] - box[4 * k + 1]);
  return area > 0 ? share * Math.sqrt(area / (grid * grid)) : Infinity;
}

export interface PagedLayout {
  /** Texture coordinates over the whole grid of pages (2 per corner, 0-1 across all pages together). */
  uv: Float32Array;
  /** Pages along each side. */
  grid: number;
  /** How many times larger each island is drawn on its page than it was in the one texture, along each axis. */
  gain: number;
  islands: number;
  /** The share of each page its islands' boxes take (row by row). */
  fill: number[];
}

/**
 * The layout over several textures: a grid of `grid` x `grid` pages that together are the level's one texture space.
 * The islands keep their shape and their size relative to each other and are all drawn at one scale, so every page
 * has the same texel density; each island lies wholly on one page, with the usual gap round it, so no page's edge
 * runs through a face and nothing has to match up across two textures. A part's islands go to the same page where
 * that leaves the pages evenly filled.
 * @param position world-space corners of non-indexed triangles
 * @param uv the layout to start from, 2 per corner (the file's, or `seenLayout`'s)
 * @param group a part per triangle, to keep together (optional)
 * @param margin gap between islands, as a share of a page's width
 * @param cls a class per triangle: triangles of different classes are different islands even where they meet
 *   (the pieces `cutIslands` makes of a face)
 */
export function pagedLayout(position: ArrayLike<number>, uv: ArrayLike<number>, grid: number, group?: ArrayLike<number>,
  margin = DEFAULT_LAYOUT.margin, cls?: ArrayLike<number>): PagedLayout {
  const tris = Math.floor(position.length / 9), pages = grid * grid;
  const { of, count } = uvIslands(position, uv, cls);
  const minU = new Float32Array(count).fill(Infinity), minV = new Float32Array(count).fill(Infinity);
  const maxU = new Float32Array(count).fill(-Infinity), maxV = new Float32Array(count).fill(-Infinity);
  const part = new Int32Array(count).fill(-1);
  for (let t = 0; t < tris; t++) {
    const k = of[t];
    if (part[k] < 0) part[k] = group ? group[t] : 0;
    for (let v = 0; v < 3; v++) {
      const u = uv[6 * t + 2 * v], w = uv[6 * t + 2 * v + 1];
      minU[k] = Math.min(minU[k], u); maxU[k] = Math.max(maxU[k], u);
      minV[k] = Math.min(minV[k], w); maxV[k] = Math.max(maxV[k], w);
    }
  }
  const bw = new Float32Array(count), bh = new Float32Array(count), area = new Float32Array(count);
  let total = 0;
  for (let k = 0; k < count; k++) {
    bw[k] = maxU[k] - minU[k];
    bh[k] = maxV[k] - minV[k];
    area[k] = bw[k] * bh[k];
    total += area[k];
  }
  // Which page each island goes to: the emptiest so far. A part that is small beside a page goes as a whole.
  const page = new Int32Array(count), load = new Float64Array(pages);
  const emptiest = () => { let b = 0; for (let p = 1; p < pages; p++) if (load[p] < load[b]) b = p; return b; };
  const byPart = new Map<number, number[]>();
  for (let k = 0; k < count; k++) { const l = byPart.get(part[k]); if (l) l.push(k); else byPart.set(part[k], [k]); }
  const sum = (l: number[]) => l.reduce((s, k) => s + area[k], 0);
  const parts = [...byPart.values()].sort((p, q) => sum(q) - sum(p));
  const share = total / pages;
  for (const l of parts) {
    if (sum(l) <= 0.25 * share) {
      const p = emptiest();
      for (const k of l) { page[k] = p; load[p] += area[k]; }
    } else {
      for (const k of l.sort((p, q) => area[q] - area[p])) { const p = emptiest(); page[k] = p; load[p] += area[k]; }
    }
  }
  const lists: number[][] = Array.from({ length: pages }, () => []);
  for (let k = 0; k < count; k++) lists[page[k]].push(k);
  // The largest scale at which every page's islands fit their square.
  const packAt = (g: number) => lists.map((l) => packBoxes(l.map((k) => bw[k] * g + margin), l.map((k) => bh[k] * g + margin)));
  let lo = 0, hi = total > 0 ? 2 / Math.sqrt(total / pages) : 1;
  let best: ReturnType<typeof packAt> | undefined;
  for (let i = 0; i < 30; i++) {
    const g = i === 0 ? hi / 64 : (lo + hi) / 2;
    const p = packAt(g);
    if (p.every((b) => b.height <= 1)) { lo = g; best = p; } else hi = g;
    if (i === 0 && !best) break;
  }
  if (!best) throw new Error(`the level's ${count} texture islands do not fit ${pages} pages: their margins alone fill them`);
  const x = new Float32Array(count), y = new Float32Array(count);
  lists.forEach((l, p) => l.forEach((k, i) => { x[k] = best![p].x[i]; y[k] = best![p].y[i]; }));
  const out = new Float32Array(tris * 6);
  for (let t = 0; t < tris; t++) {
    const k = of[t], px = page[k] % grid, py = Math.floor(page[k] / grid);
    for (let v = 0; v < 3; v++) {
      const q = 6 * t + 2 * v;
      out[q] = (px + x[k] + margin / 2 + (uv[q] - minU[k]) * lo) / grid;
      out[q + 1] = (py + y[k] + margin / 2 + (uv[q + 1] - minV[k]) * lo) / grid;
    }
  }
  return { uv: out, grid, gain: lo, islands: count, fill: Array.from(load, (a) => a * lo * lo) };
}

/** A short fingerprint of a set of texture coordinates, to tell whether maps saved with a run fit the layout loaded. */
export function layoutHash(uv: ArrayLike<number>): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < uv.length; i++) {
    hash ^= Math.round(uv[i] * 4096) & 0xffff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
