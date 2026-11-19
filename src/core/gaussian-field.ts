/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import * as THREE from 'three';
import { consolidateProjectedViews, seamMetric, surfaceLinks, type ProjectedAtlasView, type SeamScore } from './consolidate';
import { makeCamera, type ViewSpec } from './views';

/**
 * Research Spikes (`TODO.md` #11):
 * 1. Sparse Fixed-Geometry 3D Surface Gaussian Appearance Field (`fitSurfaceGaussianField`, Texture-GS / 2DGS style):
 *    - Anchors tangent-space Gaussians onto the known mesh surface (`pos`, `nrm`) and fits view-independent diffuse
 *      albedo `c_k` jointly with degree-1 directional Spherical Harmonics `D_k · ω_v` via closed-form 4×4 Ridge
 *      regression + tangent EWA splatting.
 *    - Disentangles view-dependent specular/lighting drift from intrinsic diffuse colour, renders clean novel views
 *      (`renderNovelGaussianView`), and provides a zero-cost multi-view outlier/consistency check (`ConsistencyCheck`).
 * 2. Importance-Gated Hybrid Score Distillation Sampling (`runImportanceGatedSdsPolish`):
 *    - Renders textured views along spherical/planned cameras, evaluates local diffusion score residuals
 *      `∇_x L_SDS = w(σ) (x_render - x̂_0(x_t; y))`, and updates ONLY high-importance UV texels (`importance >= gate`)
 *      via Adam momentum with surface-linked seam damping.
 */

export interface SurfelGaussian {
  texel: number;
  part: number;
  pos: [number, number, number];
  nrm: [number, number, number];
  scale: number;
  /** Disentangled view-independent diffuse RGB (`0..255`). */
  diffuse: [number, number, number];
  /** Degree-1 directional SH coefficients `[dx_r, dy_r, dz_r, dx_g, dy_g, dz_g, dx_b, dy_b, dz_b]`. */
  sh1: Float32Array;
  confidence: number;
}

export interface ConsistencyCheck {
  /** Per-view RMS RGB residual against the fitted appearance field. */
  perViewRmse: number[];
  /** Overall mean multi-view RGB residual. */
  meanRmse: number;
  /** Indices of views whose residual exceeds `1.75 × median` (likely hallucinated geometry/lighting outlier). */
  outlierViews: number[];
}

export interface SurfaceGaussianField {
  atlasSize: number;
  stride: number;
  gaussians: SurfelGaussian[];
  /** Grid lookup mapping `(gx, gy)` (`gx = floor(x / stride)`) -> index in `gaussians` (`-1` when empty). */
  gridIndex: Int32Array;
  gridSide: number;
  consistency: ConsistencyCheck;
  fitMs: number;
}

/** Solve a symmetric positive-definite 4×4 system `A x = b` via Gaussian elimination with partial pivoting. */
function solve4x4(A: Float64Array, b: Float64Array): Float64Array {
  const M = new Float64Array(16);
  M.set(A);
  const x = new Float64Array(b);
  for (let col = 0; col < 4; col++) {
    let piv = col, maxVal = Math.abs(M[col * 4 + col]);
    for (let r = col + 1; r < 4; r++) {
      const v = Math.abs(M[r * 4 + col]);
      if (v > maxVal) { maxVal = v; piv = r; }
    }
    if (maxVal < 1e-10) continue;
    if (piv !== col) {
      for (let c = col; c < 4; c++) {
        const tmp = M[col * 4 + c]; M[col * 4 + c] = M[piv * 4 + c]; M[piv * 4 + c] = tmp;
      }
      const tb = x[col]; x[col] = x[piv]; x[piv] = tb;
    }
    const diag = M[col * 4 + col];
    for (let r = col + 1; r < 4; r++) {
      const f = M[r * 4 + col] / diag;
      for (let c = col; c < 4; c++) M[r * 4 + c] -= f * M[col * 4 + c];
      x[r] -= f * x[col];
    }
  }
  const out = new Float64Array(4);
  for (let r = 3; r >= 0; r--) {
    let s = x[r];
    for (let c = r + 1; c < 4; c++) s -= M[r * 4 + c] * out[c];
    const diag = M[r * 4 + r];
    out[r] = Math.abs(diag) > 1e-10 ? s / diag : 0;
  }
  return out;
}

