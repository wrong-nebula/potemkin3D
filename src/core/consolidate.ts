import * as THREE from 'three';
import type { Engine } from './engine';
import { floatTarget } from './gpu';
import { makeCamera, type ViewSpec } from './views';

/**
 * Texture-space multi-view consolidation (TODO item 3, post-process baseline; zero model calls):
 * 1. Back-project each painted view into atlas space with per-texel confidence `w = (lens * cosθ / d) × depthContinuity × rimFade`,
 *    suppressing grazing projections and occlusion silhouettes where ghosting happens.
 * 2. Solve a regularized 2D UV/surface-tangent optical flow field `(du, dv)` per overlapping view on high-pass structural
 *    luminance (invariant to `--parallel` exposure and colour drift!) and advect the view's colours along it so slightly
 *    shifted mortar joints, bricks and trim register before blending.
 * 3. Assemble sharpness-weighted intra-view spatial gradients `g_x`, `g_y` (`0` across unshared view cuts!) and solve a
 *    3-level multigrid Screened-Poisson system within each UV island / part boundary so hard `--parallel` seam steps
 *    dissolve into smooth tonal transitions while preserving crisp surface detail.
 */

export interface SeamScore {
  /** Mean RGB step (0..255) directly across texel edges where the winning view changes on the same continuous surface. */
  step: number;
  /** Mean RGB step on immediately adjacent interior edges within the same winning view. */
  interiorStep: number;
  /** `step / max(0.5, interiorStep)`: 1.0 means view boundaries are indistinguishable from surrounding texture grain. */
  ratio: number;
  /** Count of continuous same-part surface edges crossing between different winning views. */
  boundaryEdges: number;
}

export interface ProjectedAtlasView {
  /** RGBA8 in atlas order (`row 0 = v 0`), alpha > 0 where the view validly observes the texel. */
  rgba: Uint8ClampedArray;
  /** Per-texel confidence `w = (lens * cosθ / d) * depthContinuity * rimFade`, 0 where unobserved. */
  weight: Float32Array;
}

export interface ConsolidateOptions {
  /** Working grid resolution along a side (power of two, default `min(1024, atlas.size)`). */
  size?: number;
  /** Depth-buffer render resolution for depth-continuity estimation (default 512). */
  depthSize?: number;
  /** Enable high-pass Lucas-Kanade surface-tangent flow registration + colour advection (default true). */
  flow?: boolean;
  /** Maximum tangent-flow shift in working-atlas texels (default 3). */
  maxShift?: number;
  /** Screening anchor weight `λ` on the confidence-weighted mean colour (default 0.02). */
  lambda?: number;
  /** Solve a contrast-sensitive MRF view-label assignment on the surface graph for coherent intra-patch gradients (default true). */
  mrf?: boolean;
  /** Pairwise MRF Potts smoothness weight `γ` (default 0.35). */
  mrfSmooth?: number;
  /** Use tangent-plane & depth-weighted bilateral soft back-projection attention instead of hard point sampling (default false). */
  softBackproject?: boolean;
  /** Optional list of outlier view indices (e.g. flagged by `fitSurfaceGaussianField` / `Critic`) whose weights are attenuated `0.05×`. */
  dropViews?: number[];
  /** Minimum view cosine (default `engine.options.minCos`). */
  minCos?: number;
  /** Frame border margin skipped during back-projection (default `engine.options.frameMargin`). */
  frameMargin?: number;
}

export interface ConsolidateResult {
  size: number;
  views: number;
  /** Views whose overlap triggered non-zero tangent-flow advection. */
  flowAdvected: number;
  before: SeamScore;
  /** Seam score of the discrete MRF label assignment prior to Screened-Poisson stitching (when `mrf` is enabled). */
  mrfBefore?: SeamScore;
  after: SeamScore;
  seconds: number;
}

/**
 * Per-pixel depth continuity in `[0, 1]` on a top-down view position/depth buffer (`gPos`: xyz + distance, `<= 0` = sky).
 * Drops sharply at occlusion silhouettes (`> 4%` depth jump) so foreground rims never bleed onto background walls.
 */
export function depthContinuity(gPos: ArrayLike<number>, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const d = gPos[4 * i + 3];
      if (!(d > 0)) continue;
      let maxJump = 0, silhouette = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const nd = gPos[4 * (ny * width + nx) + 3];
        if (!(nd > 0)) { silhouette = true; break; }
        const jump = Math.abs(nd - d);
        if (jump > maxJump) maxJump = jump;
      }
      const thresh = 0.04 * d + 0.025;
      if (silhouette || maxJump > thresh) out[i] = 0.08;
      else out[i] = Math.exp(-maxJump / (0.02 * d + 0.01));
    }
  }
  return out;
}

/**
 * Back-project one view (`spec`, top-down `comp` RGBA8 and top-down `gPos` float4) onto an `atlasSize` x `atlasSize`
 * atlas grid (`texelPos`, `texelNrm` from `Atlas.texelGeometry`), returning projected colours and per-texel confidence.
 */
