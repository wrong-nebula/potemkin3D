/* Ported and adapted from wrong-nebula/Fast-SDF-AO (main); see NOTICE and PROVENANCE.md. */
import * as THREE from 'three';
import { floatTarget, passMaterial, type Gpu } from './gpu';

/**
 * High-performance hybrid Ambient Occlusion & Bent-Normal baker based on the latest `wrong-nebula/Fast-SDF-AO`:
 * 1. Exact Isotropic Signed/Unsigned Distance Field baker (`bakeFastSdf`, ported from `tools/bake_sdf.cpp`):
 *    - 16-bin SAH compact BVH with 1-triangle inlined leaves and `prevTri` neighbour warm-starting
 *    - Exact Ericson 5.1.5 point-to-triangle distance (`triDist2`)
 *    - Hierarchical 8³ → 4³ → 2³ → 1³ 1-Lipschitz block culling with precomputed half-voxel distance table
 *    - Optional +Y column ray-crossing winding-number sign pass for closed meshes + direct IEEE-754 FP16 (`R16F`) output
 * 2. Quantized SAH Contact BVH (`buildContactBVH`, ported from `contact-bvh.js`):
 *    - O(T) 2-pass CSR AABB-to-cell binning on a world grid with cell-clipped triangle AABBs
 *    - 8-bin SAH + conservative 16-bit local-cell quantization (`RGBA32UI`, 16 B/node) + ray-sign-ordered short-stack walk
 *    - Deduplicated `R32UI` triangle index table + `RGBA32F` Möller-Trumbore `(v0, e1, e2)` storage
 * 3. Traced SDF + Cranley-Patterson IGN + 2D Halton(2, 3) (`vdc2`, `vdc3`) estimator (WebGL2 GPU shader + CPU parity):
 *    - Exact triangle contact check over `[0, contactRange]` from a 0.3 mm normal-offset origin
 *    - Direct handoff at `s = contactRange` to 16-step soft-visibility SDF sphere marching + bent-normal accumulation
 *    - Plus the refitted 4-tap `aoWallCorrection` formula (`accuracy/ao_formula.py`, adapted to Three.js Y-up)
 */

export type FastSdfFalloff = 'smooth' | 'linear' | 'hard';

const f32Scratch = new Float32Array(1);
const u32Scratch = new Uint32Array(f32Scratch.buffer);

