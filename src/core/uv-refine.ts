import * as THREE from 'three';
import { PAINTED, UV_REFINE_QUALITY } from './atlas';
import { sunDirection } from './clay';
import type { Engine } from './engine';
import { bitmapToRGBA, toDataUrl } from './image';
import { playerImportance } from './player-paths';
import { cellWeights, surfaceWeights } from './surface-weights';
import { MODELS, priceOf } from '../providers/models';
import { routeEdit, type ProviderOptions } from '../providers/router';

/**
 * UV-space coarse-to-fine atlas refinement (TODO item 4, Paint3D-style):
 * 1. Position/normal-conditioned 3D-seam-aware UV inpainting (`buildUvSeamGraph`, `uvInpaint`): bridges disjoint UV
 *    islands whose borders meet in 3D world space, propagates smooth harmonic albedo across intra-island and cross-seam
 *    neighbours weighted by 3D distance and normal agreement, and transfers world-anchored exemplar micro-grain (plus
 *    optional model-backed UV tile inpainting routed via `routeEdit` local/cloud).
 * 2. Importance-gated intrinsic delighting & HD detail sharpening (`bakedShadingScore`, `uvDelightAndSharpen`): regresses
 *    and removes baked directional sun/sky shading and low-frequency illumination drift per semantic part using the
 *    normal/position atlases so exported textures relight cleanly, and applies bilateral normal-preserving detail
 *    sharpening gated by combined surface & player-path importance (items 6 & 7).
 */

export interface BakedShadingScore {
  /** Area-weighted within-part `|r|` correlation between log-luminance and scene directional + sky irradiance (`0` = lighting-free). */
  correlation: number;
  /** Mean relative luminance spread `|Y_lit - Y_shaded| / Y_mean` across differently oriented faces of the same part. */
  directionalSpread: number;
}

export interface UvSeamGraph {
  size: number;
  covered: Uint8Array;
  part: Int16Array;
  medianStep: number;
  /** Flat CSR neighbour lists (intra-island 4-neighbours + cross-seam 3D world-space bridges). */
  offsets: Int32Array;
  neighbours: Int32Array;
  weights: Float32Array;
  crossSeamLinks: number;
}

export interface UvRefineOptions {
  /** Working UV grid resolution (power of two, default `min(1024, atlas.size)`). */
  size?: number;
  /** Strength of intrinsic directional + Retinex baked-lighting removal in `[0, 1]` (default 0.85). */
  delight?: number;
  /** Strength of importance-gated normal-preserving micro-detail sharpening (default 0.45). */
  sharpen?: number;
  /** Combined importance threshold `[0, 1.5]` below which HD sharpening and model tiles are skipped (default 0.35). */
  importanceGate?: number;
  /** Optional count of UV-space image-model refinement tiles on high-importance pockets (`0` by default = $0 instant). */
  modelTiles?: number;
  /** Model key for optional UV-space model tiles (default `'local-comfy-mv'` when local, else `'flux3-klein'`). */
  model?: string;
  /** Style description for optional UV-space model tiles. */
  style?: string;
  /** Per-call provider override for optional model tiles. */
  provider?: ProviderOptions;
}

export interface UvRefineResult {
  size: number;
  /** Unpainted share of covered island texels before and after UV refinement (without `finish.ts`). */
  unpaintedBefore: number;
  unpaintedAfter: number;
  crossSeamLinks: number;
  bakedShadingBefore: BakedShadingScore;
  bakedShadingAfter: BakedShadingScore;
  highImportanceShare: number;
  refinedTiles: number;
  skippedLowImportanceTiles: number;
  cost: number;
  seconds: number;
}

/**
 * Build a 3D-seam-aware UV adjacency graph from `Atlas.texelGeometry(size)`: links continuous 4-neighbours on an island
 * plus disjoint UV island perimeter texels that meet at the same 3D seam (`||p_i - p_j|| <= 2.4 * medianStep`,
 * `dot(n_i, n_j) >= 0.55`, same part).
 */