export function backProjectView(
  texelPos: ArrayLike<number>,
  texelNrm: ArrayLike<number>,
  atlasSize: number,
  coveredIdx: ArrayLike<number>,
  spec: ViewSpec,
  gPos: ArrayLike<number>,
  gSize: number,
  comp: ArrayLike<number>,
  compSize: number,
  opts: { detail?: number; minCos?: number; frameMargin?: number; softKernel?: boolean } = {},
): ProjectedAtlasView {
  const detail = opts.detail ?? 1, minCos = opts.minCos ?? 0.08, margin = opts.frameMargin ?? 0;
  const softKernel = opts.softKernel ?? false;
  const cam = makeCamera(spec);
  const lens = cam.projectionMatrix.elements[5] || 1;
  const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
  const cx = spec.position[0], cy = spec.position[1], cz = spec.position[2];
  const dCont = depthContinuity(gPos, gSize, gSize);

  const N = atlasSize * atlasSize;
  const rgba = new Uint8ClampedArray(N * 4);
  const weight = new Float32Array(N);
  const ndcLimit = 0.999 - 2 * margin;

  for (let k = 0; k < coveredIdx.length; k++) {
    const p = coveredIdx[k], p4 = 4 * p;
    const wx = texelPos[p4], wy = texelPos[p4 + 1], wz = texelPos[p4 + 2];
    const cw = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15];
    if (cw <= 0.05) continue;
    const ndcX = (vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12]) / cw;
    if (Math.abs(ndcX) > ndcLimit) continue;
    const ndcY = (vp[1] * wx + vp[5] * wy + vp[9] * wz + vp[13]) / cw;
    if (Math.abs(ndcY) > ndcLimit) continue;

    const dx = cx - wx, dy = cy - wy, dz = cz - wz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-4) continue;
    const cosv = (texelNrm[p4] * dx + texelNrm[p4 + 1] * dy + texelNrm[p4 + 2] * dz) / dist;
    if (cosv < minCos) continue;

    // Top-down image coordinates matching `PROJECT_FRAG`: u = 0.5 * ndcX + 0.5, vTop = 0.5 - 0.5 * ndcY.
    const u = ndcX * 0.5 + 0.5, vTop = 0.5 - ndcY * 0.5;
    const gx = Math.min(gSize - 1, Math.max(0, Math.floor(u * gSize)));
    const gy = Math.min(gSize - 1, Math.max(0, Math.floor(vTop * gSize)));
    const gi = gy * gSize + gx;
    const gd = gPos[4 * gi + 3];
    if (gd > 0 && dist > gd + 0.025 + 0.015 * dist) continue;   // occluded by nearer geometry

    // Bilinear sample from premultiplied `comp` (top-down), or tangent-plane bilateral soft attention kernel (`softKernel`).
    const fx = Math.min(compSize - 1, Math.max(0, u * compSize - 0.5));
    const fy = Math.min(compSize - 1, Math.max(0, vTop * compSize - 0.5));
    if (softKernel) {
      const cxPx = Math.round(fx), cyPx = Math.round(fy);
      const planeTau = 0.018 + 0.012 * dist;
      const depthTau = 0.03 * dist + 0.02;
      const nx = texelNrm[p4], ny = texelNrm[p4 + 1], nz = texelNrm[p4 + 2];
      let sr = 0, sg = 0, sb = 0, sw = 0, sCont = 0, maxA = 0;
      for (let ky = -1; ky <= 1; ky++) {
        const py = cyPx + ky;
        if (py < 0 || py >= compSize) continue;
        const gyTap = Math.min(gSize - 1, Math.max(0, Math.floor(((py + 0.5) / compSize) * gSize)));
        for (let kx = -1; kx <= 1; kx++) {
          const px = cxPx + kx;
          if (px < 0 || px >= compSize) continue;
          const ci = 4 * (py * compSize + px);
          const ca = comp[ci + 3];
          if (ca < 96) continue;
          const gxTap = Math.min(gSize - 1, Math.max(0, Math.floor(((px + 0.5) / compSize) * gSize)));
          const gTap = gyTap * gSize + gxTap;
          const td = gPos[4 * gTap + 3];
          if (td > 0 && dist > td + 0.03 + 0.018 * dist) continue;
          let wGeo = 1;
          if (td > 0) {
            const planeDist = Math.abs(nx * (gPos[4 * gTap] - wx) + ny * (gPos[4 * gTap + 1] - wy) + nz * (gPos[4 * gTap + 2] - wz));
            const depthDiff = Math.abs(td - dist);
            wGeo = Math.exp(-(planeDist * planeDist) / (2 * planeTau * planeTau) - (depthDiff * depthDiff) / (2 * depthTau * depthTau));
          }
          const dpx = px - fx, dpy = py - fy;
          const wSpatial = Math.exp(-(dpx * dpx + dpy * dpy) / (2 * 0.85 * 0.85));
          const wAlpha = ca / 255;
          const att = wSpatial * wGeo * wAlpha;
          if (att < 1e-5) continue;
          const invTapA = 255 / ca;
          sr += att * (comp[ci] * invTapA);
          sg += att * (comp[ci + 1] * invTapA);
          sb += att * (comp[ci + 2] * invTapA);
          sCont += att * (td > 0 ? dCont[gTap] : 0.5);
          sw += att;
          if (ca > maxA) maxA = ca;
        }
      }
      if (sw < 1e-4 || maxA < 128) continue;
      rgba[p4] = Math.round(sr / sw);
      rgba[p4 + 1] = Math.round(sg / sw);
      rgba[p4 + 2] = Math.round(sb / sw);
      rgba[p4 + 3] = 255;
      const rim = Math.min(1, (ndcLimit - Math.max(Math.abs(ndcX), Math.abs(ndcY))) / 0.08, (maxA - 128) / 96);
      const cont = sCont / sw;
      weight[p] = Math.max(1e-5, ((detail * lens * cosv) / Math.max(dist, 0.5)) * cont * Math.max(0.05, rim));
      continue;
    }
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(compSize - 1, x0 + 1), y1 = Math.min(compSize - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const i00 = 4 * (y0 * compSize + x0), i10 = 4 * (y0 * compSize + x1), i01 = 4 * (y1 * compSize + x0), i11 = 4 * (y1 * compSize + x1);
    const a = (comp[i00 + 3] * (1 - tx) + comp[i10 + 3] * tx) * (1 - ty) + (comp[i01 + 3] * (1 - tx) + comp[i11 + 3] * tx) * ty;
    if (a < 128) continue;
    const invA = 255 / a;
    for (let c = 0; c < 3; c++) {
      const val = ((comp[i00 + c] * (1 - tx) + comp[i10 + c] * tx) * (1 - ty) + (comp[i01 + c] * (1 - tx) + comp[i11 + c] * tx) * ty) * invA;
      rgba[p4 + c] = val;
    }
    rgba[p4 + 3] = 255;

    // Smooth rim taper near frame edges and mask borders so confidence never jumps discontinuously to 0.
    const rim = Math.min(1, (ndcLimit - Math.max(Math.abs(ndcX), Math.abs(ndcY))) / 0.08, (a - 128) / 96);
    const cont = gd > 0 ? dCont[gi] : 0.5;
    weight[p] = Math.max(1e-5, (detail * lens * cosv) / Math.max(dist, 0.5) * cont * Math.max(0.05, rim));
  }
  return { rgba, weight };
}

/** Build horizontal (`right[p] = 1`) and vertical (`down[p] = 1`) continuous same-part surface adjacency masks on the atlas grid. */
export function surfaceLinks(pos: ArrayLike<number>, nrm: ArrayLike<number>, size: number) {
  const N = size * size;
  const part = new Int16Array(N).fill(-1);
  const covered: number[] = [];
  for (let i = 0; i < N; i++) {
    if (nrm[4 * i + 3] < 0.5) continue;
    part[i] = Math.round(pos[4 * i + 3]) - 1;
    covered.push(i);
  }
  // Estimate median world step between neighbouring texels to reject cross-island jumps that share a part label.
  const steps: number[] = [];
  for (let y = 0; y < size; y += 2) {
    for (let x = 0; x + 1 < size; x += 2) {
      const i = y * size + x, j = i + 1;
      if (part[i] < 0 || part[i] !== part[j]) continue;
      const d = Math.hypot(pos[4 * j] - pos[4 * i], pos[4 * j + 1] - pos[4 * i + 1], pos[4 * j + 2] - pos[4 * i + 2]);
      if (d > 1e-5 && d < 5) steps.push(d);
    }
  }
  steps.sort((a, b) => a - b);
  const maxStep = steps.length ? Math.max(0.25, 6 * steps[steps.length >> 1]) : 2.0;

  const right = new Uint8Array(N), down = new Uint8Array(N);
  const linked = (i: number, j: number) => {
    if (part[i] < 0 || part[i] !== part[j]) return false;
    const dot = nrm[4 * i] * nrm[4 * j] + nrm[4 * i + 1] * nrm[4 * j + 1] + nrm[4 * i + 2] * nrm[4 * j + 2];
    if (dot < 0.8) return false;
    const d = Math.hypot(pos[4 * j] - pos[4 * i], pos[4 * j + 1] - pos[4 * i + 1], pos[4 * j + 2] - pos[4 * i + 2]);
    return d <= maxStep;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (part[i] < 0) continue;
      if (x + 1 < size && linked(i, i + 1)) right[i] = 1;
      if (y + 1 < size && linked(i, i + size)) down[i] = 1;
    }
  }
  return { part, covered: Int32Array.from(covered), right, down };
}

