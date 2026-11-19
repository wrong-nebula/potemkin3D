/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import * as THREE from 'three';
import {
  consolidateProjectedViews,
  depthContinuity,
  seamMetric,
  solveMrfViewLabels,
  surfaceLinks,
  type ProjectedAtlasView,
  type SeamScore,
} from './consolidate';
import { makeCamera, type ViewSpec } from './views';

/**
 * TexFusion-style Synchronised Multi-View Latent Aggregation (`TODO.md` #3 research spike; Cao et al., ICCV 2023):
 * - Maintains a shared `C`-channel UV latent atlas (`LatentAtlas`, e.g. `C = 4` SDXL or `C = 16` FLUX VAE latents, or `C = 3` x0-RGB)
 *   plus a fixed 3D-consistent UV Gaussian noise field `ε_uv` so overlapping views share spatially coherent noise.
 * - Executes the Sequential Interlaced Multiview Sampler (`runSequentialInterlacedSampler`):
 *   at each denoising step `t` (`σ_t → σ_{t-1}`), views `v = 0 .. V-1` are interlaced sequentially:
 *   1. Render already-updated UV latents from views `0 .. v-1` at step `t` (falling back to step `t+1` consensus) into
 *      view `v`'s camera frame and re-noise with projected `ε_uv`: `z_{t,v} = (1 - σ_t) ẑ_{0,agg} + σ_t ε_v`.
 *   2. Query the local step denoiser (`StepDenoiser`, e.g. ComfyUI `KSamplerAdvanced` or `/texfusion/step`) for view `v`'s
 *      clean prediction `ẑ_{0,v}^{(t)}`.
 *   3. Aggregate `ẑ_{0,v}^{(t)}` back into the shared UV latent atlas with schedule-adaptive confidence temperature
 *      (soft consensus at high `σ_t` to lock global palette/structure; sharp `cosθ/d` selection at low `σ_t` to preserve
 *      high-frequency grain without latent blur).
 */

export interface ViewLatentProjection {
  spec: ViewSpec;
  latentWidth: number;
  latentHeight: number;
  /** Per-covered-texel mapping into this view's latent grid (`-1` when occluded or outside frustum). */
  texelU: Float32Array;
  texelV: Float32Array;
  texelWeight: Float32Array;
  /** Per-view-pixel index of the primary visible atlas texel (`-1` for sky/background), for forward rendering UV → view. */
  pixelTexel: Int32Array;
}

export interface LatentAtlas {
  atlasSize: number;
  channels: number;
  /** `atlasSize * atlasSize * channels` float32 clean latent estimate `ẑ_0`. */
  data: Float32Array;
  /** Accumulated confidence per atlas texel. */
  weight: Float32Array;
  /** Fixed spatially-coherent standard normal noise field `ε_uv` (`atlasSize * atlasSize * channels`). */
  noise: Float32Array;
}

export type StepDenoiser = (args: {
  viewIndex: number;
  spec: ViewSpec;
  noisyLatent: Float32Array;
  knownMask: Uint8Array;
  channels: number;
  width: number;
  height: number;
  sigma: number;
  sigmaNext: number;
  stepIndex: number;
  totalSteps: number;
}) => Promise<Float32Array> | Float32Array;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussianNoise(length: number, seed = 42): Float32Array {
  const rng = mulberry32(seed);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 2) {
    const u1 = Math.max(1e-7, rng());
    const u2 = rng();
    const r = Math.sqrt(-2 * Math.log(u1));
    const th = 2 * Math.PI * u2;
    out[i] = r * Math.cos(th);
    if (i + 1 < length) out[i + 1] = r * Math.sin(th);
  }
  return out;
}

