/**
 * The finishing fill: what no view managed to paint gets its own part's colours, so nothing is left as bare clay.
 * What is left after the painting passes is mostly thin, uniform structure (the inner faces of beams, glazing bars,
 * the sides of joists) that no camera sees well enough to paint; its material is already on the rest of the part.
 *
 * Each unpainted cell takes the colour of the nearest painted cell of the same part that can be reached across the
 * part's own surface in the texture, fading to the part's average colour with distance (a long reach of copied
 * texels reads as a smear, an average does not). A part with nothing painted takes the average of everything.
 */
export interface WearField {
  /** Surface openness per cell in [0, 1] (0 = enclosed recess/slot, 1 = open surface). */
  openness?: ArrayLike<number>;
  /** Normalized concave curvature per cell in [0, 1] (inside corner / crease). */
  concave?: ArrayLike<number>;
  /** Normalized convex curvature per cell in [0, 1] (exposed ridge / arris). */
  convex?: ArrayLike<number>;
  /** Cavity grime darkening & warm-earthy desaturation strength in [0, 1] (default 0.22). */
  grime?: number;
  /** Exposed-edge chalky wear strength in [0, 1] (default 0.14). */
  edgeWear?: number;
}

export interface Fill {
  /**
   * RGBA, n x n: a colour for every cell on the level and the two cells round it (alpha 255), nothing further
   * out (alpha 0). The rim is for islands too thin for this grid to have caught. Unpainted cells
   * get the fill; painted cells keep their own colour, for the unpainted slivers inside them that are too thin
   * to show at this size.
   */
  rgba: Uint8ClampedArray;
  /** Cells filled, and how many of them from a painted neighbour rather than an average alone. */
  filled: number;
  near: number;
  /** Unpainted cells modulated by cavity grime or ridge wear when a `WearField` was supplied. */
  weathered?: number;
}

/**
 * @param colour RGBA, n x n: the texture's colours
 * @param painted n x n: 1 where a view painted the cell
 * @param label n x n: part index per cell, -1 where no triangle covers it
 * @param reach cells over which a neighbour's colour fades to the part's average
 * @param wear optional openness & signed-curvature fields for cavity grime and exposed-ridge wear on filled cells
 */