/** High-pass luminance (`L - boxBlur5x5(L)`) restricted to same-part texels where `mask > 0`, invariant to exposure/colour drift. */
function highPassLuminance(rgb: ArrayLike<number>, stride: 3 | 4, mask: ArrayLike<number>, part: Int16Array, size: number): Float32Array {
  const N = size * size;
  const lum = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (!(mask[i] > 0)) continue;
    const p = stride * i;
    lum[i] = 0.299 * rgb[p] + 0.587 * rgb[p + 1] + 0.114 * rgb[p + 2];
  }
  const tmp = new Float32Array(N), blur = new Float32Array(N);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (!(mask[i] > 0)) continue;
      let s = 0, n = 0;
      for (let k = -2; k <= 2; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= size) continue;
        const j = y * size + xx;
        if (mask[j] > 0 && part[j] === part[i]) { s += lum[j]; n++; }
      }
      tmp[i] = s / Math.max(1, n);
    }
  }
  const hp = new Float32Array(N);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (!(mask[i] > 0)) continue;
      let s = 0, n = 0;
      for (let k = -2; k <= 2; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= size) continue;
        const j = yy * size + x;
        if (mask[j] > 0 && part[j] === part[i]) { s += tmp[j]; n++; }
      }
      blur[i] = s / Math.max(1, n);
      hp[i] = lum[i] - blur[i];
    }
  }
  return hp;
}

/**
 * Estimate a smooth 2D UV/surface-tangent displacement field `(du, dv)` (in texels) registering `view` against the
 * accumulated reference `refRgb` / `refWeight` on `block` x `block` tiles, then advect `view.rgba` along it.
 */
export function registerAndAdvectView(
  view: ProjectedAtlasView,
  refRgb: Float32Array,
  refWeight: Float32Array,
  links: ReturnType<typeof surfaceLinks>,
  size: number,
  maxShift = 3.0,
  block = 16,
): { rgba: Uint8ClampedArray; moved: boolean } {
  const hpRef = highPassLuminance(refRgb, 3, refWeight, links.part, size);
  const hpView = highPassLuminance(view.rgba, 4, view.weight, links.part, size);
  const grid = Math.ceil(size / block);
  let bu = new Float32Array(grid * grid), bv = new Float32Array(grid * grid), bw = new Float32Array(grid * grid);
  let activeBlocks = 0;

  // Damped Lucas-Kanade structure tensor per block over overlapping high-pass structure.
  const damping = 120;
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      let sxx = 0, sxy = 0, syy = 0, sxt = 0, syt = 0, count = 0;
      const x0 = gx * block, y0 = gy * block;
      const x1 = Math.min(size - 1, x0 + block), y1 = Math.min(size - 1, y0 + block);
      for (let y = Math.max(1, y0); y < y1; y++) {
        for (let x = Math.max(1, x0); x < x1; x++) {
          const i = y * size + x;
          if (!(view.weight[i] > 0) || !(refWeight[i] > 0)) continue;
          if (!links.right[i - 1] || !links.right[i] || !links.down[i - size] || !links.down[i]) continue;
          const ix = 0.5 * (hpView[i + 1] - hpView[i - 1]);
          const iy = 0.5 * (hpView[i + size] - hpView[i - size]);
          const it = hpView[i] - hpRef[i];
          const w = Math.min(view.weight[i], refWeight[i]);
          sxx += w * ix * ix;
          sxy += w * ix * iy;
          syy += w * iy * iy;
          sxt += w * ix * it;
          syt += w * iy * it;
          count++;
        }
      }
      if (count < 12 || sxx + syy < 25) continue;
      const a = sxx + damping, d = syy + damping, det = a * d - sxy * sxy;
      if (det <= 1e-6) continue;
      // Want hpView(x + du, y + dv) ≈ hpRef(x, y) => hpView + ix*du + iy*dv = hpRef => J^T J [du, dv] = -J^T (hpView - hpRef).
      const du = THREE.MathUtils.clamp((-d * sxt + sxy * syt) / det, -maxShift, maxShift);
      const dv = THREE.MathUtils.clamp((sxy * sxt - a * syt) / det, -maxShift, maxShift);
      if (Math.hypot(du, dv) < 0.08) continue;
      const bi = gy * grid + gx;
      bu[bi] = du; bv[bi] = dv; bw[bi] = sxx + syy;
      activeBlocks++;
    }
  }
  if (!activeBlocks) return { rgba: view.rgba, moved: false };

  // Diffuse block flow smoothly into neighbouring blocks so overlap offsets carry cleanly without tearing inside the view.
  for (let iter = 0; iter < 3; iter++) {
    const nu = new Float32Array(bu), nv = new Float32Array(bv), nw = new Float32Array(bw);
    for (let gy = 0; gy < grid; gy++) {
      for (let gx = 0; gx < grid; gx++) {
        const bi = gy * grid + gx;
        let su = bu[bi] * bw[bi] * 2, sv = bv[bi] * bw[bi] * 2, sw = bw[bi] * 2;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = gx + dx, ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= grid || ny >= grid) continue;
          const nj = ny * grid + nx;
          if (!(bw[nj] > 0)) continue;
          su += bu[nj] * bw[nj]; sv += bv[nj] * bw[nj]; sw += bw[nj];
        }
        if (sw > 0) { nu[bi] = su / sw; nv[bi] = sv / sw; nw[bi] = Math.max(bw[bi], sw * 0.25); }
      }
    }
    bu = nu; bv = nv; bw = nw;
  }

  // Advect `view.rgba` bilinearly along the interpolated block flow, strictly within same-part observed texels.
  const out = new Uint8ClampedArray(view.rgba);
  for (let k = 0; k < links.covered.length; k++) {
    const p = links.covered[k];
    if (!(view.weight[p] > 0)) continue;
    const x = p % size, y = (p - x) / size;
    const bgx = Math.min(grid - 1, Math.max(0, (x + 0.5) / block - 0.5));
    const bgy = Math.min(grid - 1, Math.max(0, (y + 0.5) / block - 0.5));
    const bx0 = Math.floor(bgx), by0 = Math.floor(bgy), bx1 = Math.min(grid - 1, bx0 + 1), by1 = Math.min(grid - 1, by0 + 1);
    const btx = bgx - bx0, bty = bgy - by0;
    const b00 = by0 * grid + bx0, b10 = by0 * grid + bx1, b01 = by1 * grid + bx0, b11 = by1 * grid + bx1;
    const du = (bu[b00] * (1 - btx) + bu[b10] * btx) * (1 - bty) + (bu[b01] * (1 - btx) + bu[b11] * btx) * bty;
    const dv = (bv[b00] * (1 - btx) + bv[b10] * btx) * (1 - bty) + (bv[b01] * (1 - btx) + bv[b11] * btx) * bty;
    if (Math.abs(du) < 0.04 && Math.abs(dv) < 0.04) continue;

    const sx = THREE.MathUtils.clamp(x + du, 0, size - 1), sy = THREE.MathUtils.clamp(y + dv, 0, size - 1);
    const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(size - 1, x0 + 1), y1 = Math.min(size - 1, y0 + 1);
    const i00 = y0 * size + x0, i10 = y0 * size + x1, i01 = y1 * size + x0, i11 = y1 * size + x1;
    const myPart = links.part[p];
    if (links.part[i00] !== myPart || links.part[i10] !== myPart || links.part[i01] !== myPart || links.part[i11] !== myPart) continue;
    if (!(view.weight[i00] > 0 && view.weight[i10] > 0 && view.weight[i01] > 0 && view.weight[i11] > 0)) continue;
    const tx = sx - x0, ty = sy - y0;
    for (let c = 0; c < 3; c++) {
      out[4 * p + c] = (view.rgba[4 * i00 + c] * (1 - tx) + view.rgba[4 * i10 + c] * tx) * (1 - ty)
        + (view.rgba[4 * i01 + c] * (1 - tx) + view.rgba[4 * i11 + c] * tx) * ty;
    }
  }
  return { rgba: out, moved: true };
}

