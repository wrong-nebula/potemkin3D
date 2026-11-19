import * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import type { Engine } from './engine';
import {
  bakeFastSdf,
  buildFastContactBvh,
  fastSdfTracedOpenness,
  fastSdfWallFormula,
  runFastSdfAoGpuPass,
  type FastSdfFalloff,
} from './fast-sdf-ao';
import {
  jointBilateralUpsampleScalar,
  type AtlasGuide,
  type JointBilateralOptions,
} from './jbu';

export {
  estimatePlaneTolerance,
  jointBilateralUpsampleRgba,
  jointBilateralUpsampleScalar,
  JBU_ATLAS_GLSL,
  type AtlasGuide,
  type JointBilateralOptions,
} from './jbu';

export {
  bakeFastSdf,
  buildFastContactBvh,
  contactHitDistance,
  fastSdfTracedOpenness,
  fastSdfWallFormula,
  floatToHalf,
  runFastSdfAoGpuPass,
  sampleFastSdf,
  vdc2,
  vdc3,
  type FastContactBvh,
  type FastSdfFalloff,
  type FastSdfVolume,
} from './fast-sdf-ao';

/**
 * Ambient occlusion baked into texture space: how much of the sky each texel of the level can see. Corners, the
 * foot of a wall and the underside of an arch come out darker. It depends on the geometry alone, so it costs no
 * model call.
 *
 * By default (`mode: 'fast-sdf'`), `bakeAo` uses the latest `wrong-nebula/Fast-SDF-AO` hybrid architecture:
 * - Quantized 8-bin SAH local Contact BVH (`RGBA32UI` 16 B/node + 1 m CSR world grid) for exact near-surface triangle
 *   intersections (`0.3 mm` bias, thin plates & crisp 5 cm crevices),
 * - Hierarchical 8³ 1-Lipschitz-culled isotropic `R16F` 3D Signed/Unsigned Distance Field for far sphere-marching,
 * - Cranley-Patterson IGN + 2D Halton(2, 3) (`vdc2`, `vdc3`) hemisphere stratification + bent-normal accumulation,
 * executed in a single WebGL2 GPU shader pass (with exact CPU fallback), or via legacy per-texel `MeshBVH` raycasting
 * (`mode: 'bvh'`).
 */
export interface AoOptions {
  /** Map size in px. Occlusion is smooth, so this can be well under the texture's size. */
  size: number;
  /** Rays per texel. */
  rays: number;
  /** Only geometry nearer than this (m) occludes, fading out towards it. */
  radius: number;
  /** Baking backend: `'fast-sdf'` (hybrid Contact BVH + R16F SDF, default), `'sdf'` (alias), `'formula'` (4-tap wall-corrected SDF), or `'bvh'`. */
  mode?: 'fast-sdf' | 'sdf' | 'formula' | 'bvh';
  /** Longest-axis isotropic SDF resolution (multiple of 8, default 128). */
  gridRes?: number;
  /** Distance falloff curve for Fast-SDF-AO (`'linear'` matches `openness`, `'smooth'` matches `[0.64R, R]` smoothstep, `'hard'` unattenuated). */
  falloff?: FastSdfFalloff;
  /** Optional higher target map size to Joint-Bilateral-Upsample into after shading at reduced `size` (`mrdoob/three.js#35602`). */
  upsampleTo?: number;
}

export const DEFAULT_AO: AoOptions = { size: 1024, rays: 24, radius: 2.5, mode: 'fast-sdf' };

export interface AoMap {
  size: number;
  /** One byte per texel, rows in glTF image order (first row = v 0): 255 = open sky, 0 = fully occluded. */
  data: Uint8ClampedArray;
  rays: number;
  radius: number;
  seconds: number;
  mode?: 'fast-sdf' | 'formula' | 'bvh';
  /** Optional world-space unit bent normals (`3 * size * size` floats) accumulated during `fast-sdf` baking. */
  bentNormals?: Float32Array;
  /** Optional surface position & normal guide (`size × size`) enabling Joint Bilateral Upsampling when merged into higher-res ORM maps. */
  guide?: AtlasGuide;
}

/** `n` directions over the hemisphere around +Z, denser towards the pole (cosine-weighted), as xyz triples. */
export function hemisphere(n: number): Float32Array {
  const out = new Float32Array(3 * n);
  const golden = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n, a = 2 * Math.PI * ((i * golden) % 1), r = Math.sqrt(u);
    out.set([r * Math.cos(a), r * Math.sin(a), Math.sqrt(1 - u)], 3 * i);
  }
  return out;
}