/**
 * Fit a sparse (`stride >= 2`) or dense (`stride = 1`) fixed-geometry Surface Gaussian Appearance Field to projected
 * views (`specs` + `projected`), disentangling intrinsic diffuse colour from degree-1 view-direction SH shading.
 */
export function fitSurfaceGaussianField(
  projected: ProjectedAtlasView[],
  specs: ViewSpec[],
  pos: ArrayLike<number>,
  nrm: ArrayLike<number>,
  atlasSize: number,
  opts: { stride?: number; shReg?: number } = {},
): SurfaceGaussianField {
  const t0 = performance.now();
  const stride = Math.max(1, opts.stride ?? 2);
  const shReg = opts.shReg ?? 0.35;
  const links = surfaceLinks(pos, nrm, atlasSize);
  const gridSide = Math.ceil(atlasSize / stride);
  const gridIndex = new Int32Array(gridSide * gridSide).fill(-1);

  // Estimate world step per atlas texel for physical Gaussian kernel width
  let stepSum = 0, stepCnt = 0;
  for (let k = 0; k < links.covered.length; k += 4) {
    const p = links.covered[k];
    if (links.right[p]) {
      const p4 = 4 * p, q4 = p4 + 4;
      stepSum += Math.hypot(pos[q4] - pos[p4], pos[q4 + 1] - pos[p4 + 1], pos[q4 + 2] - pos[p4 + 2]);
      stepCnt++;
    }
  }
  const worldStep = stepCnt ? stepSum / stepCnt : 0.05;
  const baseScale = worldStep * stride * 1.15;

  const gaussians: SurfelGaussian[] = [];
  const ata = new Float64Array(16);
  const rhsR = new Float64Array(4), rhsG = new Float64Array(4), rhsB = new Float64Array(4);

  for (let gy = 0; gy < gridSide; gy++) {
    for (let gx = 0; gx < gridSide; gx++) {
      // Pick covered anchor texel closest to cell centre
      let anchor = -1;
      const cx = Math.min(atlasSize - 1, gx * stride + (stride >> 1));
      const cy = Math.min(atlasSize - 1, gy * stride + (stride >> 1));
      if (links.part[cy * atlasSize + cx] >= 0) {
        anchor = cy * atlasSize + cx;
      } else {
        for (let dy = 0; dy < stride && anchor < 0; dy++) {
          for (let dx = 0; dx < stride && anchor < 0; dx++) {
            const xx = gx * stride + dx, yy = gy * stride + dy;
            if (xx < atlasSize && yy < atlasSize && links.part[yy * atlasSize + xx] >= 0) anchor = yy * atlasSize + xx;
          }
        }
      }
      if (anchor < 0) continue;

      const a4 = 4 * anchor;
      const mx = pos[a4], my = pos[a4 + 1], mz = pos[a4 + 2];
      const nx = nrm[a4], ny = nrm[a4 + 1], nz = nrm[a4 + 2];
      const part = links.part[anchor];

      ata.fill(0);
      rhsR.fill(0); rhsG.fill(0); rhsB.fill(0);
      let totalW = 0;

      // Gather observations across the `stride × stride` patch around `anchor` on the same part & normal
      const rPatch = Math.max(1, stride);
      const ax0 = anchor % atlasSize, ay0 = (anchor / atlasSize) | 0;
      for (let dy = -rPatch; dy <= rPatch; dy++) {
        const yy = ay0 + dy;
        if (yy < 0 || yy >= atlasSize) continue;
        for (let dx = -rPatch; dx <= rPatch; dx++) {
          const xx = ax0 + dx;
          if (xx < 0 || xx >= atlasSize) continue;
          const q = yy * atlasSize + xx;
          if (links.part[q] !== part) continue;
          const q4 = 4 * q;
          if (nx * nrm[q4] + ny * nrm[q4 + 1] + nz * nrm[q4 + 2] < 0.85) continue;
          const d2 = (pos[q4] - mx) ** 2 + (pos[q4 + 1] - my) ** 2 + (pos[q4 + 2] - mz) ** 2;
          const wSpatial = Math.exp(-d2 / (2 * baseScale * baseScale));
          if (wSpatial < 0.05) continue;

          for (let v = 0; v < projected.length; v++) {
            const wv = projected[v].weight[q];
            if (!(wv > 0)) continue;
            const w = wv * wSpatial;
            const camPos = specs[v].position;
            const vx = camPos[0] - pos[q4], vy = camPos[1] - pos[q4 + 1], vz = camPos[2] - pos[q4 + 2];
            const vLen = Math.hypot(vx, vy, vz) || 1;
            const b0 = 1, b1 = vx / vLen, b2 = vy / vLen, b3 = vz / vLen;
            const basis = [b0, b1, b2, b3];
            const cr = projected[v].rgba[q4], cg = projected[v].rgba[q4 + 1], cb = projected[v].rgba[q4 + 2];
            for (let i = 0; i < 4; i++) {
              const wi = w * basis[i];
              rhsR[i] += wi * cr;
              rhsG[i] += wi * cg;
              rhsB[i] += wi * cb;
              for (let j = 0; j < 4; j++) ata[i * 4 + j] += wi * basis[j];
            }
            totalW += w;
          }
        }
      }
      if (totalW <= 0) continue;

      // Tikhonov regularisation on directional SH terms (basis 1..3) so single-view surfels stay pure diffuse!
      const reg = shReg * Math.max(totalW, 1e-3);
      ata[0] += 1e-6;
      ata[5] += reg;
      ata[10] += reg;
      ata[15] += reg;

      const solR = solve4x4(ata, rhsR);
      const solG = solve4x4(ata, rhsG);
      const solB = solve4x4(ata, rhsB);

      const idx = gaussians.length;
      gridIndex[gy * gridSide + gx] = idx;
      gaussians.push({
        texel: anchor,
        part,
        pos: [mx, my, mz],
        nrm: [nx, ny, nz],
        scale: baseScale,
        diffuse: [
          Math.max(0, Math.min(255, solR[0])),
          Math.max(0, Math.min(255, solG[0])),
          Math.max(0, Math.min(255, solB[0])),
        ],
        sh1: Float32Array.from([solR[1], solR[2], solR[3], solG[1], solG[2], solG[3], solB[1], solB[2], solB[3]]),
        confidence: totalW,
      });
    }
  }

  // Evaluate free multi-view photometric consistency check against fitted SH + diffuse Gaussians
  const perViewRmse: number[] = [];
  let allSq = 0, allCnt = 0;
  for (let v = 0; v < projected.length; v++) {
    let sq = 0, cnt = 0;
    const camPos = specs[v].position;
    for (const g of gaussians) {
      const p = g.texel;
      if (!(projected[v].weight[p] > 0)) continue;
      const vx = camPos[0] - g.pos[0], vy = camPos[1] - g.pos[1], vz = camPos[2] - g.pos[2];
      const vLen = Math.hypot(vx, vy, vz) || 1;
      const ox = vx / vLen, oy = vy / vLen, oz = vz / vLen;
      const pr = g.diffuse[0] + g.sh1[0] * ox + g.sh1[1] * oy + g.sh1[2] * oz;
      const pg = g.diffuse[1] + g.sh1[3] * ox + g.sh1[4] * oy + g.sh1[5] * oz;
      const pb = g.diffuse[2] + g.sh1[6] * ox + g.sh1[7] * oy + g.sh1[8] * oz;
      const p4 = 4 * p;
      const d2 = ((projected[v].rgba[p4] - pr) ** 2 + (projected[v].rgba[p4 + 1] - pg) ** 2 + (projected[v].rgba[p4 + 2] - pb) ** 2) / 3;
      sq += d2; cnt++;
      allSq += d2; allCnt++;
    }
    perViewRmse.push(cnt ? +Math.sqrt(sq / cnt).toFixed(3) : 0);
  }
  const sortedRmse = [...perViewRmse].sort((a, b) => a - b);
  const medRmse = sortedRmse.length ? sortedRmse[sortedRmse.length >> 1] : 0;
  const outlierViews: number[] = [];
  perViewRmse.forEach((r, idx) => {
    if (medRmse > 0.5 && r > medRmse * 1.75 + 4) outlierViews.push(idx);
  });

  return {
    atlasSize,
    stride,
    gaussians,
    gridIndex,
    gridSide,
    consistency: {
      perViewRmse,
      meanRmse: allCnt ? +Math.sqrt(allSq / allCnt).toFixed(3) : 0,
      outlierViews,
    },
    fitMs: +(performance.now() - t0).toFixed(2),
  };
}