/**
 * Multi-scale Screened-Poisson solver over masked UV islands:
 * minimizes `λ Σ w_p ||U_p - data_p||² + Σ_{(p,q)} ||U_q - U_p - g_{pq}||²` with natural Neumann boundaries on
 * island/part edges, using a coarse-to-fine residual pyramid + Red-Black SOR (`ω = 1.78`).
 */
export function poissonStitch(
  dataRgb: Float32Array,
  dataWeight: Float32Array,
  gx: Float32Array,
  gy: Float32Array,
  links: { part: Int16Array; right: Uint8Array; down: Uint8Array },
  size: number,
  lambda = 0.02,
): Uint8ClampedArray {
  const N = size * size;
  const active = new Uint8Array(N);
  let wSum = 0, count = 0;
  for (let i = 0; i < N; i++) {
    if (dataWeight[i] > 0 && links.part[i] >= 0) { active[i] = 1; wSum += dataWeight[i]; count++; }
  }
  const out = new Uint8ClampedArray(N * 4);
  if (!count) return out;
  const meanW = wSum / count;
  const anchor = new Float32Array(N);
  for (let i = 0; i < N; i++) if (active[i]) anchor[i] = lambda * Math.min(4, Math.max(0.25, dataWeight[i] / meanW));

  // Initialize solution `u` from `dataRgb`.
  const u = new Float32Array(dataRgb);

  // Build right-hand side `rhs[3*p + c] = anchor[p] * dataRgb[3*p + c] - div(g)_p` once on the fine grid!
  const rhs = new Float32Array(N * 3);
  const deg = new Float32Array(N);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (!active[i]) continue;
      let d = anchor[i];
      let rx = anchor[i] * dataRgb[3 * i], rg = anchor[i] * dataRgb[3 * i + 1], rb = anchor[i] * dataRgb[3 * i + 2];
      // Right edge: U(i+1) - U(i) ≈ gx(i)  =>  (U(i) - U(i+1)) ≈ -gx(i)
      if (links.right[i] && active[i + 1]) {
        d += 1; rx -= gx[3 * i]; rg -= gx[3 * i + 1]; rb -= gx[3 * i + 2];
      }
      // Left edge: U(i) - U(i-1) ≈ gx(i-1)
      if (x > 0 && links.right[i - 1] && active[i - 1]) {
        d += 1; rx += gx[3 * (i - 1)]; rg += gx[3 * (i - 1) + 1]; rb += gx[3 * (i - 1) + 2];
      }
      // Down edge: U(i+size) - U(i) ≈ gy(i)
      if (links.down[i] && active[i + size]) {
        d += 1; rx -= gy[3 * i]; rg -= gy[3 * i + 1]; rb -= gy[3 * i + 2];
      }
      // Up edge: U(i) - U(i-size) ≈ gy(i-size)
      if (y > 0 && links.down[i - size] && active[i - size]) {
        d += 1; rx += gy[3 * (i - size)]; rg += gy[3 * (i - size) + 1]; rb += gy[3 * (i - size) + 2];
      }
      deg[i] = d;
      rhs[3 * i] = rx; rhs[3 * i + 1] = rg; rhs[3 * i + 2] = rb;
    }
  }

  // Red-Black SOR relaxation on `(deg * I - A) x = b`.
  const relax = (
    xArr: Float32Array, bArr: Float32Array, dArr: Float32Array,
    act: Uint8Array, rLink: Uint8Array, dLink: Uint8Array, s: number, iters: number, omega = 1.78,
  ) => {
    for (let it = 0; it < iters; it++) {
      for (let color = 0; color < 2; color++) {
        for (let y = 0; y < s; y++) {
          let x = (y + color) & 1;
          for (; x < s; x += 2) {
            const i = y * s + x;
            if (!act[i]) continue;
            const d = dArr[i];
            if (d <= 0) continue;
            let n0 = bArr[3 * i], n1 = bArr[3 * i + 1], n2 = bArr[3 * i + 2];
            if (rLink[i] && act[i + 1]) { const j = 3 * (i + 1); n0 += xArr[j]; n1 += xArr[j + 1]; n2 += xArr[j + 2]; }
            if (x > 0 && rLink[i - 1] && act[i - 1]) { const j = 3 * (i - 1); n0 += xArr[j]; n1 += xArr[j + 1]; n2 += xArr[j + 2]; }
            if (dLink[i] && act[i + s]) { const j = 3 * (i + s); n0 += xArr[j]; n1 += xArr[j + 1]; n2 += xArr[j + 2]; }
            if (y > 0 && dLink[i - s] && act[i - s]) { const j = 3 * (i - s); n0 += xArr[j]; n1 += xArr[j + 1]; n2 += xArr[j + 2]; }
            const inv = omega / d, keep = 1 - omega;
            xArr[3 * i] = keep * xArr[3 * i] + inv * n0;
            xArr[3 * i + 1] = keep * xArr[3 * i + 1] + inv * n1;
            xArr[3 * i + 2] = keep * xArr[3 * i + 2] + inv * n2;
          }
        }
      }
    }
  };

  // Recursive 2-level V-cycle residual correction so broad 60-texel tonal steps converge in milliseconds.
  const vCycle = (
    xArr: Float32Array, bArr: Float32Array, aArr: Float32Array, dArr: Float32Array,
    act: Uint8Array, pArr: Int16Array, rLink: Uint8Array, dLink: Uint8Array, s: number, depth: number,
  ) => {
    relax(xArr, bArr, dArr, act, rLink, dLink, s, depth === 0 ? 12 : 8);
    if (depth < 2 && s >= 64 && (s & 1) === 0) {
      const cs = s >> 1, cN = cs * cs;
      const cAct = new Uint8Array(cN), cPart = new Int16Array(cN).fill(-1);
      const cAnchor = new Float32Array(cN), cB = new Float32Array(cN * 3);
      // Compute fine residual `res = b - L x` and restrict 2x2 same-part blocks to coarse grid.
      for (let cy = 0; cy < cs; cy++) {
        for (let cx = 0; cx < cs; cx++) {
          const ci = cy * cs + cx;
          let domPart = -1, nSub = 0, aSub = 0, r0 = 0, r1 = 0, r2 = 0;
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const fx = 2 * cx + dx, fy = 2 * cy + dy, fi = fy * s + fx;
              if (!act[fi]) continue;
              if (domPart < 0) domPart = pArr[fi];
              else if (pArr[fi] !== domPart) continue;
              let ax0 = dArr[fi] * xArr[3 * fi], ax1 = dArr[fi] * xArr[3 * fi + 1], ax2 = dArr[fi] * xArr[3 * fi + 2];
              if (rLink[fi] && act[fi + 1]) { const j = 3 * (fi + 1); ax0 -= xArr[j]; ax1 -= xArr[j + 1]; ax2 -= xArr[j + 2]; }
              if (fx > 0 && rLink[fi - 1] && act[fi - 1]) { const j = 3 * (fi - 1); ax0 -= xArr[j]; ax1 -= xArr[j + 1]; ax2 -= xArr[j + 2]; }
              if (dLink[fi] && act[fi + s]) { const j = 3 * (fi + s); ax0 -= xArr[j]; ax1 -= xArr[j + 1]; ax2 -= xArr[j + 2]; }
              if (fy > 0 && dLink[fi - s] && act[fi - s]) { const j = 3 * (fi - s); ax0 -= xArr[j]; ax1 -= xArr[j + 1]; ax2 -= xArr[j + 2]; }
              r0 += bArr[3 * fi] - ax0;
              r1 += bArr[3 * fi + 1] - ax1;
              r2 += bArr[3 * fi + 2] - ax2;
              aSub += aArr[fi];
              nSub++;
            }
          }
          if (!nSub) continue;
          cAct[ci] = 1;
          cPart[ci] = domPart;
          cAnchor[ci] = aSub;
          cB[3 * ci] = r0; cB[3 * ci + 1] = r1; cB[3 * ci + 2] = r2;
        }
      }
      const cR = new Uint8Array(cN), cD = new Uint8Array(cN), cDeg = new Float32Array(cN);
      for (let cy = 0; cy < cs; cy++) {
        for (let cx = 0; cx < cs; cx++) {
          const ci = cy * cs + cx;
          if (!cAct[ci]) continue;
          if (cx + 1 < cs && cAct[ci + 1] && cPart[ci] === cPart[ci + 1]) {
            const f0 = (2 * cy) * s + (2 * cx + 1), f1 = (2 * cy + 1) * s + (2 * cx + 1);
            if (rLink[f0] || rLink[f1]) cR[ci] = 1;
          }
          if (cy + 1 < cs && cAct[ci + cs] && cPart[ci] === cPart[ci + cs]) {
            const f0 = (2 * cy + 1) * s + (2 * cx), f1 = (2 * cy + 1) * s + (2 * cx + 1);
            if (dLink[f0] || dLink[f1]) cD[ci] = 1;
          }
        }
      }
      for (let cy = 0; cy < cs; cy++) {
        for (let cx = 0; cx < cs; cx++) {
          const ci = cy * cs + cx;
          if (!cAct[ci]) continue;
          let dg = cAnchor[ci];
          if (cR[ci]) dg += 1;
          if (cx > 0 && cR[ci - 1]) dg += 1;
          if (cD[ci]) dg += 1;
          if (cy > 0 && cD[ci - cs]) dg += 1;
          cDeg[ci] = dg;
        }
      }
      const cErr = new Float32Array(cN * 3);
      vCycle(cErr, cB, cAnchor, cDeg, cAct, cPart, cR, cD, cs, depth + 1);
      // Prolongate coarse error correction back to matching-part fine cells, then post-smooth.
      for (let cy = 0; cy < cs; cy++) {
        for (let cx = 0; cx < cs; cx++) {
          const ci = cy * cs + cx;
          if (!cAct[ci]) continue;
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const fi = (2 * cy + dy) * s + (2 * cx + dx);
              if (!act[fi] || pArr[fi] !== cPart[ci]) continue;
              xArr[3 * fi] += cErr[3 * ci];
              xArr[3 * fi + 1] += cErr[3 * ci + 1];
              xArr[3 * fi + 2] += cErr[3 * ci + 2];
            }
          }
        }
      }
      relax(xArr, bArr, dArr, act, rLink, dLink, s, 14);
    } else {
      relax(xArr, bArr, dArr, act, rLink, dLink, s, 45);
    }
  };

  vCycle(u, rhs, anchor, deg, active, links.part, links.right, links.down, size, 0);
  vCycle(u, rhs, anchor, deg, active, links.part, links.right, links.down, size, 0);

  for (let i = 0; i < N; i++) {
    if (!active[i]) continue;
    out[4 * i] = u[3 * i];
    out[4 * i + 1] = u[3 * i + 1];
    out[4 * i + 2] = u[3 * i + 2];
    out[4 * i + 3] = 255;
  }
  return out;
}

