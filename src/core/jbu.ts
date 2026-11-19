/* Adapted from mrdoob/three.js#35602 (JointBilateralUpsample.js by Ben Houston, MIT); see NOTICE and PROVENANCE.md. */

/**
 * Geometry-Guided Joint Bilateral Upsampling for reduced-resolution atlas maps & textures (`mrdoob/three.js#35602`):
 *
 * Plain bilinear upsampling of half/quarter-resolution maps (baked AO at 512–1024 px, multi-view consolidation deltas,
 * UV-refinement delighting offsets) leaks dark contact shadows and tonal offsets across 90° wall–floor creases, bevels,
 * ledges and narrow UV island gutters when applied to 2K/4K/8K atlases.
 *
 * Following Sloan et al. (PG 2007), Kopf et al. (SIGGRAPH 2007) and Three.js `jointBilateralUpsample` (#35602):
 * - Weights the 2×2 nearest low-resolution texels by bilinear spatial weights `wx * wy` multiplied by:
 *   1. **Surface-plane distance** `planeDistance = dot(P_tap - P_full, N_full)` (`exp(-(planeDistance / tolerance)^2)`),
 *      which — unlike raw Euclidean or depth difference — stays `0` along arbitrarily steep/slanted planar surfaces
 *      while rejecting step discontinuities and disjoint UV islands;
 *   2. **Normal power** `max(0, dot(N_tap, N_full))^normalPower` (`normalPower = 8` via repeated squaring), preventing
 *      leakage across 90° corners and sharp creases inside continuous UV charts;
 *   3. **Coverage weighting** (`lowNrm.w > 0.5`), ignoring empty UV gutter texels whenever at least one covered tap
 *      matches, with a small `1e-4` floor fading gracefully to bilinear when no tap matches.
 */

export interface AtlasGuide {
  /** `size * size * 4` float32 world positions (`xyz` + `partLabel + 1` in `w`), glTF row order (`row 0 = v 0`). */
  pos: Float32Array;
  /** `size * size * 4` float32 unit world normals (`xyz` + coverage `0|1` in `w`), glTF row order (`row 0 = v 0`). */
  nrm: Float32Array;
  size: number;
}

export interface JointBilateralOptions {
  /** Surface-plane distance tolerance in metres (default: auto-estimated from texel world spacing, floor `0.015` m). */
  planeTolerance?: number;
  /** Power-of-two exponent on `max(0, dot(n_low, n_full))` (default `8`). */
  normalPower?: number;
  /** Reject taps belonging to a different semantic mesh part (`pos.w`, default `true`). */
  respectParts?: boolean;
}

function pow2Chain(x: number, power: number): number {
  let v = x > 0 ? x : 0;
  for (let p = 1; p < power; p *= 2) v *= v;
  return v;
}

/** Estimate characteristic world-space step per low-res texel so `planeTolerance` scales naturally from small props to 100 m levels. */
export function estimatePlaneTolerance(lowGuide: AtlasGuide): number {
  const { pos, nrm, size } = lowGuide;
  const samples: number[] = [];
  const stride = Math.max(1, (size * size) >> 10);
  for (let i = 0; i + 1 < size * size; i += stride) {
    if (nrm[4 * i + 3] < 0.5 || nrm[4 * (i + 1) + 3] < 0.5) continue;
    if (Math.round(pos[4 * i + 3]) !== Math.round(pos[4 * (i + 1) + 3])) continue;
    const d = Math.hypot(pos[4 * (i + 1)] - pos[4 * i], pos[4 * (i + 1) + 1] - pos[4 * i + 1], pos[4 * (i + 1) + 2] - pos[4 * i + 2]);
    if (d > 1e-5 && d < 10) samples.push(d);
  }
  if (!samples.length) return 0.04;
  samples.sort((a, b) => a - b);
  const med = samples[samples.length >> 1];
  return Math.max(0.012, 0.45 * med);
}