/**
 * Bake the disentangled diffuse component (`c_k`) of `SurfaceGaussianField` onto the `atlasSize × atlasSize` UV atlas
 * via surface-normal-aware tangent EWA Gaussian splatting.
 */
export function bakeGaussianFieldToAtlas(
  field: SurfaceGaussianField,
  pos: ArrayLike<number>,
  nrm: ArrayLike<number>,
): Uint8ClampedArray {
  const S = field.atlasSize;
  const N = S * S;
  const out = new Uint8ClampedArray(N * 4);
  const links = surfaceLinks(pos, nrm, S);

  for (let k = 0; k < links.covered.length; k++) {
    const p = links.covered[k], p4 = 4 * p;
    const x = p % S, y = (p / S) | 0;
    if (field.stride === 1) {
      // Texture-GS 1:1 texel mode: read disentangled diffuse directly without EWA kernel blur!
      const gi = field.gridIndex[y * field.gridSide + x];
      if (gi >= 0) {
        const g = field.gaussians[gi];
        out[p4] = Math.max(0, Math.min(255, Math.round(g.diffuse[0])));
        out[p4 + 1] = Math.max(0, Math.min(255, Math.round(g.diffuse[1])));
        out[p4 + 2] = Math.max(0, Math.min(255, Math.round(g.diffuse[2])));
        out[p4 + 3] = 255;
        continue;
      }
    }
    const gx0 = Math.floor(x / field.stride), gy0 = Math.floor(y / field.stride);
    const px = pos[p4], py = pos[p4 + 1], pz = pos[p4 + 2];
    const nx = nrm[p4], ny = nrm[p4 + 1], nz = nrm[p4 + 2];
    const part = links.part[p];

    let sr = 0, sg = 0, sb = 0, sw = 0;
    for (let dy = -2; dy <= 2; dy++) {
      const gy = gy0 + dy;
      if (gy < 0 || gy >= field.gridSide) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const gx = gx0 + dx;
        if (gx < 0 || gx >= field.gridSide) continue;
        const gi = field.gridIndex[gy * field.gridSide + gx];
        if (gi < 0) continue;
        const g = field.gaussians[gi];
        if (g.part !== part) continue;
        const ndot = nx * g.nrm[0] + ny * g.nrm[1] + nz * g.nrm[2];
        if (ndot < 0.8) continue;
        const d2 = (px - g.pos[0]) ** 2 + (py - g.pos[1]) ** 2 + (pz - g.pos[2]) ** 2;
        const w = Math.exp(-d2 / (2 * g.scale * g.scale)) * Math.pow(ndot, 6) * Math.sqrt(g.confidence);
        sr += w * g.diffuse[0];
        sg += w * g.diffuse[1];
        sb += w * g.diffuse[2];
        sw += w;
      }
    }
    if (sw > 0) {
      out[p4] = Math.max(0, Math.min(255, Math.round(sr / sw)));
      out[p4 + 1] = Math.max(0, Math.min(255, Math.round(sg / sw)));
      out[p4 + 2] = Math.max(0, Math.min(255, Math.round(sb / sw)));
      out[p4 + 3] = 255;
    }
  }
  return out;
}