export function fillColours(
  colour: ArrayLike<number>,
  painted: ArrayLike<number>,
  label: ArrayLike<number>,
  n: number,
  reach = 24,
  wear?: WearField,
): Fill {
  const N = n * n;
  const sums = new Map<number, [number, number, number, number]>();
  const all: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < N; i++) {
    if (label[i] < 0 || !painted[i]) continue;
    let s = sums.get(label[i]);
    if (!s) sums.set(label[i], (s = [0, 0, 0, 0]));
    for (const t of [s, all]) { t[0] += colour[4 * i]; t[1] += colour[4 * i + 1]; t[2] += colour[4 * i + 2]; t[3]++; }
  }
  const mean = (l: number): [number, number, number] => {
    const s = sums.get(l) ?? all;
    return s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : [128, 128, 128];
  };
  // nearest painted cell of the same part, across the part's cells: breadth-first from every painted cell at once
  const src = new Int32Array(N).fill(-1), dist = new Uint16Array(N);
  let queue: number[] = [];
  for (let i = 0; i < N; i++) if (label[i] >= 0 && painted[i]) { src[i] = i; queue.push(i); }
  while (queue.length) {
    const next: number[] = [];
    for (const c of queue) {
      const x = c % n, y = (c - x) / n;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const m = ny * n + nx;
        if (src[m] >= 0 || label[m] !== label[c] || painted[m]) continue;
        src[m] = src[c];
        dist[m] = Math.min(65535, dist[c] + 1);
        next.push(m);
      }
    }
    queue = next;
  }
  const rgba = new Uint8ClampedArray(N * 4);
  let filled = 0, near = 0, weathered = 0;
  const grimeStrength = wear ? (wear.grime ?? 0.22) : 0;
  const edgeStrength = wear ? (wear.edgeWear ?? 0.14) : 0;
  for (let i = 0; i < N; i++) {
    if (label[i] < 0) continue;
    rgba[4 * i + 3] = 255;
    if (painted[i]) { for (let k = 0; k < 3; k++) rgba[4 * i + k] = colour[4 * i + k]; continue; }
    const m = mean(label[i]);
    const t = src[i] >= 0 ? Math.min(1, dist[i] / reach) : 1;
    const s = src[i] >= 0 ? src[i] : i;
    let r = t >= 1 ? m[0] : colour[4 * s] * (1 - t) + m[0] * t;
    let g = t >= 1 ? m[1] : colour[4 * s + 1] * (1 - t) + m[1] * t;
    let b = t >= 1 ? m[2] : colour[4 * s + 2] * (1 - t) + m[2] * t;
    if (wear) {
      const open = wear.openness ? wear.openness[i] : 1;
      const conc = wear.concave ? Math.min(1, Math.max(0, wear.concave[i])) : 0;
      const conv = wear.convex ? Math.min(1, Math.max(0, wear.convex[i])) : 0;
      const enc = Math.min(1, Math.max(0, (0.65 - open) / 0.45));
      const cavity = Math.min(1, 0.65 * enc + 0.6 * conc);
      const ridge = Math.min(1, conv * Math.min(1, Math.max(0, (open - 0.45) / 0.4)));
      const gAmt = grimeStrength * cavity;
      const eAmt = edgeStrength * ridge * (1 - 0.7 * cavity);
      if (gAmt > 0.005 || eAmt > 0.005) {
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        if (gAmt > 0) {
          // Cavity grime: darken toward a warm-earthy desaturated umber so deep recesses don't glow with sunlit wall tone.
          const gr = luma * 0.62 + 6, gg = luma * 0.58 + 4, gb = luma * 0.50 + 2;
          r = r * (1 - gAmt) + gr * gAmt;
          g = g * (1 - gAmt) + gg * gAmt;
          b = b * (1 - gAmt) + gb * gAmt;
        }
        if (eAmt > 0) {
          // Exposed ridge wear: slight chalky desaturation and lift along convex arrises.
          const chalk = Math.min(245, luma * 0.65 + 78);
          r = r * (1 - eAmt) + chalk * eAmt;
          g = g * (1 - eAmt) + chalk * 0.99 * eAmt;
          b = b * (1 - eAmt) + chalk * 0.96 * eAmt;
        }
        weathered++;
      }
    }
    rgba[4 * i] = r;
    rgba[4 * i + 1] = g;
    rgba[4 * i + 2] = b;
    filled++;
    if (t < 1) near++;
  }
  // a rim round the level's cells: islands thinner than a cell fall between them
  for (let pass = 0; pass < 2; pass++) {
    const add: [number, number, number, number][] = [];
    for (let i = 0; i < N; i++) {
      if (rgba[4 * i + 3]) continue;
      const x = i % n, y = (i - x) / n;
      let r = 0, g = 0, b = 0, k = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const m = 4 * (ny * n + nx);
        if (rgba[m + 3]) { r += rgba[m]; g += rgba[m + 1]; b += rgba[m + 2]; k++; }
      }
      if (k) add.push([i, r / k, g / k, b / k]);
    }
    for (const [i, r, g, b] of add) rgba.set([r, g, b, 255], 4 * i);
  }
  return { rgba, filled, near, ...(wear ? { weathered } : {}) };
}

export interface StateWearOptions {
  /** Cavity grime darkening strength on unpainted clay creases (default 0.18). */
  cavityStrength?: number;
  /** Convex ridge highlight strength on unpainted clay arrises (default 0.12). */
  ridgeStrength?: number;
}

export interface StateWearResult {
  state: Uint8ClampedArray;
  /** Share of unpainted geometry pixels lying in concave creases / wall feet. */
  cavityShare: number;
  /** Share of unpainted geometry pixels lying on exposed convex ridges / edges. */
  ridgeShare: number;
  modifiedPixels: number;
}