/** Precompute bidirectional UV-texel ↔ view-latent correspondence with depth-continuity occlusion guards. */
export function buildViewLatentProjection(
  texelPos: ArrayLike<number>,
  texelNrm: ArrayLike<number>,
  atlasSize: number,
  coveredIdx: ArrayLike<number>,
  spec: ViewSpec,
  gPos: ArrayLike<number>,
  gSize: number,
  latentWidth: number,
  latentHeight: number,
  opts: { minCos?: number; frameMargin?: number } = {},
): ViewLatentProjection {
  const minCos = opts.minCos ?? 0.08;
  const margin = opts.frameMargin ?? 0;
  const ndcLimit = 0.999 - 2 * margin;
  const cam = makeCamera(spec);
  const lens = cam.projectionMatrix.elements[5] || 1;
  const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
  const [cx, cy, cz] = spec.position;
  const dCont = depthContinuity(gPos, gSize, gSize);

  const N = atlasSize * atlasSize;
  const texelU = new Float32Array(N).fill(-1);
  const texelV = new Float32Array(N).fill(-1);
  const texelWeight = new Float32Array(N);

  const pixelTexel = new Int32Array(latentWidth * latentHeight).fill(-1);
  const pixelBestDist = new Float32Array(latentWidth * latentHeight).fill(Infinity);

  for (let k = 0; k < coveredIdx.length; k++) {
    const p = coveredIdx[k], p4 = 4 * p;
    const wx = texelPos[p4], wy = texelPos[p4 + 1], wz = texelPos[p4 + 2];
    const cw = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15];
    if (cw <= 0.05) continue;
    const ndcX = (vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12]) / cw;
    const ndcY = (vp[1] * wx + vp[5] * wy + vp[9] * wz + vp[13]) / cw;
    if (Math.abs(ndcX) > ndcLimit || Math.abs(ndcY) > ndcLimit) continue;

    const dx = cx - wx, dy = cy - wy, dz = cz - wz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-4) continue;
    const cosv = (texelNrm[p4] * dx + texelNrm[p4 + 1] * dy + texelNrm[p4 + 2] * dz) / dist;
    if (cosv < minCos) continue;

    const u = ndcX * 0.5 + 0.5, vTop = 0.5 - ndcY * 0.5;
    const gx = Math.min(gSize - 1, Math.max(0, Math.floor(u * gSize)));
    const gy = Math.min(gSize - 1, Math.max(0, Math.floor(vTop * gSize)));
    const gi = gy * gSize + gx;
    const gd = gPos[4 * gi + 3];
    if (gd > 0 && dist > gd + 0.025 + 0.015 * dist) continue;

    texelU[p] = u * latentWidth - 0.5;
    texelV[p] = vTop * latentHeight - 0.5;
    const rim = Math.min(1, (ndcLimit - Math.max(Math.abs(ndcX), Math.abs(ndcY))) / 0.08);
    const cont = gd > 0 ? dCont[gi] : 0.5;
    texelWeight[p] = Math.max(1e-5, ((lens * cosv) / Math.max(dist, 0.5)) * cont * Math.max(0.05, rim));

    const lx = Math.min(latentWidth - 1, Math.max(0, Math.floor(u * latentWidth)));
    const ly = Math.min(latentHeight - 1, Math.max(0, Math.floor(vTop * latentHeight)));
    const li = ly * latentWidth + lx;
    if (dist < pixelBestDist[li]) {
      pixelBestDist[li] = dist;
      pixelTexel[li] = p;
    }
  }
  return { spec, latentWidth, latentHeight, texelU, texelV, texelWeight, pixelTexel };
}

export function createLatentAtlas(atlasSize: number, channels: number, seed = 1337): LatentAtlas {
  const len = atlasSize * atlasSize * channels;
  return {
    atlasSize,
    channels,
    data: new Float32Array(len),
    weight: new Float32Array(atlasSize * atlasSize),
    noise: gaussianNoise(len, seed),
  };
}

function sampleViewBilinear(
  viewLatent: ArrayLike<number>,
  width: number,
  height: number,
  channels: number,
  fx: number,
  fy: number,
  out: Float32Array,
  outOffset: number,
) {
  const cx = Math.max(0, Math.min(width - 1.000001, fx));
  const cy = Math.max(0, Math.min(height - 1.000001, fy));
  const x0 = cx | 0, tx = cx - x0, x1 = Math.min(width - 1, x0 + 1);
  const y0 = cy | 0, ty = cy - y0, y1 = Math.min(height - 1, y0 + 1);
  const i00 = (y0 * width + x0) * channels;
  const i10 = (y0 * width + x1) * channels;
  const i01 = (y1 * width + x0) * channels;
  const i11 = (y1 * width + x1) * channels;
  for (let c = 0; c < channels; c++) {
    out[outOffset + c] =
      (viewLatent[i00 + c] * (1 - tx) + viewLatent[i10 + c] * tx) * (1 - ty) +
      (viewLatent[i01 + c] * (1 - tx) + viewLatent[i11 + c] * tx) * ty;
  }
}