/**
 * Render a clean novel camera view (`width × height` RGBA8) from `SurfaceGaussianField` given the novel view's world
 * geometry buffers (`gPos`, `gNrm`), optionally including view-dependent SH (`includeSh = false` gives pure delighted albedo).
 */
export function renderNovelGaussianView(
  field: SurfaceGaussianField,
  spec: ViewSpec,
  gPos: ArrayLike<number>,
  gNrm: ArrayLike<number>,
  width: number,
  height: number,
  opts: { includeSh?: boolean } = {},
): Uint8ClampedArray {
  const includeSh = opts.includeSh ?? false;
  const out = new Uint8ClampedArray(width * height * 4);
  const camPos = spec.position;

  // Build spatial hash of Gaussians for fast O(1) novel-view lookup
  const cell = Math.max(0.05, (field.gaussians[0]?.scale ?? 0.1) * 2.5);
  const buckets = new Map<string, number[]>();
  const keyOf = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < field.gaussians.length; i++) {
    const g = field.gaussians[i];
    const k = keyOf(g.pos[0], g.pos[1], g.pos[2]);
    let arr = buckets.get(k);
    if (!arr) { arr = []; buckets.set(k, arr); }
    arr.push(i);
  }

  for (let i = 0; i < width * height; i++) {
    const i4 = 4 * i;
    if (!(gPos[i4 + 3] > 0)) continue;
    const wx = gPos[i4], wy = gPos[i4 + 1], wz = gPos[i4 + 2];
    const nx = gNrm[i4], ny = gNrm[i4 + 1], nz = gNrm[i4 + 2];
    const cx = Math.floor(wx / cell), cy = Math.floor(wy / cell), cz = Math.floor(wz / cell);

    const vx = camPos[0] - wx, vy = camPos[1] - wy, vz = camPos[2] - wz;
    const vLen = Math.hypot(vx, vy, vz) || 1;
    const ox = vx / vLen, oy = vy / vLen, oz = vz / vLen;

    let sr = 0, sg = 0, sb = 0, sw = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const list = buckets.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!list) continue;
          for (const gi of list) {
            const g = field.gaussians[gi];
            const ndot = nx * g.nrm[0] + ny * g.nrm[1] + nz * g.nrm[2];
            if (ndot < 0.75) continue;
            const d2 = (wx - g.pos[0]) ** 2 + (wy - g.pos[1]) ** 2 + (wz - g.pos[2]) ** 2;
            const w = Math.exp(-d2 / (2 * g.scale * g.scale)) * Math.pow(ndot, 6);
            let cr = g.diffuse[0], cg = g.diffuse[1], cb = g.diffuse[2];
            if (includeSh) {
              cr += g.sh1[0] * ox + g.sh1[1] * oy + g.sh1[2] * oz;
              cg += g.sh1[3] * ox + g.sh1[4] * oy + g.sh1[5] * oz;
              cb += g.sh1[6] * ox + g.sh1[7] * oy + g.sh1[8] * oz;
            }
            sr += w * cr; sg += w * cg; sb += w * cb; sw += w;
          }
        }
      }
    }
    if (sw > 0) {
      out[i4] = Math.max(0, Math.min(255, Math.round(sr / sw)));
      out[i4 + 1] = Math.max(0, Math.min(255, Math.round(sg / sw)));
      out[i4 + 2] = Math.max(0, Math.min(255, Math.round(sb / sw)));
      out[i4 + 3] = 255;
    }
  }
  return out;
}