const ray = new THREE.Ray();
const t = new THREE.Vector3(), b = new THREE.Vector3(), nn = new THREE.Vector3();

/**
 * Openness of one surface point, 0 to 1: the share of the hemisphere around its normal with nothing nearer than
 * `radius` in the way (things further off within the radius occlude less).
 * @param spin turn of the direction set about the normal (radians), varied per texel so the pattern doesn't band
 */
export function openness(bvh: MeshBVH, p: THREE.Vector3, n: THREE.Vector3, dirs: Float32Array, radius: number, spin = 0): number {
  nn.copy(n).normalize();
  t.set(Math.abs(nn.y) < 0.99 ? 0 : 1, Math.abs(nn.y) < 0.99 ? 1 : 0, 0).cross(nn).normalize();
  b.crossVectors(nn, t);
  const c = Math.cos(spin), s = Math.sin(spin);
  ray.origin.copy(p).addScaledVector(nn, 0.02);   // off the surface, so it doesn't hit itself
  let blocked = 0;
  const count = dirs.length / 3;
  for (let i = 0; i < count; i++) {
    const x = dirs[3 * i] * c - dirs[3 * i + 1] * s, y = dirs[3 * i] * s + dirs[3 * i + 1] * c, z = dirs[3 * i + 2];
    ray.direction.set(t.x * x + b.x * y + nn.x * z, t.y * x + b.y * y + nn.y * z, t.z * x + b.z * y + nn.z * z);
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0, radius);
    if (hit) blocked += 1 - hit.distance / radius;
  }
  return 1 - blocked / count;
}

/**
 * Smooth the baked values a little within the islands and carry them a few texels into the gutters, so sampling
 * between texels never pulls in an unbaked one.
 * @param value openness per texel, anything where `baked` is 0
 */
export function finishAo(value: Float32Array, baked: Uint8Array, size: number, gutter = 4): Uint8ClampedArray {
  let v = value, m = baked;
  const pass = (fill: boolean) => {
    const nv = new Float32Array(v), nm = new Uint8Array(m);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (fill === !!m[i]) continue;   // smoothing touches baked texels, filling the unbaked ones
        let sum = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= size || yy >= size || !m[yy * size + xx]) continue;
            sum += v[yy * size + xx];
            n++;
          }
        }
        if (n) { nv[i] = sum / n; nm[i] = 1; }
      }
    }
    v = nv; m = nm;
  };
  pass(false);
  for (let k = 0; k < gutter; k++) pass(true);
  const out = new Uint8ClampedArray(size * size).fill(255);
  for (let i = 0; i < out.length; i++) if (m[i]) out[i] = 255 * v[i];
  return out;
}

/**
 * An ORM map (RGBA) with the baked occlusion written into its R channel, resampled to the map's size.
 * Uses Geometry-Guided Joint Bilateral Upsampling (`mrdoob/three.js#35602`) whenever `ao.size !== ormSize` and both
 * `ao.guide` and `fullGuide` are available, preventing contact-shadow leakage across 90° creases and UV gutters.
 */
export function withOcclusion(
  orm: Uint8ClampedArray,
  ormSize: number,
  ao: AoMap,
  fullGuide?: { pos: Float32Array; nrm: Float32Array },
  jbuOpts?: JointBilateralOptions,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(orm);
  if (ao.size === ormSize) {
    for (let i = 0; i < ao.data.length; i++) out[4 * i] = ao.data[i];
    return out;
  }
  if (ao.guide && fullGuide && fullGuide.pos.length === ormSize * ormSize * 4) {
    const upsampled = jointBilateralUpsampleScalar(
      ao.data,
      ao.guide,
      { pos: fullGuide.pos, nrm: fullGuide.nrm, size: ormSize },
      jbuOpts,
    );
    for (let i = 0; i < upsampled.length; i++) out[4 * i] = upsampled[i];
    return out;
  }
  const k = ao.size / ormSize;
  for (let y = 0; y < ormSize; y++) {
    const fy = Math.min(ao.size - 1, Math.max(0, (y + 0.5) * k - 0.5)), y0 = Math.floor(fy), y1 = Math.min(ao.size - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < ormSize; x++) {
      const fx = Math.min(ao.size - 1, Math.max(0, (x + 0.5) * k - 0.5)), x0 = Math.floor(fx), x1 = Math.min(ao.size - 1, x0 + 1), tx = fx - x0;
      const d = ao.data;
      out[4 * (y * ormSize + x)] = (d[y0 * ao.size + x0] * (1 - tx) + d[y0 * ao.size + x1] * tx) * (1 - ty)
        + (d[y1 * ao.size + x0] * (1 - tx) + d[y1 * ao.size + x1] * tx) * ty;
    }
  }
  return out;
}