/**
 * Measure colour discontinuity across view-assignment boundaries (`owner[p] !== owner[q]`) on continuous same-part
 * surfaces, alongside the immediately adjacent intra-view gradient (`ratio = 1.0` means invisible seams).
 */
export function seamMetric(
  rgba: ArrayLike<number>,
  owner: Int16Array,
  links: { right: Uint8Array; down: Uint8Array },
  size: number,
): SeamScore {
  const diff = (p: number, q: number) =>
    (Math.abs(rgba[4 * p] - rgba[4 * q]) + Math.abs(rgba[4 * p + 1] - rgba[4 * q + 1]) + Math.abs(rgba[4 * p + 2] - rgba[4 * q + 2])) / 3;

  let bSum = 0, bCount = 0, iSum = 0, iCount = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      if (owner[p] < 0) continue;
      if (links.right[p] && owner[p + 1] >= 0 && owner[p] !== owner[p + 1]) {
        bSum += diff(p, p + 1);
        bCount++;
        if (x > 0 && links.right[p - 1] && owner[p - 1] === owner[p]) { iSum += diff(p - 1, p); iCount++; }
        if (x + 2 < size && links.right[p + 1] && owner[p + 2] === owner[p + 1]) { iSum += diff(p + 1, p + 2); iCount++; }
      }
      if (links.down[p] && owner[p + size] >= 0 && owner[p] !== owner[p + size]) {
        bSum += diff(p, p + size);
        bCount++;
        if (y > 0 && links.down[p - size] && owner[p - size] === owner[p]) { iSum += diff(p - size, p); iCount++; }
        if (y + 2 < size && links.down[p + size] && owner[p + 2 * size] === owner[p + size]) { iSum += diff(p + size, p + 2 * size); iCount++; }
      }
    }
  }
  const step = bCount ? bSum / bCount : 0;
  const interiorStep = iCount ? iSum / iCount : 0;
  return {
    step: +step.toFixed(3),
    interiorStep: +interiorStep.toFixed(3),
    ratio: bCount ? +(step / Math.max(0.5, interiorStep)).toFixed(3) : 1,
    boundaryEdges: bCount,
  };
}