// ------------------------------------------------------------------ Importance-Gated Hybrid SDS Polish

export type SdsScoreTargetFn = (args: {
  viewIndex: number;
  spec: ViewSpec;
  renderedRgb: Float32Array; // [0..255] W*H*3
  width: number;
  height: number;
  sigma: number;
  step: number;
}) => Promise<Float32Array> | Float32Array; // returns denoised target x̂_0 in [0..255] W*H*3

export interface SdsPolishOptions {
  /** Optimisation iterations (default 24). */
  steps?: number;
  /** Importance threshold `[0, 1]`: texels below `importanceGate` receive zero SDS updates (default 0.55). */
  importanceGate?: number;
  /** Adam step size in RGB units `[0..255]` (default 2.5). */
  lr?: number;
  /** Render resolution of SDS camera crops (default 48). */
  viewSize?: number;
}

export interface SdsPolishResult {
  rgba: Uint8ClampedArray;
  activeTexels: number;
  untouchedLowImportanceTexels: number;
  initialLoss: number;
  finalLoss: number;
  seconds: number;
}

/**
 * Importance-gated Score Distillation Sampling (`TODO.md` #11):
 * optimizes the UV atlas over `views` by distilling `x̂_0(x_t; y) - x_render` strictly onto high-importance surfaces
 * (`importance[p] >= importanceGate`), keeping low-importance regions bit-exact and free of oversaturation drift.
 */
