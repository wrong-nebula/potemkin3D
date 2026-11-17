import * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';

/**
 * The ground as a material, not as views. Painted from eye height the ground is stretched; painted from above one
 * view at a time its stones change size from view to view. Here a few tiles of the one material are painted once,
 * seen from straight above at a fixed scale, and laid over every texel of ground from that texel's place in the
 * world, so scale and colour are the same everywhere and nothing is stretched.
 *
 * Three things keep it from reading as one picture repeated:
 *  - the laying: each patch of ground about a metre across takes its own piece of the tile, shifted (and for
 *    materials with no direction, turned) at random, and patches are blended into their neighbours, so no seam and
 *    no repeat can be found;
 *  - the tiles: the first is painted, the others are the same stretch of ground dirtier and more worn, stone for
 *    stone. Which shows where changes in zones a few metres across, so the yard has cleaner and grimier stretches;
 *  - the level: dirt gathers towards walls and the feet of props, and the ground keeps the slow changes of tone the
 *    eye-level views gave it.
 */
export interface GroundOptions {
  /** How many tiles to paint (1 to 3). */
  tiles: number;
  /** Metres of ground one tile shows from edge to edge: with it the size of the stones is set. */
  span: number;
  /** Size of the patches the ground is laid in (m): at most a quarter of the span, so a patch never reaches its tile's edge. */
  cell: number;
  /** How patches may be turned: 2 = any angle (stone, earth, concrete), 1 = quarter turns (square tiles), 0 = not at all (planks, bricks,
   *  setts in rows). Unset: read from the tile (`tileGrain`). */
  turn?: number;
  /** How strongly the ground darkens towards walls and the feet of props (0 = not at all). */
  dirt: number;
}

export const DEFAULT_GROUND: GroundOptions = { tiles: 3, span: 3, cell: 0.75, dirt: 1 };

/** The capture quality ground laid from tiles is stored at: as good as a view from 3 m above, so players' views keep it. */
export const GROUND_QUALITY = 0.3;

/** What the second and third tile show that the first does not: the same ground, dirtier, and more worn. */
export const TILE_VARIANTS = ['', 'it is dirtier and damper: grime and dark stains lie on it, and dirt and a little moss fill every joint and crack',
  'it is more worn and weathered: paler, scuffed and faded in places, with a few cracks and chips'];

export interface EdgeField {
  /** Per cell, 0..255: how close the nearest wall or prop is (255 = against it, 0 = over a metre away). */
  data: Uint8Array;
  width: number;
  height: number;
  /** World x and z of the field's corner, and the size of a cell (m). */
  origin: [number, number];
  cell: number;
}

/**
 * How near each spot of ground is to something standing on it: from 0.3 m above the floor, the shortest of 12
 * level rays. Dirt gathers there, and nobody walks it clean.
 */
export function edgeField(bvh: MeshBVH, bounds: THREE.Box3, floorY: number, cell = 0.25, reach = 1): EdgeField {
  const width = Math.max(1, Math.ceil((bounds.max.x - bounds.min.x) / cell)), height = Math.max(1, Math.ceil((bounds.max.z - bounds.min.z) / cell));
  const data = new Uint8Array(width * height);
  const ray = new THREE.Ray();
  const dirs = Array.from({ length: 12 }, (_, k) => new THREE.Vector3(Math.cos((k / 12) * 2 * Math.PI), 0, Math.sin((k / 12) * 2 * Math.PI)));
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      ray.origin.set(bounds.min.x + (i + 0.5) * cell, floorY + 0.3, bounds.min.z + (j + 0.5) * cell);
      let nearest = reach;
      for (const d of dirs) {
        ray.direction.copy(d);
        const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
        if (hit && hit.distance < nearest) nearest = hit.distance;
      }
      // against the wall 1, fading out by `reach`
      const t = THREE.MathUtils.clamp((nearest - 0.1) / (reach - 0.1), 0, 1);
      data[j * width + i] = Math.round(255 * (1 - t * t * (3 - 2 * t)));
    }
  }
  return { data, width, height, origin: [bounds.min.x, bounds.min.z], cell };
}