export function buildUvSeamGraph(pos: ArrayLike<number>, nrm: ArrayLike<number>, size: number): UvSeamGraph {
  const N = size * size;
  const covered = new Uint8Array(N);
  const part = new Int16Array(N).fill(-1);
  const steps: number[] = [];

  for (let i = 0; i < N; i++) {
    if (nrm[4 * i + 3] > 0.5) {
      covered[i] = 1;
      part[i] = Math.max(0, Math.round(pos[4 * i + 3]) - 1);
    }
  }
  for (let y = 0; y < size; y += 2) {
    for (let x = 0; x < size - 1; x += 2) {
      const i = y * size + x, j = i + 1;
      if (!covered[i] || !covered[j] || part[i] !== part[j]) continue;
      const d = Math.hypot(pos[4 * j] - pos[4 * i], pos[4 * j + 1] - pos[4 * i + 1], pos[4 * j + 2] - pos[4 * i + 2]);
      if (d > 1e-5 && d < 4) steps.push(d);
    }
  }
  steps.sort((a, b) => a - b);
  const medianStep = steps.length ? steps[steps.length >> 1] : 0.05;
  const intraMax = Math.max(0.08, medianStep * 3.8);

  const adj: number[][] = Array.from({ length: N }, () => []);
  const adjW: number[][] = Array.from({ length: N }, () => []);
  const boundary: number[] = [];

  const linkWeight = (i: number, j: number, d: number) => {
    const dot = nrm[4 * i] * nrm[4 * j] + nrm[4 * i + 1] * nrm[4 * j + 1] + nrm[4 * i + 2] * nrm[4 * j + 2];
    const nSim = Math.max(0.08, 0.25 + 0.75 * Math.max(0, dot));
    return nSim / (0.25 + d / Math.max(1e-4, medianStep));
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (!covered[i]) continue;
      let isBorder = x === 0 || y === 0 || x === size - 1 || y === size - 1;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const j = ny * size + nx;
        if (!covered[j]) { isBorder = true; continue; }
        const d = Math.hypot(pos[4 * j] - pos[4 * i], pos[4 * j + 1] - pos[4 * i + 1], pos[4 * j + 2] - pos[4 * i + 2]);
        const dot = nrm[4 * i] * nrm[4 * j] + nrm[4 * i + 1] * nrm[4 * j + 1] + nrm[4 * i + 2] * nrm[4 * j + 2];
        if (part[i] !== part[j] || d > intraMax || dot < 0.2) { isBorder = true; continue; }
        adj[i].push(j);
        adjW[i].push(linkWeight(i, j, d));
      }
      if (isBorder) boundary.push(i);
    }
  }

  // Spatial voxel hash of UV island border texels to bridge 3D seams across separated UV charts.
  const seamRadius = Math.max(0.05, medianStep * 2.6);
  const vox = new Map<string, number[]>();
  const vk = (x: number, y: number, z: number) => `${x},${y},${z}`;
  for (const i of boundary) {
    const gx = Math.floor(pos[4 * i] / seamRadius);
    const gy = Math.floor(pos[4 * i + 1] / seamRadius);
    const gz = Math.floor(pos[4 * i + 2] / seamRadius);
    const key = vk(gx, gy, gz);
    const list = vox.get(key);
    if (list) list.push(i); else vox.set(key, [i]);
  }

  let crossSeamLinks = 0;
  for (const i of boundary) {
    const ix = i % size, iy = (i - ix) / size;
    const gx = Math.floor(pos[4 * i] / seamRadius);
    const gy = Math.floor(pos[4 * i + 1] / seamRadius);
    const gz = Math.floor(pos[4 * i + 2] / seamRadius);
    let bestJ = -1, bestD = seamRadius;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const j of vox.get(vk(gx + dx, gy + dy, gz + dz)) ?? []) {
            if (j === i || part[j] !== part[i]) continue;
            const jx = j % size, jy = (j - jx) / size;
            // Skip immediate 2D UV neighbours already linked on the same chart.
            if (Math.abs(jx - ix) <= 2 && Math.abs(jy - iy) <= 2) continue;
            const dot = nrm[4 * i] * nrm[4 * j] + nrm[4 * i + 1] * nrm[4 * j + 1] + nrm[4 * i + 2] * nrm[4 * j + 2];
            if (dot < 0.55) continue;
            const d = Math.hypot(pos[4 * j] - pos[4 * i], pos[4 * j + 1] - pos[4 * i + 1], pos[4 * j + 2] - pos[4 * i + 2]);
            if (d < bestD) { bestD = d; bestJ = j; }
          }
        }
      }
    }
    if (bestJ >= 0 && !adj[i].includes(bestJ)) {
      const w = linkWeight(i, bestJ, bestD) * 0.9;
      adj[i].push(bestJ); adjW[i].push(w);
      adj[bestJ].push(i); adjW[bestJ].push(w);
      crossSeamLinks++;
    }
  }

  let totalEdges = 0;
  for (let i = 0; i < N; i++) totalEdges += adj[i].length;
  const offsets = new Int32Array(N + 1);
  const neighbours = new Int32Array(totalEdges);
  const weights = new Float32Array(totalEdges);
  let cursor = 0;
  for (let i = 0; i < N; i++) {
    offsets[i] = cursor;
    const ns = adj[i], ws = adjW[i];
    for (let k = 0; k < ns.length; k++) {
      neighbours[cursor] = ns[k];
      weights[cursor] = ws[k];
      cursor++;
    }
  }
  offsets[N] = cursor;

  return { size, covered, part, medianStep, offsets, neighbours, weights, crossSeamLinks };
}

/**
 * Position/normal-conditioned UV-space inpainting over `graph`: propagates colours across both intra-island neighbours
 * and 3D cross-seam links via harmonic membrane relaxation, transfers world-space exemplar micro-grain from same-part
 * painted surfaces of matching orientation, and dilates a 2-texel island rim so unpainted share drops to ~0.
 */