export async function runImportanceGatedSdsPolish(
  initialRgba: Uint8ClampedArray,
  pos: ArrayLike<number>,
  nrm: ArrayLike<number>,
  importance: ArrayLike<number>,
  atlasSize: number,
  views: ViewSpec[],
  scoreTarget: SdsScoreTargetFn,
  opts: SdsPolishOptions = {},
): Promise<SdsPolishResult> {
  const t0 = performance.now();
  const steps = Math.max(1, opts.steps ?? 24);
  const gate = opts.importanceGate ?? 0.55;
  const lr = opts.lr ?? 2.5;
  const VSize = opts.viewSize ?? 48;
  const N = atlasSize * atlasSize;
  const links = surfaceLinks(pos, nrm, atlasSize);

  const impMask = new Float32Array(N);
  let activeTexels = 0, untouchedLow = 0;
  for (const p of links.covered) {
    if (!initialRgba[4 * p + 3]) continue;
    const imp = importance[p] ?? 0;
    if (imp >= gate) {
      impMask[p] = Math.min(1, (imp - gate) / Math.max(0.05, 1 - gate) * 0.7 + 0.3);
      activeTexels++;
    } else {
      untouchedLow++;
    }
  }

  // Precompute visible pixel <-> atlas texel correspondence per camera (z-buffered)
  const viewMaps = views.map((spec) => {
    const cam = makeCamera(spec);
    const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
    const [cx, cy, cz] = spec.position;
    const pixTexel = new Int32Array(VSize * VSize).fill(-1);
    const pixDist = new Float32Array(VSize * VSize).fill(Infinity);
    const pixCos = new Float32Array(VSize * VSize);

    for (const p of links.covered) {
      const p4 = 4 * p;
      const wx = pos[p4], wy = pos[p4 + 1], wz = pos[p4 + 2];
      const cw = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15];
      if (cw <= 0.05) continue;
      const ndcX = (vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12]) / cw;
      const ndcY = (vp[1] * wx + vp[5] * wy + vp[9] * wz + vp[13]) / cw;
      if (Math.abs(ndcX) > 0.99 || Math.abs(ndcY) > 0.99) continue;
      const dx = cx - wx, dy = cy - wy, dz = cz - wz;
      const dist = Math.hypot(dx, dy, dz);
      if (dist < 1e-4) continue;
      const cosv = (nrm[p4] * dx + nrm[p4 + 1] * dy + nrm[p4 + 2] * dz) / dist;
      if (cosv < 0.08) continue;
      const px = Math.min(VSize - 1, Math.max(0, Math.floor((ndcX * 0.5 + 0.5) * VSize)));
      const py = Math.min(VSize - 1, Math.max(0, Math.floor((0.5 - ndcY * 0.5) * VSize)));
      const idx = py * VSize + px;
      if (dist < pixDist[idx]) {
        pixDist[idx] = dist;
        pixTexel[idx] = p;
        pixCos[idx] = cosv;
      }
    }
    return { spec, pixTexel, pixCos };
  });

  const texRgb = new Float32Array(N * 3);
  for (let p = 0; p < N; p++) {
    texRgb[3 * p] = initialRgba[4 * p];
    texRgb[3 * p + 1] = initialRgba[4 * p + 1];
    texRgb[3 * p + 2] = initialRgba[4 * p + 2];
  }
  const m1 = new Float32Array(N * 3);
  const m2 = new Float32Array(N * 3);
  const beta1 = 0.85, beta2 = 0.98;

  let initialLoss = 0, finalLoss = 0;

  for (let step = 0; step < steps; step++) {
    // Anneal SDS noise sigma from 0.45 -> 0.12 (HiFA / DreamTime coarse-to-fine polish schedule)
    const sigma = 0.45 - 0.33 * (step / Math.max(1, steps - 1));
    const wSigma = sigma * sigma + 0.15;
    const gradSum = new Float32Array(N * 3);
    const gradW = new Float32Array(N);
    let stepSq = 0, stepCnt = 0;

    for (let v = 0; v < viewMaps.length; v++) {
      const vm = viewMaps[v];
      const rendered = new Float32Array(VSize * VSize * 3).fill(128);
      for (let i = 0; i < VSize * VSize; i++) {
        const p = vm.pixTexel[i];
        if (p >= 0) {
          rendered[3 * i] = texRgb[3 * p];
          rendered[3 * i + 1] = texRgb[3 * p + 1];
          rendered[3 * i + 2] = texRgb[3 * p + 2];
        }
      }
      const x0 = await scoreTarget({
        viewIndex: v,
        spec: vm.spec,
        renderedRgb: rendered,
        width: VSize,
        height: VSize,
        sigma,
        step,
      });
      for (let i = 0; i < VSize * VSize; i++) {
        const p = vm.pixTexel[i];
        if (p < 0 || !(impMask[p] > 0)) continue;
        const w = vm.pixCos[i] * wSigma;
        const dr = rendered[3 * i] - x0[3 * i];
        const dg = rendered[3 * i + 1] - x0[3 * i + 1];
        const db = rendered[3 * i + 2] - x0[3 * i + 2];
        gradSum[3 * p] += w * dr;
        gradSum[3 * p + 1] += w * dg;
        gradSum[3 * p + 2] += w * db;
        gradW[p] += w;
        stepSq += (dr * dr + dg * dg + db * db) / 3;
        stepCnt++;
      }
    }

    const stepRmse = stepCnt ? Math.sqrt(stepSq / stepCnt) : 0;
    if (step === 0) initialLoss = stepRmse;
    finalLoss = stepRmse;

    const bc1 = 1 - Math.pow(beta1, step + 1);
    const bc2 = 1 - Math.pow(beta2, step + 1);
    for (const p of links.covered) {
      const gateW = impMask[p];
      if (!(gateW > 0) || !(gradW[p] > 0)) continue;
      const invW = 1 / gradW[p];
      for (let c = 0; c < 3; c++) {
        const idx = 3 * p + c;
        const g = gradSum[idx] * invW;
        m1[idx] = beta1 * m1[idx] + (1 - beta1) * g;
        m2[idx] = beta2 * m2[idx] + (1 - beta2) * g * g;
        const mHat = m1[idx] / bc1;
        const vHat = m2[idx] / bc2;
        texRgb[idx] = Math.max(0, Math.min(255, texRgb[idx] - lr * gateW * (mHat / (Math.sqrt(vHat) + 1e-5))));
      }
    }
  }

  const out = new Uint8ClampedArray(initialRgba);
  for (const p of links.covered) {
    if (!(impMask[p] > 0)) continue; // Bit-exact preservation of low-importance texels!
    out[4 * p] = Math.round(texRgb[3 * p]);
    out[4 * p + 1] = Math.round(texRgb[3 * p + 1]);
    out[4 * p + 2] = Math.round(texRgb[3 * p + 2]);
  }
  return {
    rgba: out,
    activeTexels,
    untouchedLowImportanceTexels: untouchedLow,
    initialLoss: +initialLoss.toFixed(3),
    finalLoss: +finalLoss.toFixed(3),
    seconds: +((performance.now() - t0) / 1000).toFixed(4),
  };
}

