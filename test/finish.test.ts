import { describe, expect, it } from 'vitest';
import { fillColours } from '../src/core/finish';

describe('fillColours', () => {
  // an 8 x 2 strip of texture: a red part (cells 0-7, the first two painted) over a blue part with nothing painted,
  // and one cell no triangle covers
  const n = 8;
  const label = new Int16Array(n * n).fill(-1), painted = new Uint8Array(n * n), colour = new Uint8ClampedArray(n * n * 4);
  for (let x = 0; x < 8; x++) { label[x] = 0; label[n + x] = 1; }
  label[n + 7] = -1;
  for (const [x, r] of [[0, 200], [1, 100]]) { painted[x] = 1; colour.set([r, 10, 10, 255], 4 * x); }
  const f = fillColours(colour, painted, label, n, 4);
  const at = (i: number) => [...f.rgba.slice(4 * i, 4 * i + 4)];

  it('carries a painted neighbour of the same part outwards, fading to the part average', () => {
    expect(at(2)).toEqual([112, 10, 10, 255]);       // one cell from the 100 red: three quarters of it, a quarter of the average 150 (112.5)
    expect(at(5)[0]).toBe(150);                      // four cells off and beyond: the average alone
    expect(at(0)).toEqual([200, 10, 10, 255]);       // painted cells keep their own colour, for slivers inside them
  });

  it('gives a part with nothing painted the average of everything, and colours only a rim beyond the level', () => {
    expect(at(n + 3)).toEqual([150, 10, 10, 255]);
    expect(at(n + 7)[3]).toBe(255);                  // an uncovered cell beside the level: part of the rim
    expect(at(5 * n + 3)[3]).toBe(0);                // further out: nothing
    expect(f.filled).toBe(6 + 7);
    expect(f.near).toBe(3);                          // cells 2, 3, 4 of the red part
  });
});