/**
 * Joint bilateral upsampling of a single-channel `Uint8ClampedArray` / `Float32Array` map (such as `AoMap.data`)
 * from `lowSize` to `fullSize` guided by `(lowGuide, fullGuide)`.
 */
export function jointBilateralUpsampleScalar(
  lowData: ArrayLike<number>,
  lowGuide: AtlasGuide,
  fullGuide: AtlasGuide,
  opts: JointBilateralOptions = {},
): Uint8ClampedArray {
  const lowSize = lowGuide.size;
  const fullSize = fullGuide.size;
  const out = new Uint8ClampedArray(fullSize * fullSize);
  if (lowSize === fullSize) {
    for (let i = 0; i < out.length; i++) out[i] = Math.round(lowData[i]);
    return out;
  }

  const tol = opts.planeTolerance ?? estimatePlaneTolerance(lowGuide);
  const invTol2 = 1 / (tol * tol);
  const normalPower = opts.normalPower ?? 8;
  const respectParts = opts.respectParts !== false;
  const scale = lowSize / fullSize;
  const lPos = lowGuide.pos, lNrm = lowGuide.nrm;
  const fPos = fullGuide.pos, fNrm = fullGuide.nrm;

  for (let fy = 0; fy < fullSize; fy++) {
    const py = (fy + 0.5) * scale - 0.5;
    const by = Math.floor(py), fracY = py - by;
    const y0 = Math.max(0, Math.min(lowSize - 1, by));
    const y1 = Math.max(0, Math.min(lowSize - 1, by + 1));

    for (let fx = 0; fx < fullSize; fx++) {
      const fi = fy * fullSize + fx;
      const px = (fx + 0.5) * scale - 0.5;
      const bx = Math.floor(px), fracX = px - bx;
      const x0 = Math.max(0, Math.min(lowSize - 1, bx));
      const x1 = Math.max(0, Math.min(lowSize - 1, bx + 1));

      if (fNrm[4 * fi + 3] < 0.5) {
        // Gutter texel: plain bilinear fallback
        const v00 = lowData[y0 * lowSize + x0], v10 = lowData[y0 * lowSize + x1];
        const v01 = lowData[y1 * lowSize + x0], v11 = lowData[y1 * lowSize + x1];
        out[fi] = Math.round((v00 * (1 - fracX) + v10 * fracX) * (1 - fracY) + (v01 * (1 - fracX) + v11 * fracX) * fracY);
        continue;
      }

      const f4 = 4 * fi;
      const pxW = fPos[f4], pyW = fPos[f4 + 1], pzW = fPos[f4 + 2];
      const fPart = Math.round(fPos[f4 + 3]);
      const nx = fNrm[f4], ny = fNrm[f4 + 1], nz = fNrm[f4 + 2];

      let sum = 0, total = 0;
      for (let dy = 0; dy <= 1; dy++) {
        const ty = dy === 0 ? y0 : y1;
        const wy = dy === 0 ? 1 - fracY : fracY;
        for (let dx = 0; dx <= 1; dx++) {
          const tx = dx === 0 ? x0 : x1;
          const wx = dx === 0 ? 1 - fracX : fracX;
          const ti = ty * lowSize + tx;
          const t4 = 4 * ti;
          let geoWeight = 0;
          if (lNrm[t4 + 3] >= 0.5 && (!respectParts || Math.round(lPos[t4 + 3]) === fPart)) {
            const planeDist = (lPos[t4] - pxW) * nx + (lPos[t4 + 1] - pyW) * ny + (lPos[t4 + 2] - pzW) * nz;
            const depthWeight = Math.exp(-(planeDist * planeDist) * invTol2);
            const ndot = lNrm[t4] * nx + lNrm[t4 + 1] * ny + lNrm[t4 + 2] * nz;
            const normalWeight = pow2Chain(ndot, normalPower);
            geoWeight = depthWeight * normalWeight;
          }
          // Floor 1e-4 matches three.js#35602 graceful fallback when no tap matches
          const w = (wx * wy) * (geoWeight + 1e-4);
          sum += lowData[ti] * w;
          total += w;
        }
      }
      out[fi] = Math.max(0, Math.min(255, Math.round(sum / Math.max(total, 1e-12))));
    }
  }
  return out;
}