/** The occlusion map as an RGBA image (grey, opaque), for saving, display and export on its own. */
export function aoImage(ao: AoMap): Uint8ClampedArray {
  const out = new Uint8ClampedArray(ao.size * ao.size * 4);
  for (let i = 0; i < ao.data.length; i++) out.set([ao.data[i], ao.data[i], ao.data[i], 255], 4 * i);
  return out;
}

/**
 * Bake ambient occlusion using `wrong-nebula/Fast-SDF-AO` (Quantized SAH Contact BVH + 1-Lipschitz isotropic `R16F` SDF
 * + Cranley-Patterson IGN + 2D Halton(2, 3) hemisphere stratification). Executes on WebGL2 GPU when available.
 */
export async function bakeFastSdfAo(
  engine: Engine,
  opts: Partial<AoOptions> = {},
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<AoMap> {
  const o = { ...DEFAULT_AO, ...opts };
  const t0 = performance.now();
  const size = Math.min(o.size, engine.atlas.size);
  const rScale = o.radius / 1.12;
  const falloff: FastSdfFalloff = o.falloff ?? 'linear';
  const { pos, nrm } = engine.atlas.texelGeometry(size);

  const vol = bakeFastSdf(engine.level.geometry, {
    maxRes: o.gridRes ?? 128,
    reach: o.radius,
    clip: Math.max(o.radius * 1.34, o.radius + 0.35),
  });

  const maybeUpsample = (baseMap: AoMap): AoMap => {
    const target = o.upsampleTo ? Math.min(o.upsampleTo, engine.atlas.size) : baseMap.size;
    if (target <= baseMap.size || !baseMap.guide) return baseMap;
    const fullGeo = engine.atlas.texelGeometry(target);
    const fullGuide: AtlasGuide = { pos: fullGeo.pos, nrm: fullGeo.nrm, size: target };
    const upsampled = jointBilateralUpsampleScalar(baseMap.data, baseMap.guide, fullGuide);
    return {
      ...baseMap,
      size: target,
      data: upsampled,
      guide: fullGuide,
      seconds: (performance.now() - t0) / 1000,
    };
  };

  const lowGuide: AtlasGuide = { pos, nrm, size };

  if (o.mode === 'formula') {
    const N = size * size;
    const value = new Float32Array(N);
    const baked = new Uint8Array(N);
    onProgress?.(0, N);
    for (let i = 0; i < N; i++) {
      if (nrm[4 * i + 3] < 0.5) continue;
      value[i] = fastSdfWallFormula(vol, pos[4 * i], pos[4 * i + 1], pos[4 * i + 2], nrm[4 * i], nrm[4 * i + 1], nrm[4 * i + 2], o.radius);
      baked[i] = 1;
    }
    onProgress?.(N, N);
    return maybeUpsample({ size, data: finishAo(value, baked, size), rays: 4, radius: o.radius, seconds: (performance.now() - t0) / 1000, mode: 'formula', guide: lowGuide });
  }

  const contactRange = Math.max(0.24 * rScale, 0.12 * rScale + 0.6 * vol.voxelDiag);
  const cbvh = buildFastContactBvh(engine.level.geometry, {
    gridSize: Math.max(1.0, contactRange * 2),
    range: contactRange,
    bias: 0.0003 * Math.max(1, rScale),
  });

  if (engine.gpu) {
    try {
      onProgress?.(0, 1);
      const gpuOut = runFastSdfAoGpuPass(engine.gpu, pos, nrm, size, vol, cbvh, {
        rays: o.rays,
        radius: o.radius,
        falloff,
      });
      onProgress?.(1, 1);
      return maybeUpsample({
        size,
        data: finishAo(gpuOut.value, gpuOut.baked, size),
        rays: Math.ceil(o.rays / 4) * 4,
        radius: o.radius,
        seconds: (performance.now() - t0) / 1000,
        mode: 'fast-sdf',
        bentNormals: gpuOut.bentNormals,
        guide: lowGuide,
      });
    } catch {
      // Fall back cleanly to CPU Fast-SDF-AO if WebGL integer/3D textures are unavailable in a mock environment
    }
  }

  const texels: number[] = [];
  for (let i = 0; i < size * size; i++) if (nrm[4 * i + 3] > 0.5) texels.push(i);
  const value = new Float32Array(size * size);
  const baked = new Uint8Array(size * size);
  const bentNormals = new Float32Array(size * size * 3);
  let slice = performance.now();
  onProgress?.(0, texels.length);
  for (let k = 0; k < texels.length; k++) {
    const i = texels[k];
    const x = i % size, y = (i / size) | 0;
    value[i] = fastSdfTracedOpenness(
      vol, cbvh,
      pos[4 * i], pos[4 * i + 1], pos[4 * i + 2],
      nrm[4 * i], nrm[4 * i + 1], nrm[4 * i + 2],
      { rays: o.rays, radius: o.radius, falloff, pixelX: x + 0.5, pixelY: y + 0.5, outBent: bentNormals, bentOffset: 3 * i },
    );
    baked[i] = 1;
    if ((k & 511) === 0 && performance.now() - slice > 40) {
      onProgress?.(k, texels.length);
      await new Promise((r) => setTimeout(r));
      if (signal?.aborted) throw new Error('stopped');
      slice = performance.now();
    }
  }
  onProgress?.(texels.length, texels.length);
  return maybeUpsample({
    size,
    data: finishAo(value, baked, size),
    rays: o.rays,
    radius: o.radius,
    seconds: (performance.now() - t0) / 1000,
    mode: 'fast-sdf',
    bentNormals,
    guide: lowGuide,
  });
}

export const bakeSdfAo = bakeFastSdfAo;

/** Bake the level's ambient occlusion (`mode: 'fast-sdf'` default, or `'bvh'` for legacy per-texel BVH raycasts). */
export async function bakeAo(
  engine: Engine,
  opts: Partial<AoOptions> = {},
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<AoMap> {
  const o = { ...DEFAULT_AO, ...opts };
  if (o.mode !== 'bvh') return bakeFastSdfAo(engine, o, onProgress, signal);

  const t0 = performance.now();
  const size = Math.min(o.size, engine.atlas.size);
  const { pos, nrm } = engine.atlas.texelGeometry(size);
  const texels: number[] = [];
  for (let i = 0; i < size * size; i++) if (nrm[4 * i + 3] > 0.5) texels.push(i);
  const dirs = hemisphere(o.rays);
  const value = new Float32Array(size * size), baked = new Uint8Array(size * size);
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  let slice = performance.now();
  onProgress?.(0, texels.length);
  for (let k = 0; k < texels.length; k++) {
    const i = texels[k];
    p.set(pos[4 * i], pos[4 * i + 1], pos[4 * i + 2]);
    n.set(nrm[4 * i], nrm[4 * i + 1], nrm[4 * i + 2]);
    value[i] = openness(engine.level.bvh, p, n, dirs, o.radius, (((i * 2654435761) >>> 0) / 4294967296) * 2 * Math.PI);
    baked[i] = 1;
    if ((k & 255) === 0 && performance.now() - slice > 40) {
      onProgress?.(k, texels.length);
      await new Promise((r) => setTimeout(r));
      if (signal?.aborted) throw new Error('stopped');
      slice = performance.now();
    }
  }
  onProgress?.(texels.length, texels.length);
  const baseMap: AoMap = { size, data: finishAo(value, baked, size), rays: o.rays, radius: o.radius, seconds: (performance.now() - t0) / 1000, mode: 'bvh', guide: { pos, nrm, size } };
  const target = o.upsampleTo ? Math.min(o.upsampleTo, engine.atlas.size) : size;
  if (target > size) {
    const fullGeo = engine.atlas.texelGeometry(target);
    const fullGuide: AtlasGuide = { pos: fullGeo.pos, nrm: fullGeo.nrm, size: target };
    return { ...baseMap, size: target, data: jointBilateralUpsampleScalar(baseMap.data, baseMap.guide!, fullGuide), guide: fullGuide, seconds: (performance.now() - t0) / 1000 };
  }
  return baseMap;
}

/**
 * Head-to-head benchmark comparing `openness` (`MeshBVH`), `Fast-SDF-AO` Traced (`ContactBVH` + 1-Lipschitz SDF + Halton(2,3)),
 * and `Fast-SDF-AO` 4-tap `aoWallCorrection` against 256-ray exact BVH ground truth (`TODO.md` #7).
 */
export function compareAoMethods(
  bvh: MeshBVH,
  points: { position: THREE.Vector3; normal: THREE.Vector3 }[],
  opts: { radius?: number; rays?: number; gridRes?: number; falloff?: FastSdfFalloff } = {},
) {
  const radius = opts.radius ?? 1.12;
  const rays = opts.rays ?? 24;
  const falloff = opts.falloff ?? 'linear';
  const gtDirs = hemisphere(256);
  const bvhDirs = hemisphere(rays);
  const rScale = radius / 1.12;

  const gt = new Float32Array(points.length);
  const rayTmp = new THREE.Ray();
  const tVec = new THREE.Vector3(), bVec = new THREE.Vector3(), nVec = new THREE.Vector3();
  for (let i = 0; i < points.length; i++) {
    if (falloff === 'linear') {
      gt[i] = openness(bvh, points[i].position, points[i].normal, gtDirs, radius, i * 0.618);
    } else {
      nVec.copy(points[i].normal).normalize();
      tVec.set(Math.abs(nVec.y) < 0.99 ? 0 : 1, Math.abs(nVec.y) < 0.99 ? 1 : 0, 0).cross(nVec).normalize();
      bVec.crossVectors(nVec, tVec);
      rayTmp.origin.copy(points[i].position).addScaledVector(nVec, 0.001);
      let blocked = 0;
      for (let d = 0; d < 256; d++) {
        const lx = gtDirs[3 * d], ly = gtDirs[3 * d + 1], lz = gtDirs[3 * d + 2];
        rayTmp.direction.set(tVec.x * lx + bVec.x * ly + nVec.x * lz, tVec.y * lx + bVec.y * ly + nVec.y * lz, tVec.z * lx + bVec.z * ly + nVec.z * lz);
        const hit = bvh.raycastFirst(rayTmp, THREE.DoubleSide, 0, radius);
        if (hit) blocked += 1;
      }
      gt[i] = 1 - blocked / 256;
    }
  }

  const tBvh0 = performance.now();
  const bvhVals = new Float32Array(points.length);
  for (let i = 0; i < points.length; i++) {
    bvhVals[i] = openness(bvh, points[i].position, points[i].normal, bvhDirs, radius, i * 0.618);
  }
  const bvhEvalMs = performance.now() - tBvh0;

  const vol = bakeFastSdf(bvh.geometry, { maxRes: opts.gridRes ?? 128, reach: radius });
  const contactRange = Math.max(0.24 * rScale, 0.12 * rScale + 0.6 * vol.voxelDiag);
  const cbvh = buildFastContactBvh(bvh.geometry, { gridSize: Math.max(1.0, contactRange * 2), range: contactRange, bias: 0.0003 * Math.max(1, rScale) });

  const tTraced0 = performance.now();
  const tracedVals = new Float32Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const p = points[i].position, n = points[i].normal;
    tracedVals[i] = fastSdfTracedOpenness(vol, cbvh, p.x, p.y, p.z, n.x, n.y, n.z, { rays, radius, falloff, pixelX: i & 63, pixelY: i >> 6 });
  }
  const tracedEvalMs = performance.now() - tTraced0;

  const tForm0 = performance.now();
  const formVals = new Float32Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const p = points[i].position, n = points[i].normal;
    formVals[i] = fastSdfWallFormula(vol, p.x, p.y, p.z, n.x, n.y, n.z, radius);
  }
  const formEvalMs = performance.now() - tForm0;

  const score = (pred: Float32Array) => {
    let mae = 0, mg = 0, mp = 0;
    for (let i = 0; i < gt.length; i++) {
      mae += Math.abs(pred[i] - gt[i]);
      mg += gt[i]; mp += pred[i];
    }
    mae /= Math.max(1, gt.length);
    mg /= Math.max(1, gt.length); mp /= Math.max(1, gt.length);
    let cov = 0, vg = 0, vp = 0;
    for (let i = 0; i < gt.length; i++) {
      const dg = gt[i] - mg, dp = pred[i] - mp;
      cov += dg * dp; vg += dg * dg; vp += dp * dp;
    }
    const r = vg > 1e-9 && vp > 1e-9 ? cov / Math.sqrt(vg * vp) : 1;
    return { mae: +mae.toFixed(4), correlation: +r.toFixed(4) };
  };

  return {
    bvh: { ...score(bvhVals), evalMs: +bvhEvalMs.toFixed(2) },
    fastSdfTraced: {
      ...score(tracedVals),
      sdfBuildMs: vol.stats.buildMs,
      contactBuildMs: cbvh.buildMs,
      contactBytes: cbvh.bytes,
      culledFraction: +(vol.stats.culledVoxels / Math.max(1, vol.stats.totalVoxels)).toFixed(3),
      evalMs: +tracedEvalMs.toFixed(2),
    },
    fastSdfFormula: {
      ...score(formVals),
      evalMs: +formEvalMs.toFixed(2),
    },
  };
}