/**
 * Forward-render the shared UV latent atlas into view `proj` at noise level `sigma` (`z_t = (1 - σ) ẑ_0 + σ ε`),
 * using the 3D-projected UV noise `ε_uv` on surface pixels and deterministic view fallback noise on sky/unseen pixels.
 */
export function renderNoisyViewLatent(
  atlas: LatentAtlas,
  proj: ViewLatentProjection,
  sigma: number,
  fallbackNoise: Float32Array,
): { noisyLatent: Float32Array; knownMask: Uint8Array } {
  const { latentWidth: W, latentHeight: H } = proj;
  const C = atlas.channels;
  const noisyLatent = new Float32Array(W * H * C);
  const knownMask = new Uint8Array(W * H);

  for (let i = 0; i < W * H; i++) {
    const p = proj.pixelTexel[i];
    const o = i * C;
    if (p >= 0 && atlas.weight[p] > 0) {
      knownMask[i] = 1;
      // Even at step 0 (`sigma = 1`), interlaced views `v > 0` condition on `0 .. v-1`'s clean prediction (`effSigma <= 0.85`)
      const effSigma = Math.min(sigma, 0.85);
      const pOff = p * C;
      for (let c = 0; c < C; c++) {
        noisyLatent[o + c] = (1 - effSigma) * atlas.data[pOff + c] + effSigma * atlas.noise[pOff + c];
      }
    } else if (p >= 0) {
      const pOff = p * C;
      for (let c = 0; c < C; c++) noisyLatent[o + c] = atlas.noise[pOff + c];
    } else {
      for (let c = 0; c < C; c++) noisyLatent[o + c] = fallbackNoise[o + c];
    }
  }
  return { noisyLatent, knownMask };
}

export interface SimsOptions {
  /** Number of denoising steps (default 12). */
  steps?: number;
  /** Latent channel count (e.g. 4 for SDXL, 16 for FLUX, 3 for RGB-space x0 testing; default 4). */
  channels?: number;
  /** Seed for shared 3D UV Gaussian noise (default 42). */
  seed?: number;
  /** Use MRF patch-to-view assignment on the final clean latent bake (default true). */
  finalMrf?: boolean;
}

export interface SimsResult {
  atlas: LatentAtlas;
  /** Final clean (`σ = 0`) predictions per view. */
  cleanViews: Float32Array[];
  /** Mean L2 discrepancy across overlapping UV texels before final aggregation. */
  crossViewDiscrepancy: number;
  denoiserCalls: number;
  seconds: number;
}

/**
 * Run TexFusion's **Sequential Interlaced Multiview Sampler (SIMS)** across `projections` using `stepDenoiser`.
 */