export function uvInpaint(
  colour: ArrayLike<number>,
  painted: ArrayLike<number>,
  pos: ArrayLike<number>,
  nrm: ArrayLike<number>,
  size: number,
  graph = buildUvSeamGraph(pos, nrm, size),
): { rgba: Uint8ClampedArray; filled: number; seamBridged: number } {
  const N = size * size;
  const { covered, part, offsets, neighbours, weights } = graph;

  // Per-part and global painted means + painted exemplar bank bucketed by (part, normal octant) for grain synthesis.
  const partSum = new Map<number, [number, number, number, number]>();
  const globalSum: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < N; i++) {
    if (!covered[i] || !painted[i]) continue;
    const p = part[i];
    let s = partSum.get(p);
    if (!s) partSum.set(p, (s = [0, 0, 0, 0]));
    for (const acc of [s, globalSum]) {
      acc[0] += colour[4 * i]; acc[1] += colour[4 * i + 1]; acc[2] += colour[4 * i + 2]; acc[3]++;
    }
  }
  const partMean = (p: number): [number, number, number] => {
    const s = partSum.get(p) ?? globalSum;
    return s[3] > 0 ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : [140, 136, 128];
  };

  // Multi-source BFS over `graph` (crossing 3D seams!) to seed every unpainted texel from its closest 3D surface neighbour.
  const src = new Int32Array(N).fill(-1);
  const hops = new Uint16Array(N);
  const crossedSeam = new Uint8Array(N);
  let queue: number[] = [];
  for (let i = 0; i < N; i++) {
    if (covered[i] && painted[i]) { src[i] = i; queue.push(i); }
  }
  while (queue.length) {
    const next: number[] = [];
    for (const u of queue) {
      const ux = u % size, uy = (u - ux) / size;
      for (let e = offsets[u]; e < offsets[u + 1]; e++) {
        const v = neighbours[e];
        if (src[v] >= 0 || !covered[v] || painted[v]) continue;
        src[v] = src[u];
        hops[v] = Math.min(65535, hops[u] + 1);
        const vx = v % size, vy = (v - vx) / size;
        crossedSeam[v] = crossedSeam[u] || (Math.abs(vx - ux) > 2 || Math.abs(vy - uy) > 2 ? 1 : 0);
        next.push(v);
      }
    }
    queue = next;
  }

  // Initialize continuous float RGB buffer on unpainted texels and solve position/normal-weighted harmonic relaxation.
  const buf = new Float32Array(N * 3);
  const nextBuf = new Float32Array(N * 3);
  const unpaintedIdx: number[] = [];
  let seamBridged = 0;
  for (let i = 0; i < N; i++) {
    if (!covered[i]) continue;
    if (painted[i]) {
      buf[3 * i] = colour[4 * i];
      buf[3 * i + 1] = colour[4 * i + 1];
      buf[3 * i + 2] = colour[4 * i + 2];
    } else {
      unpaintedIdx.push(i);
      if (crossedSeam[i]) seamBridged++;
      const m = partMean(part[i]);
      if (src[i] >= 0) {
        const s = src[i];
        const fade = Math.min(0.65, hops[i] / 36);
        buf[3 * i] = colour[4 * s] * (1 - fade) + m[0] * fade;
        buf[3 * i + 1] = colour[4 * s + 1] * (1 - fade) + m[1] * fade;
        buf[3 * i + 2] = colour[4 * s + 2] * (1 - fade) + m[2] * fade;
      } else {
        buf[3 * i] = m[0]; buf[3 * i + 1] = m[1]; buf[3 * i + 2] = m[2];
      }
    }
  }
  nextBuf.set(buf);

  // Harmonic relaxation on unpainted texels (Dirichlet boundary at painted texels, cross-seam Neumann/bridge continuity).
  const iters = Math.min(32, Math.max(12, Math.ceil(size / 32)));
  for (let it = 0; it < iters && unpaintedIdx.length > 0; it++) {
    for (const i of unpaintedIdx) {
      let r = 0, g = 0, b = 0, wSum = 0;
      for (let e = offsets[i]; e < offsets[i + 1]; e++) {
        const j = neighbours[e], w = weights[e];
        r += buf[3 * j] * w; g += buf[3 * j + 1] * w; b += buf[3 * j + 2] * w;
        wSum += w;
      }
      if (wSum > 1e-6) {
        const m = partMean(part[i]);
        const anchor = 0.015;
        nextBuf[3 * i] = (r + anchor * m[0]) / (wSum + anchor);
        nextBuf[3 * i + 1] = (g + anchor * m[1]) / (wSum + anchor);
        nextBuf[3 * i + 2] = (b + anchor * m[2]) / (wSum + anchor);
      } else {
        nextBuf[3 * i] = buf[3 * i];
        nextBuf[3 * i + 1] = buf[3 * i + 1];
        nextBuf[3 * i + 2] = buf[3 * i + 2];
      }
    }
    for (const i of unpaintedIdx) {
      buf[3 * i] = nextBuf[3 * i];
      buf[3 * i + 1] = nextBuf[3 * i + 1];
      buf[3 * i + 2] = nextBuf[3 * i + 2];
    }
  }

  // Extract high-pass exemplar grain `(colour - localMean)` from painted interior texels per (part, normal octant)
  // and transfer it by 3D world-coordinate hashing so filled regions carry realistic material micro-texture.
  const octant = (i: number) =>
    (nrm[4 * i] >= 0 ? 1 : 0) | (nrm[4 * i + 1] >= 0 ? 2 : 0) | (nrm[4 * i + 2] >= 0 ? 4 : 0);
  const grainBank = new Map<number, [number, number, number][]>();
  for (let i = 0; i < N; i++) {
    if (!covered[i] || !painted[i]) continue;
    let mr = 0, mg = 0, mb = 0, cnt = 0;
    for (let e = offsets[i]; e < offsets[i + 1]; e++) {
      const j = neighbours[e];
      if (!painted[j]) continue;
      mr += colour[4 * j]; mg += colour[4 * j + 1]; mb += colour[4 * j + 2]; cnt++;
    }
    if (cnt < 2) continue;
    mr /= cnt; mg /= cnt; mb /= cnt;
    const key = part[i] * 8 + octant(i);
    let bank = grainBank.get(key);
    if (!bank) grainBank.set(key, (bank = []));
    if (bank.length < 512) {
      bank.push([
        Math.max(-28, Math.min(28, colour[4 * i] - mr)),
        Math.max(-28, Math.min(28, colour[4 * i + 1] - mg)),
        Math.max(-28, Math.min(28, colour[4 * i + 2] - mb)),
      ]);
    }
  }

  const invStep = 1 / Math.max(1e-3, graph.medianStep);
  const rgba = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N; i++) {
    if (!covered[i]) continue;
    if (painted[i]) {
      rgba[4 * i] = colour[4 * i];
      rgba[4 * i + 1] = colour[4 * i + 1];
      rgba[4 * i + 2] = colour[4 * i + 2];
      rgba[4 * i + 3] = 255;
      continue;
    }
    let gr = 0, gg = 0, gb = 0;
    const bank = grainBank.get(part[i] * 8 + octant(i));
    if (bank && bank.length >= 4) {
      const wx = Math.round(pos[4 * i] * invStep);
      const wy = Math.round(pos[4 * i + 1] * invStep);
      const wz = Math.round(pos[4 * i + 2] * invStep);
      const h = (Math.imul(wx, 73856093) ^ Math.imul(wy, 19349663) ^ Math.imul(wz, 83492791)) >>> 0;
      const sample = bank[h % bank.length];
      gr = sample[0] * 0.85; gg = sample[1] * 0.85; gb = sample[2] * 0.85;
    }
    rgba[4 * i] = Math.max(0, Math.min(255, Math.round(buf[3 * i] + gr)));
    rgba[4 * i + 1] = Math.max(0, Math.min(255, Math.round(buf[3 * i + 1] + gg)));
    rgba[4 * i + 2] = Math.max(0, Math.min(255, Math.round(buf[3 * i + 2] + gb)));
    rgba[4 * i + 3] = 255;
  }

  // 2-texel dilation rim around covered islands so sub-cell thin strips at 4K/8K never sample empty background.
  for (let pass = 0; pass < 2; pass++) {
    const rim: [number, number, number, number][] = [];
    for (let i = 0; i < N; i++) {
      if (rgba[4 * i + 3]) continue;
      const x = i % size, y = (i - x) / size;
      let r = 0, g = 0, b = 0, k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const m = 4 * (ny * size + nx);
          if (rgba[m + 3]) { r += rgba[m]; g += rgba[m + 1]; b += rgba[m + 2]; k++; }
        }
      }
      if (k) rim.push([i, r / k, g / k, b / k]);
    }
    for (const [i, r, g, b] of rim) rgba.set([r, g, b, 255], 4 * i);
  }

  return { rgba, filled: unpaintedIdx.length, seamBridged };
}