/**
 * Contrast-sensitive Markov Random Field (MRF) view-label solver on the `surfaceLinks` graph (`TODO.md` #3).
 * Replaces noisy per-texel argmax view selection with piecewise-coherent patches whose cuts follow low-discrepancy
 * texture contours:
 *   E(L) = Σ_p -log(max(w_{L_p}(p), ε)) + Σ_{(p,q)∈E, L_p ≠ L_q} [ γ_0 + γ_1 · (||I_{L_p}(p)-I_{L_q}(p)||_2 + ||I_{L_p}(q)-I_{L_q}(q)||_2) / 510 ]
 * Optimised via red-black checkerboard Iterated Conditional Modes (ICM) over observed candidate labels per texel.
 */
export function solveMrfViewLabels(
  views: { rgba: Uint8ClampedArray; weight: Float32Array }[],
  links: ReturnType<typeof surfaceLinks>,
  size: number,
  opts: { smooth?: number; colorPenalty?: number; passes?: number } = {},
): Int16Array {
  const N = size * size;
  const gamma0 = opts.smooth ?? 0.35;
  const gamma1 = opts.colorPenalty ?? 1.25;
  const passes = opts.passes ?? 6;
  const labels = new Int16Array(N).fill(-1);

  // Initialise with maximum-confidence view per covered texel
  for (let k = 0; k < links.covered.length; k++) {
    const p = links.covered[k];
    let bestV = -1, bestW = 0;
    for (let v = 0; v < views.length; v++) {
      const w = views[v].weight[p];
      if (w > bestW) { bestW = w; bestV = v; }
    }
    labels[p] = bestV;
  }

  const pairCost = (p: number, q: number, u: number, v: number): number => {
    if (u === v || v < 0) return 0;
    const p4 = 4 * p, q4 = 4 * q;
    const iu = views[u].rgba, iv = views[v].rgba;
    // Where both views observe the edge, penalise cutting across mismatched RGB features; otherwise charge 2 * gamma0.
    const uHasQ = views[u].weight[q] > 0, vHasP = views[v].weight[p] > 0;
    if (!uHasQ || !vHasP) return gamma0 * 1.5;
    const dp = Math.hypot(iu[p4] - iv[p4], iu[p4 + 1] - iv[p4 + 1], iu[p4 + 2] - iv[p4 + 2]);
    const dq = Math.hypot(iu[q4] - iv[q4], iu[q4 + 1] - iv[q4 + 1], iu[q4 + 2] - iv[q4 + 2]);
    return gamma0 + gamma1 * ((dp + dq) / (2 * 441.673));
  };

  for (let it = 0; it < passes; it++) {
    let changed = 0;
    for (let parity = 0; parity < 2; parity++) {
      for (let k = 0; k < links.covered.length; k++) {
        const p = links.covered[k];
        const x = p % size, y = (p / size) | 0;
        if (((x + y) & 1) !== parity) continue;
        const cur = labels[p];
        if (cur < 0) continue;

        const nbrs: number[] = [];
        if (links.right[p] && labels[p + 1] >= 0) nbrs.push(p + 1);
        if (x > 0 && links.right[p - 1] && labels[p - 1] >= 0) nbrs.push(p - 1);
        if (links.down[p] && labels[p + size] >= 0) nbrs.push(p + size);
        if (y > 0 && links.down[p - size] && labels[p - size] >= 0) nbrs.push(p - size);
        if (!nbrs.length) continue;

        // Candidate labels: current + best-weight + neighbour labels that validly observe `p`
        let bestLabel = cur;
        let bestEnergy = Infinity;
        for (let v = 0; v < views.length; v++) {
          const w = views[v].weight[p];
          if (!(w > 0)) continue;
          let e = -Math.log(Math.max(w, 1e-6)) * 0.45;
          for (let ni = 0; ni < nbrs.length; ni++) {
            const q = nbrs[ni];
            e += pairCost(p, q, v, labels[q]);
          }
          if (e < bestEnergy - 1e-6) {
            bestEnergy = e;
            bestLabel = v;
          }
        }
        if (bestLabel !== cur) {
          labels[p] = bestLabel;
          changed++;
        }
      }
    }
    if (!changed) break;
  }
  return labels;
}

/**
 * Im2SurfTex-inspired geodesic bilateral attention pooling in atlas space (`TODO.md` #3):
 * attends over surface-linked 3×3 projected texels per view weighted by 3D world-space proximity, surface normal
 * alignment `(n_p · n_q)^8`, and local projection confidence `w_v(q)` before multi-view fusion.
 */
export function softBackprojectPool(
  views: { rgba: Uint8ClampedArray; weight: Float32Array }[],
  pos: ArrayLike<number>,
  nrm: ArrayLike<number>,
  links: ReturnType<typeof surfaceLinks>,
  size: number,
  opts: { spatialSigma?: number; temperature?: number } = {},
): ProjectedAtlasView[] {
  const temp = Math.max(0.15, opts.temperature ?? 0.65);
  // Estimate typical world texel spacing from linked neighbours
  let stepSum = 0, stepCount = 0;
  for (let k = 0; k < links.covered.length; k += 4) {
    const p = links.covered[k];
    if (links.right[p]) {
      const p4 = 4 * p, q4 = p4 + 4;
      stepSum += Math.hypot(pos[q4] - pos[p4], pos[q4 + 1] - pos[p4 + 1], pos[q4 + 2] - pos[p4 + 2]);
      stepCount++;
    }
  }
  const sigmaWorld = (opts.spatialSigma ?? 1.15) * (stepCount ? stepSum / stepCount : 0.05);
  const inv2Sigma2 = 1 / Math.max(1e-8, 2 * sigmaWorld * sigmaWorld);

  return views.map((pv) => {
    const outRgba = new Uint8ClampedArray(pv.rgba);
    const outW = new Float32Array(pv.weight);
    for (let k = 0; k < links.covered.length; k++) {
      const p = links.covered[k];
      if (!(pv.weight[p] > 0)) continue;
      const x = p % size, y = (p / size) | 0;
      const p4 = 4 * p;
      const px = pos[p4], py = pos[p4 + 1], pz = pos[p4 + 2];
      const nx = nrm[p4], ny = nrm[p4 + 1], nz = nrm[p4 + 2];
      const partP = links.part[p];

      let sr = 0, sg = 0, sb = 0, sw = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= size) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= size) continue;
          const q = yy * size + xx;
          if (links.part[q] !== partP || !(pv.weight[q] > 0)) continue;
          const q4 = 4 * q;
          const ndot = nx * nrm[q4] + ny * nrm[q4 + 1] + nz * nrm[q4 + 2];
          if (ndot < 0.85) continue;
          const d2 = (pos[q4] - px) ** 2 + (pos[q4 + 1] - py) ** 2 + (pos[q4 + 2] - pz) ** 2;
          const wGeo = Math.exp(-d2 * inv2Sigma2) * Math.pow(ndot, 8);
          const wConf = Math.pow(pv.weight[q], 1 / temp);
          // Bilateral Photometric guard so sharp mortar/brick edges inside a view never blur
          const cDiff2 =
            (pv.rgba[q4] - pv.rgba[p4]) ** 2 +
            (pv.rgba[q4 + 1] - pv.rgba[p4 + 1]) ** 2 +
            (pv.rgba[q4 + 2] - pv.rgba[p4 + 2]) ** 2;
          const wPhoto = dx === 0 && dy === 0 ? 1 : Math.exp(-cDiff2 / (2 * 26 * 26));
          const att = wGeo * wConf * wPhoto;
          sr += att * pv.rgba[q4];
          sg += att * pv.rgba[q4 + 1];
          sb += att * pv.rgba[q4 + 2];
          sw += att;
        }
      }
      if (sw > 0) {
        outRgba[p4] = Math.round(sr / sw);
        outRgba[p4 + 1] = Math.round(sg / sw);
        outRgba[p4 + 2] = Math.round(sb / sw);
        outRgba[p4 + 3] = 255;
      }
    }
    return { rgba: outRgba, weight: outW };
  });
}