/**
 * Joint bilateral upsampling of an RGBA8 map (with optional `coverage` alpha weighting matching `three.js#35602`).
 */
export function jointBilateralUpsampleRgba(
  lowRgba: Uint8ClampedArray,
  lowGuide: AtlasGuide,
  fullGuide: AtlasGuide,
  opts: JointBilateralOptions & { coverage?: boolean } = {},
): Uint8ClampedArray {
  const lowSize = lowGuide.size;
  const fullSize = fullGuide.size;
  if (lowSize === fullSize) return new Uint8ClampedArray(lowRgba);

  const out = new Uint8ClampedArray(fullSize * fullSize * 4);
  const tol = opts.planeTolerance ?? estimatePlaneTolerance(lowGuide);
  const invTol2 = 1 / (tol * tol);
  const normalPower = opts.normalPower ?? 8;
  const respectParts = opts.respectParts !== false;
  const useCoverage = opts.coverage ?? true;
  const scale = lowSize / fullSize;
  const lPos = lowGuide.pos, lNrm = lowGuide.nrm;
  const fPos = fullGuide.pos, fNrm = fullGuide.nrm;

  for (let fy = 0; fy < fullSize; fy++) {
    const py = (fy + 0.5) * scale - 0.5;
    const by = Math.floor(py), fracY = py - by;
    const y0 = Math.max(0, Math.min(lowSize - 1, by));
    const y1 = Math.max(0, Math.min(lowSize - 1, by + 1));

    for (let fx = 0; fx < fullSize; fx++) {
      const fi = fy * fullSize + fx;
      const f4 = 4 * fi;
      if (fNrm[f4 + 3] < 0.5) continue;

      const px = (fx + 0.5) * scale - 0.5;
      const bx = Math.floor(px), fracX = px - bx;
      const x0 = Math.max(0, Math.min(lowSize - 1, bx));
      const x1 = Math.max(0, Math.min(lowSize - 1, bx + 1));

      const pxW = fPos[f4], pyW = fPos[f4 + 1], pzW = fPos[f4 + 2];
      const fPart = Math.round(fPos[f4 + 3]);
      const nx = fNrm[f4], ny = fNrm[f4 + 1], nz = fNrm[f4 + 2];

      let sr = 0, sg = 0, sb = 0, sa = 0, total = 0;
      for (let dy = 0; dy <= 1; dy++) {
        const ty = dy === 0 ? y0 : y1;
        const wy = dy === 0 ? 1 - fracY : fracY;
        for (let dx = 0; dx <= 1; dx++) {
          const tx = dx === 0 ? x0 : x1;
          const wx = dx === 0 ? 1 - fracX : fracX;
          const ti = ty * lowSize + tx;
          const t4 = 4 * ti;
          let geoWeight = 0;
          if (lNrm[t4 + 3] >= 0.5 && (!respectParts || Math.round(lPos[t4 + 3]) === fPart)) {
            const planeDist = (lPos[t4] - pxW) * nx + (lPos[t4 + 1] - pyW) * ny + (lPos[t4 + 2] - pzW) * nz;
            const depthWeight = Math.exp(-(planeDist * planeDist) * invTol2);
            const ndot = lNrm[t4] * nx + lNrm[t4 + 1] * ny + lNrm[t4 + 2] * nz;
            const normalWeight = pow2Chain(ndot, normalPower);
            geoWeight = depthWeight * normalWeight;
          }
          const w = (wx * wy) * (geoWeight + 1e-4);
          const a = lowRgba[t4 + 3] / 255;
          if (useCoverage) {
            sr += lowRgba[t4] * a * w;
            sg += lowRgba[t4 + 1] * a * w;
            sb += lowRgba[t4 + 2] * a * w;
            sa += a * w;
          } else {
            sr += lowRgba[t4] * w;
            sg += lowRgba[t4 + 1] * w;
            sb += lowRgba[t4 + 2] * w;
            sa += a * w;
          }
          total += w;
        }
      }
      if (useCoverage) {
        const denom = Math.max(sa, 1e-6);
        out[f4] = Math.max(0, Math.min(255, Math.round(sr / denom)));
        out[f4 + 1] = Math.max(0, Math.min(255, Math.round(sg / denom)));
        out[f4 + 2] = Math.max(0, Math.min(255, Math.round(sb / denom)));
        out[f4 + 3] = Math.max(0, Math.min(255, Math.round((sa / Math.max(total, 1e-12)) * 255)));
      } else {
        const denom = Math.max(total, 1e-12);
        out[f4] = Math.max(0, Math.min(255, Math.round(sr / denom)));
        out[f4 + 1] = Math.max(0, Math.min(255, Math.round(sg / denom)));
        out[f4 + 2] = Math.max(0, Math.min(255, Math.round(sb / denom)));
        out[f4 + 3] = Math.max(0, Math.min(255, Math.round((sa / denom) * 255)));
      }
    }
  }
  return out;
}