/** Exact IEEE-754 float32 → binary16 (`R16F`) conversion from `tools/bake_sdf.cpp`. */
export function floatToHalf(f: number): number {
  f32Scratch[0] = f;
  const u = u32Scratch[0];
  const sign = (u >>> 16) & 0x8000;
  const exp = ((u >>> 23) & 0xff) - 127 + 15;
  let frac = u & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    frac = (frac | 0x800000) >>> (1 - exp);
    return sign | ((frac + 0x1000) >>> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | ((frac + 0x1000) >>> 13);
}

/** Exact Ericson (Real-Time Collision Detection 5.1.5) squared point-to-triangle distance. */
export function triDist2(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const dx = px - (ax + abx * v), dy = py - (ay + aby * v), dz = pz - (az + abz * v);
    return dx * dx + dy * dy + dz * dz;
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const dx = px - (ax + acx * w), dy = py - (ay + acy * w), dz = pz - (az + acz * w);
    return dx * dx + dy * dy + dz * dz;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const dx = px - (bx + (cx - bx) * w), dy = py - (by + (cy - by) * w), dz = pz - (bz + (cz - bz) * w);
    return dx * dx + dy * dy + dz * dz;
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  const dx = px - (ax + abx * v + acx * w);
  const dy = py - (ay + aby * v + acy * w);
  const dz = pz - (az + abz * v + acz * w);
  return dx * dx + dy * dy + dz * dz;
}

interface FlatTriangles {
  count: number;
  ax: Float64Array; ay: Float64Array; az: Float64Array;
  bx: Float64Array; by: Float64Array; bz: Float64Array;
  cx: Float64Array; cy: Float64Array; cz: Float64Array;
  lo: [number, number, number];
  hi: [number, number, number];
}

function extractTriangles(geometry: THREE.BufferGeometry, matrixWorld?: THREE.Matrix4): FlatTriangles {
  const pos = geometry.getAttribute('position');
  const idx = geometry.getIndex();
  const pArr = pos.array;
  const stride = pos.itemSize;
  const iArr = idx ? idx.array : null;
  const vertCount = idx ? idx.count : pos.count;
  const triCount = (vertCount / 3) | 0;

  const ax = new Float64Array(triCount), ay = new Float64Array(triCount), az = new Float64Array(triCount);
  const bx = new Float64Array(triCount), by = new Float64Array(triCount), bz = new Float64Array(triCount);
  const cx = new Float64Array(triCount), cy = new Float64Array(triCount), cz = new Float64Array(triCount);
  let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity;
  const m = matrixWorld ? matrixWorld.elements : null;

  for (let t = 0; t < triCount; t++) {
    const i0 = (iArr ? iArr[3 * t] : 3 * t) * stride;
    const i1 = (iArr ? iArr[3 * t + 1] : 3 * t + 1) * stride;
    const i2 = (iArr ? iArr[3 * t + 2] : 3 * t + 2) * stride;
    let x0 = pArr[i0], y0 = pArr[i0 + 1], z0 = pArr[i0 + 2];
    let x1 = pArr[i1], y1 = pArr[i1 + 1], z1 = pArr[i1 + 2];
    let x2 = pArr[i2], y2 = pArr[i2 + 1], z2 = pArr[i2 + 2];
    if (m) {
      const tx0 = m[0] * x0 + m[4] * y0 + m[8] * z0 + m[12];
      const ty0 = m[1] * x0 + m[5] * y0 + m[9] * z0 + m[13];
      const tz0 = m[2] * x0 + m[6] * y0 + m[10] * z0 + m[14];
      const tx1 = m[0] * x1 + m[4] * y1 + m[8] * z1 + m[12];
      const ty1 = m[1] * x1 + m[5] * y1 + m[9] * z1 + m[13];
      const tz1 = m[2] * x1 + m[6] * y1 + m[10] * z1 + m[14];
      const tx2 = m[0] * x2 + m[4] * y2 + m[8] * z2 + m[12];
      const ty2 = m[1] * x2 + m[5] * y2 + m[9] * z2 + m[13];
      const tz2 = m[2] * x2 + m[6] * y2 + m[10] * z2 + m[14];
      x0 = tx0; y0 = ty0; z0 = tz0;
      x1 = tx1; y1 = ty1; z1 = tz1;
      x2 = tx2; y2 = ty2; z2 = tz2;
    }
    ax[t] = x0; ay[t] = y0; az[t] = z0;
    bx[t] = x1; by[t] = y1; bz[t] = z1;
    cx[t] = x2; cy[t] = y2; cz[t] = z2;
    const mnx = Math.min(x0, x1, x2), mny = Math.min(y0, y1, y2), mnz = Math.min(z0, z1, z2);
    const mxx = Math.max(x0, x1, x2), mxy = Math.max(y0, y1, y2), mxz = Math.max(z0, z1, z2);
    if (mnx < lx) lx = mnx; if (mny < ly) ly = mny; if (mnz < lz) lz = mnz;
    if (mxx > hx) hx = mxx; if (mxy > hy) hy = mxy; if (mxz > hz) hz = mxz;
  }
  if (triCount === 0) { lx = ly = lz = 0; hx = hy = hz = 1; }
  return { count: triCount, ax, ay, az, bx, by, bz, cx, cy, cz, lo: [lx, ly, lz], hi: [hx, hy, hz] };
}

/**
 * Compact 16-bin SAH closest-triangle BVH from `tools/bake_sdf.cpp` (`BVH_LEAF = 1`, child references `< 0` inline leaves).
 */
class CompactClosestBvh {
  readonly count: number;
  readonly nodeLo: Float32Array; // 6 floats per internal node: [loX0, loX1, loY0, loY1, loZ0, loZ1]
  readonly nodeHi: Float32Array; // 6 floats per internal node: [hiX0, hiX1, hiY0, hiY1, hiZ0, hiZ1]
  readonly child: Int32Array;    // 2 ints per internal node
  readonly rootRef: number;
  readonly rootLo: [number, number, number];
  readonly rootHi: [number, number, number];
  readonly pax: Float64Array; readonly pay: Float64Array; readonly paz: Float64Array;
  readonly pbx: Float64Array; readonly pby: Float64Array; readonly pbz: Float64Array;
  readonly pcx: Float64Array; readonly pcy: Float64Array; readonly pcz: Float64Array;
  private readonly sr = new Int32Array(128);
  private readonly sd = new Float64Array(128);

  constructor(tris: FlatTriangles) {
    const n = tris.count;
    this.count = n;
    this.pax = new Float64Array(n); this.pay = new Float64Array(n); this.paz = new Float64Array(n);
    this.pbx = new Float64Array(n); this.pby = new Float64Array(n); this.pbz = new Float64Array(n);
    this.pcx = new Float64Array(n); this.pcy = new Float64Array(n); this.pcz = new Float64Array(n);
    this.rootLo = [...tris.lo];
    this.rootHi = [...tris.hi];

    if (n === 0) {
      this.nodeLo = new Float32Array(0);
      this.nodeHi = new Float32Array(0);
      this.child = new Int32Array(0);
      this.rootRef = -1;
      return;
    }

    const pLoX = new Float32Array(n), pLoY = new Float32Array(n), pLoZ = new Float32Array(n);
    const pHiX = new Float32Array(n), pHiY = new Float32Array(n), pHiZ = new Float32Array(n);
    const pCX = new Float32Array(n), pCY = new Float32Array(n), pCZ = new Float32Array(n);
    const order = new Int32Array(n);
    const eps = 1e-6;
    for (let i = 0; i < n; i++) {
      order[i] = i;
      pLoX[i] = Math.min(tris.ax[i], tris.bx[i], tris.cx[i]) - eps;
      pLoY[i] = Math.min(tris.ay[i], tris.by[i], tris.cy[i]) - eps;
      pLoZ[i] = Math.min(tris.az[i], tris.bz[i], tris.cz[i]) - eps;
      pHiX[i] = Math.max(tris.ax[i], tris.bx[i], tris.cx[i]) + eps;
      pHiY[i] = Math.max(tris.ay[i], tris.by[i], tris.cy[i]) + eps;
      pHiZ[i] = Math.max(tris.az[i], tris.bz[i], tris.cz[i]) + eps;
      pCX[i] = (tris.ax[i] + tris.bx[i] + tris.cx[i]) / 3;
      pCY[i] = (tris.ay[i] + tris.by[i] + tris.cy[i]) / 3;
      pCZ[i] = (tris.az[i] + tris.bz[i] + tris.cz[i]) / 3;
    }

    if (n === 1) {
      this.nodeLo = new Float32Array(0);
      this.nodeHi = new Float32Array(0);
      this.child = new Int32Array(0);
      this.rootRef = ~0;
      this.pax[0] = tris.ax[0]; this.pay[0] = tris.ay[0]; this.paz[0] = tris.az[0];
      this.pbx[0] = tris.bx[0]; this.pby[0] = tris.by[0]; this.pbz[0] = tris.bz[0];
      this.pcx[0] = tris.cx[0]; this.pcy[0] = tris.cy[0]; this.pcz[0] = tris.cz[0];
      return;
    }

    const internalCount = n - 1;
    this.nodeLo = new Float32Array(internalCount * 6);
    this.nodeHi = new Float32Array(internalCount * 6);
    this.child = new Int32Array(internalCount * 2);
    this.rootRef = 0;

    const NB = 16;
    const bLoX = new Float32Array(NB), bLoY = new Float32Array(NB), bLoZ = new Float32Array(NB);
    const bHiX = new Float32Array(NB), bHiY = new Float32Array(NB), bHiZ = new Float32Array(NB);
    const bCnt = new Int32Array(NB);
    const rArea = new Float32Array(NB), rCnt = new Int32Array(NB);

    const setChild = (cid: number, slot: number, lx: number, ly: number, lz: number, hx: number, hy: number, hz: number, ref: number) => {
      const b6 = cid * 6 + slot;
      this.nodeLo[b6] = lx; this.nodeLo[b6 + 2] = ly; this.nodeLo[b6 + 4] = lz;
      this.nodeHi[b6] = hx; this.nodeHi[b6 + 2] = hy; this.nodeHi[b6 + 4] = hz;
      this.child[cid * 2 + slot] = ref;
    };

    const build = (s: number, e: number, cid: number) => {
      if (e - s === 2) {
        const k0 = order[s], k1 = order[s + 1];
        setChild(cid, 0, pLoX[k0], pLoY[k0], pLoZ[k0], pHiX[k0], pHiY[k0], pHiZ[k0], ~s);
        setChild(cid, 1, pLoX[k1], pLoY[k1], pLoZ[k1], pHiX[k1], pHiY[k1], pHiZ[k1], ~(s + 1));
        return;
      }

      let clx = Infinity, cly = Infinity, clz = Infinity, chx = -Infinity, chy = -Infinity, chz = -Infinity;
      for (let i = s; i < e; i++) {
        const k = order[i];
        if (pCX[k] < clx) clx = pCX[k]; if (pCY[k] < cly) cly = pCY[k]; if (pCZ[k] < clz) clz = pCZ[k];
        if (pCX[k] > chx) chx = pCX[k]; if (pCY[k] > chy) chy = pCY[k]; if (pCZ[k] > chz) chz = pCZ[k];
      }

      const bins = Math.min(NB, e - s);
      let bestCost = Infinity, bestAx = -1, bestB = 0;
      for (let ax = 0; ax < 3; ax++) {
        const cLo = ax === 0 ? clx : ax === 1 ? cly : clz;
        const ext = (ax === 0 ? chx : ax === 1 ? chy : chz) - cLo;
        if (ext <= 1e-7) continue;
        const sc = bins / ext;
        const cArr = ax === 0 ? pCX : ax === 1 ? pCY : pCZ;
        for (let b = 0; b < bins; b++) {
          bCnt[b] = 0;
          bLoX[b] = bLoY[b] = bLoZ[b] = Infinity;
          bHiX[b] = bHiY[b] = bHiZ[b] = -Infinity;
        }
        for (let i = s; i < e; i++) {
          const k = order[i];
          let bi = ((cArr[k] - cLo) * sc) | 0;
          if (bi >= bins) bi = bins - 1; else if (bi < 0) bi = 0;
          bCnt[bi]++;
          if (pLoX[k] < bLoX[bi]) bLoX[bi] = pLoX[k];
          if (pLoY[k] < bLoY[bi]) bLoY[bi] = pLoY[k];
          if (pLoZ[k] < bLoZ[bi]) bLoZ[bi] = pLoZ[k];
          if (pHiX[k] > bHiX[bi]) bHiX[bi] = pHiX[k];
          if (pHiY[k] > bHiY[bi]) bHiY[bi] = pHiY[k];
          if (pHiZ[k] > bHiZ[bi]) bHiZ[bi] = pHiZ[k];
        }
        let rlx = Infinity, rly = Infinity, rlz = Infinity, rhx = -Infinity, rhy = -Infinity, rhz = -Infinity, rc = 0;
        for (let b = bins - 1; b > 0; b--) {
          rc += bCnt[b];
          if (bLoX[b] < rlx) rlx = bLoX[b]; if (bLoY[b] < rly) rly = bLoY[b]; if (bLoZ[b] < rlz) rlz = bLoZ[b];
          if (bHiX[b] > rhx) rhx = bHiX[b]; if (bHiY[b] > rhy) rhy = bHiY[b]; if (bHiZ[b] > rhz) rhz = bHiZ[b];
          rCnt[b] = rc;
          const dx = rhx - rlx, dy = rhy - rly, dz = rhz - rlz;
          rArea[b] = rc ? dx * dy + dy * dz + dz * dx : 0;
        }
        let llx = Infinity, lly = Infinity, llz = Infinity, lhx = -Infinity, lhy = -Infinity, lhz = -Infinity, lc = 0;
        for (let b = 0; b < bins - 1; b++) {
          lc += bCnt[b];
          if (bLoX[b] < llx) llx = bLoX[b]; if (bLoY[b] < lly) lly = bLoY[b]; if (bLoZ[b] < llz) llz = bLoZ[b];
          if (bHiX[b] > lhx) lhx = bHiX[b]; if (bHiY[b] > lhy) lhy = bHiY[b]; if (bHiZ[b] > lhz) lhz = bHiZ[b];
          if (!lc || !rCnt[b + 1]) continue;
          const dx = lhx - llx, dy = lhy - lly, dz = lhz - llz;
          const cost = (dx * dy + dy * dz + dz * dx) * lc + rArea[b + 1] * rCnt[b + 1];
          if (cost < bestCost) { bestCost = cost; bestAx = ax; bestB = b + 1; }
        }
      }

      let m = s;
      if (bestAx >= 0) {
        const cLo = bestAx === 0 ? clx : bestAx === 1 ? cly : clz;
        const ext = (bestAx === 0 ? chx : bestAx === 1 ? chy : chz) - cLo;
        const sc = bins / ext;
        const cArr = bestAx === 0 ? pCX : bestAx === 1 ? pCY : pCZ;
        let i = s, j = e - 1;
        while (i <= j) {
          let bi = ((cArr[order[i]] - cLo) * sc) | 0;
          if (bi >= bins) bi = bins - 1; else if (bi < 0) bi = 0;
          if (bi < bestB) i++;
          else { const tmp = order[i]; order[i] = order[j]; order[j] = tmp; j--; }
        }
        m = i;
      }
      if (m <= s || m >= e) {
        const extX = chx - clx, extY = chy - cly, extZ = chz - clz;
        const ax = extX >= extY && extX >= extZ ? 0 : extY >= extZ ? 1 : 2;
        const cArr = ax === 0 ? pCX : ax === 1 ? pCY : pCZ;
        const slice = Array.from(order.subarray(s, e)).sort((a, b) => cArr[a] - cArr[b]);
        order.set(slice, s);
        m = (s + e) >> 1;
      }

      let llx = Infinity, lly = Infinity, llz = Infinity, lhx = -Infinity, lhy = -Infinity, lhz = -Infinity;
      for (let i = s; i < m; i++) {
        const k = order[i];
        if (pLoX[k] < llx) llx = pLoX[k]; if (pLoY[k] < lly) lly = pLoY[k]; if (pLoZ[k] < llz) llz = pLoZ[k];
        if (pHiX[k] > lhx) lhx = pHiX[k]; if (pHiY[k] > lhy) lhy = pHiY[k]; if (pHiZ[k] > lhz) lhz = pHiZ[k];
      }
      let rlx = Infinity, rly = Infinity, rlz = Infinity, rhx = -Infinity, rhy = -Infinity, rhz = -Infinity;
      for (let i = m; i < e; i++) {
        const k = order[i];
        if (pLoX[k] < rlx) rlx = pLoX[k]; if (pLoY[k] < rly) rly = pLoY[k]; if (pLoZ[k] < rlz) rlz = pLoZ[k];
        if (pHiX[k] > rhx) rhx = pHiX[k]; if (pHiY[k] > rhy) rhy = pHiY[k]; if (pHiZ[k] > rhz) rhz = pHiZ[k];
      }

      const lc = cid + 1, rc = cid + (m - s);
      setChild(cid, 0, llx, lly, llz, lhx, lhy, lhz, m - s === 1 ? ~s : lc);
      setChild(cid, 1, rlx, rly, rlz, rhx, rhy, rhz, e - m === 1 ? ~m : rc);
      if (m - s > 1) build(s, m, lc);
      if (e - m > 1) build(m, e, rc);
    };

    build(0, n, 0);
    for (let k = 0; k < n; k++) {
      const id = order[k];
      this.pax[k] = tris.ax[id]; this.pay[k] = tris.ay[id]; this.paz[k] = tris.az[id];
      this.pbx[k] = tris.bx[id]; this.pby[k] = tris.by[id]; this.pbz[k] = tris.bz[id];
      this.pcx[k] = tris.cx[id]; this.pcy[k] = tris.cy[id]; this.pcz[k] = tris.cz[id];
    }
  }

  /** Squared distance to nearest triangle < `best2`, warm-started with `skip` leaf. Returns `[best2, leaf]`. */
  closest(px: number, py: number, pz: number, best2: number, bestTri: number, skip = -1): [number, number] {
    if (this.count === 0) return [best2, bestTri];
    const vx = Math.max(this.rootLo[0] - px, 0, px - this.rootHi[0]);
    const vy = Math.max(this.rootLo[1] - py, 0, py - this.rootHi[1]);
    const vz = Math.max(this.rootLo[2] - pz, 0, pz - this.rootHi[2]);
    const rootD2 = vx * vx + vy * vy + vz * vz;
    if (rootD2 >= best2) return [best2, bestTri];

    const sr = this.sr, sd = this.sd;
    sr[0] = this.rootRef;
    sd[0] = rootD2;
    let sp = 1;
    const nLo = this.nodeLo, nHi = this.nodeHi, ch = this.child;

    while (sp > 0) {
      --sp;
      const er = sr[sp];
      if (sd[sp] >= best2) continue;
      if (er < 0) {
        const k = ~er;
        if (k === skip) continue;
        const d = triDist2(
          px, py, pz,
          this.pax[k], this.pay[k], this.paz[k],
          this.pbx[k], this.pby[k], this.pbz[k],
          this.pcx[k], this.pcy[k], this.pcz[k],
        );
        if (d < best2) { best2 = d; bestTri = k; }
        continue;
      }
      const b6 = er * 6;
      const l0x = Math.max(nLo[b6] - px, px - nHi[b6], 0);
      const l1x = Math.max(nLo[b6 + 1] - px, px - nHi[b6 + 1], 0);
      const l0y = Math.max(nLo[b6 + 2] - py, py - nHi[b6 + 2], 0);
      const l1y = Math.max(nLo[b6 + 3] - py, py - nHi[b6 + 3], 0);
      const l0z = Math.max(nLo[b6 + 4] - pz, pz - nHi[b6 + 4], 0);
      const l1z = Math.max(nLo[b6 + 5] - pz, pz - nHi[b6 + 5], 0);
      const dl = l0x * l0x + l0y * l0y + l0z * l0z;
      const dr = l1x * l1x + l1y * l1y + l1z * l1z;
      const c0 = ch[er * 2], c1 = ch[er * 2 + 1];
      if (dl < dr) {
        if (dr < best2) { sr[sp] = c1; sd[sp++] = dr; }
        if (dl < best2) { sr[sp] = c0; sd[sp++] = dl; }
      } else {
        if (dl < best2) { sr[sp] = c0; sd[sp++] = dl; }
        if (dr < best2) { sr[sp] = c1; sd[sp++] = dr; }
      }
    }
    return [best2, bestTri];
  }
}

/**
 * Identify triangles belonging to watertight connected shells (every directed edge `(a->b)` paired with `(b->a)`
 * within that connected component). Allows closed walls, pillars and props to receive exact negative interior SDF
 * signs without single-sided floor/backdrop sheets corrupting column winding numbers!
 */
function findWatertightTriangles(tris: FlatTriangles): Uint8Array {
  const mask = new Uint8Array(tris.count);
  if (tris.count < 4 || tris.count > 200000) return mask;
  const q = 1e4;
  const vKey = (x: number, y: number, z: number) => `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;

  // Disjoint-set union over triangles sharing quantized vertices
  const parent = Int32Array.from({ length: tris.count }, (_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) { const nx = parent[x]; parent[x] = r; x = nx; }
    return r;
  };
  const unite = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const vertOwner = new Map<string, number>();
  const keys = new Array<[string, string, string]>(tris.count);
  for (let i = 0; i < tris.count; i++) {
    const k0 = vKey(tris.ax[i], tris.ay[i], tris.az[i]);
    const k1 = vKey(tris.bx[i], tris.by[i], tris.bz[i]);
    const k2 = vKey(tris.cx[i], tris.cy[i], tris.cz[i]);
    keys[i] = [k0, k1, k2];
    for (const kv of keys[i]) {
      const prev = vertOwner.get(kv);
      if (prev !== undefined) unite(i, prev);
      else vertOwner.set(kv, i);
    }
  }

  const compEdges = new Map<number, Map<string, number>>();
  const compTriCounts = new Map<number, number>();
  for (let i = 0; i < tris.count; i++) {
    const root = find(i);
    compTriCounts.set(root, (compTriCounts.get(root) ?? 0) + 1);
    let em = compEdges.get(root);
    if (!em) { em = new Map(); compEdges.set(root, em); }
    const [k0, k1, k2] = keys[i];
    for (const [u, v] of [[k0, k1], [k1, k2], [k2, k0]]) {
      if (u === v) continue;
      const [lo, hi, sgn] = u < v ? [u, v, 1] : [v, u, -1];
      const ek = `${lo}|${hi}`;
      em.set(ek, (em.get(ek) ?? 0) + sgn);
    }
  }

  const closedRoots = new Set<number>();
  for (const [root, em] of compEdges) {
    if ((compTriCounts.get(root) ?? 0) < 4 || em.size === 0) continue;
    let closed = true;
    for (const bal of em.values()) {
      if (bal !== 0) { closed = false; break; }
    }
    if (closed) closedRoots.add(root);
  }
  if (!closedRoots.size) return mask;
  for (let i = 0; i < tris.count; i++) {
    if (closedRoots.has(find(i))) mask[i] = 1;
  }
  return mask;
}

/** Column ray-crossing winding-number sign mask along +Y (ported from `insideMask` in `tools/bake_sdf.cpp` to Three.js Y-up). */
function insideMaskYUp(
  tris: FlatTriangles,
  triMask: Uint8Array | null,
  lo: [number, number, number],
  span: [number, number, number],
  RX: number,
  RY: number,
  RZ: number,
): Uint8Array {
  const inside = new Uint8Array(RX * RY * RZ);
  const sx = span[0] / RX, sz = span[2] / RZ;
  const cols = RX * RZ;
  const start = new Uint32Array(cols + 1);
  const validTris: number[] = [];
  const bounds: number[] = [];

  for (let i = 0; i < tris.count; i++) {
    if (triMask && !triMask[i]) continue;
    if ((tris.ax[i] === tris.bx[i] && tris.ax[i] === tris.cx[i]) || (tris.az[i] === tris.bz[i] && tris.az[i] === tris.cz[i])) continue;
    const x0 = Math.min(tris.ax[i], tris.bx[i], tris.cx[i]), x1 = Math.max(tris.ax[i], tris.bx[i], tris.cx[i]);
    const z0 = Math.min(tris.az[i], tris.bz[i], tris.cz[i]), z1 = Math.max(tris.az[i], tris.bz[i], tris.cz[i]);
    const i0 = Math.max(0, Math.floor((x0 - lo[0]) / sx - 0.5)), i1 = Math.min(RX - 1, Math.ceil((x1 - lo[0]) / sx - 0.5));
    const k0 = Math.max(0, Math.floor((z0 - lo[2]) / sz - 0.5)), k1 = Math.min(RZ - 1, Math.ceil((z1 - lo[2]) / sz - 0.5));
    if (i0 > i1 || k0 > k1) continue;
    validTris.push(i);
    bounds.push(i0, i1, k0, k1);
    for (let k = k0; k <= k1; k++) for (let ix = i0; ix <= i1; ix++) start[k * RX + ix + 1]++;
  }
  for (let c = 1; c <= cols; c++) start[c] += start[c - 1];
  const items = new Uint32Array(start[cols]);
  const fill = new Uint32Array(start.subarray(0, cols));
  for (let idx = 0; idx < validTris.length; idx++) {
    const triId = validTris[idx];
    const i0 = bounds[4 * idx], i1 = bounds[4 * idx + 1], k0 = bounds[4 * idx + 2], k1 = bounds[4 * idx + 3];
    for (let k = k0; k <= k1; k++) for (let ix = i0; ix <= i1; ix++) items[fill[k * RX + ix]++] = triId;
  }

  const hits: { y: number; delta: number }[] = [];
  for (let col = 0; col < cols; col++) {
    const e0 = start[col], e1 = start[col + 1];
    if (e0 === e1) continue;
    const ix = col % RX, iz = (col / RX) | 0;
    const x = lo[0] + (ix + 0.5) * sx + 1.2345e-9 * sx;
    const z = lo[2] + (iz + 0.5) * sz + 2.7182e-9 * sz;
    hits.length = 0;
    for (let e = e0; e < e1; e++) {
      const t = items[e];
      const ax = tris.ax[t] - x, az = tris.az[t] - z;
      const bx = tris.bx[t] - x, bz = tris.bz[t] - z;
      const cx = tris.cx[t] - x, cz = tris.cz[t] - z;
      // Projected in XZ so +Y normal corresponds to s < 0 or > 0 consistently
      const w0 = bz * cx - bx * cz;
      const w1 = cz * ax - cx * az;
      const w2 = az * bx - ax * bz;
      if (!((w0 > 0 && w1 > 0 && w2 > 0) || (w0 < 0 && w1 < 0 && w2 < 0))) continue;
      const s = w0 + w1 + w2;
      const yHit = (w0 * tris.ay[t] + w1 * tris.by[t] + w2 * tris.cy[t]) / s;
      hits.push({ y: yHit, delta: s > 0 ? -1 : 1 });
    }
    if (!hits.length) continue;
    hits.sort((a, b) => a.y - b.y);
    let winding = 0, h = 0;
    for (let iy = 0; iy < RY; iy++) {
      const yc = lo[1] + ((iy + 0.5) * span[1]) / RY;
      while (h < hits.length && hits[h].y < yc) winding += hits[h++].delta;
      if (winding !== 0) inside[(iz * RY + iy) * RX + ix] = 1;
    }
  }
  return inside;
}

export interface FastSdfVolume {
  lo: [number, number, number];
  span: [number, number, number];
  dims: [number, number, number];
  voxelSize: [number, number, number];
  voxelDiag: number;
  clip: number;
  signed: boolean;
  /** Exact float32 distance volume (`x` fastest, then `y`, then `z`; voxel `i` at `lo + (i + 0.5) * span / dims`). */
  f32: Float32Array;
  /** IEEE-754 binary16 (`R16F`) volume ready for zero-loop WebGL2 `Data3DTexture` upload. */
  f16: Uint16Array;
  stats: { buildMs: number; queries: number; culledVoxels: number; totalVoxels: number };
}

export interface BakeFastSdfOptions {
  /** Longest-axis target resolution (rounded to multiples of `block`, default 96). */
  maxRes?: number;
  /** AO reach in metres (default 1.12). Voxels farther than `reach + voxelDiag` skip BVH queries via 1-Lipschitz culling. */
  reach?: number;
  /** Clip distance written outside the narrow band (default `reach * 1.34`). */
  clip?: number;
  /** Hierarchical Lipschitz block size (power of two, default 8). */
  block?: number;
  /** Negate interior voxels via column winding number (`'auto'` enables on watertight meshes, default `'auto'`). */
  signed?: 'auto' | boolean;
}

/**
 * Exact isotropic hierarchical 1-Lipschitz SDF baker ported from `wrong-nebula/Fast-SDF-AO/tools/bake_sdf.cpp`.
 */
export function bakeFastSdf(
  geometry: THREE.BufferGeometry,
  opts: BakeFastSdfOptions = {},
  matrixWorld?: THREE.Matrix4,
): FastSdfVolume {
  const t0 = performance.now();
  const tris = extractTriangles(geometry, matrixWorld);
  const reach = opts.reach ?? 1.12;
  const clip = opts.clip ?? Math.max(reach * 1.34, reach + 0.35);
  const B = opts.block ?? 8;
  const maxRes = Math.max(16, opts.maxRes ?? 96);

  const pad = Math.min(clip, reach * 1.08);
  const lo: [number, number, number] = [tris.lo[0] - pad, tris.lo[1] - pad, tris.lo[2] - pad];
  const rawSpan: [number, number, number] = [
    Math.max(0.25, tris.hi[0] - tris.lo[0] + 2 * pad),
    Math.max(0.25, tris.hi[1] - tris.lo[1] + 2 * pad),
    Math.max(0.25, tris.hi[2] - tris.lo[2] + 2 * pad),
  ];
  const maxAxis = Math.max(rawSpan[0], rawSpan[1], rawSpan[2]);
  const targetVox = maxAxis / maxRes;
  const roundBlock = (n: number) => Math.max(B, Math.min(256, Math.ceil(n / B) * B));
  const RX = roundBlock(rawSpan[0] / targetVox);
  const RY = roundBlock(rawSpan[1] / targetVox);
  const RZ = roundBlock(rawSpan[2] / targetVox);
  // Adjust span slightly so voxels remain strictly isotropic where possible
  const span: [number, number, number] = [rawSpan[0], rawSpan[1], rawSpan[2]];
  const vox: [number, number, number] = [span[0] / RX, span[1] / RY, span[2] / RZ];
  const voxelDiag = Math.hypot(vox[0], vox[1], vox[2]);
  const limit = Math.min(clip, reach + voxelDiag);

  const bvh = new CompactClosestBvh(tris);
  const NV = RX * RY * RZ;
  const f32 = new Float32Array(NV);
  const f16 = new Uint16Array(NV);
  const fclip = clip;
  const hclip = floatToHalf(fclip);

  // Precompute conservative half-voxel distance table T0[(z*TW+y)*TW+x] for offsets in [-B, B]
  const TW = 2 * B + 1;
  const dtab = new Float64Array(TW * TW * TW);
  for (let z = -B; z <= B; z++) {
    for (let y = -B; y <= B; y++) {
      for (let x = -B; x <= B; x++) {
        const ox = 0.5 * x * vox[0], oy = 0.5 * y * vox[1], oz = 0.5 * z * vox[2];
        dtab[(z + B) * TW * TW + (y + B) * TW + (x + B)] = Math.hypot(ox, oy, oz) * (1 + 1e-12) + 1e-12;
      }
    }
  }
  const tBase = (B * TW + B) * TW + B;
  const T = (x: number, y: number, z: number) => dtab[tBase + (z * TW + y) * TW + x];
  const halfDiagBlock = 0.5 * voxelDiag * B;

  let queries = 0, culledVoxels = 0, prevTri = -1;

  const nearest = (px: number, py: number, pz: number, lim: number, upper = Infinity): number => {
    queries++;
    const start = Math.min(lim + 1e-9, upper * (1 + 1e-9) + 1e-12);
    let best2 = start * start;
    let tri = -1, skip = -1;
    if (prevTri >= 0) {
      const dp2 = triDist2(
        px, py, pz,
        bvh.pax[prevTri], bvh.pay[prevTri], bvh.paz[prevTri],
        bvh.pbx[prevTri], bvh.pby[prevTri], bvh.pbz[prevTri],
        bvh.pcx[prevTri], bvh.pcy[prevTri], bvh.pcz[prevTri],
      );
      if (dp2 <= best2) { best2 = dp2; tri = prevTri; skip = prevTri; }
    }
    const [d2, hitTri] = bvh.closest(px, py, pz, best2, tri, skip);
    if (hitTri >= 0) prevTri = hitTri;
    const d = Math.sqrt(d2);
    return hitTri >= 0 && d <= lim ? d : Infinity;
  };

  const fillCube = (ox: number, oy: number, oz: number, S: number) => {
    for (let z = 0; z < S; z++) {
      for (let y = 0; y < S; y++) {
        const rowOff = ((oz + z) * RY + (oy + y)) * RX + ox;
        f32.fill(fclip, rowOff, rowOff + S);
        f16.fill(hclip, rowOff, rowOff + S);
      }
    }
  };

  const cube = (ox: number, oy: number, oz: number, S: number, dref: number, rx: number, ry: number, rz: number) => {
    if (S >= 4 && (S & 1) === 0) {
      const h = S >> 1;
      const hd = T(h - 1, h - 1, h - 1);
      for (let cz = 0; cz < 2; cz++) {
        for (let cy = 0; cy < 2; cy++) {
          for (let cx = 0; cx < 2; cx++) {
            const x0 = ox + cx * h, y0 = oy + cy * h, z0 = oz + cz * h;
            const hx = 2 * x0 + h, hy = 2 * y0 + h, hz = 2 * z0 + h;
            const rc = T(hx - rx, hy - ry, hz - rz);
            if (dref - rc - hd > limit) {
              fillCube(x0, y0, z0, h);
              culledVoxels += h * h * h;
              continue;
            }
            if (dref + rc - hd > limit) {
              const ds = nearest(lo[0] + 0.5 * hx * vox[0], lo[1] + 0.5 * hy * vox[1], lo[2] + 0.5 * hz * vox[2], limit + hd, dref + rc);
              if (!Number.isFinite(ds)) {
                fillCube(x0, y0, z0, h);
                culledVoxels += h * h * h;
                continue;
              }
              cube(x0, y0, z0, h, ds, hx, hy, hz);
            } else {
              cube(x0, y0, z0, h, dref, rx, ry, rz);
            }
          }
        }
      }
      return;
    }
    for (let z = 0; z < S; z++) {
      const k = oz + z;
      for (let y = 0; y < S; y++) {
        const j = oy + y;
        const rowOff = (k * RY + j) * RX;
        for (let x = 0; x < S; x++) {
          const i = ox + x;
          const r = T(2 * i + 1 - rx, 2 * j + 1 - ry, 2 * k + 1 - rz);
          if (dref - r > limit) {
            f32[rowOff + i] = fclip;
            f16[rowOff + i] = hclip;
            culledVoxels++;
            continue;
          }
          let d = nearest(
            lo[0] + 0.5 * (2 * i + 1) * vox[0],
            lo[1] + 0.5 * (2 * j + 1) * vox[1],
            lo[2] + 0.5 * (2 * k + 1) * vox[2],
            limit,
            dref + r,
          );
          if (!Number.isFinite(d)) d = clip;
          const val = Math.min(d, clip);
          f32[rowOff + i] = val;
          f16[rowOff + i] = floatToHalf(val);
        }
      }
    }
  };

  const NBX = RX / B, NBY = RY / B, NBZ = RZ / B;
  for (let bz = 0; bz < NBZ; bz++) {
    for (let by = 0; by < NBY; by++) {
      for (let bx = 0; bx < NBX; bx++) {
        const ox = bx * B, oy = by * B, oz = bz * B;
        const rx = 2 * ox + B, ry = 2 * oy + B, rz = 2 * oz + B;
        const dc = nearest(
          lo[0] + 0.5 * rx * vox[0],
          lo[1] + 0.5 * ry * vox[1],
          lo[2] + 0.5 * rz * vox[2],
          limit + halfDiagBlock,
        );
        if (!Number.isFinite(dc)) {
          fillCube(ox, oy, oz, B);
          culledVoxels += B * B * B;
        } else {
          cube(ox, oy, oz, B, dc, rx, ry, rz);
        }
      }
    }
  }

  let doSigned = false;
  if (opts.signed !== false && tris.count > 0) {
    const wtMask = opts.signed === true ? null : findWatertightTriangles(tris);
    const hasClosed = wtMask === null || wtMask.some((v) => v === 1);
    if (hasClosed) {
      doSigned = true;
      const inside = insideMaskYUp(tris, wtMask, lo, span, RX, RY, RZ);
      for (let i = 0; i < NV; i++) {
        if (inside[i]) {
          f32[i] = -f32[i];
          f16[i] ^= 0x8000;
        }
      }
    }
  }

  return {
    lo,
    span,
    dims: [RX, RY, RZ],
    voxelSize: vox,
    voxelDiag,
    clip,
    signed: doSigned,
    f32,
    f16,
    stats: {
      buildMs: +(performance.now() - t0).toFixed(2),
      queries,
      culledVoxels,
      totalVoxels: NV,
    },
  };
}

/** Hardware-equivalent trilinear sample of `FastSdfVolume` (`voxel i` centred at `lo + (i + 0.5) * vox`). */
export function sampleFastSdf(vol: FastSdfVolume, wx: number, wy: number, wz: number): number {
  const [RX, RY, RZ] = vol.dims;
  const fx = (wx - vol.lo[0]) / vol.voxelSize[0] - 0.5;
  const fy = (wy - vol.lo[1]) / vol.voxelSize[1] - 0.5;
  const fz = (wz - vol.lo[2]) / vol.voxelSize[2] - 0.5;
  if (fx < -0.5 || fy < -0.5 || fz < -0.5 || fx > RX - 0.5 || fy > RY - 0.5 || fz > RZ - 0.5) return vol.clip;
  const cx = Math.max(0, Math.min(RX - 1.000001, fx));
  const cy = Math.max(0, Math.min(RY - 1.000001, fy));
  const cz = Math.max(0, Math.min(RZ - 1.000001, fz));
  const x0 = cx | 0, tx = cx - x0, x1 = Math.min(RX - 1, x0 + 1);
  const y0 = cy | 0, ty = cy - y0, y1 = Math.min(RY - 1, y0 + 1);
  const z0 = cz | 0, tz = cz - z0, z1 = Math.min(RZ - 1, z0 + 1);
  const f = vol.f32;
  const sY = RX, sZ = RX * RY;
  const b00 = z0 * sZ + y0 * sY, b10 = z0 * sZ + y1 * sY;
  const b01 = z1 * sZ + y0 * sY, b11 = z1 * sZ + y1 * sY;
  const c00 = f[b00 + x0] * (1 - tx) + f[b00 + x1] * tx;
  const c10 = f[b10 + x0] * (1 - tx) + f[b10 + x1] * tx;
  const c01 = f[b01 + x0] * (1 - tx) + f[b01 + x1] * tx;
  const c11 = f[b11 + x0] * (1 - tx) + f[b11 + x1] * tx;
  return (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
}

/**
 * Refitted 4-tap `aoWallCorrection` formula from `wrong-nebula/Fast-SDF-AO/accuracy/ao_formula.py`
 * (adapted to Three.js Y-up coordinates, scaled proportionally to `radius / 1.12`).
 */
export function fastSdfWallFormula(
  vol: FastSdfVolume,
  px: number, py: number, pz: number,
  nx: number, ny: number, nz: number,
  radius = 1.12,
  wall = 0,
): number {
  const s = radius / 1.12;
  const invS = 1 / s;
  const r0 = 0.16, r1 = 0.48, r2 = 0.8, r3 = 1.12;
  const ny2 = ny * ny;
  const d0 = sampleFastSdf(vol, px + nx * r0 * s, py + ny * r0 * s, pz + nz * r0 * s) * invS;
  const d1 = sampleFastSdf(vol, px + nx * r1 * s, py + ny * r1 * s, pz + nz * r1 * s) * invS;
  // Third tap on vertical faces: 0.7 m out, 0.4 m down (-Y); 0.8 m along normal on horizontal faces
  const d2 = sampleFastSdf(
    vol,
    px + nx * 0.7 * s,
    py + (ny * (0.7 + 0.1 * ny2) - 0.4 * (1 - ny2)) * s,
    pz + nz * 0.7 * s,
  ) * invS;
  // Fourth tap: 1.12 m along normal on floors/tops; 0.8 m tilted 45° up (+Y) on vertical faces
  const d3 = sampleFastSdf(
    vol,
    px + nx * 0.5657 * s,
    py + (ny * (0.5657 + 0.5543 * ny2) + 0.5657 * (1 - ny2)) * s,
    pz + nz * 0.5657 * s,
  ) * invS;

  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const vertical = wall * (1 - Math.abs(ny));
  const k = 0.92 / 2.9;

  const v0 = clamp01(1 - (d0 + 0.1523) / r0);
  const v1 = clamp01(1 - (d1 - 0.0624) / r1);
  const v2 = clamp01(1 - (d2 + 0.4135) / r2);
  const v3 = clamp01(1 - (d3 - 0.2624) / 0.8);
  const walls = clamp01(1.1356 - (7.212 * v0 * v0 + 0.4812 * v1 + 0.1365 * v2 + 0.1172 * v3));

  const s0 = clamp01(1 - (d0 + 0.024) / r0);
  const s1 = clamp01(1 - (d1 + 0.078) / r1);
  const s2 = clamp01(1 - d2 / r2);
  const s3c = clamp01(1 - (d3 + 0.02) / r3);
  const s3p2 = s3c * s3c, s3p4 = s3p2 * s3p2, s3 = s3p4 * s3p4;
  const flat = clamp01(1 - k * (s0 * s0 + 0.8166666667 * Math.sqrt(s1) + 0.6333333333 * Math.sqrt(s2) + 0.45 * s3));

  const u0 = clamp01(1 - (d0 - 0.0644) / r0);
  const u1 = clamp01(1 - (d1 + 0.0633) / r1);
  const u2 = clamp01(1 - (d2 + 0.1349) / 0.8);
  const u3 = clamp01(1 - (d3 + 0.1475) / 0.8);
  const side = clamp01(1.106 - (0.1429 * u0 * u0 + 0.1795 * Math.sqrt(u1) + 0.2928 * Math.sqrt(u2) + 0.2654 * u3));

  const tuned = ny > 0.7 ? flat : side;
  return walls * vertical + tuned * (1 - vertical);
}

// ------------------------------------------------------------------ Quantized SAH Contact BVH (`contact-bvh.js`)

const SAH_BINS = 8;

export interface FastContactBvh {
  nodeData: Uint32Array;
  nodeLen: number;
  ordIdx: Int32Array;
  ordLen: number;
  v0x: Float32Array; v0y: Float32Array; v0z: Float32Array;
  e1x: Float32Array; e1y: Float32Array; e1z: Float32Array;
  e2x: Float32Array; e2y: Float32Array; e2z: Float32Array;
  triCount: number;
  gridData: Uint32Array;
  gridMin: [number, number, number];
  gridDims: [number, number, number];
  gridSize: number;
  rootMin: [number, number, number];
  rootSpan: [number, number, number];
  range: number;
  bias: number;
  bytes: number;
  buildMs: number;
}

/**
 * Port of `buildContactBVH` from `wrong-nebula/Fast-SDF-AO/contact-bvh.js`:
 * O(T) 2-pass CSR AABB-to-cell binning + cell-clipped 8-bin SAH + conservative 16-bit RGBA32UI node quantization.
 */
export function buildFastContactBvh(
  geometry: THREE.BufferGeometry,
  opts: { gridSize?: number; range?: number; bias?: number; max3DTextureSize?: number } = {},
  matrixWorld?: THREE.Matrix4,
): FastContactBvh {
  const t0 = performance.now();
  const range = opts.range ?? 0.25;
  const bias = opts.bias ?? 0.0003;
  const max3D = opts.max3DTextureSize ?? 256;
  const tris = extractTriangles(geometry, matrixWorld);
  const triCount = tris.count;

  const v0x = new Float32Array(triCount), v0y = new Float32Array(triCount), v0z = new Float32Array(triCount);
  const e1x = new Float32Array(triCount), e1y = new Float32Array(triCount), e1z = new Float32Array(triCount);
  const e2x = new Float32Array(triCount), e2y = new Float32Array(triCount), e2z = new Float32Array(triCount);
  const tLoX = new Float32Array(triCount), tLoY = new Float32Array(triCount), tLoZ = new Float32Array(triCount);
  const tHiX = new Float32Array(triCount), tHiY = new Float32Array(triCount), tHiZ = new Float32Array(triCount);
  const tCenX = new Float32Array(triCount), tCenY = new Float32Array(triCount), tCenZ = new Float32Array(triCount);

  for (let i = 0; i < triCount; i++) {
    const x0 = tris.ax[i], y0 = tris.ay[i], z0 = tris.az[i];
    const x1 = tris.bx[i], y1 = tris.by[i], z1 = tris.bz[i];
    const x2 = tris.cx[i], y2 = tris.cy[i], z2 = tris.cz[i];
    v0x[i] = x0; v0y[i] = y0; v0z[i] = z0;
    e1x[i] = x1 - x0; e1y[i] = y1 - y0; e1z[i] = z1 - z0;
    e2x[i] = x2 - x0; e2y[i] = y2 - y0; e2z[i] = z2 - z0;
    const lx = Math.min(x0, x1, x2), ly = Math.min(y0, y1, y2), lz = Math.min(z0, z1, z2);
    const hx = Math.max(x0, x1, x2), hy = Math.max(y0, y1, y2), hz = Math.max(z0, z1, z2);
    tLoX[i] = lx; tLoY[i] = ly; tLoZ[i] = lz;
    tHiX[i] = hx; tHiY[i] = hy; tHiZ[i] = hz;
    tCenX[i] = 0.5 * (lx + hx); tCenY[i] = 0.5 * (ly + hy); tCenZ[i] = 0.5 * (lz + hz);
  }

  let nodeCap = Math.max(256, triCount * 4), nodeLen = 0;
  let nodeData = new Uint32Array(nodeCap * 4);
  let ordCap = Math.max(256, triCount * 4), ordLen = 0;
  let ordIdx = new Int32Array(ordCap);

  const ensureNodes = (extra: number) => {
    if (nodeLen + extra <= nodeCap) return;
    while (nodeLen + extra > nodeCap) nodeCap *= 2;
    const next = new Uint32Array(nodeCap * 4);
    next.set(nodeData.subarray(0, nodeLen * 4));
    nodeData = next;
  };
  const ensureOrd = (extra: number) => {
    if (ordLen + extra <= ordCap) return;
    while (ordLen + extra > ordCap) ordCap *= 2;
    const next = new Int32Array(ordCap);
    next.set(ordIdx.subarray(0, ordLen));
    ordIdx = next;
  };

  const workCap = Math.max(256, triCount);
  const wIdx = new Int32Array(workCap);
  const wLoX = new Float32Array(workCap), wLoY = new Float32Array(workCap), wLoZ = new Float32Array(workCap);
  const wHiX = new Float32Array(workCap), wHiY = new Float32Array(workCap), wHiZ = new Float32Array(workCap);
  const wCX = new Float32Array(workCap), wCY = new Float32Array(workCap), wCZ = new Float32Array(workCap);
  const bLoX = new Float32Array(SAH_BINS), bLoY = new Float32Array(SAH_BINS), bLoZ = new Float32Array(SAH_BINS);
  const bHiX = new Float32Array(SAH_BINS), bHiY = new Float32Array(SAH_BINS), bHiZ = new Float32Array(SAH_BINS);
  const bCnt = new Int32Array(SAH_BINS), rArea = new Float32Array(SAH_BINS), rCnt = new Int32Array(SAH_BINS);

  let qMinX = 0, qMinY = 0, qMinZ = 0, qInvX = 1, qInvY = 1, qInvZ = 1;
  const packBox = (at: number, lx: number, ly: number, lz: number, hx: number, hy: number, hz: number, meta: number) => {
    const qlx = Math.max(0, Math.min(65535, Math.floor((lx - qMinX) * qInvX)));
    const qly = Math.max(0, Math.min(65535, Math.floor((ly - qMinY) * qInvY)));
    const qlz = Math.max(0, Math.min(65535, Math.floor((lz - qMinZ) * qInvZ)));
    const qhx = Math.max(qlx, Math.min(65535, Math.ceil((hx - qMinX) * qInvX)));
    const qhy = Math.max(qly, Math.min(65535, Math.ceil((hy - qMinY) * qInvY)));
    const qhz = Math.max(qlz, Math.min(65535, Math.ceil((hz - qMinZ) * qInvZ)));
    const o = at * 4;
    nodeData[o] = (qlx | (qly << 16)) >>> 0;
    nodeData[o + 1] = (qlz | (qhx << 16)) >>> 0;
    nodeData[o + 2] = (qhy | (qhz << 16)) >>> 0;
    nodeData[o + 3] = meta >>> 0;
  };

  const buildSubtree = (s: number, e: number): number => {
    ensureNodes(1);
    const at = nodeLen++;
    let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity;
    let clx = Infinity, cly = Infinity, clz = Infinity, chx = -Infinity, chy = -Infinity, chz = -Infinity;
    for (let i = s; i < e; i++) {
      const k = wIdx[i];
      if (wLoX[k] < lx) lx = wLoX[k]; if (wLoY[k] < ly) ly = wLoY[k]; if (wLoZ[k] < lz) lz = wLoZ[k];
      if (wHiX[k] > hx) hx = wHiX[k]; if (wHiY[k] > hy) hy = wHiY[k]; if (wHiZ[k] > hz) hz = wHiZ[k];
      if (wCX[k] < clx) clx = wCX[k]; if (wCY[k] < cly) cly = wCY[k]; if (wCZ[k] < clz) clz = wCZ[k];
      if (wCX[k] > chx) chx = wCX[k]; if (wCY[k] > chy) chy = wCY[k]; if (wCZ[k] > chz) chz = wCZ[k];
    }
    const n = e - s;
    if (n <= 4) {
      ensureOrd(n);
      const first = ordLen;
      for (let i = s; i < e; i++) ordIdx[ordLen++] = wIdx[i];
      packBox(at, lx, ly, lz, hx, hy, hz, (0x80000000 | ((first << 3) | n)) >>> 0);
      return at;
    }

    const extX = chx - clx, extY = chy - cly, extZ = chz - clz;
    let bestCost = Infinity, bestAx = -1, bestBin = 0;
    for (let ax = 0; ax < 3; ax++) {
      const cLo = ax === 0 ? clx : ax === 1 ? cly : clz;
      const ext = ax === 0 ? extX : ax === 1 ? extY : extZ;
      if (ext <= 1e-7) continue;
      const sc = SAH_BINS / ext;
      const cArr = ax === 0 ? wCX : ax === 1 ? wCY : wCZ;
      for (let b = 0; b < SAH_BINS; b++) {
        bCnt[b] = 0;
        bLoX[b] = bLoY[b] = bLoZ[b] = Infinity;
        bHiX[b] = bHiY[b] = bHiZ[b] = -Infinity;
      }
      for (let i = s; i < e; i++) {
        const k = wIdx[i];
        let bi = ((cArr[k] - cLo) * sc) | 0;
        if (bi >= SAH_BINS) bi = SAH_BINS - 1; else if (bi < 0) bi = 0;
        bCnt[bi]++;
        if (wLoX[k] < bLoX[bi]) bLoX[bi] = wLoX[k];
        if (wLoY[k] < bLoY[bi]) bLoY[bi] = wLoY[k];
        if (wLoZ[k] < bLoZ[bi]) bLoZ[bi] = wLoZ[k];
        if (wHiX[k] > bHiX[bi]) bHiX[bi] = wHiX[k];
        if (wHiY[k] > bHiY[bi]) bHiY[bi] = wHiY[k];
        if (wHiZ[k] > bHiZ[bi]) bHiZ[bi] = wHiZ[k];
      }
      let rlx = Infinity, rly = Infinity, rlz = Infinity, rhx = -Infinity, rhy = -Infinity, rhz = -Infinity, rc = 0;
      for (let b = SAH_BINS - 1; b > 0; b--) {
        rc += bCnt[b];
        if (bLoX[b] < rlx) rlx = bLoX[b]; if (bLoY[b] < rly) rly = bLoY[b]; if (bLoZ[b] < rlz) rlz = bLoZ[b];
        if (bHiX[b] > rhx) rhx = bHiX[b]; if (bHiY[b] > rhy) rhy = bHiY[b]; if (bHiZ[b] > rhz) rhz = bHiZ[b];
        rCnt[b] = rc;
        const dx = rhx - rlx, dy = rhy - rly, dz = rhz - rlz;
        rArea[b] = rc ? dx * dy + dy * dz + dz * dx : 0;
      }
      let llx = Infinity, lly = Infinity, llz = Infinity, lhx = -Infinity, lhy = -Infinity, lhz = -Infinity, lc = 0;
      for (let b = 0; b < SAH_BINS - 1; b++) {
        lc += bCnt[b];
        if (bLoX[b] < llx) llx = bLoX[b]; if (bLoY[b] < lly) lly = bLoY[b]; if (bLoZ[b] < llz) llz = bLoZ[b];
        if (bHiX[b] > lhx) lhx = bHiX[b]; if (bHiY[b] > lhy) lhy = bHiY[b]; if (bHiZ[b] > lhz) lhz = bHiZ[b];
        if (!lc || !rCnt[b + 1]) continue;
        const dx = lhx - llx, dy = lhy - lly, dz = lhz - llz;
        const cost = (dx * dy + dy * dz + dz * dx) * lc + rArea[b + 1] * rCnt[b + 1];
        if (cost < bestCost) { bestCost = cost; bestAx = ax; bestBin = b + 1; }
      }
    }

    let m = s, splitAx = 0;
    if (bestAx >= 0) {
      splitAx = bestAx;
      const cLo = bestAx === 0 ? clx : bestAx === 1 ? cly : clz;
      const ext = bestAx === 0 ? extX : bestAx === 1 ? extY : extZ;
      const sc = SAH_BINS / ext;
      const cArr = bestAx === 0 ? wCX : bestAx === 1 ? wCY : wCZ;
      let i = s, j = e - 1;
      while (i <= j) {
        let bi = ((cArr[wIdx[i]] - cLo) * sc) | 0;
        if (bi >= SAH_BINS) bi = SAH_BINS - 1; else if (bi < 0) bi = 0;
        if (bi < bestBin) i++;
        else { const tmp = wIdx[i]; wIdx[i] = wIdx[j]; wIdx[j] = tmp; j--; }
      }
      m = i;
    }
    if (m <= s || m >= e) {
      const spX = hx - lx, spY = hy - ly, spZ = hz - lz;
      splitAx = spX >= spY && spX >= spZ ? 0 : spY >= spZ ? 1 : 2;
      m = (s + e) >> 1;
    }

    buildSubtree(s, m);
    const right = buildSubtree(m, e);
    packBox(at, lx, ly, lz, hx, hy, hz, (((splitAx & 3) << 29) | (right & 0x1fffffff)) >>> 0);
    return at;
  };

  const [gLoX, gLoY, gLoZ] = tris.lo;
  const [gHiX, gHiY, gHiZ] = tris.hi;
  const maxSpan = Math.max(gHiX - gLoX, gHiY - gLoY, gHiZ - gLoZ, 1);
  let gridSize = opts.gridSize ?? 1.0;
  if (gridSize > 0 && Math.floor(maxSpan / gridSize) + 2 > max3D) {
    gridSize = Math.ceil((maxSpan / (max3D - 2)) * 100) / 100;
  }

  let gridData = new Uint32Array(2);
  let gridMin: [number, number, number] = [0, 0, 0];
  let gridDims: [number, number, number] = [1, 1, 1];
  let rootMin: [number, number, number] = [0, 0, 0];
  let rootSpan: [number, number, number] = [1, 1, 1];

  if (gridSize > 0 && triCount > 0) {
    gridMin = [Math.floor(gLoX / gridSize) * gridSize, Math.floor(gLoY / gridSize) * gridSize, Math.floor(gLoZ / gridSize) * gridSize];
    gridDims = [
      Math.floor((gHiX - gridMin[0]) / gridSize) + 1,
      Math.floor((gHiY - gridMin[1]) / gridSize) + 1,
      Math.floor((gHiZ - gridMin[2]) / gridSize) + 1,
    ];
    const [gx, gy, gz] = gridDims;
    const nCells = gx * gy * gz;
    const invG = 1 / gridSize;
    const expand = range + Math.abs(bias);

    const counts = new Int32Array(nCells);
    for (let i = 0; i < triCount; i++) {
      const x0 = Math.max(0, Math.floor((tLoX[i] - expand - gridMin[0]) * invG));
      const x1 = Math.min(gx - 1, Math.floor((tHiX[i] + expand - gridMin[0]) * invG));
      const y0 = Math.max(0, Math.floor((tLoY[i] - expand - gridMin[1]) * invG));
      const y1 = Math.min(gy - 1, Math.floor((tHiY[i] + expand - gridMin[1]) * invG));
      const z0 = Math.max(0, Math.floor((tLoZ[i] - expand - gridMin[2]) * invG));
      const z1 = Math.min(gz - 1, Math.floor((tHiZ[i] + expand - gridMin[2]) * invG));
      for (let z = z0; z <= z1; z++) {
        for (let y = y0; y <= y1; y++) {
          let off = (z * gy + y) * gx + x0;
          for (let x = x0; x <= x1; x++, off++) counts[off]++;
        }
      }
    }
    const offsets = new Int32Array(nCells + 1);
    for (let c = 0; c < nCells; c++) offsets[c + 1] = offsets[c] + counts[c];
    const cellTris = new Int32Array(offsets[nCells]);
    const cursor = new Int32Array(offsets.subarray(0, nCells));
    for (let i = 0; i < triCount; i++) {
      const x0 = Math.max(0, Math.floor((tLoX[i] - expand - gridMin[0]) * invG));
      const x1 = Math.min(gx - 1, Math.floor((tHiX[i] + expand - gridMin[0]) * invG));
      const y0 = Math.max(0, Math.floor((tLoY[i] - expand - gridMin[1]) * invG));
      const y1 = Math.min(gy - 1, Math.floor((tHiY[i] + expand - gridMin[1]) * invG));
      const z0 = Math.max(0, Math.floor((tLoZ[i] - expand - gridMin[2]) * invG));
      const z1 = Math.min(gz - 1, Math.floor((tHiZ[i] + expand - gridMin[2]) * invG));
      for (let z = z0; z <= z1; z++) {
        for (let y = y0; y <= y1; y++) {
          let off = (z * gy + y) * gx + x0;
          for (let x = x0; x <= x1; x++, off++) cellTris[cursor[off]++] = i;
        }
      }
    }

    gridData = new Uint32Array(nCells * 2);
    const cellSpan = gridSize + 2 * expand;
    const invSpan = 65535 / cellSpan;
    for (let z = 0; z < gz; z++) {
      for (let y = 0; y < gy; y++) {
        for (let x = 0; x < gx; x++) {
          const cid = (z * gy + y) * gx + x;
          const cStart = offsets[cid], cEnd = offsets[cid + 1], cLen = cEnd - cStart;
          const first = nodeLen;
          if (cLen > 0) {
            const clx = gridMin[0] + x * gridSize - expand;
            const cly = gridMin[1] + y * gridSize - expand;
            const clz = gridMin[2] + z * gridSize - expand;
            const chx = clx + cellSpan, chy = cly + cellSpan, chz = clz + cellSpan;
            qMinX = clx; qMinY = cly; qMinZ = clz;
            qInvX = invSpan; qInvY = invSpan; qInvZ = invSpan;
            for (let i = 0; i < cLen; i++) {
              const k = cellTris[cStart + i];
              wIdx[i] = k;
              const lx = tLoX[k] > clx ? tLoX[k] : clx;
              const ly = tLoY[k] > cly ? tLoY[k] : cly;
              const lz = tLoZ[k] > clz ? tLoZ[k] : clz;
              const hx = tHiX[k] < chx ? tHiX[k] : chx;
              const hy = tHiY[k] < chy ? tHiY[k] : chy;
              const hz = tHiZ[k] < chz ? tHiZ[k] : chz;
              wLoX[k] = lx; wLoY[k] = ly; wLoZ[k] = lz;
              wHiX[k] = hx; wHiY[k] = hy; wHiZ[k] = hz;
              wCX[k] = 0.5 * (lx + hx); wCY[k] = 0.5 * (ly + hy); wCZ[k] = 0.5 * (lz + hz);
            }
            buildSubtree(0, cLen);
          }
          gridData[cid * 2] = first;
          gridData[cid * 2 + 1] = nodeLen;
        }
      }
    }
  } else if (triCount > 0) {
    const pad = 1e-4;
    rootMin = [gLoX - pad, gLoY - pad, gLoZ - pad];
    rootSpan = [Math.max(gHiX - gLoX + 2 * pad, 1e-3), Math.max(gHiY - gLoY + 2 * pad, 1e-3), Math.max(gHiZ - gLoZ + 2 * pad, 1e-3)];
    qMinX = rootMin[0]; qMinY = rootMin[1]; qMinZ = rootMin[2];
    qInvX = 65535 / rootSpan[0]; qInvY = 65535 / rootSpan[1]; qInvZ = 65535 / rootSpan[2];
    for (let i = 0; i < triCount; i++) {
      wIdx[i] = i;
      wLoX[i] = tLoX[i]; wLoY[i] = tLoY[i]; wLoZ[i] = tLoZ[i];
      wHiX[i] = tHiX[i]; wHiY[i] = tHiY[i]; wHiZ[i] = tHiZ[i];
      wCX[i] = tCenX[i]; wCY[i] = tCenY[i]; wCZ[i] = tCenZ[i];
    }
    buildSubtree(0, triCount);
  }

  const trimmedNodes = nodeData.subarray(0, nodeLen * 4);
  const trimmedOrd = ordIdx.subarray(0, ordLen);
  return {
    nodeData: trimmedNodes,
    nodeLen,
    ordIdx: trimmedOrd,
    ordLen,
    v0x, v0y, v0z, e1x, e1y, e1z, e2x, e2y, e2z,
    triCount,
    gridData,
    gridMin,
    gridDims,
    gridSize,
    rootMin,
    rootSpan,
    range,
    bias,
    bytes: trimmedNodes.byteLength + trimmedOrd.byteLength + triCount * 36 + gridData.byteLength,
    buildMs: +(performance.now() - t0).toFixed(2),
  };
}

const cpuStack = new Int32Array(32);

/**
 * CPU mirror of `contactBlocked` in `contact-bvh.js` (returns closest hit distance in `(0, contactRange]` or `-1`).
 */
export function contactHitDistance(
  cbvh: FastContactBvh,
  px: number, py: number, pz: number,
  nx: number, ny: number, nz: number,
  wx: number, wy: number, wz: number,
  contactRange = cbvh.range,
): number {
  const ox = px + nx * cbvh.bias, oy = py + ny * cbvh.bias, oz = pz + nz * cbvh.bias;
  const invX = 1 / (Math.abs(wx) > 1e-20 ? wx : 1e-20);
  const invY = 1 / (Math.abs(wy) > 1e-20 ? wy : 1e-20);
  const invZ = 1 / (Math.abs(wz) > 1e-20 ? wz : 1e-20);

  let root = 0, end = cbvh.nodeLen;
  let qMinX = cbvh.rootMin[0], qMinY = cbvh.rootMin[1], qMinZ = cbvh.rootMin[2];
  let qSpanX = cbvh.rootSpan[0], qSpanY = cbvh.rootSpan[1], qSpanZ = cbvh.rootSpan[2];

  if (cbvh.gridSize > 0) {
    const cx = Math.floor((px - cbvh.gridMin[0]) / cbvh.gridSize);
    const cy = Math.floor((py - cbvh.gridMin[1]) / cbvh.gridSize);
    const cz = Math.floor((pz - cbvh.gridMin[2]) / cbvh.gridSize);
    const [gx, gy, gz] = cbvh.gridDims;
    if (cx < 0 || cy < 0 || cz < 0 || cx >= gx || cy >= gy || cz >= gz) return -1;
    const cid = ((cz * gy + cy) * gx + cx) * 2;
    root = cbvh.gridData[cid];
    end = cbvh.gridData[cid + 1];
    if (root >= end) return -1;
    const expand = cbvh.range + Math.abs(cbvh.bias);
    qMinX = cbvh.gridMin[0] + cx * cbvh.gridSize - expand;
    qMinY = cbvh.gridMin[1] + cy * cbvh.gridSize - expand;
    qMinZ = cbvh.gridMin[2] + cz * cbvh.gridSize - expand;
    qSpanX = qSpanY = qSpanZ = cbvh.gridSize + 2 * expand;
  } else if (end <= 0) {
    return -1;
  }

  const sX = qSpanX / 65535, sY = qSpanY / 65535, sZ = qSpanZ / 65535;
  const nd = cbvh.nodeData, ord = cbvh.ordIdx;
  let sp = 0, node = root, bestDist = contactRange + 1;

  for (let visit = 0; visit < 2048; visit++) {
    const o = node * 4;
    const nx0 = nd[o], ny0 = nd[o + 1], nz0 = nd[o + 2], meta = nd[o + 3];
    const lx = qMinX + (nx0 & 0xffff) * sX, ly = qMinY + (nx0 >>> 16) * sY, lz = qMinZ + (ny0 & 0xffff) * sZ;
    const hx = qMinX + (ny0 >>> 16) * sX, hy = qMinY + (nz0 & 0xffff) * sY, hz = qMinZ + (nz0 >>> 16) * sZ;
    const ax = (lx - ox) * invX, bx = (hx - ox) * invX;
    const ay = (ly - oy) * invY, by = (hy - oy) * invY;
    const az = (lz - oz) * invZ, bz = (hz - oz) * invZ;
    const t0 = Math.max(0, Math.min(ax, bx), Math.min(ay, by), Math.min(az, bz));
    const t1 = Math.min(Math.min(contactRange, bestDist), Math.max(ax, bx), Math.max(ay, by), Math.max(az, bz));
    if (t1 >= t0) {
      if ((meta & 0x80000000) !== 0) {
        const first = (meta & 0x7fffffff) >>> 3;
        const count = meta & 7;
        for (let j = 0; j < count; j++) {
          const tri = ord[first + j];
          const e1x = cbvh.e1x[tri], e1y = cbvh.e1y[tri], e1z = cbvh.e1z[tri];
          const e2x = cbvh.e2x[tri], e2y = cbvh.e2y[tri], e2z = cbvh.e2z[tri];
          const hxC = wy * e2z - wz * e2y;
          const hyC = wz * e2x - wx * e2z;
          const hzC = wx * e2y - wy * e2x;
          const det = e1x * hxC + e1y * hyC + e1z * hzC;
          if (Math.abs(det) < 1e-10) continue;
          const invDet = 1 / det;
          const sx = ox - cbvh.v0x[tri], sy = oy - cbvh.v0y[tri], sz = oz - cbvh.v0z[tri];
          const u = (sx * hxC + sy * hyC + sz * hzC) * invDet;
          if (u < -1e-6 || u > 1 + 1e-6) continue;
          const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
          const v = (wx * qx + wy * qy + wz * qz) * invDet;
          if (v < -1e-6 || u + v > 1 + 1e-6) continue;
          const dist = (e2x * qx + e2y * qy + e2z * qz) * invDet;
          if (dist > 0 && dist <= contactRange && dist < bestDist) bestDist = dist;
        }
      } else {
        const axis = meta >>> 29;
        const right = meta & 0x1fffffff;
        const left = node + 1;
        const neg = (axis === 0 ? wx : axis === 1 ? wy : wz) < 0;
        const firstChild = neg ? right : left;
        const secondChild = neg ? left : right;
        if (sp < 24) cpuStack[sp++] = secondChild;
        node = firstChild;
        continue;
      }
    }
    if (sp === 0) break;
    node = cpuStack[--sp];
  }
  return bestDist <= contactRange ? bestDist : -1;
}

// ------------------------------------------------------------------ Halton(2, 3) + IGN Sampling

export function vdc2(bits: number): number {
  let b = bits >>> 0;
  b = ((b << 16) | (b >>> 16)) >>> 0;
  b = (((b & 0x55555555) << 1) | ((b & 0xaaaaaaaa) >>> 1)) >>> 0;
  b = (((b & 0x33333333) << 2) | ((b & 0xcccccccc) >>> 2)) >>> 0;
  b = (((b & 0x0f0f0f0f) << 4) | ((b & 0xf0f0f0f0) >>> 4)) >>> 0;
  b = (((b & 0x00ff00ff) << 8) | ((b & 0xff00ff00) >>> 8)) >>> 0;
  return b * 2.3283064365386963e-10;
}

export function vdc3(n: number): number {
  let rem = n >>> 0, f = 1, r = 0;
  for (let j = 0; j < 8 && rem > 0; j++) {
    f /= 3;
    r += f * (rem % 3);
    rem = (rem / 3) | 0;
  }
  return r;
}

function ign(x: number, y: number): number {
  const v = 52.9829189 * ((0.06711056 * x + 0.00583715 * y) % 1);
  return v - Math.floor(v);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Exact hybrid Traced SDF + Contact BVH + Halton(2, 3) + IGN openness & bent-normal evaluator from `contact-bvh.js`.
 */
export function fastSdfTracedOpenness(
  vol: FastSdfVolume,
  cbvh: FastContactBvh,
  px: number, py: number, pz: number,
  nx: number, ny: number, nz: number,
  opts: { rays?: number; radius?: number; falloff?: FastSdfFalloff; pixelX?: number; pixelY?: number; outBent?: Float32Array; bentOffset?: number } = {},
): number {
  const rays = Math.max(1, opts.rays ?? 24);
  const radius = opts.radius ?? 1.12;
  const rScale = radius / 1.12;
  const falloff = opts.falloff ?? 'linear';
  const contactRange = Math.min(radius, cbvh.range);

  const nLen = Math.hypot(nx, ny, nz) || 1;
  const ux = nx / nLen, uy = ny / nLen, uz = nz / nLen;
  // Tangent frame matching `candidateAOBent` in `contact-bvh.js`
  const ax = Math.abs(ux) < 0.9 ? 1 : 0, ay = Math.abs(ux) < 0.9 ? 0 : 1, az = 0;
  let tx = uy * az - uz * ay, ty = uz * ax - ux * az, tz = ux * ay - uy * ax;
  const tLen = Math.hypot(tx, ty, tz) || 1;
  tx /= tLen; ty /= tLen; tz /= tLen;
  const bx = uy * tz - uz * ty, by = uz * tx - ux * tz, bz = ux * ty - uy * tx;

  const fx = opts.pixelX ?? (px * 137.3 + pz * 53.7);
  const fy = opts.pixelY ?? (py * 97.1 + px * 29.3);
  const su = ign(fx, fy);
  const sp = ign(fx + 37, fy + 17);

  let visSum = 0;
  let bentX = 0, bentY = 0, bentZ = 0;
  // Partition `rays` into virtual frames of 4 rays matching Fast-SDF-AO's `candidateAOBent` stratification
  const frames = Math.ceil(rays / 4);
  let traced = 0;

  for (let frame = 0; frame < frames && traced < rays; frame++) {
    const nd = Math.min(4, rays - traced);
    const fu = (su + vdc2(frame)) % 1;
    const base = frame * 4;
    for (let i = 0; i < nd; i++, traced++) {
      const u = Math.max(1e-4, Math.min(0.9999, (i + fu) / nd));
      const phi = 6.283185307179586 * ((sp + vdc3(base + i)) % 1);
      const ru = Math.sqrt(u), cosn = Math.sqrt(1 - u);
      const cPhi = Math.cos(phi), sPhi = Math.sin(phi);
      const wx = tx * (ru * cPhi) + bx * (ru * sPhi) + ux * cosn;
      const wy = ty * (ru * cPhi) + by * (ru * sPhi) + uy * cosn;
      const wz = tz * (ru * cPhi) + bz * (ru * sPhi) + uz * cosn;

      const hitDist = contactHitDistance(cbvh, px, py, pz, ux, uy, uz, wx, wy, wz, contactRange);
      if (hitDist >= 0) {
        const vHit = falloff === 'linear' ? Math.max(0, hitDist / radius) : 0;
        visSum += vHit;
        bentX += wx * vHit; bentY += wy * vHit; bentZ += wz * vHit;
        continue;
      }

      let s = contactRange;
      let v = 1;
      const minStep = 0.028 * rScale;
      const eCap = 0.025 * rScale;
      for (let k = 0; k < 24 && s <= radius; k++) {
        const d = sampleFastSdf(vol, px + wx * s, py + wy * s, pz + wz * s);
        const e = Math.max(Math.min(eCap, 0.1 * s * cosn), 1e-6);
        let stepVis = Math.max(0, Math.min(1, (d + e) / (4 * e)));
        if (falloff === 'smooth') {
          const fade = smoothstep(radius, 0.642857 * radius, s);
          stepVis = 1 + (stepVis - 1) * fade;
        } else if (falloff === 'linear') {
          const fade = Math.max(0, 1 - s / radius);
          stepVis = 1 + (stepVis - 1) * fade;
        }
        if (stepVis < v) v = stepVis;
        if (v < 0.01) break;
        s += Math.max(d, minStep);
      }
      visSum += v;
      bentX += wx * v; bentY += wy * v; bentZ += wz * v;
    }
  }

  if (opts.outBent) {
    const bo = opts.bentOffset ?? 0;
    const bl = Math.hypot(bentX, bentY, bentZ);
    if (bl > 1e-4) {
      opts.outBent[bo] = bentX / bl;
      opts.outBent[bo + 1] = bentY / bl;
      opts.outBent[bo + 2] = bentZ / bl;
    } else {
      opts.outBent[bo] = ux;
      opts.outBent[bo + 1] = uy;
      opts.outBent[bo + 2] = uz;
    }
  }
  return visSum / rays;
}

// ------------------------------------------------------------------ WebGL2 GPU Atlas Shader (`CONTACT_GLSL`)

const FAST_SDF_ATLAS_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler3D;
precision highp usampler2D;
precision highp usampler3D;

uniform sampler2D uTexelPos;
uniform sampler2D uTexelNrm;
uniform sampler3D uSdfTex;
uniform vec3 uSdfLo;
uniform vec3 uSdfSpan;
uniform float uSdfClip;

uniform usampler2D contactNodes;
uniform usampler2D contactTriIdx;
uniform sampler2D contactTriangles;
uniform usampler3D contactGrid;
uniform vec3 contactGridMin;
uniform float contactGridSize;
uniform vec3 contactRootMin;
uniform vec3 contactRootSpan;
uniform int contactNodeCount;
uniform float contactRange;
uniform float contactBias;

uniform float uRadius;
uniform int uFrames;
uniform int uFalloffMode; // 0 = linear, 1 = smooth, 2 = hard

layout(location = 0) out vec4 outAoBent;

vec4 contactFetch(sampler2D tex, int i) {
  int width = textureSize(tex, 0).x;
  return texelFetch(tex, ivec2(i % width, i / width), 0);
}
uvec4 contactFetchNode(int i) {
  int width = textureSize(contactNodes, 0).x;
  return texelFetch(contactNodes, ivec2(i % width, i / width), 0);
}
int contactFetchTriId(int i) {
  int width = textureSize(contactTriIdx, 0).x;
  return int(texelFetch(contactTriIdx, ivec2(i % width, i / width), 0).r);
}

float staticDistance(vec3 p) {
  vec3 uvw = (p - uSdfLo) / uSdfSpan;
  if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) return uSdfClip;
  return texture(uSdfTex, uvw).r;
}

float contactHitDistance(vec3 p, vec3 n, vec3 w) {
  vec3 origin = p + n * contactBias;
  vec3 safeW = mix(w, vec3(1e-20), lessThan(abs(w), vec3(1e-20)));
  vec3 inv = 1.0 / safeW;
  int root = 0, end = contactNodeCount;
  vec3 qMin = contactRootMin, qSpan = contactRootSpan;
  if (contactGridSize > 0.0) {
    ivec3 cell = ivec3(floor((p - contactGridMin) / contactGridSize));
    ivec3 dims = textureSize(contactGrid, 0);
    if (any(lessThan(cell, ivec3(0))) || any(greaterThanEqual(cell, dims))) return -1.0;
    uvec2 bounds = texelFetch(contactGrid, cell, 0).xy;
    root = int(bounds.x);
    end = int(bounds.y);
    if (root >= end) return -1.0;
    float expand = contactRange + abs(contactBias);
    qMin = contactGridMin + vec3(cell) * contactGridSize - vec3(expand);
    qSpan = vec3(contactGridSize + 2.0 * expand);
  } else if (end <= 0) {
    return -1.0;
  }
  vec3 qScale = qSpan * (1.0 / 65535.0);
  int stack[24];
  int sp = 0;
  int node = root;
  float bestDist = contactRange + 1.0;
  for (int visit = 0; visit < 2048; visit++) {
    uvec4 nd = contactFetchNode(node);
    vec3 lo = qMin + vec3(float(nd.x & 0xFFFFu), float(nd.x >> 16u), float(nd.y & 0xFFFFu)) * qScale;
    vec3 hi = qMin + vec3(float(nd.y >> 16u), float(nd.z & 0xFFFFu), float(nd.z >> 16u)) * qScale;
    vec3 a = (lo - origin) * inv, b = (hi - origin) * inv;
    vec3 nearT = min(a, b), farT = max(a, b);
    float t0 = max(0.0, max(nearT.x, max(nearT.y, nearT.z)));
    float t1 = min(min(contactRange, bestDist), min(farT.x, min(farT.y, farT.z)));
    if (t1 >= t0) {
      uint meta = nd.w;
      if ((meta & 0x80000000u) != 0u) {
        int first = int((meta & 0x7FFFFFFFu) >> 3u);
        int count = int(meta & 7u);
        for (int j = 0; j < 4; j++) {
          if (j >= count) break;
          int tri = contactFetchTriId(first + j) * 3;
          vec3 v0 = contactFetch(contactTriangles, tri).xyz;
          vec3 e1 = contactFetch(contactTriangles, tri + 1).xyz;
          vec3 e2 = contactFetch(contactTriangles, tri + 2).xyz;
          vec3 h = cross(w, e2);
          float det = dot(e1, h);
          if (abs(det) < 1e-10) continue;
          vec3 s = origin - v0;
          float u = dot(s, h) / det;
          if (u < -1e-6 || u > 1.0 + 1e-6) continue;
          vec3 q = cross(s, e1);
          float v = dot(w, q) / det;
          if (v < -1e-6 || u + v > 1.0 + 1e-6) continue;
          float dist = dot(e2, q) / det;
          if (dist > 0.0 && dist <= contactRange && dist < bestDist) bestDist = dist;
        }
      } else {
        int axis = int(meta >> 29u);
        int right = int(meta & 0x1FFFFFFFu);
        int left = node + 1;
        bool neg = (axis == 0 ? w.x : (axis == 1 ? w.y : w.z)) < 0.0;
        int firstChild = neg ? right : left;
        int secondChild = neg ? left : right;
        if (sp < 24) stack[sp++] = secondChild;
        node = firstChild;
        continue;
      }
    }
    if (sp == 0) break;
    node = stack[--sp];
  }
  return bestDist <= contactRange ? bestDist : -1.0;
}

float ign(vec2 p) {
  return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}
float vdc2(uint bits) {
  bits = (bits << 16u) | (bits >> 16u);
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return float(bits) * 2.3283064365386963e-10;
}
float vdc3(uint n) {
  float f = 1.0, r = 0.0;
  for (int j = 0; j < 6; j++) { f /= 3.0; r += f * float(n % 3u); n /= 3u; }
  return r;
}

void main() {
  ivec2 coord = ivec2(gl_FragCoord.xy);
  vec4 nrm4 = texelFetch(uTexelNrm, coord, 0);
  if (nrm4.w < 0.5) {
    outAoBent = vec4(1.0, 0.0, 1.0, 0.0);
    return;
  }
  vec3 p = texelFetch(uTexelPos, coord, 0).xyz;
  vec3 n = normalize(nrm4.xyz);
  vec3 a = abs(n.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 t = normalize(cross(n, a)), b = cross(n, t);

  float su = ign(gl_FragCoord.xy);
  float sp = ign(gl_FragCoord.xy + vec2(37.0, 17.0));
  float rScale = uRadius / 1.12;
  float minStep = 0.028 * rScale;
  float eCap = 0.025 * rScale;

  float visSum = 0.0;
  vec3 bent = vec3(0.0);
  int totalRays = uFrames * 4;

  for (int frame = 0; frame < 64; frame++) {
    if (frame >= uFrames) break;
    float fu = fract(su + vdc2(uint(frame)));
    uint base = uint(frame) * 4u;
    for (int i = 0; i < 4; i++) {
      float u = clamp((float(i) + fu) * 0.25, 1e-4, 0.9999);
      float phi = 6.2831853 * fract(sp + vdc3(base + uint(i)));
      float ru = sqrt(u), cosn = sqrt(1.0 - u);
      vec3 w = t * (ru * cos(phi)) + b * (ru * sin(phi)) + n * cosn;

      float hitDist = contactHitDistance(p, n, w);
      if (hitDist >= 0.0) {
        float vHit = uFalloffMode == 0 ? clamp(hitDist / uRadius, 0.0, 1.0) : 0.0;
        visSum += vHit;
        bent += w * vHit;
        continue;
      }

      float s = min(uRadius, contactRange);
      float v = 1.0;
      for (int k = 0; k < 24; k++) {
        if (s > uRadius) break;
        float d = staticDistance(p + w * s);
        float e = max(min(eCap, 0.1 * s * cosn), 1e-6);
        float stepVis = clamp((d + e) / (4.0 * e), 0.0, 1.0);
        if (uFalloffMode == 1) {
          float fade = smoothstep(uRadius, 0.642857 * uRadius, s);
          stepVis = mix(1.0, stepVis, fade);
        } else if (uFalloffMode == 0) {
          float fade = clamp(1.0 - s / uRadius, 0.0, 1.0);
          stepVis = mix(1.0, stepVis, fade);
        }
        v = min(v, stepVis);
        if (v < 0.01) break;
        s += max(d, minStep);
      }
      visSum += v;
      bent += w * v;
    }
  }

  float ao = visSum / float(max(1, totalRays));
  float bl = length(bent);
  vec3 bn = bl > 1e-4 ? bent / bl : n;
  outAoBent = vec4(ao, bn);
}`;

/**
 * Execute the full-atlas WebGL2 `Fast-SDF-AO` shader pass over `(pos, nrm)` texel geometry (`RGBA32UI` SAH contact BVH
 * + hardware-trilinear `R16F` 3D SDF), returning openness per texel and bent normals.
 */
export function runFastSdfAoGpuPass(
  gpu: Gpu,
  pos: Float32Array,
  nrm: Float32Array,
  size: number,
  vol: FastSdfVolume,
  cbvh: FastContactBvh,
  opts: { rays?: number; radius?: number; falloff?: FastSdfFalloff } = {},
): { value: Float32Array; baked: Uint8Array; bentNormals: Float32Array } {
  const radius = opts.radius ?? 1.12;
  const frames = Math.max(1, Math.min(64, Math.ceil((opts.rays ?? 24) / 4)));
  const falloffMode = opts.falloff === 'smooth' ? 1 : opts.falloff === 'hard' ? 2 : 0;
  const maxTex = gpu.renderer.capabilities.maxTextureSize || 4096;

  // 1. Pack Contact BVH GPU textures matching `contact-bvh.js`
  const nLen = Math.max(1, cbvh.nodeLen);
  const nWidth = Math.min(1024, maxTex, nLen);
  const nHeight = Math.ceil(nLen / nWidth);
  const nBuf = new Uint32Array(nWidth * nHeight * 4);
  nBuf.set(cbvh.nodeData);
  const nodeTex = new THREE.DataTexture(nBuf, nWidth, nHeight, THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
  nodeTex.internalFormat = 'RGBA32UI';
  nodeTex.minFilter = nodeTex.magFilter = THREE.NearestFilter;
  nodeTex.generateMipmaps = false;
  nodeTex.needsUpdate = true;

  const idxLen = Math.max(1, cbvh.ordLen);
  const idxW = Math.min(1024, maxTex, idxLen);
  const idxH = Math.ceil(idxLen / idxW);
  const idxBuf = new Uint32Array(idxW * idxH);
  for (let i = 0; i < cbvh.ordLen; i++) idxBuf[i] = cbvh.ordIdx[i] >>> 0;
  const triIdxTex = new THREE.DataTexture(idxBuf, idxW, idxH, THREE.RedIntegerFormat, THREE.UnsignedIntType);
  triIdxTex.internalFormat = 'R32UI';
  triIdxTex.minFilter = triIdxTex.magFilter = THREE.NearestFilter;
  triIdxTex.generateMipmaps = false;
  triIdxTex.needsUpdate = true;

  const tTexels = Math.max(1, cbvh.triCount * 3);
  const tWidth = Math.min(1024, maxTex, tTexels);
  const tHeight = Math.ceil(tTexels / tWidth);
  const tBuf = new Float32Array(tWidth * tHeight * 4);
  for (let k = 0; k < cbvh.triCount; k++) {
    const o = k * 12;
    tBuf[o] = cbvh.v0x[k]; tBuf[o + 1] = cbvh.v0y[k]; tBuf[o + 2] = cbvh.v0z[k];
    tBuf[o + 4] = cbvh.e1x[k]; tBuf[o + 5] = cbvh.e1y[k]; tBuf[o + 6] = cbvh.e1z[k];
    tBuf[o + 8] = cbvh.e2x[k]; tBuf[o + 9] = cbvh.e2y[k]; tBuf[o + 10] = cbvh.e2z[k];
  }
  const triTex = new THREE.DataTexture(tBuf, tWidth, tHeight, THREE.RGBAFormat, THREE.FloatType);
  triTex.minFilter = triTex.magFilter = THREE.NearestFilter;
  triTex.generateMipmaps = false;
  triTex.needsUpdate = true;

  const gridTex = new THREE.Data3DTexture(cbvh.gridData, cbvh.gridDims[0], cbvh.gridDims[1], cbvh.gridDims[2]);
  gridTex.format = THREE.RGIntegerFormat;
  gridTex.type = THREE.UnsignedIntType;
  gridTex.internalFormat = 'RG32UI';
  gridTex.minFilter = gridTex.magFilter = THREE.NearestFilter;
  gridTex.unpackAlignment = 1;
  gridTex.needsUpdate = true;

  // 2. Pack isotropic R16F 3D SDF texture (core-guaranteed LinearFilter in WebGL2!)
  const sdfTex = new THREE.Data3DTexture(vol.f16, vol.dims[0], vol.dims[1], vol.dims[2]);
  sdfTex.format = THREE.RedFormat;
  sdfTex.type = THREE.HalfFloatType;
  sdfTex.internalFormat = 'R16F';
  sdfTex.minFilter = sdfTex.magFilter = THREE.LinearFilter;
  sdfTex.wrapS = sdfTex.wrapT = sdfTex.wrapR = THREE.ClampToEdgeWrapping;
  sdfTex.unpackAlignment = 1;
  sdfTex.needsUpdate = true;

  // 3. Upload atlas `pos` and `nrm` (glTF row order: row 0 = v 0, read back with `topDown = false` to preserve row order)
  const posTex = new THREE.DataTexture(pos, size, size, THREE.RGBAFormat, THREE.FloatType);
  posTex.minFilter = posTex.magFilter = THREE.NearestFilter;
  posTex.needsUpdate = true;
  const nrmTex = new THREE.DataTexture(nrm, size, size, THREE.RGBAFormat, THREE.FloatType);
  nrmTex.minFilter = nrmTex.magFilter = THREE.NearestFilter;
  nrmTex.needsUpdate = true;

  const rt = floatTarget(size, size);
  const mat = passMaterial(FAST_SDF_ATLAS_FRAG, {
    uTexelPos: { value: posTex },
    uTexelNrm: { value: nrmTex },
    uSdfTex: { value: sdfTex },
    uSdfLo: { value: new THREE.Vector3(...vol.lo) },
    uSdfSpan: { value: new THREE.Vector3(...vol.span) },
    uSdfClip: { value: vol.clip },
    contactNodes: { value: nodeTex },
    contactTriIdx: { value: triIdxTex },
    contactTriangles: { value: triTex },
    contactGrid: { value: gridTex },
    contactGridMin: { value: new THREE.Vector3(...cbvh.gridMin) },
    contactGridSize: { value: cbvh.gridSize },
    contactRootMin: { value: new THREE.Vector3(...cbvh.rootMin) },
    contactRootSpan: { value: new THREE.Vector3(...cbvh.rootSpan) },
    contactNodeCount: { value: cbvh.nodeLen },
    contactRange: { value: cbvh.range },
    contactBias: { value: cbvh.bias },
    uRadius: { value: radius },
    uFrames: { value: frames },
    uFalloffMode: { value: falloffMode },
  });

  let pixels: Float32Array;
  try {
    gpu.pass(mat, rt);
    pixels = gpu.readF32(rt, 0, false);
  } finally {
    rt.dispose();
    mat.dispose();
    nodeTex.dispose();
    triIdxTex.dispose();
    triTex.dispose();
    gridTex.dispose();
    sdfTex.dispose();
    posTex.dispose();
    nrmTex.dispose();
  }

  const N = size * size;
  const value = new Float32Array(N);
  const baked = new Uint8Array(N);
  const bentNormals = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    if (nrm[4 * i + 3] > 0.5) {
      value[i] = Math.max(0, Math.min(1, pixels[4 * i]));
      baked[i] = 1;
      bentNormals[3 * i] = pixels[4 * i + 1];
      bentNormals[3 * i + 1] = pixels[4 * i + 2];
      bentNormals[3 * i + 2] = pixels[4 * i + 3];
    }
  }
  return { value, baked, bentNormals };
}