export async function runSequentialInterlacedSampler(
  projections: ViewLatentProjection[],
  coveredIdx: ArrayLike<number>,
  pos: ArrayLike<number>,
  nrm: ArrayLike<number>,
  atlasSize: number,
  stepDenoiser: StepDenoiser,
  opts: SimsOptions = {},
): Promise<SimsResult> {
  const t0 = performance.now();
  const steps = Math.max(2, opts.steps ?? 12);
  const channels = opts.channels ?? 4;
  const seed = opts.seed ?? 42;
  const atlas = createLatentAtlas(atlasSize, channels, seed);
  const V = projections.length;
  const N = atlasSize * atlasSize;

  const fallbackNoises = projections.map((p, v) =>
    gaussianNoise(p.latentWidth * p.latentHeight * channels, seed + 1009 * (v + 1)),
  );
  const cleanViews: Float32Array[] = new Array(V);
  const scratch = new Float32Array(channels);
  let denoiserCalls = 0;

  // Linear rectified-flow schedule σ_0 = 1.0 -> σ_steps = 0.0
  for (let s = 0; s < steps; s++) {
    const sigma = 1 - s / steps;
    const sigmaNext = 1 - (s + 1) / steps;
    // Schedule-adaptive confidence exponent: soft averaging early (global structure/palette), sharp winner late (crisp detail)
    const progress = s / Math.max(1, steps - 1);
    const gamma = 1.0 + 3.5 * progress * progress;

    // Accumulate step-s consensus while interlacing views sequentially within the wave!
    const stepSum = new Float32Array(N * channels);
    const stepW = new Float32Array(N);

    for (let v = 0; v < V; v++) {
      const proj = projections[v];
      // Interlaced read: blend already-denoised views `0..v-1` from THIS step `s` ahead of step `s-1`'s atlas!
      const liveAtlas: LatentAtlas = {
        ...atlas,
        data: new Float32Array(atlas.data),
        weight: new Float32Array(atlas.weight),
      };
      for (let k = 0; k < coveredIdx.length; k++) {
        const p = coveredIdx[k];
        if (stepW[p] > 0) {
          const invW = 1 / stepW[p];
          const pOff = p * channels;
          for (let c = 0; c < channels; c++) liveAtlas.data[pOff + c] = stepSum[pOff + c] * invW;
          liveAtlas.weight[p] = stepW[p];
        }
      }

      const { noisyLatent, knownMask } = renderNoisyViewLatent(liveAtlas, proj, sigma, fallbackNoises[v]);
      const x0 = await stepDenoiser({
        viewIndex: v,
        spec: proj.spec,
        noisyLatent,
        knownMask,
        channels,
        width: proj.latentWidth,
        height: proj.latentHeight,
        sigma,
        sigmaNext,
        stepIndex: s,
        totalSteps: steps,
      });
      denoiserCalls++;
      cleanViews[v] = x0;

      for (let k = 0; k < coveredIdx.length; k++) {
        const p = coveredIdx[k];
        const wRaw = proj.texelWeight[p];
        if (!(wRaw > 0)) continue;
        const w = Math.pow(wRaw, gamma);
        sampleViewBilinear(x0, proj.latentWidth, proj.latentHeight, channels, proj.texelU[p], proj.texelV[p], scratch, 0);
        const pOff = p * channels;
        for (let c = 0; c < channels; c++) stepSum[pOff + c] += w * scratch[c];
        stepW[p] += w;
      }
    }

    for (let k = 0; k < coveredIdx.length; k++) {
      const p = coveredIdx[k];
      if (stepW[p] > 0) {
        const invW = 1 / stepW[p];
        const pOff = p * channels;
        for (let c = 0; c < channels; c++) atlas.data[pOff + c] = stepSum[pOff + c] * invW;
        atlas.weight[p] = stepW[p];
      }
    }
  }

  // Measure cross-view L2 discrepancy across overlapping UV texels on the final clean predictions
  let discSum = 0, discCount = 0;
  for (let k = 0; k < coveredIdx.length; k++) {
    const p = coveredIdx[k];
    if (!(atlas.weight[p] > 0)) continue;
    let obs = 0;
    for (let v = 0; v < V; v++) if (projections[v].texelWeight[p] > 0) obs++;
    if (obs < 2) continue;
    const pOff = p * channels;
    for (let v = 0; v < V; v++) {
      const proj = projections[v];
      if (!(proj.texelWeight[p] > 0)) continue;
      sampleViewBilinear(cleanViews[v], proj.latentWidth, proj.latentHeight, channels, proj.texelU[p], proj.texelV[p], scratch, 0);
      let d2 = 0;
      for (let c = 0; c < channels; c++) d2 += (scratch[c] - atlas.data[pOff + c]) ** 2;
      discSum += Math.sqrt(d2 / channels);
      discCount++;
    }
  }

  // Optional final MRF patch selection when channels === 3 (decoded RGB/3-ch latent)
  if (opts.finalMrf !== false && channels >= 3 && V >= 2) {
    const links = surfaceLinks(pos, nrm, atlasSize);
    const asRgbaViews: ProjectedAtlasView[] = projections.map((proj, v) => {
      const rgba = new Uint8ClampedArray(N * 4);
      for (let k = 0; k < coveredIdx.length; k++) {
        const p = coveredIdx[k];
        if (!(proj.texelWeight[p] > 0)) continue;
        sampleViewBilinear(cleanViews[v], proj.latentWidth, proj.latentHeight, channels, proj.texelU[p], proj.texelV[p], scratch, 0);
        rgba[4 * p] = Math.max(0, Math.min(255, Math.round((scratch[0] * 0.5 + 0.5) * 255)));
        rgba[4 * p + 1] = Math.max(0, Math.min(255, Math.round((scratch[1] * 0.5 + 0.5) * 255)));
        rgba[4 * p + 2] = Math.max(0, Math.min(255, Math.round((scratch[2] * 0.5 + 0.5) * 255)));
        rgba[4 * p + 3] = 255;
      }
      return { rgba, weight: proj.texelWeight };
    });
    const labels = solveMrfViewLabels(asRgbaViews, links, atlasSize);
    for (let k = 0; k < coveredIdx.length; k++) {
      const p = coveredIdx[k], lv = labels[p];
      if (lv < 0) continue;
      const proj = projections[lv];
      sampleViewBilinear(cleanViews[lv], proj.latentWidth, proj.latentHeight, channels, proj.texelU[p], proj.texelV[p], atlas.data, p * channels);
    }
  }

  return {
    atlas,
    cleanViews,
    crossViewDiscrepancy: discCount ? +(discSum / discCount).toFixed(5) : 0,
    denoiserCalls,
    seconds: +((performance.now() - t0) / 1000).toFixed(4),
  };
}