function srgbToLinear(u8: number): number {
  const s = u8 / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function linearToSrgbU8(lin: number): number {
  const c = Math.max(0, Math.min(1, lin));
  const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(s * 255)));
}

/**
 * Measure residual baked directional lighting on covered texels: within each semantic part spanning multiple normal
 * directions, computes `|r(log Y, irradiance)|` and the sunlit-vs-shaded relative luminance gap.
 */
export function bakedShadingScore(
  rgba: ArrayLike<number>,
  covered: ArrayLike<number>,
  pos: ArrayLike<number>,
  nrm: ArrayLike<number>,
  size: number,
  sunDir: [number, number, number] = [0.45, 0.78, 0.43],
): BakedShadingScore {
  const N = size * size;
  const sLen = Math.hypot(sunDir[0], sunDir[1], sunDir[2]) || 1;
  const sx = sunDir[0] / sLen, sy = sunDir[1] / sLen, sz = sunDir[2] / sLen;

  const byPart = new Map<number, { logY: number[]; irr: number[]; yLit: number; nLit: number; yShade: number; nShade: number }>();
  for (let i = 0; i < N; i++) {
    if (!covered[i] || rgba[4 * i + 3] < 128) continue;
    const p = Math.max(0, Math.round(pos[4 * i + 3]) - 1);
    const r = srgbToLinear(rgba[4 * i]), g = srgbToLinear(rgba[4 * i + 1]), b = srgbToLinear(rgba[4 * i + 2]);
    const Y = Math.max(1e-4, 0.2126 * r + 0.7152 * g + 0.0722 * b);
    const ndotl = Math.max(0, nrm[4 * i] * sx + nrm[4 * i + 1] * sy + nrm[4 * i + 2] * sz);
    const sky = 0.5 + 0.5 * nrm[4 * i + 1];
    const irr = 0.7 * ndotl + 0.3 * sky;
    let rec = byPart.get(p);
    if (!rec) byPart.set(p, (rec = { logY: [], irr: [], yLit: 0, nLit: 0, yShade: 0, nShade: 0 }));
    rec.logY.push(Math.log(Y));
    rec.irr.push(irr);
    if (ndotl >= 0.35) { rec.yLit += Y; rec.nLit++; }
    else if (ndotl <= 0.08) { rec.yShade += Y; rec.nShade++; }
  }

  let corrSum = 0, corrWeight = 0, spreadSum = 0, spreadWeight = 0;
  for (const rec of byPart.values()) {
    const n = rec.logY.length;
    if (n < 16) continue;
    let mY = 0, mI = 0;
    for (let k = 0; k < n; k++) { mY += rec.logY[k]; mI += rec.irr[k]; }
    mY /= n; mI /= n;
    let vY = 0, vI = 0, cov = 0;
    for (let k = 0; k < n; k++) {
      const dy = rec.logY[k] - mY, di = rec.irr[k] - mI;
      vY += dy * dy; vI += di * di; cov += dy * di;
    }
    if (vI / n > 0.004 && vY > 1e-8) {
      corrSum += Math.abs(cov / Math.sqrt(vY * vI)) * n;
      corrWeight += n;
    }
    if (rec.nLit >= 8 && rec.nShade >= 8) {
      const lit = rec.yLit / rec.nLit, shade = rec.yShade / rec.nShade;
      const mean = 0.5 * (lit + shade);
      if (mean > 1e-4) {
        spreadSum += (Math.abs(lit - shade) / mean) * (rec.nLit + rec.nShade);
        spreadWeight += rec.nLit + rec.nShade;
      }
    }
  }

  return {
    correlation: corrWeight > 0 ? +(corrSum / corrWeight).toFixed(4) : 0,
    directionalSpread: spreadWeight > 0 ? +(spreadSum / spreadWeight).toFixed(4) : 0,
  };
}