/**
 * Reusable GLSL3 Joint Bilateral Upsample function for `Atlas` WebGL2 shaders (`CONSOLIDATE_PAINT_FRAG`, `UV_REFINE_FRAG`).
 * Mirrors `mrdoob/three.js#35602` (`jointBilateralUpsample`): plane-distance Gaussian × `cos^8(θ)` normal weight + `1e-4` floor.
 */
export const JBU_ATLAS_GLSL = /* glsl */ `
vec4 jbuSampleAtlas(
  sampler2D inputTex,
  sampler2D lowPosTex,
  sampler2D lowNrmTex,
  vec2 uv,
  vec3 fullPos,
  vec3 fullNrm,
  float fullPart,
  float planeTolerance,
  bool useCoverage
) {
  vec2 size = vec2(textureSize(lowPosTex, 0));
  vec2 pixel = uv * size - 0.5;
  vec2 base = floor(pixel);
  vec2 fraction = fract(pixel);
  float tol = max(planeTolerance, 0.005);
  vec4 sum = vec4(0.0);
  float total = 0.0;

  for (int y = 0; y <= 1; y++) {
    for (int x = 0; x <= 1; x++) {
      ivec2 tapCoord = clamp(ivec2(base) + ivec2(x, y), ivec2(0), ivec2(size) - 1);
      vec4 tapPos4 = texelFetch(lowPosTex, tapCoord, 0);
      vec4 tapNrm4 = texelFetch(lowNrmTex, tapCoord, 0);
      float geoWeight = 0.0;
      if (tapNrm4.w >= 0.5 && abs((tapPos4.w - 1.0) - fullPart) < 0.5) {
        float planeDist = dot(tapPos4.xyz - fullPos, fullNrm);
        float depthWeight = exp(-pow(planeDist / tol, 2.0));
        float nw = max(0.0, dot(normalize(tapNrm4.xyz), fullNrm));
        nw = nw * nw; nw = nw * nw; nw = nw * nw; // normalPower = 8
        geoWeight = depthWeight * nw;
      }
      float wx = x == 0 ? 1.0 - fraction.x : fraction.x;
      float wy = y == 0 ? 1.0 - fraction.y : fraction.y;
      float weight = wx * wy * (geoWeight + 1e-4);
      vec4 val = texelFetch(inputTex, tapCoord, 0);
      sum += (useCoverage ? vec4(val.rgb * val.a, val.a) : val) * weight;
      total += weight;
    }
  }
  return useCoverage ? vec4(sum.rgb / max(sum.a, 1e-6), sum.a / max(total, 1e-6)) : sum / max(total, 1e-6);
}
`;