/** Decode a 3-channel `[-1, 1]` `LatentAtlas` to RGBA8 for direct seam-score comparison with `consolidateProjectedViews`. */
export function decodeRgbLatentAtlas(atlas: LatentAtlas): Uint8ClampedArray {
  const N = atlas.atlasSize * atlas.atlasSize;
  const C = atlas.channels;
  const out = new Uint8ClampedArray(N * 4);
  for (let p = 0; p < N; p++) {
    if (!(atlas.weight[p] > 0)) continue;
    const o = p * C;
    out[4 * p] = Math.max(0, Math.min(255, Math.round((atlas.data[o] * 0.5 + 0.5) * 255)));
    out[4 * p + 1] = Math.max(0, Math.min(255, Math.round(((C > 1 ? atlas.data[o + 1] : atlas.data[o]) * 0.5 + 0.5) * 255)));
    out[4 * p + 2] = Math.max(0, Math.min(255, Math.round(((C > 2 ? atlas.data[o + 2] : atlas.data[o]) * 0.5 + 0.5) * 255)));
    out[4 * p + 3] = 255;
  }
  return out;
}

/**
 * Controlled head-to-head benchmark comparing independent multi-view denoising, independent denoising + Screened-Poisson
 * consolidation (`consolidateProjectedViews`), and TexFusion's Sequential Interlaced Multiview Sampler (`SIMS`) under the
 * exact same stochastic rectified-flow denoiser.
 */