function solveSmallLinear(A: Float64Array, b: Float64Array, d: number): Float64Array {
  const M = new Float64Array(d * (d + 1));
  for (let r = 0; r < d; r++) {
    for (let c = 0; c < d; c++) M[r * (d + 1) + c] = A[r * d + c];
    M[r * (d + 1) + d] = b[r];
  }
  for (let k = 0; k < d; k++) {
    let piv = k;
    for (let r = k + 1; r < d; r++) if (Math.abs(M[r * (d + 1) + k]) > Math.abs(M[piv * (d + 1) + k])) piv = r;
    if (Math.abs(M[piv * (d + 1) + k]) < 1e-9) continue;
    if (piv !== k) {
      for (let c = k; c <= d; c++) {
        const tmp = M[k * (d + 1) + c]; M[k * (d + 1) + c] = M[piv * (d + 1) + c]; M[piv * (d + 1) + c] = tmp;
      }
    }
    const diag = M[k * (d + 1) + k];
    for (let c = k; c <= d; c++) M[k * (d + 1) + c] /= diag;
    for (let r = 0; r < d; r++) {
      if (r === k) continue;
      const f = M[r * (d + 1) + k];
      for (let c = k; c <= d; c++) M[r * (d + 1) + c] -= f * M[k * (d + 1) + c];
    }
  }
  const x = new Float64Array(d);
  for (let r = 0; r < d; r++) x[r] = M[r * (d + 1) + d];
  return x;
}

/**
 * Remove residual baked directional sun/sky lighting and low-frequency illumination drift while preserving intrinsic
 * material colour and grain, then sharpen high-frequency detail gated by per-texel `importance` (items 6 & 7).
 */
