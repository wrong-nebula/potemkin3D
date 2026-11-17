import type { Atlas } from './atlas';
import { toCanvas } from './image';

/**
 * A style reference for views that see little painted texture yet: a sheet of material samples cut from the
 * texture baked so far. A view painted from mostly bare clay invents its own paving and plaster; shown samples of
 * what the level already has, it keeps closer to them.
 *
 * Why samples and not a neighbouring view's photo: given a photo, the image model often just returns that photo
 * and ignores the blockout. Samples come from texture space, so they have no perspective and no layout to copy.
 * Even so, a view with almost nothing in it (one blank wall) can come back as the sheet itself, so such views get
 * no reference (see `wantsSwatches`), and the blockout check holds back whatever still slips through.
 */

/** Samples on the sheet (2 x 2) and the size of each on it, in px. */
const TILE = 256;

/**
 * Up to four squares of `side` px that are painted throughout and differ in colour, as [x, y] corners.
 * @param data RGBA, size x size; alpha 0 = unpainted
 */
export function pickSwatches(data: Uint8ClampedArray, size: number, side: number): [number, number][] {
  const g = Math.max(1, Math.floor(side / 12));   // search on a grid of g px blocks
  const n = Math.floor(size / g), k = Math.round(side / g);
  // integral image of fully painted blocks
  const full = new Int32Array((n + 1) * (n + 1));
  for (let by = 0; by < n; by++) {
    for (let bx = 0; bx < n; bx++) {
      let ok = 1;
      for (let y = by * g; y < (by + 1) * g && ok; y++) for (let x = bx * g; x < (bx + 1) * g; x++) if (!data[4 * (y * size + x) + 3]) { ok = 0; break; }
      full[(by + 1) * (n + 1) + bx + 1] = ok + full[by * (n + 1) + bx + 1] + full[(by + 1) * (n + 1) + bx] - full[by * (n + 1) + bx];
    }
  }
  const mean = (bx: number, by: number) => {
    let r = 0, gr = 0, b = 0, c = 0;
    for (let y = by * g; y < (by + k) * g; y += 4) for (let x = bx * g; x < (bx + k) * g; x += 4) { const i = 4 * (y * size + x); r += data[i]; gr += data[i + 1]; b += data[i + 2]; c++; }
    return [r / c, gr / c, b / c];
  };
  const picked: { at: [number, number]; colour: number[] }[] = [];
  for (let by = 0; by + k <= n && picked.length < 4; by += 2) {
    for (let bx = 0; bx + k <= n && picked.length < 4; bx += 2) {
      const sum = full[(by + k) * (n + 1) + bx + k] - full[by * (n + 1) + bx + k] - full[(by + k) * (n + 1) + bx] + full[by * (n + 1) + bx];
      if (sum !== k * k) continue;
      if (picked.some((p) => Math.abs(p.at[0] - bx) < k && Math.abs(p.at[1] - by) < k)) continue;   // overlaps one already taken
      const colour = mean(bx, by);
      if (picked.some((p) => Math.abs(p.colour[0] - colour[0]) + Math.abs(p.colour[1] - colour[1]) + Math.abs(p.colour[2] - colour[2]) < 40)) continue;
      picked.push({ at: [bx, by], colour });
    }
  }
  return picked.map((p) => [p.at[0] * g, p.at[1] * g]);
}

/** The sample sheet for the texture as it is now, as a JPEG data URL; null while there is too little to sample. */
export function swatchSheet(atlas: Atlas): string | null {
  const { data, size } = atlas.readBytes([0.5, 0.5, 0.5], Math.min(2048, atlas.size), true);
  const side = Math.round(size / 16);   // 128 px of a 2048 px read: big enough to show a material, small enough to find painted
  const at = pickSwatches(data, size, side);
  if (at.length < 3) return null;
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const source = toCanvas(data, size, size);
  const sheet = document.createElement('canvas');
  sheet.width = sheet.height = 2 * TILE;
  const ctx = sheet.getContext('2d')!;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.imageSmoothingQuality = 'high';
  at.forEach(([x, y], i) => ctx.drawImage(source, x, y, side, side, (i % 2) * TILE, Math.floor(i / 2) * TILE, TILE, TILE));
  return sheet.toDataURL('image/jpeg', 0.9);
}

/**
 * Whether a view has enough structure of its own to be given a reference without returning the reference: at
 * least two faces, none of them filling half the frame.
 * @param faces sizes of the view's faces as shares of the frame
 */
export function wantsSwatches(faces: number[]): boolean {
  return faces.length >= 2 && Math.max(...faces) < 0.5;
}