/** Mean colour (0..1) of an RGBA image. */
export function meanColour(rgba: ArrayLike<number>): [number, number, number] {
  let r = 0, g = 0, b = 0;
  const n = rgba.length / 4;
  for (let i = 0; i < rgba.length; i += 4) { r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; }
  return [r / n / 255, g / n / 255, b / n / 255];
}

/**
 * Take out of the later tiles any colour cast the model gave them (each channel scaled towards the first tile's
 * mean), but leave them darker or lighter than the first, within limits: a dirtier ground is a darker one.
 */
export function matchTiles(tiles: Uint8ClampedArray[]): Uint8ClampedArray[] {
  if (tiles.length < 2) return tiles;
  const ref = meanColour(tiles[0]);
  const lum = (c: number[]) => 0.3 * c[0] + 0.6 * c[1] + 0.1 * c[2];
  return tiles.map((t, k) => {
    if (k === 0) return t;
    const m = meanColour(t);
    const keep = THREE.MathUtils.clamp(lum(m) / Math.max(lum(ref), 0.02), 0.7, 1.15);
    const gain = [0, 1, 2].map((c) => (ref[c] / Math.max(m[c], 0.02)) * keep);
    const out = new Uint8ClampedArray(t.length);
    for (let i = 0; i < t.length; i += 4) { out[i] = t[i] * gain[0]; out[i + 1] = t[i + 1] * gain[1]; out[i + 2] = t[i + 2] * gain[2]; out[i + 3] = 255; }
    return out;
  });
}

/** The height of the floor most players stand on (to 10 cm), from their eye positions; `fallback` when there are none. */
export function floorHeight(eyes: { y: number }[], eyeHeight: number, fallback = 0): number {
  const votes = new Map<number, number>();
  for (const p of eyes) { const y = Math.round((p.y - eyeHeight) * 10) / 10; votes.set(y, (votes.get(y) ?? 0) + 1); }
  let best = fallback, most = 0;
  for (const [y, n] of votes) if (n > most) { most = n; best = y; }
  return best;
}

/**
 * Whether a point of the surface is ground: facing up at the floor's height, or facing up on one of the named parts
 * (with `any`: on one of the named parts whichever way it faces, for a ceiling or a wall laid from tiles).
 */
export function isGround(ny: number, y: number, label: number, floorY: number, labels: number[] = [], band = 0.15, any = false): boolean {
  return labels.length ? (any || ny >= 0.7) && labels.includes(label) : ny >= 0.85 && Math.abs(y - floorY) <= band;
}

/**
 * The ground's slow change of tone across the level, from what the views painted of it: per cell of the field, the
 * brightness of the painted ground around it (about `sigma` metres) over the colour of the painted ground as a whole.
 * Views paint the ground stretched, but where it is lighter and where darker they get right; that is kept, and the
 * stretched detail is not.
 * @param samples x, z, r, g, b (0..255) for each painted sample of ground
 * @param base a gain on everything (the tiles brought to the painted ground's overall tone)
 * @returns RGBA per cell, the gain times 127 (127 = unchanged), within `range`
 */