/**
 * Head-to-head benchmark comparing `SurfaceGaussianField` (`stride = 1` Texture-GS and `stride = 2` sparse 3DGS)
 * against `consolidateProjectedViews` (Screened-Poisson) under both diffuse brick detail and directional specular glare.
 */
export function benchmarkGaussianFieldVsPoisson(atlasSize = 64) {
  const S = atlasSize, N = S * S;
  const pos = new Float32Array(N * 4), nrm = new Float32Array(N * 4);
  const gtDiffuse = new Float32Array(N * 3);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      pos.set([(x / S) * 6 - 3, (y / S) * 6 - 3, 0, 1], 4 * i);
      nrm.set([0, 0, 1, 1], 4 * i);
      const grain = Math.sin(y * 0.7) * 18 + Math.cos(x * 0.6) * 14;
      gtDiffuse[3 * i] = 148 + grain;
      gtDiffuse[3 * i + 1] = 135 + grain * 0.9;
      gtDiffuse[3 * i + 2] = 120 + grain * 0.8;
    }
  }
  const links = surfaceLinks(pos, nrm, S);

  const specs: ViewSpec[] = [
    { id: 0, position: [-3.4, 0.4, 3.2], yaw: -0.72, pitch: 0.1, fov: 80 },
    { id: 1, position: [-1.1, 1.6, 3.6], yaw: -0.28, pitch: -0.38, fov: 80 },
    { id: 2, position: [1.8, 1.2, 3.5], yaw: 0.44, pitch: -0.3, fov: 80 },
    { id: 3, position: [3.2, 0.8, 3.3], yaw: 0.68, pitch: -0.2, fov: 80 },
  ];

  // Views exhibit asymmetric directional sun/specular bias `ox * 34 + oy * 28` across upper-hemisphere cameras!
  const projected: ProjectedAtlasView[] = specs.map((sp, v) => {
    const rgba = new Uint8ClampedArray(N * 4);
    const weight = new Float32Array(N);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        if (v === 0 && x > S * 0.68) continue;
        if (v === 3 && x < S * 0.32) continue;
        const i = y * S + x;
        const vx = sp.position[0] - pos[4 * i], vy = sp.position[1] - pos[4 * i + 1], vz = sp.position[2] - pos[4 * i + 2];
        const len = Math.hypot(vx, vy, vz);
        const ox = vx / len, oy = vy / len, oz = vz / len;
        const specBias = ox * 34 + oy * 28;
        rgba[4 * i] = Math.max(0, Math.min(255, Math.round(gtDiffuse[3 * i] + specBias)));
        rgba[4 * i + 1] = Math.max(0, Math.min(255, Math.round(gtDiffuse[3 * i + 1] + specBias * 0.9)));
        rgba[4 * i + 2] = Math.max(0, Math.min(255, Math.round(gtDiffuse[3 * i + 2] + specBias * 0.8)));
        rgba[4 * i + 3] = 255;
        weight[i] = oz / Math.max(1, len);
      }
    }
    return { rgba, weight };
  });

  const poisson = consolidateProjectedViews(projected, pos, nrm, S);
  const gsDense = fitSurfaceGaussianField(projected, specs, pos, nrm, S, { stride: 1, shReg: 0.15 });
  const gsDenseRgba = bakeGaussianFieldToAtlas(gsDense, pos, nrm);
  const gsSparse = fitSurfaceGaussianField(projected, specs, pos, nrm, S, { stride: 2, shReg: 0.15 });
  const gsSparseRgba = bakeGaussianFieldToAtlas(gsSparse, pos, nrm);

  const rmseVsGt = (rgba: Uint8ClampedArray) => {
    let sq = 0;
    for (let i = 0; i < N; i++) {
      for (let c = 0; c < 3; c++) sq += (rgba[4 * i + c] - gtDiffuse[3 * i + c]) ** 2;
    }
    return +Math.sqrt(sq / (N * 3)).toFixed(3);
  };

  return {
    poisson: {
      seam: poisson.after,
      diffuseRmse: rmseVsGt(poisson.stitched),
    },
    gaussianDense: {
      seam: seamMetric(gsDenseRgba, poisson.owner, links, S) as SeamScore,
      diffuseRmse: rmseVsGt(gsDenseRgba),
      fitMs: gsDense.fitMs,
    },
    gaussianSparse: {
      seam: seamMetric(gsSparseRgba, poisson.owner, links, S) as SeamScore,
      diffuseRmse: rmseVsGt(gsSparseRgba),
      fitMs: gsSparse.fitMs,
    },
  };
}