/**
 * Subtle signed-curvature & cavity conditioning on the unpainted clay pixels of a view's state image.
 * Uses the view's world-position (`pos`, w = distance) and world-normal (`nrm`, w = label + 1) G-buffers:
 * - Where neighbor surfaces bend into the front hemisphere of `N` (`(P_q - P_p) · N > 0`, e.g. wall-floor bases and
 *   inside corners), unpainted clay receives a subtle warm-umber cavity darkening cue.
 * - Where neighbor surfaces bend away behind `N` (`(P_q - P_p) · N < 0`, e.g. column arrises, step lips and sills),
 *   unpainted clay receives a crisp lightened edge-wear cue.
 * Depth jumps across silhouettes are rejected so foreground occluders never cast halos onto distant walls.
 */
export function conditionStateWithWear(
  state: Uint8ClampedArray,
  unknown: Uint8Array,
  pos: ArrayLike<number>,
  nrm: ArrayLike<number>,
  size: number,
  opts: StateWearOptions = {},
): StateWearResult {
  const cavStr = opts.cavityStrength ?? 0.18;
  const ridStr = opts.ridgeStrength ?? 0.12;
  const out = new Uint8ClampedArray(state);
  const r1 = Math.max(1, Math.round((3 * size) / 1024));
  const r2 = Math.max(2, Math.round((8 * size) / 1024));
  const offsets: [number, number][] = [
    [r1, 0], [-r1, 0], [0, r1], [0, -r1],
    [r2, 0], [-r2, 0], [0, r2], [0, -r2],
  ];

  let unknownCount = 0, cavityPx = 0, ridgePx = 0, modifiedPixels = 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (!unknown[i]) continue;
      if (nrm[4 * i + 3] < 0.5) continue;
      unknownCount++;

      const px = pos[4 * i], py = pos[4 * i + 1], pz = pos[4 * i + 2], dist = pos[4 * i + 3];
      const nx = nrm[4 * i], ny = nrm[4 * i + 1], nz = nrm[4 * i + 2];
      const maxGap = Math.max(0.28, 0.16 * dist);

      let conc = 0, conv = 0, taps = 0;
      for (let k = 0; k < offsets.length; k++) {
        const qx = x + offsets[k][0], qy = y + offsets[k][1];
        if (qx < 0 || qy < 0 || qx >= size || qy >= size) continue;
        const j = qy * size + qx;
        if (nrm[4 * j + 3] < 0.5) continue;
        if (Math.abs(pos[4 * j + 3] - dist) > maxGap) continue;
        const dx = pos[4 * j] - px, dy = pos[4 * j + 1] - py, dz = pos[4 * j + 2] - pz;
        const len = Math.hypot(dx, dy, dz);
        if (len < 1e-5 || len > maxGap * 1.5) continue;
        taps++;
        const dotN = Math.min(1, Math.max(-1, nx * nrm[4 * j] + ny * nrm[4 * j + 1] + nz * nrm[4 * j + 2]));
        const turn = 1 - dotN;
        if (turn < 0.015) continue;
        const proj = (dx * nx + dy * ny + dz * nz) / len;
        const w = 0.35 + 0.65 * Math.min(1, turn * 2.2);
        if (proj > 0.035) conc += proj * w;
        else if (proj < -0.035) conv += -proj * w;
      }
      if (!taps) continue;
      const cavity = Math.min(1, (conc / taps) * 3.2);
      const ridge = Math.min(1, (conv / taps) * 3.0);
      if (cavity >= 0.12) cavityPx++;
      if (ridge >= 0.12) ridgePx++;
      if (cavity < 0.04 && ridge < 0.04) continue;

      const p = 4 * i;
      let r = out[p], g = out[p + 1], b = out[p + 2];
      if (cavity >= 0.04) {
        const c = cavStr * cavity;
        r *= 1 - 0.85 * c;
        g *= 1 - 0.96 * c;
        b *= 1 - 1.15 * c;
      }
      if (ridge >= 0.04) {
        const e = ridStr * ridge * (1 - 0.6 * cavity);
        r = r + (236 - r) * e;
        g = g + (234 - g) * e;
        b = b + (228 - b) * e;
      }
      out[p] = Math.round(r);
      out[p + 1] = Math.round(g);
      out[p + 2] = Math.round(b);
      modifiedPixels++;
    }
  }

  return {
    state: out,
    cavityShare: unknownCount ? cavityPx / unknownCount : 0,
    ridgeShare: unknownCount ? ridgePx / unknownCount : 0,
    modifiedPixels,
  };
}
