/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
/**
 * What a view shows, in words, for the prompt: which labelled parts of the level are in the area to paint and
 * roughly where, plus which pixels are roofs. Image models invent less when told what the gray shapes are.
 */
export interface ViewClasses {
  /** Part label index per pixel (-1 = sky), top-down. */
  label: Int16Array;
  /** 1 where the pixel is a roof surface. */
  roof: Uint8Array;
  /** 1 where the pixel is ground you could stand on (not a roof). */
  floor: Uint8Array;
}

export interface ViewDescription {
  /** e.g. "cobblestone ground (bottom), house walls (left), stone fountain (center, small)"; '' without labels */
  parts: string;
  roofShare: number;
  floorShare: number;
}

/**
 * Labels that name roofs; null when the level has none (then roofs are found by slope and height).
 * @param fromFile false when the labels are names given to the level's shapes: a shape is a whole house, roof and
 *   all, so its name says nothing about which of its faces are roof
 */
export function roofLabels(labels: string[], fromFile = true): boolean[] | null {
  if (!fromFile) return null;
  const r = labels.map((l) => /\broofs?\b/.test(l));
  return r.some(Boolean) ? r : null;
}

/** A roof surface faces up at least this much (normal y): gable ends and fascias labelled as roof are walls. */
export const ROOF_MIN_NY = 0.25;

/** Roof test for one surface point when the level has no roof labels: sloped or flat, well above the ground. */
export const looksLikeRoof = (ny: number, y: number, groundY: number) => ny > 0.35 && y > groundY + 3.5;

/**
 * @param nrm RGBA float per pixel: world normal xyz, a = label + 1 (0 = sky), top-down
 * @param pos RGBA float per pixel: world position xyz, top-down
 */
export function classifyView(nrm: Float32Array, pos: Float32Array, labels: string[], groundY: number, fromFile = true): ViewClasses {
  const n = nrm.length / 4;
  const roofOf = roofLabels(labels, fromFile);
  const label = new Int16Array(n).fill(-1);
  const roof = new Uint8Array(n);
  const floor = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = nrm[4 * i + 3];
    if (a < 0.5) continue;
    const k = Math.round(a - 1);
    label[i] = k;
    const ny = nrm[4 * i + 1];
    if (roofOf ? roofOf[k] && ny > ROOF_MIN_NY : looksLikeRoof(ny, pos[4 * i + 1], groundY)) roof[i] = 1;
    else if (ny > 0.7) floor[i] = 1;
  }
  return { label, roof, floor };
}

const where = (cx: number, cy: number) => {
  const h = cx < 0.33 ? 'left' : cx > 0.67 ? 'right' : 'center';
  const v = cy < 0.33 ? 'top' : cy > 0.67 ? 'bottom' : '';
  return v ? (h === 'center' ? v : `${v} ${h}`) : h;
};

/** A name that already says the part is something to walk on. */
const WALKED_ON = /\b(ground|floor|paving|pavement|street|road|path|courtyard|terrace|steps?|stairs?|ramp)\b/;

/**
 * Parts inside `area` (all geometry when undefined), biggest first, with rough positions in the frame.
 * @param shells labels that are a whole room or building in one shape: their up-facing pixels are called floor
 *   rather than by the shape's name (a hall named "plaster wall" still has a floor)
 */
export function describeView(c: ViewClasses, labels: string[], size: number, area?: Uint8Array, shells?: boolean[]): ViewDescription {
  const floorOf = shells && shells.some(Boolean) ? labels.length : -1;   // an extra entry collecting shell floors
  if (floorOf >= 0) labels = [...labels, 'floor'];
  const count = new Float64Array(labels.length);
  const sx = new Float64Array(labels.length);
  const sy = new Float64Array(labels.length);
  let total = 0, roofs = 0, floors = 0;
  for (let i = 0; i < c.label.length; i++) {
    const k = c.label[i];
    if (k < 0 || (area && !area[i])) continue;
    total++;
    roofs += c.roof[i];
    floors += c.floor[i];
    if (k < labels.length) {
      const to = floorOf >= 0 && shells![k] && c.floor[i] && !WALKED_ON.test(labels[k]) ? floorOf : k;
      count[to]++;
      sx[to] += (i % size) / size;
      sy[to] += Math.floor(i / size) / size;
    }
  }
  // Parts without a name say nothing; parts that share a name and a place in the frame are one entry.
  const seen = new Map<string, { name: string; share: number; place: string }>();
  for (let k = 0; k < labels.length; k++) {
    if (!labels[k] || !count[k] || labels.length < 2) continue;
    const place = where(sx[k] / count[k], sy[k] / count[k]);
    const key = `${labels[k]}|${place}`;
    const e = seen.get(key) ?? { name: labels[k], share: 0, place };
    e.share += total ? count[k] / total : 0;
    seen.set(key, e);
  }
  const parts = [...seen.values()]
    .filter((p) => p.share >= 0.004)   // down to what the blockout check looks at: a small prop left unnamed gets painted away
    .sort((a, b) => b.share - a.share)
    .slice(0, 8)
    .map((p) => `${p.name} (${p.share > 0.4 ? 'most of the frame' : p.place}${p.share < 0.04 ? ', small' : ''})`)
    .join(', ');
  return { parts, roofShare: total ? roofs / total : 0, floorShare: total ? floors / total : 0 };
}
