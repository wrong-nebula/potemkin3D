/**
 * The finishing fill: what no view managed to paint gets its own part's colours, so nothing is left as bare clay.
 * What is left after the painting passes is mostly thin, uniform structure (the inner faces of beams, glazing bars,
 * the sides of joists) that no camera sees well enough to paint; its material is already on the rest of the part.
 *
 * Each unpainted cell takes the colour of the nearest painted cell of the same part that can be reached across the
 * part's own surface in the texture, fading to the part's average colour with distance (a long reach of copied
 * texels reads as a smear, an average does not). A part with nothing painted takes the average of everything.
 */
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
}

/**
 * @param colour RGBA, n x n: the texture's colours
 * @param painted n x n: 1 where a view painted the cell
 * @param label n x n: part index per cell, -1 where no triangle covers it
 * @param reach cells over which a neighbour's colour fades to the part's average
 */
export function fillColours(colour: ArrayLike<number>, painted: ArrayLike<number>, label: ArrayLike<number>, n: number, reach = 24): Fill {
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
  let filled = 0, near = 0;
  for (let i = 0; i < N; i++) {
    if (label[i] < 0) continue;
    rgba[4 * i + 3] = 255;
    if (painted[i]) { for (let k = 0; k < 3; k++) rgba[4 * i + k] = colour[4 * i + k]; continue; }
    const m = mean(label[i]);
    const t = src[i] >= 0 ? Math.min(1, dist[i] / reach) : 1;
    const s = src[i] >= 0 ? src[i] : i;
    for (let k = 0; k < 3; k++) rgba[4 * i + k] = t >= 1 ? m[k] : colour[4 * s + k] * (1 - t) + m[k] * t;
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
  return { rgba, filled, near };
}