export async function benchmarkTexFusionVsConsolidate(opts: { atlasSize?: number; steps?: number } = {}) {
  const S = opts.atlasSize ?? 48;
  const steps = opts.steps ?? 10;
  const N = S * S;
  const pos = new Float32Array(N * 4);
  const nrm = new Float32Array(N * 4);
  const covered: number[] = [];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      pos.set([(x / S) * 6 - 3, (y / S) * 4 - 2, 0, 1], 4 * i);
      nrm.set([0, 0, 1, 1], 4 * i);
      covered.push(i);
    }
  }
  const coveredIdx = Int32Array.from(covered);
  const links = surfaceLinks(pos, nrm, S);

  const specs: ViewSpec[] = [
    { id: 0, position: [-1.4, 0, 3.6], yaw: -0.32, pitch: 0, fov: 78 },
    { id: 1, position: [0.0, 0, 3.5], yaw: 0.0, pitch: 0, fov: 78 },
    { id: 2, position: [1.4, 0, 3.6], yaw: 0.32, pitch: 0, fov: 78 },
  ];

  const gSize = 48;
  const projections = specs.map((spec) => {
    const cam = makeCamera(spec);
    const invVp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).invert();
    const gPos = new Float32Array(gSize * gSize * 4);
    const origin = new THREE.Vector3(...spec.position);
    const farPt = new THREE.Vector3();
    for (let y = 0; y < gSize; y++) {
      for (let x = 0; x < gSize; x++) {
        const ndcX = ((x + 0.5) / gSize) * 2 - 1;
        const ndcY = 1 - ((y + 0.5) / gSize) * 2;
        farPt.set(ndcX, ndcY, 0.5).applyMatrix4(invVp);
        const dir = farPt.sub(origin).normalize();
        if (Math.abs(dir.z) > 1e-4) {
          const tHit = -origin.z / dir.z;
          if (tHit > 0) {
            const wx = origin.x + dir.x * tHit, wy = origin.y + dir.y * tHit;
            gPos.set([wx, wy, 0, tHit], 4 * (y * gSize + x));
          }
        }
      }
    }
    return buildViewLatentProjection(pos, nrm, S, coveredIdx, spec, gPos, gSize, 48, 48);
  });

  // Stochastic inpaint-aware denoiser: global stone palette drifts with initial noise unless anchored by `knownMask` overlap!
  const makeDenoiser = (): StepDenoiser => ({ viewIndex, noisyLatent, knownMask, width, height, channels, sigma }) => {
    const proj = projections[viewIndex];
    const out = new Float32Array(noisyLatent.length);
    let mode0 = 0, mode1 = 0, mode2 = 0, cnt = 0;
    // Anchor global palette on `knownMask` overlap when available (InpaintModelConditioning), else center 4×4 noise seed
    for (let i = 0; i < width * height; i++) {
      if (!knownMask[i]) continue;
      mode0 += noisyLatent[i * channels] - 0.12;
      mode1 += noisyLatent[i * channels + 1] - 0.04;
      mode2 += noisyLatent[i * channels + 2] + 0.05;
      cnt++;
    }
    if (cnt === 0) {
      const cx = width >> 1, cy = height >> 1;
      for (let dy = -2; dy < 2; dy++) {
        for (let dx = -2; dx < 2; dx++) {
          const idx = ((cy + dy) * width + (cx + dx)) * channels;
          mode0 += noisyLatent[idx];
          mode1 += noisyLatent[idx + 1];
          mode2 += noisyLatent[idx + 2];
          cnt++;
        }
      }
    }
    mode0 /= cnt; mode1 /= cnt; mode2 /= cnt;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pxIdx = y * width + x;
        const i = pxIdx * channels;
        const p = proj.pixelTexel[pxIdx];
        const wx = p >= 0 ? pos[4 * p] : (x / width) * 6 - 3;
        const wy = p >= 0 ? pos[4 * p + 1] : (y / height) * 4 - 2;
        const brick = Math.sin(wy * 4.5 + mode0 * 1.2) * 0.14 + Math.cos(wx * 3.8 + mode1 * 1.0) * 0.11;
        const prior0 = 0.12 + brick + mode0 * 0.65;
        const prior1 = 0.04 + brick * 0.9 + mode1 * 0.60;
        const prior2 = -0.05 + brick * 0.8 + mode2 * 0.55;
        const blend = knownMask[pxIdx] ? 0.2 + 0.45 * sigma : 0.35 + 0.55 * sigma;
        out[i] = Math.max(-1, Math.min(1, (1 - blend) * noisyLatent[i] + blend * prior0));
        out[i + 1] = Math.max(-1, Math.min(1, (1 - blend) * noisyLatent[i + 1] + blend * prior1));
        out[i + 2] = Math.max(-1, Math.min(1, (1 - blend) * noisyLatent[i + 2] + blend * prior2));
      }
    }
    return out;
  };

  const denoiser = makeDenoiser();

  // 1. Independent parallel denoising (`--parallel`: each view denoised independently from its own Gaussian noise)
  const indepClean: Float32Array[] = [];
  for (let v = 0; v < specs.length; v++) {
    const proj = projections[v];
    const eps = gaussianNoise(proj.latentWidth * proj.latentHeight * 3, 9000 + v * 777);
    let z = new Float32Array(eps);
    let x0 = new Float32Array(eps.length);
    for (let s = 0; s < steps; s++) {
      const sigma = 1 - s / steps;
      const sigmaNext = 1 - (s + 1) / steps;
      x0 = new Float32Array(await denoiser({
        viewIndex: v,
        spec: proj.spec,
        noisyLatent: z,
        knownMask: new Uint8Array(proj.latentWidth * proj.latentHeight),
        channels: 3,
        width: proj.latentWidth,
        height: proj.latentHeight,
        sigma,
        sigmaNext,
        stepIndex: s,
        totalSteps: steps,
      }));
      for (let j = 0; j < z.length; j++) z[j] = (1 - sigmaNext) * x0[j] + sigmaNext * eps[j];
    }
    indepClean.push(x0);
  }

  const scratch = new Float32Array(3);
  const indepProjected: ProjectedAtlasView[] = projections.map((proj, v) => {
    const rgba = new Uint8ClampedArray(N * 4);
    for (const p of coveredIdx) {
      if (!(proj.texelWeight[p] > 0)) continue;
      sampleViewBilinear(indepClean[v], proj.latentWidth, proj.latentHeight, 3, proj.texelU[p], proj.texelV[p], scratch, 0);
      rgba[4 * p] = Math.max(0, Math.min(255, Math.round((scratch[0] * 0.5 + 0.5) * 255)));
      rgba[4 * p + 1] = Math.max(0, Math.min(255, Math.round((scratch[1] * 0.5 + 0.5) * 255)));
      rgba[4 * p + 2] = Math.max(0, Math.min(255, Math.round((scratch[2] * 0.5 + 0.5) * 255)));
      rgba[4 * p + 3] = 255;
    }
    return { rgba, weight: proj.texelWeight };
  });

  // Measure independent cross-view L2 discrepancy
  let indepDiscSum = 0, indepDiscCnt = 0;
  for (const p of coveredIdx) {
    const vals: number[][] = [];
    for (let v = 0; v < projections.length; v++) {
      if (projections[v].texelWeight[p] > 0) {
        const c4 = 4 * p;
        vals.push([indepProjected[v].rgba[c4] / 127.5 - 1, indepProjected[v].rgba[c4 + 1] / 127.5 - 1, indepProjected[v].rgba[c4 + 2] / 127.5 - 1]);
      }
    }
    if (vals.length >= 2) {
      const m = [0, 1, 2].map((c) => vals.reduce((s, x) => s + x[c], 0) / vals.length);
      for (const x of vals) {
        indepDiscSum += Math.sqrt(((x[0] - m[0]) ** 2 + (x[1] - m[1]) ** 2 + (x[2] - m[2]) ** 2) / 3);
        indepDiscCnt++;
      }
    }
  }
  const indepDiscrepancy = +(indepDiscSum / Math.max(1, indepDiscCnt)).toFixed(5);
  const postCons = consolidateProjectedViews(indepProjected, pos, nrm, S);

  // 2. TexFusion Sequential Interlaced Multiview Sampler (SIMS)
  const sims = await runSequentialInterlacedSampler(projections, coveredIdx, pos, nrm, S, denoiser, {
    steps,
    channels: 3,
    seed: 9000,
    finalMrf: true,
  });
  const simsRgba = decodeRgbLatentAtlas(sims.atlas);
  const simsRawSeam: SeamScore = seamMetric(simsRgba, postCons.owner, links, S);

  return {
    independent: {
      crossViewDiscrepancy: indepDiscrepancy,
      rawSeam: postCons.before,
      postConsolidateSeam: postCons.after,
    },
    texFusionSims: {
      crossViewDiscrepancy: sims.crossViewDiscrepancy,
      rawSeam: simsRawSeam,
      denoiserCalls: sims.denoiserCalls,
    },
  };
}
