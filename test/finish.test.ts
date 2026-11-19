import { describe, expect, it } from 'vitest';
import { conditionStateWithWear, fillColours } from '../src/core/finish';
import { prompts, type PromptContext } from '../src/providers/models';

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

  it('darkens enclosed cavities with warm grime and lifts exposed convex ridges when WearField is passed', () => {
    const openness = new Float32Array(n * n).fill(1);
    const concave = new Float32Array(n * n);
    const convex = new Float32Array(n * n);
    // Cell 5: deep enclosed crease; Cell 6: open exposed convex ridge; Cell 7: flat open control
    openness[5] = 0.15;
    concave[5] = 0.9;
    openness[6] = 0.95;
    convex[6] = 0.95;

    const wf = fillColours(colour, painted, label, n, 4, { openness, concave, convex, grime: 0.3, edgeWear: 0.25 });
    const px = (i: number) => [...wf.rgba.slice(4 * i, 4 * i + 4)];
    const luma = (rgb: number[]) => 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];

    expect(px(0)).toEqual([200, 10, 10, 255]); // painted cell untouched
    expect(px(7)).toEqual([150, 10, 10, 255]); // open flat cell keeps baseline fill
    expect(luma(px(5))).toBeLessThan(luma(px(7)) - 5); // cavity grime darkens recessed slot
    expect(luma(px(6))).toBeGreaterThan(luma(px(7)) + 10); // ridge wear lifts exposed arris
    expect(wf.weathered).toBe(2);
  });
});

describe('conditionStateWithWear & prompt wear grounding', () => {
  it('darkens concave wall-floor creases, lifts convex arrises, and ignores silhouette depth jumps', () => {
    const S = 32;
    const state = new Uint8ClampedArray(S * S * 4);
    const unknown = new Uint8Array(S * S).fill(1);
    const pos = new Float32Array(S * S * 4);
    const nrm = new Float32Array(S * S * 4);

    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        state.set([180, 180, 180, 255], 4 * i);
        if (x < 16) {
          // Left half: L-shaped concave corner at y = 8 (wall above facing +Z, floor below facing +Y)
          if (y < 8) {
            const h = (8 - y) * 0.04;
            pos.set([x * 0.04, h, 0, 3.0], 4 * i);
            nrm.set([0, 0, 1, 1], 4 * i);
          } else {
            const z = (y - 8) * 0.04;
            pos.set([x * 0.04, 0, z, 3.0], 4 * i);
            nrm.set([0, 1, 0, 1], 4 * i);
          }
        } else {
          // Right half: convex step edge at y = 20 (top facing +Y at y=1, riser below facing +Z bending away in -Z)
          if (y < 20) {
            const z = (20 - y) * -0.04;
            pos.set([x * 0.04, 1, z, 3.0], 4 * i);
            nrm.set([0, 1, 0, 1], 4 * i);
          } else {
            const h = 1 - (y - 20) * 0.04;
            pos.set([x * 0.04, h, 0, 3.0], 4 * i);
            nrm.set([0, 0, 1, 1], 4 * i);
          }
        }
      }
    }

    // Place a foreground post at huge depth jump at (4, 24) to verify no silhouette bleed
    const postIdx = 24 * S + 4;
    pos.set([0.16, 0.2, 2.2, 0.8], 4 * postIdx);
    nrm.set([1, 0, 0, 1], 4 * postIdx);

    const res = conditionStateWithWear(state, unknown, pos, nrm, S);
    expect(res.modifiedPixels).toBeGreaterThan(10);
    expect(res.cavityShare).toBeGreaterThan(0.02);
    expect(res.ridgeShare).toBeGreaterThan(0.02);

    // Concave crease pixel (x=8, y=8) darkened with warm shift (blue reduced more than red)
    const cavIdx = 4 * (8 * S + 8);
    expect(res.state[cavIdx]).toBeLessThan(180);
    expect(res.state[cavIdx + 2]).toBeLessThanOrEqual(res.state[cavIdx]);

    // Convex step lip pixel (x=24, y=20) brightened
    const ridIdx = 4 * (20 * S + 24);
    expect(res.state[ridIdx]).toBeGreaterThan(180);

    // Flat floor pixel next to silhouette post (x=5, y=24) unaffected by foreground depth jump
    const silNeighbour = 4 * (24 * S + 5);
    expect(res.state[silNeighbour]).toBe(180);
  });

  it('adds natural cavity/ridge wear grounding to lit prompts and omits it on diffuse/albedo passes', () => {
    const base: PromptContext = {
      look: 'weathered limestone walls and paving',
      roofLook: 'terracotta tiles',
      parts: 'courtyard wall (center)',
      mode: 'first',
      floor: false,
      wear: { cavity: true, ridge: true },
    };
    expect(prompts.caption(base)).toMatch(/recessed corners.*exposed edges/i);
    expect(prompts.instruction(base)).toMatch(/recessed corners.*exposed edges/i);
    expect(prompts.caption({ ...base, diffuse: true })).not.toMatch(/recessed corners/i);
    expect(prompts.caption({ ...base, wording: 'cel' })).not.toMatch(/recessed corners/i);
  });
});