/**
 * Pure-array consolidation pipeline over already back-projected views: tangent-flow registration + advection,
 * optional MRF view-label assignment & bilateral soft back-projection pooling, sharpness-weighted gradient assembly,
 * and Screened-Poisson stitch.
 */
export function consolidateProjectedViews(
  projected: ProjectedAtlasView[],
  pos: ArrayLike<number>,
  nrm: ArrayLike<number>,
  size: number,
  opts: { flow?: boolean; maxShift?: number; lambda?: number; qualityRatio?: number; mrf?: boolean; mrfSmooth?: number; softBackproject?: boolean } = {},
) {
  const useFlow = opts.flow !== false, maxShift = opts.maxShift ?? 3.0, lambda = opts.lambda ?? 0.02, ratio = opts.qualityRatio ?? 0.4;
  const useMrf = opts.mrf !== false;
  const useSoft = opts.softBackproject ?? false;
  const N = size * size;
  const links = surfaceLinks(pos, nrm, size);

  // 1. Reproduce the hard sequential/parallel winner atlas (`PROJECT_FRAG`'s `old.a >= ratio * q` rule) to record `owner` and `before` seam score.
  const hardRgba = new Uint8ClampedArray(N * 4);
  const bestQ = new Float32Array(N);
  const owner = new Int16Array(N).fill(-1);
  for (let v = 0; v < projected.length; v++) {
    const pv = projected[v];
    for (let k = 0; k < links.covered.length; k++) {
      const p = links.covered[k], q = pv.weight[p];
      if (!(q > 0)) continue;
      if (bestQ[p] > 0 && bestQ[p] >= ratio * q) continue;
      bestQ[p] = q;
      owner[p] = v;
      const p4 = 4 * p;
      hardRgba[p4] = pv.rgba[p4]; hardRgba[p4 + 1] = pv.rgba[p4 + 1]; hardRgba[p4 + 2] = pv.rgba[p4 + 2]; hardRgba[p4 + 3] = 255;
    }
  }
  const before = seamMetric(hardRgba, owner, links, size);

  // 2. Register overlapping views via high-pass tangent flow first so all views share a structurally aligned UV frame.
  const sumRgbInit = new Float32Array(N * 3), sumWInit = new Float32Array(N);
  const refMean = new Float32Array(N * 3);
  let flowAdvected = 0;
  let aligned: ProjectedAtlasView[] = [];

  for (let v = 0; v < projected.length; v++) {
    const pv = projected[v];
    let rgba = pv.rgba;
    if (useFlow && v > 0) {
      for (let k = 0; k < links.covered.length; k++) {
        const p = links.covered[k];
        if (sumWInit[p] > 0) {
          refMean[3 * p] = sumRgbInit[3 * p] / sumWInit[p];
          refMean[3 * p + 1] = sumRgbInit[3 * p + 1] / sumWInit[p];
          refMean[3 * p + 2] = sumRgbInit[3 * p + 2] / sumWInit[p];
        }
      }
      const reg = registerAndAdvectView(pv, refMean, sumWInit, links, size, maxShift);
      rgba = reg.rgba;
      if (reg.moved) flowAdvected++;
    }
    aligned.push({ rgba, weight: pv.weight });
    for (let k = 0; k < links.covered.length; k++) {
      const p = links.covered[k], w = pv.weight[p];
      if (!(w > 0)) continue;
      sumRgbInit[3 * p] += w * rgba[4 * p];
      sumRgbInit[3 * p + 1] += w * rgba[4 * p + 1];
      sumRgbInit[3 * p + 2] += w * rgba[4 * p + 2];
      sumWInit[p] += w;
    }
  }

  if (useSoft) {
    aligned = softBackprojectPool(aligned, pos, nrm, links, size);
  }

  // 3. Optional MRF patch-to-view assignment for ghost-free intra-patch spatial gradients and cleaner seam cuts.
  let mrfOwner: Int16Array | undefined;
  let mrfBefore: SeamScore | undefined;
  if (useMrf) {
    mrfOwner = solveMrfViewLabels(aligned, links, size, { smooth: opts.mrfSmooth ?? 0.35 });
    const mrfHard = new Uint8ClampedArray(N * 4);
    for (let k = 0; k < links.covered.length; k++) {
      const p = links.covered[k], lv = mrfOwner[p];
      if (lv < 0) continue;
      const p4 = 4 * p, src = aligned[lv].rgba;
      mrfHard[p4] = src[p4]; mrfHard[p4 + 1] = src[p4 + 1]; mrfHard[p4 + 2] = src[p4 + 2]; mrfHard[p4 + 3] = 255;
    }
    mrfBefore = seamMetric(mrfHard, mrfOwner, links, size);
  }

  // 4. Assemble Screened-Poisson data term (`sumRgb`, `sumW`) and coherent gradients (`gx`, `gy`).
  const sumRgb = new Float32Array(N * 3), sumW = new Float32Array(N);
  const gxSum = new Float32Array(N * 3), gxW = new Float32Array(N);
  const gySum = new Float32Array(N * 3), gyW = new Float32Array(N);

  for (let v = 0; v < aligned.length; v++) {
    const pv = aligned[v], rgba = pv.rgba;
    for (let k = 0; k < links.covered.length; k++) {
      const p = links.covered[k], w = pv.weight[p];
      if (!(w > 0)) continue;
      const p4 = 4 * p, p3 = 3 * p;
      const dataBoost = mrfOwner && mrfOwner[p] === v ? 1.5 : 1.0;
      const wd = w * dataBoost;
      sumRgb[p3] += wd * rgba[p4];
      sumRgb[p3 + 1] += wd * rgba[p4 + 1];
      sumRgb[p3 + 2] += wd * rgba[p4 + 2];
      sumW[p] += wd;

      if (links.right[p] && pv.weight[p + 1] > 0) {
        const mrfMatch = mrfOwner && mrfOwner[p] === v && mrfOwner[p + 1] === v ? 6.0 : 1.0;
        const ew = Math.min(w, pv.weight[p + 1]) ** 2 * mrfMatch;
        const q4 = p4 + 4;
        gxSum[p3] += ew * (rgba[q4] - rgba[p4]);
        gxSum[p3 + 1] += ew * (rgba[q4 + 1] - rgba[p4 + 1]);
        gxSum[p3 + 2] += ew * (rgba[q4 + 2] - rgba[p4 + 2]);
        gxW[p] += ew;
      }
      if (links.down[p] && pv.weight[p + size] > 0) {
        const mrfMatch = mrfOwner && mrfOwner[p] === v && mrfOwner[p + size] === v ? 6.0 : 1.0;
        const ew = Math.min(w, pv.weight[p + size]) ** 2 * mrfMatch;
        const q4 = 4 * (p + size);
        gySum[p3] += ew * (rgba[q4] - rgba[p4]);
        gySum[p3 + 1] += ew * (rgba[q4 + 1] - rgba[p4 + 1]);
        gySum[p3 + 2] += ew * (rgba[q4 + 2] - rgba[p4 + 2]);
        gyW[p] += ew;
      }
    }
  }

  const dataRgb = new Float32Array(N * 3);
  const gx = new Float32Array(N * 3), gy = new Float32Array(N * 3);
  for (let k = 0; k < links.covered.length; k++) {
    const p = links.covered[k], p3 = 3 * p;
    if (sumW[p] > 0) {
      dataRgb[p3] = sumRgb[p3] / sumW[p];
      dataRgb[p3 + 1] = sumRgb[p3 + 1] / sumW[p];
      dataRgb[p3 + 2] = sumRgb[p3 + 2] / sumW[p];
    }
    if (gxW[p] > 0) {
      gx[p3] = gxSum[p3] / gxW[p];
      gx[p3 + 1] = gxSum[p3 + 1] / gxW[p];
      gx[p3 + 2] = gxSum[p3 + 2] / gxW[p];
    }
    if (gyW[p] > 0) {
      gy[p3] = gySum[p3] / gyW[p];
      gy[p3 + 1] = gySum[p3 + 1] / gyW[p];
      gy[p3 + 2] = gySum[p3 + 2] / gyW[p];
    }
  }

  const stitched = poissonStitch(dataRgb, sumW, gx, gy, links, size, lambda);
  const seamOwner = mrfOwner ?? owner;
  const after = seamMetric(stitched, owner, links, size);
  return { hardRgba, stitched, owner, seamOwner, mrfBefore, links, before, after, flowAdvected };
}