export function uvDelightAndSharpen(
  rgba: ArrayLike<number>,
  pos: ArrayLike<number>,
  nrm: ArrayLike<number>,
  importance: ArrayLike<number>,
  size: number,
  graph = buildUvSeamGraph(pos, nrm, size),
  opts: { delight?: number; sharpen?: number; importanceGate?: number; sunDir?: [number, number, number] } = {},
): { rgba: Uint8ClampedArray; deltaRgba: Uint8ClampedArray; highImportanceShare: number } {
  const N = size * size;
  const delight = opts.delight ?? 0.85;
  const sharpen = opts.sharpen ?? 0.45;
  const gate = opts.importanceGate ?? 0.35;
  const sun = opts.sunDir ?? [0.45, 0.78, 0.43];
  const sLen = Math.hypot(sun[0], sun[1], sun[2]) || 1;
  const sx = sun[0] / sLen, sy = sun[1] / sLen, sz = sun[2] / sLen;
  const { covered, part, offsets, neighbours, weights } = graph;

  const linR = new Float32Array(N), linG = new Float32Array(N), linB = new Float32Array(N);
  const logY = new Float32Array(N);
  let covCount = 0, highCount = 0;
  for (let i = 0; i < N; i++) {
    if (!covered[i]) continue;
    covCount++;
    if (importance[i] >= gate) highCount++;
    const r = srgbToLinear(rgba[4 * i]), g = srgbToLinear(rgba[4 * i + 1]), b = srgbToLinear(rgba[4 * i + 2]);
    linR[i] = r; linG[i] = g; linB[i] = b;
    logY[i] = Math.log(Math.max(1e-4, 0.2126 * r + 0.7152 * g + 0.0722 * b));
  }

  // Smooth `logY` across `graph` (8 passes) to isolate the low-frequency illumination envelope `envY` from fine grain.
  let envY = Float32Array.from(logY);
  let tmpY = new Float32Array(N);
  for (let pass = 0; pass < 8; pass++) {
    for (let i = 0; i < N; i++) {
      if (!covered[i]) continue;
      let s = envY[i] * 0.5, wSum = 0.5;
      for (let e = offsets[i]; e < offsets[i + 1]; e++) {
        const j = neighbours[e], w = weights[e];
        s += envY[j] * w; wSum += w;
      }
      tmpY[i] = s / wSum;
    }
    const swap = envY; envY = tmpY; tmpY = swap;
  }

  // Regress per-part directional shading basis `[1, max(0, n·sun), n.y, n.x, n.z]` with ridge regularization so
  // baked sunlight and sky gradients cancel out while intrinsic part albedo `β_0` stays intact.
  const D = 5;
  const partSys = new Map<number, { A: Float64Array; b: Float64Array; count: number; sumEnv: number }>();
  for (let i = 0; i < N; i++) {
    if (!covered[i]) continue;
    const p = part[i];
    let sys = partSys.get(p);
    if (!sys) {
      const A = new Float64Array(D * D);
      // Ridge penalty on directional terms (indices 1..4) prevents overfitting when a part has only one normal!
      for (let k = 1; k < D; k++) A[k * D + k] = 4.0;
      partSys.set(p, (sys = { A, b: new Float64Array(D), count: 0, sumEnv: 0 }));
    }
    const ndotl = Math.max(0, nrm[4 * i] * sx + nrm[4 * i + 1] * sy + nrm[4 * i + 2] * sz);
    const feat = [1, ndotl, nrm[4 * i + 1], nrm[4 * i], nrm[4 * i + 2]];
    const y = envY[i];
    for (let r = 0; r < D; r++) {
      sys.b[r] += feat[r] * y;
      for (let c = 0; c < D; c++) sys.A[r * D + c] += feat[r] * feat[c];
    }
    sys.count++;
    sys.sumEnv += y;
  }

  const partCoeffs = new Map<number, { beta: Float64Array; meanEnv: number }>();
  for (const [p, sys] of partSys) {
    if (sys.count < 8) continue;
    partCoeffs.set(p, { beta: solveSmallLinear(sys.A, sys.b, D), meanEnv: sys.sumEnv / sys.count });
  }

  // Delight in log-luminance space while preserving fine grain `logY - envY` and linear chromaticity.
  const delitLogY = Float32Array.from(logY);
  if (delight > 0) {
    for (let i = 0; i < N; i++) {
      if (!covered[i]) continue;
      const fit = partCoeffs.get(part[i]);
      if (!fit) continue;
      const ndotl = Math.max(0, nrm[4 * i] * sx + nrm[4 * i + 1] * sy + nrm[4 * i + 2] * sz);
      const predEnv = fit.beta[0] + fit.beta[1] * ndotl + fit.beta[2] * nrm[4 * i + 1] + fit.beta[3] * nrm[4 * i] + fit.beta[4] * nrm[4 * i + 2];
      // Directional shading bias relative to the part's neutral mean + gentle Retinex low-frequency flattening.
      const dirBias = predEnv - fit.meanEnv;
      const retinexBias = (envY[i] - predEnv) * 0.28;
      const correction = Math.max(-0.65, Math.min(0.65, delight * (dirBias + retinexBias)));
      delitLogY[i] = logY[i] - correction;
    }
  }

  // Importance-gated bilateral normal-preserving high-pass detail sharpening (only where `importance[i] >= gate`).
  const finalLogY = Float32Array.from(delitLogY);
  if (sharpen > 0) {
    for (let i = 0; i < N; i++) {
      if (!covered[i] || importance[i] < gate) continue;
      let blur = 0, wSum = 0;
      for (let e = offsets[i]; e < offsets[i + 1]; e++) {
        const j = neighbours[e];
        const dot = nrm[4 * i] * nrm[4 * j] + nrm[4 * i + 1] * nrm[4 * j + 1] + nrm[4 * i + 2] * nrm[4 * j + 2];
        if (dot < 0.8) continue;   // never sharpen across 3D geometric creases
        const photoW = Math.exp(-Math.abs(delitLogY[j] - delitLogY[i]) / 0.22);
        const w = weights[e] * photoW;
        blur += delitLogY[j] * w;
        wSum += w;
      }
      if (wSum > 1e-6) {
        const detail = delitLogY[i] - blur / wSum;
        const impBoost = Math.min(1.25, 0.35 + (importance[i] - gate) / Math.max(0.15, 1 - gate));
        finalLogY[i] = delitLogY[i] + Math.max(-0.22, Math.min(0.22, detail * sharpen * impBoost));
      }
    }
  }

  const out = new Uint8ClampedArray(rgba.length);
  out.set(rgba);
  const deltaRgba = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N; i++) {
    deltaRgba[4 * i] = deltaRgba[4 * i + 1] = deltaRgba[4 * i + 2] = 128;
    if (!covered[i]) continue;
    const gain = Math.exp(finalLogY[i] - logY[i]);
    const r = linearToSrgbU8(linR[i] * gain);
    const g = linearToSrgbU8(linG[i] * gain);
    const b = linearToSrgbU8(linB[i] * gain);
    out[4 * i] = r; out[4 * i + 1] = g; out[4 * i + 2] = b; out[4 * i + 3] = 255;
    deltaRgba[4 * i] = Math.max(1, Math.min(255, Math.round(128 + ((r - rgba[4 * i]) * 127) / 255)));
    deltaRgba[4 * i + 1] = Math.max(1, Math.min(255, Math.round(128 + ((g - rgba[4 * i + 1]) * 127) / 255)));
    deltaRgba[4 * i + 2] = Math.max(1, Math.min(255, Math.round(128 + ((b - rgba[4 * i + 2]) * 127) / 255)));
    deltaRgba[4 * i + 3] = 255;
  }
  // 1-texel delta rim dilation so bilinear page sampling at UV island borders never interpolates toward neutral 128.
  for (let i = 0; i < N; i++) {
    if (deltaRgba[4 * i + 3]) continue;
    const x = i % size, y = (i - x) / size;
    let dr = 0, dg = 0, db = 0, k = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const m = 4 * (ny * size + nx);
        if (deltaRgba[m + 3] === 255) { dr += deltaRgba[m]; dg += deltaRgba[m + 1]; db += deltaRgba[m + 2]; k++; }
      }
    }
    if (k) {
      deltaRgba[4 * i] = Math.round(dr / k);
      deltaRgba[4 * i + 1] = Math.round(dg / k);
      deltaRgba[4 * i + 2] = Math.round(db / k);
      deltaRgba[4 * i + 3] = 128;
    }
  }

  return {
    rgba: out,
    deltaRgba,
    highImportanceShare: covCount > 0 ? +(highCount / covCount).toFixed(4) : 0,
  };
}

