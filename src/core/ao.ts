import * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import type { Engine } from './engine';

/**
 * Ambient occlusion baked into texture space: how much of the sky each texel of the level can see. Corners, the
 * foot of a wall and the underside of an arch come out darker. It depends on the geometry alone, so it costs no
 * model call: rays are cast from every texel against the level's BVH.
 *
 * It goes into the occlusion channel of the exported material (glTF's occlusionTexture, the R of the ORM map), so
 * an engine's ambient light gets grounded contact shading for free, and the lit display uses it the same way.
 */
export interface AoOptions {
  /** Map size in px. Occlusion is smooth, so this can be well under the texture's size. */
  size: number;
  /** Rays per texel. */
  rays: number;
  /** Only geometry nearer than this (m) occludes, fading out towards it. */
  radius: number;
}

export const DEFAULT_AO: AoOptions = { size: 1024, rays: 24, radius: 2.5 };

export interface AoMap {
  size: number;
  /** One byte per texel, rows in glTF image order (first row = v 0): 255 = open sky, 0 = fully occluded. */
  data: Uint8ClampedArray;
  rays: number;
  radius: number;
  seconds: number;
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

/** An ORM map (RGBA) with the baked occlusion written into its R channel, resampled to the map's size. */
export function withOcclusion(orm: Uint8ClampedArray, ormSize: number, ao: AoMap): Uint8ClampedArray {
  const out = new Uint8ClampedArray(orm);
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

/** Bake the level's ambient occlusion. Runs on the CPU in slices, so the page stays responsive. */
export async function bakeAo(engine: Engine, opts: Partial<AoOptions> = {}, onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal): Promise<AoMap> {
  const o = { ...DEFAULT_AO, ...opts };
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
    // a different turn per texel (a hash of its index), so neighbouring texels don't share one ray pattern
    value[i] = openness(engine.level.bvh, p, n, dirs, o.radius, ((i * 2654435761) >>> 0) / 4294967296 * 2 * Math.PI);
    baked[i] = 1;
    if ((k & 255) === 0 && performance.now() - slice > 40) {
      onProgress?.(k, texels.length);
      await new Promise((r) => setTimeout(r));
      if (signal?.aborted) throw new Error('stopped');
      slice = performance.now();
    }
  }
  onProgress?.(texels.length, texels.length);
  return { size, data: finishAo(value, baked, size), rays: o.rays, radius: o.radius, seconds: (performance.now() - t0) / 1000 };
}