/** Dilate an RGBA8 map a few cells into empty (`alpha = 0`) UV gutters so bilinear upsampling never pulls neutral gutter bytes onto island rims. */
function dilateGutter(rgba: Uint8ClampedArray, size: number, passes = 3): Uint8ClampedArray {
  let cur = new Uint8ClampedArray(rgba);
  for (let it = 0; it < passes; it++) {
    const next = new Uint8ClampedArray(cur);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (cur[4 * i + 3]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
            const j = 4 * (ny * size + nx);
            if (!cur[j + 3]) continue;
            r += cur[j]; g += cur[j + 1]; b += cur[j + 2]; n++;
          }
        }
        if (n) { next[4 * i] = r / n; next[4 * i + 1] = g / n; next[4 * i + 2] = b / n; next[4 * i + 3] = 255; }
      }
    }
    cur = next;
  }
  return cur;
}

/**
 * Consolidate all recorded views of `engine` in texture space and update `engine.atlas` in place (preserving native
 * atlas resolution and per-texel capture quality `alpha`). Zero model calls.
 */
export function consolidateViews(
  engine: Engine,
  views: { spec: ViewSpec; comp: Uint8ClampedArray; detail?: number }[],
  opts: ConsolidateOptions = {},
): ConsolidateResult {
  const t0 = performance.now();
  const size = Math.min(engine.atlas.size, opts.size ?? 1024);
  const depthSize = Math.min(engine.size, opts.depthSize ?? 512);
  const { pos, nrm } = engine.atlas.texelGeometry(size);
  const covered: number[] = [];
  for (let i = 0; i < size * size; i++) if (nrm[4 * i + 3] > 0.5) covered.push(i);
  const coveredIdx = Int32Array.from(covered);

  const dropSet = opts.dropViews?.length ? new Set(opts.dropViews) : null;
  const depthRt = floatTarget(depthSize, depthSize, { count: 3, depth: true });
  const projected: ProjectedAtlasView[] = [];
  try {
    for (let idx = 0; idx < views.length; idx++) {
      const v = views[idx];
      if (!v.comp?.length) continue;
      engine.views.renderGeometry(makeCamera(v.spec), depthRt);
      const gPos = engine.gpu.readF32(depthRt, 0, true);
      const pv = backProjectView(pos, nrm, size, coveredIdx, v.spec, gPos, depthSize, v.comp, engine.size, {
        detail: v.detail ?? 1,
        minCos: opts.minCos ?? engine.options.minCos,
        frameMargin: opts.frameMargin ?? engine.options.frameMargin,
        softKernel: opts.softBackproject,
      });
      if (dropSet?.has(idx)) {
        for (let i = 0; i < pv.weight.length; i++) pv.weight[i] *= 0.05;
      }
      projected.push(pv);
    }
  } finally {
    depthRt.dispose();
  }

  if (projected.length < 2) {
    const zero: SeamScore = { step: 0, interiorStep: 0, ratio: 1, boundaryEdges: 0 };
    return { size, views: projected.length, flowAdvected: 0, before: zero, after: zero, seconds: (performance.now() - t0) / 1000 };
  }

  const c = consolidateProjectedViews(projected, pos, nrm, size, {
    flow: opts.flow,
    maxShift: opts.maxShift,
    lambda: opts.lambda,
    mrf: opts.mrf,
    mrfSmooth: opts.mrfSmooth,
    softBackproject: opts.softBackproject,
    qualityRatio: engine.options.qualityRatio,
  });

  if (size >= engine.atlas.size) {
    engine.atlas.updatePaint(dilateGutter(c.stitched, size, 3), size);
  } else {
    // Preserve 100% of native 4K/8K detail inside views via signed offset `stitched - current`, and blend `stitched` across 1-cell view-boundary ribbons!
    const current = engine.atlas.readBytes([0.5, 0.5, 0.5], size, true).data;
    const delta = new Uint8ClampedArray(size * size * 4);
    const paint = dilateGutter(c.stitched, size, 3);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (!c.stitched[4 * i + 3] || !current[4 * i + 3]) continue;
        for (let ch = 0; ch < 3; ch++) {
          const diff = (c.stitched[4 * i + ch] - current[4 * i + ch]) / 255;
          delta[4 * i + ch] = Math.round(128 + THREE.MathUtils.clamp(diff, -1, 1) * 127);
        }
        delta[4 * i + 3] = 255;
        const own = c.owner[i];
        let onSeam = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const j = ny * size + nx;
          if (c.owner[j] >= 0 && c.owner[j] !== own && c.links.part[j] === c.links.part[i]) { onSeam = true; break; }
        }
        paint[4 * i + 3] = onSeam ? 255 : 128;
      }
    }
    engine.atlas.applyConsolidation(paint, dilateGutter(delta, size, 3), size, { pos, nrm });
  }

  return {
    size,
    views: projected.length,
    flowAdvected: c.flowAdvected,
    before: c.before,
    ...(c.mrfBefore ? { mrfBefore: c.mrfBefore } : {}),
    after: c.after,
    seconds: +((performance.now() - t0) / 1000).toFixed(3),
  };
}