/**
 * Run coarse-to-fine UV-space inpainting + importance-gated intrinsic delighting & sharpening on `engine.atlas`.
 */
export async function refineUvAtlas(engine: Engine, opts: UvRefineOptions = {}, signal?: AbortSignal): Promise<UvRefineResult> {
  const t0 = performance.now();
  const maxWork = Math.min(1024, engine.atlas.size);
  const rawSize = opts.size ?? maxWork;
  const size = Math.max(engine.atlas.grid * 64, Math.min(engine.atlas.size, 1 << Math.round(Math.log2(Math.max(64, rawSize)))));
  const N = size * size;

  const { pos, nrm } = engine.atlas.texelGeometry(size);
  const quality = engine.atlas.cellQuality(size);
  const current = engine.atlas.readBytes([0.5, 0.5, 0.5], size, true).data;

  const graph = buildUvSeamGraph(pos, nrm, size);
  const painted = new Uint8Array(N);
  let covCount = 0, unpBefore = 0;
  for (let i = 0; i < N; i++) {
    if (!graph.covered[i]) continue;
    covCount++;
    if (quality[i] > PAINTED) painted[i] = 1;
    else unpBefore++;
  }

  // Combined surface + player-path importance projected onto `size x size` UV space (items 6 & 7).
  const level = engine.level;
  const sw = level.surfaceWeights && level.surfaceWeights.importance.length === level.triangles
    ? level.surfaceWeights
    : surfaceWeights(level, engine.clay.lighting);
  level.surfaceWeights = sw;
  const pp = level.playerPaths && level.playerPaths.rank.length === level.triangles
    ? level.playerPaths
    : playerImportance(level);
  level.playerPaths = pp;
  const triImp = new Float32Array(level.triangles);
  for (let t = 0; t < level.triangles; t++) {
    const pw = pp.rank[t] > 0 ? 0.25 + 1.15 * pp.rank[t] : 0.1;
    triImp[t] = sw.importance[t] * pw;
  }
  const importance = cellWeights(level.geometry.getAttribute('uv').array, triImp, size);

  const toSun = sunDirection(engine.clay.lighting).negate();
  const sunDir: [number, number, number] = [toSun.x, toSun.y, toSun.z];
  const bakedShadingBefore = bakedShadingScore(current, graph.covered, pos, nrm, size, sunDir);

  // Stage 1: Position/normal-conditioned 3D-seam-aware UV inpainting.
  const inpainted = uvInpaint(current, painted, pos, nrm, size, graph);
  let working = inpainted.rgba;

  // Optional Stage 1b: Model-backed UV tile refinement on high-importance pockets (`routeEdit` local or cloud).
  let refinedTiles = 0, skippedLowImportanceTiles = 0, cost = 0;
  const gate = opts.importanceGate ?? 0.35;
  const maxTiles = opts.modelTiles ?? 0;
  if (maxTiles > 0) {
    const tilesPerSide = size >= 1024 ? 2 : 1;
    const T = Math.floor(size / tilesPerSide);
    const candidates: { tx: number; ty: number; score: number; meanImp: number }[] = [];
    for (let ty = 0; ty < tilesPerSide; ty++) {
      for (let tx = 0; tx < tilesPerSide; tx++) {
        let cov = 0, unp = 0, impSum = 0;
        for (let y = 0; y < T; y++) {
          for (let x = 0; x < T; x++) {
            const idx = (ty * T + y) * size + (tx * T + x);
            if (!graph.covered[idx]) continue;
            cov++;
            if (!painted[idx]) unp++;
            impSum += importance[idx];
          }
        }
        if (cov < 16) continue;
        const meanImp = impSum / cov;
        if (meanImp < gate) { skippedLowImportanceTiles++; continue; }
        candidates.push({ tx, ty, meanImp, score: meanImp * (0.35 + unp / cov) });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    const modelKey = opts.model ?? (opts.provider?.provider === 'local' ? 'local-comfy-mv' : 'flux3-klein');
    const model = MODELS[modelKey] ?? MODELS['flux3-klein'];
    const style = opts.style ?? 'weathered architectural stone, plaster and wood materials';

    for (const cand of candidates.slice(0, maxTiles)) {
      if (signal?.aborted) break;
      const tileRgba = new Uint8ClampedArray(T * T * 4);
      const maskRgba = new Uint8ClampedArray(T * T * 4);
      const nrmHintRgba = new Uint8ClampedArray(T * T * 4);
      for (let y = 0; y < T; y++) {
        for (let x = 0; x < T; x++) {
          const srcIdx = (cand.ty * T + y) * size + (cand.tx * T + x);
          const dst = 4 * (y * T + x);
          if (graph.covered[srcIdx]) {
            tileRgba[dst] = working[4 * srcIdx];
            tileRgba[dst + 1] = working[4 * srcIdx + 1];
            tileRgba[dst + 2] = working[4 * srcIdx + 2];
            tileRgba[dst + 3] = 255;
            nrmHintRgba[dst] = Math.round((nrm[4 * srcIdx] * 0.5 + 0.5) * 255);
            nrmHintRgba[dst + 1] = Math.round((nrm[4 * srcIdx + 1] * 0.5 + 0.5) * 255);
            nrmHintRgba[dst + 2] = Math.round((nrm[4 * srcIdx + 2] * 0.5 + 0.5) * 255);
            nrmHintRgba[dst + 3] = 255;
          } else {
            tileRgba[dst] = tileRgba[dst + 1] = tileRgba[dst + 2] = 128; tileRgba[dst + 3] = 255;
            nrmHintRgba[dst] = nrmHintRgba[dst + 1] = 128; nrmHintRgba[dst + 2] = nrmHintRgba[dst + 3] = 255;
          }
          const editVal = graph.covered[srcIdx] && !painted[srcIdx] ? (model.mask === 'black' ? 0 : 255) : (model.mask === 'black' ? 255 : 0);
          maskRgba[dst] = maskRgba[dst + 1] = maskRgba[dst + 2] = editVal; maskRgba[dst + 3] = 255;
        }
      }
      const r = await routeEdit(model, {
        imageUrl: toDataUrl(tileRgba, T, T, 'image/png'),
        maskUrl: model.mask ? toDataUrl(maskRgba, T, T, 'image/png') : undefined,
        refUrls: [toDataUrl(nrmHintRgba, T, T, 'image/png')],
        prompt: { look: style, roofLook: style, parts: 'UV texture atlas islands conditioned on surface normal map', mode: 'fill', diffuse: true, floor: false },
        seed: 101 + cand.ty * 4 + cand.tx,
        size: T,
      }, signal, opts.provider);
      const genTile = bitmapToRGBA(r.image, T, T);
      for (let y = 0; y < T; y++) {
        for (let x = 0; x < T; x++) {
          const srcIdx = (cand.ty * T + y) * size + (cand.tx * T + x);
          if (!graph.covered[srcIdx] || painted[srcIdx]) continue;
          const dst = 4 * (y * T + x);
          working[4 * srcIdx] = genTile[dst];
          working[4 * srcIdx + 1] = genTile[dst + 1];
          working[4 * srcIdx + 2] = genTile[dst + 2];
        }
      }
      if (r.providerUsed !== 'local') cost += priceOf(model, T);
      refinedTiles++;
    }
  } else {
    // Report how many low-importance 256x256 UV sectors were gated off from HD sharpening.
    const sec = Math.max(1, size >> 2);
    for (let sy = 0; sy < size; sy += sec) {
      for (let sx = 0; sx < size; sx += sec) {
        let cov = 0, imp = 0;
        for (let y = sy; y < sy + sec; y++) {
          for (let x = sx; x < sx + sec; x++) {
            const idx = y * size + x;
            if (graph.covered[idx]) { cov++; imp += importance[idx]; }
          }
        }
        if (cov > 0 && imp / cov < gate) skippedLowImportanceTiles++;
      }
    }
  }

  // Stage 2: Intrinsic delighting + importance-gated normal-preserving HD detail sharpening.
  const delit = uvDelightAndSharpen(working, pos, nrm, importance, size, graph, {
    delight: opts.delight, sharpen: opts.sharpen, importanceGate: gate, sunDir,
  });
  const bakedShadingAfter = bakedShadingScore(delit.rgba, graph.covered, pos, nrm, size, sunDir);

  // Recompute signed delta relative to `current` for already-painted texels, and write both inpaint + delta to native pages.
  const paintDelta = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N; i++) {
    paintDelta[4 * i] = paintDelta[4 * i + 1] = paintDelta[4 * i + 2] = 128;
    if (!graph.covered[i] || !painted[i]) continue;
    paintDelta[4 * i] = Math.max(1, Math.min(255, Math.round(128 + ((delit.rgba[4 * i] - current[4 * i]) * 127) / 255)));
    paintDelta[4 * i + 1] = Math.max(1, Math.min(255, Math.round(128 + ((delit.rgba[4 * i + 1] - current[4 * i + 1]) * 127) / 255)));
    paintDelta[4 * i + 2] = Math.max(1, Math.min(255, Math.round(128 + ((delit.rgba[4 * i + 2] - current[4 * i + 2]) * 127) / 255)));
    paintDelta[4 * i + 3] = 255;
  }
  for (let i = 0; i < N; i++) {
    if (paintDelta[4 * i + 3]) continue;
    const x = i % size, y = (i - x) / size;
    let dr = 0, dg = 0, db = 0, k = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const m = 4 * (ny * size + nx);
        if (paintDelta[m + 3] === 255) { dr += paintDelta[m]; dg += paintDelta[m + 1]; db += paintDelta[m + 2]; k++; }
      }
    }
    if (k) {
      paintDelta[4 * i] = Math.round(dr / k);
      paintDelta[4 * i + 1] = Math.round(dg / k);
      paintDelta[4 * i + 2] = Math.round(db / k);
      paintDelta[4 * i + 3] = 128;
    }
  }

  engine.atlas.applyUvRefinement(delit.rgba, paintDelta, size, UV_REFINE_QUALITY, { pos, nrm });

  const afterQ = engine.atlas.cellQuality(size);
  let unpAfter = 0;
  for (let i = 0; i < N; i++) if (graph.covered[i] && !(afterQ[i] > PAINTED)) unpAfter++;

  void THREE;
  return {
    size,
    unpaintedBefore: covCount > 0 ? +(unpBefore / covCount).toFixed(4) : 0,
    unpaintedAfter: covCount > 0 ? +(unpAfter / covCount).toFixed(4) : 0,
    crossSeamLinks: graph.crossSeamLinks,
    bakedShadingBefore,
    bakedShadingAfter,
    highImportanceShare: delit.highImportanceShare,
    refinedTiles,
    skippedLowImportanceTiles,
    cost: +cost.toFixed(4),
    seconds: +((performance.now() - t0) / 1000).toFixed(3),
  };
}
