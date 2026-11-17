/**
 * What a run's cameras delivered, measured from the run itself (no model call): how each paid frame was spent, and
 * how sharply the texture ended up sampled. These are the numbers camera planning is judged by.
 */

export interface FrameUse {
  /** Share of the frame with no level in it. */
  sky: number;
  /** Share of the frame that was level not painted yet. */
  fresh: number;
  /** Share of the view's level pixels that were already painted: what the painter had to go on. */
  context: number;
  /** Share of the view's level pixels seen at a graze (under `minCos`). */
  grazing: number;
  /** Share of the frame that became texture: unpainted, seen at a usable angle, and kept for projection. */
  productive: number;
}

/**
 * How one view's frame was spent.
 * @param geometry 1 where the pixel shows the level
 * @param known 1 where it was already painted well enough to keep
 * @param cos cosine between the surface normal and the direction to the camera, per pixel
 * @param kept 1 where the view's composite was kept for projection (omit to count every unpainted pixel)
 */
export function frameUse(geometry: ArrayLike<number>, known: ArrayLike<number>, cos: ArrayLike<number>, kept?: ArrayLike<number>,
  minCos = 0.3): FrameUse {
  const n = geometry.length;
  let geo = 0, fresh = 0, grazing = 0, productive = 0;
  for (let i = 0; i < n; i++) {
    if (!geometry[i]) continue;
    geo++;
    const graze = cos[i] < minCos;
    if (graze) grazing++;
    if (known[i]) continue;
    fresh++;
    if (!graze && (!kept || kept[i])) productive++;
  }
  return { sky: 1 - geo / n, fresh: fresh / n, context: geo ? 1 - fresh / geo : 0, grazing: geo ? grazing / geo : 0, productive: productive / n };
}

export interface Sampling {
  /** View pixels per texel at the 10th, 50th and 90th percentile of painted cells. */
  p10: number;
  p50: number;
  p90: number;
  /** Share of painted cells sampled at under 1, and under 0.5, view pixels per texel. */
  under1: number;
  under05: number;
  cells: number;
  /**
   * Over the whole texture, unpainted cells included: the detail it holds as a share of what its resolution could
   * (each cell counts its view pixels per texel, capped at 1), and the share of cells sampled at 1 or more.
   */
  detail: number;
  full: number;
  /**
   * What a player gets on the surface, whatever the layout: detail in pixels per metre, the lesser of what the views
   * captured and what the texture can hold, at the median of the painted surface (by area). And the texture's own
   * texels per metre there, to tell which of the two is the limit.
   */
  surface: number;
  texels: number;
  /** The same detail in pixels per metre, as the mean over the painted surface and at its sharpest quarter. */
  surfaceMean: number;
  surface75: number;
}

/**
 * How sharply the painted texture is sampled: for each painted cell, the view pixels it was captured with per
 * texel. Under 1, the texture holds less detail than its own resolution; it is blurry there.
 * @param quality best capture quality per cell (cos / distance; 0 = unpainted), grid x grid
 * @param pos world position per cell (xyz + anything), grid x grid
 * @param covered 1 where a triangle covers the cell
 * @param texelsPerCell texture texels along one cell
 * @param pixelsPerMetre view pixels across one metre seen head-on from 1 m (half the view size over tan of half the lens angle)
 */
export function sampling(quality: ArrayLike<number>, pos: ArrayLike<number>, covered: ArrayLike<number>, grid: number, texelsPerCell: number,
  pixelsPerMetre: number): Sampling {
  const ratios: number[] = [];
  const onSurface: [number, number, number][] = [];   // detail and texels per metre, and the cell's area
  let all = 0;
  for (let y = 0; y < grid; y++) {
    for (let x = 0; x < grid - 1; x++) {
      const i = y * grid + x, j = i + 1;
      if (!covered[i] || !covered[j]) continue;
      const metres = Math.hypot(pos[4 * j] - pos[4 * i], pos[4 * j + 1] - pos[4 * i + 1], pos[4 * j + 2] - pos[4 * i + 2]);
      if (metres < 1e-4 || metres > 5) continue;   // two cells on different islands
      all++;
      if (!(quality[i] > 0)) continue;
      ratios.push((pixelsPerMetre * quality[i]) / (texelsPerCell / metres));
      onSurface.push([Math.min(pixelsPerMetre * quality[i], texelsPerCell / metres), texelsPerCell / metres, metres * metres]);
    }
  }
  ratios.sort((a, b) => a - b);
  const at = (f: number) => (ratios.length ? ratios[Math.floor(f * (ratios.length - 1))] : 0);
  const under = (v: number) => (ratios.length ? ratios.filter((r) => r < v).length / ratios.length : 0);
  const area = onSurface.reduce((t, r) => t + r[2], 0);
  const detail = all ? ratios.reduce((t, r) => t + Math.min(1, r), 0) / all : 0;
  return { p10: at(0.1), p50: at(0.5), p90: at(0.9), under1: under(1), under05: under(0.5), cells: ratios.length,
    detail, full: all ? ratios.filter((r) => r >= 1).length / all : 0, surface: byArea(onSurface, 0), texels: byArea(onSurface, 1),
    surfaceMean: area ? onSurface.reduce((t, r) => t + r[0] * r[2], 0) / area : 0, surface75: byArea(onSurface, 0, 0.75) };
}

/** The median (or another quantile `at`) of column `k`, each row weighted by its area (the last column). */
function byArea(rows: [number, number, number][], k: 0 | 1, at = 0.5): number {
  const sorted = [...rows].sort((a, b) => a[k] - b[k]);
  const half = sorted.reduce((t, r) => t + r[2], 0) * at;
  let t = 0;
  for (const r of sorted) { t += r[2]; if (t >= half) return r[k]; }
  return 0;
}

export interface ViewMetrics extends FrameUse {
  index: number;
  kind: string;
  model: string;
  /** Pitch in degrees (negative looks down). */
  pitch: number;
  faces: number;
  /** Largest face as a share of the frame. */
  maxFace: number;
  /** Share of the area to paint that the blockout check held back, when the view was checked. */
  held?: number;
  price: number;
}

export interface RunMetrics {
  /**
   * Of the texture a player can see from anywhere they can stand: its share of the whole texture, and how much of
   * it is painted. This, not the share of the whole texture painted, says how finished a level looks.
   */
  seen?: { share: number; painted: number; /** Share of it that no view painted and the finishing fill coloured. */ filled?: number };
  views: ViewMetrics[];
  sampling: Sampling;
  /** Share of the texture's island texels that are painted. */
  coverage: number;
  cost: number;
  /** Mean share of each paid frame that became texture, and the same for the planned (not second-go or hole) views. */
  productive: number;
  productivePlanned: number;
  /** Mean context of the planned views after the first. */
  context: number;
  /** Paid views that delivered under 3% of a frame. */
  wasted: number;
}

/** Roll the per-view numbers up. */
export function summarise(views: ViewMetrics[], s: Sampling, coverage: number, cost: number): RunMetrics {
  const mean = (list: ViewMetrics[], f: (v: ViewMetrics) => number) => (list.length ? list.reduce((a, v) => a + f(v), 0) / list.length : 0);
  const planned = views.filter((v) => v.kind !== 'fill' && v.kind !== 'again');
  return { views, sampling: s, coverage, cost, productive: mean(views, (v) => v.productive), productivePlanned: mean(planned, (v) => v.productive),
    context: mean(planned.slice(1), (v) => v.context), wasted: views.filter((v) => v.productive < 0.03).length };
}