export function toneField(samples: ArrayLike<number>, f: { origin: [number, number]; cell: number; width: number; height: number },
  base: [number, number, number] = [1, 1, 1], sigma = 1.5, range: [number, number] = [0.85, 1.15]): Uint8Array {
  const n = f.width * f.height;
  const sum = [new Float32Array(n), new Float32Array(n), new Float32Array(n)], count = new Float32Array(n);
  const total = [0, 0, 0];
  let all = 0;
  for (let i = 0; i < samples.length; i += 5) {
    const cx = Math.floor((samples[i] - f.origin[0]) / f.cell), cz = Math.floor((samples[i + 1] - f.origin[1]) / f.cell);
    if (cx < 0 || cz < 0 || cx >= f.width || cz >= f.height) continue;
    const at = cz * f.width + cx;
    for (let k = 0; k < 3; k++) { sum[k][at] += samples[i + 2 + k]; total[k] += samples[i + 2 + k]; }
    count[at]++;
    all++;
  }
  // three box blurs make a Gaussian near enough; blurring sums and counts alike skips the cells with no samples
  const r = Math.max(1, Math.round(sigma / f.cell));
  const blur = (a: Float32Array) => {
    const t = new Float32Array(n);
    for (let pass = 0; pass < 3; pass++) {
      for (let j = 0; j < f.height; j++) {
        let acc = 0;
        for (let i = -r; i < f.width; i++) {
          if (i + r < f.width) acc += a[j * f.width + i + r];
          if (i - r - 1 >= 0) acc -= a[j * f.width + i - r - 1];
          if (i >= 0) t[j * f.width + i] = acc;
        }
      }
      for (let i = 0; i < f.width; i++) {
        let acc = 0;
        for (let j = -r; j < f.height; j++) {
          if (j + r < f.height) acc += t[(j + r) * f.width + i];
          if (j - r - 1 >= 0) acc -= t[(j - r - 1) * f.width + i];
          if (j >= 0) a[j * f.width + i] = acc;
        }
      }
    }
  };
  blur(count);
  for (const c of sum) blur(c);
  const out = new Uint8Array(4 * n);
  const side = (2 * r + 1) ** 6;   // what one sample's weight sums to after the blurs
  const lum = (c: number[]) => 0.3 * c[0] + 0.6 * c[1] + 0.1 * c[2];
  const overall = all ? lum(total) / all : 0;
  for (let i = 0; i < n; i++) {
    // count / side: samples per cell around here. Under two a cell (little painted ground nearby), trust them less.
    const trust = Math.min(1, count[i] / side / 2);
    // lighter or darker only: a view that painted the ground wrongly (sky, a wall's colour) must not tint it
    const local = overall > 0 && count[i] > 0 ? lum([sum[0][i], sum[1][i], sum[2][i]]) / count[i] / overall : 1;
    const gain = THREE.MathUtils.clamp(1 + (local - 1) * trust, range[0], range[1]);
    for (let k = 0; k < 3; k++) out[4 * i + k] = Math.round(THREE.MathUtils.clamp(gain * base[k], 0, 2) * 127);
    out[4 * i + 3] = 255;
  }
  return out;
}

/**
 * How strongly a tile's lines run along its own axes, 0 (none: gravel, rough cobbles, concrete) to 1 (all of them:
 * boards, bricks, setts in rows). The directions of its edges, weighted by their strength, are folded onto a quarter
 * turn and averaged as vectors. A tile with a grain must not be turned when laid: its rows would run every way.
 */
export function tileGrain(rgba: ArrayLike<number>, size: number, n = 256): number {
  const step = size / n;
  const lum = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      // each cell: the mean of a few pixels, so texture finer than the cells doesn't count as lines
      let acc = 0, k = 0;
      for (let dy = 0; dy < step; dy += Math.max(1, step / 3)) for (let dx = 0; dx < step; dx += Math.max(1, step / 3)) {
        const i = 4 * (Math.min(size - 1, Math.floor(y * step + dy)) * size + Math.min(size - 1, Math.floor(x * step + dx)));
        acc += 0.3 * rgba[i] + 0.6 * rgba[i + 1] + 0.1 * rgba[i + 2];
        k++;
      }
      lum[y * n + x] = acc / k;
    }
  }
  let re = 0, im = 0, total = 0;
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const gx = lum[y * n + x + 1] - lum[y * n + x - 1], gy = lum[(y + 1) * n + x] - lum[(y - 1) * n + x];
      const m = gx * gx + gy * gy;
      if (m < 1e-6) continue;
      const a = 4 * Math.atan2(gy, gx);
      re += m * Math.cos(a); im += m * Math.sin(a); total += m;
    }
  }
  // lines along the axes put the folded direction at angle 0: only that part counts, not lines along the diagonals
  return total ? Math.max(0, re / total) : 0;
}
