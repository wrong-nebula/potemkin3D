import { describe, expect, it } from 'vitest';
import { bakedShadingScore, buildUvSeamGraph, uvDelightAndSharpen, uvInpaint } from '../src/core/uv-refine';

/**
 * Two separated UV charts on a 64x64 atlas that meet along a shared 3D seam (`x3d = 4.0 m`):
 * - Left chart (`u = 4..24, v = 8..48`): painted warm sandstone (`[195, 162, 124]` + brick grain)
 * - Right chart (`u = 40..56, v = 8..48`): completely unpainted (`0`), separated by 16 empty atlas texels in 2D UV
 *   but touching `x3d = 4.0 m` in 3D world space with the same normal `(0, 0, 1)` and part (`1`)!
 * - Third isolated chart (`part = 2` dark slate `[55, 62, 70]`): must keep its own material and never bleed onto part 1.
 */
describe('buildUvSeamGraph and uvInpaint', () => {
  it('bridges 3D seams across separated UV charts and fills unpainted texels with seamless colour and grain', () => {
    const S = 64, N = S * S;
    const pos = new Float32Array(N * 4);
    const nrm = new Float32Array(N * 4);
    const colour = new Uint8ClampedArray(N * 4);
    const painted = new Uint8Array(N);

    for (let y = 8; y < 48; y++) {
      // Chart A: u = 4..23 -> world x = 0.0 .. 3.8 m (0.2 m/texel), painted sandstone
      for (let x = 4; x < 24; x++) {
        const i = y * S + x;
        pos[4 * i] = (x - 4) * 0.2;
        pos[4 * i + 1] = (y - 8) * 0.2;
        pos[4 * i + 2] = 0;
        pos[4 * i + 3] = 1;   // part 0 (+1)
        nrm.set([0, 0, 1, 1], 4 * i);
        const grain = ((x + y) % 4 === 0 ? -12 : 8);
        colour.set([195 + grain, 162 + grain, 124 + grain, 255], 4 * i);
        painted[i] = 1;
      }
      // Chart B: u = 40..55 -> world x = 4.0 .. 7.0 m (touches Chart A's x = 3.8 m edge across the 3D seam!), UNPAINTED!
      for (let x = 40; x < 56; x++) {
        const i = y * S + x;
        pos[4 * i] = 4.0 + (x - 40) * 0.2;
        pos[4 * i + 1] = (y - 8) * 0.2;
        pos[4 * i + 2] = 0;
        pos[4 * i + 3] = 1;   // same part 0 (+1)
        nrm.set([0, 0, 1, 1], 4 * i);
      }
    }

    // Separate part 1 (`pos.w = 2`) painted cool dark slate at y = 52..60, x = 4..20
    for (let y = 52; y < 60; y++) {
      for (let x = 4; x < 20; x++) {
        const i = y * S + x;
        pos.set([(x - 4) * 0.2, 10 + (y - 52) * 0.2, 5, 2], 4 * i);
        nrm.set([0, 1, 0, 1], 4 * i);
        colour.set([52, 58, 68, 255], 4 * i);
        painted[i] = 1;
      }
    }

    const graph = buildUvSeamGraph(pos, nrm, S);
    expect(graph.crossSeamLinks).toBeGreaterThanOrEqual(30);

    const res = uvInpaint(colour, painted, pos, nrm, S, graph);
    expect(res.filled).toBe(40 * 16);
    expect(res.seamBridged).toBe(40 * 16);

    // Every covered texel in Chart B is now opaque and matches Chart A's warm sandstone (R > B + 45), with non-zero grain variance
    let sumR = 0, sumB = 0, diffAdj = 0, count = 0;
    for (let y = 10; y < 46; y++) {
      for (let x = 41; x < 55; x++) {
        const i = y * S + x;
        expect(res.rgba[4 * i + 3]).toBe(255);
        sumR += res.rgba[4 * i];
        sumB += res.rgba[4 * i + 2];
        diffAdj += Math.abs(res.rgba[4 * i] - res.rgba[4 * (i - 1)]);
        count++;
      }
    }
    expect(sumR / count).toBeGreaterThan(175);
    expect(sumR / count - sumB / count).toBeGreaterThan(50);
    expect(diffAdj / count).toBeGreaterThan(2);   // transferred exemplar grain, not flat blur
  });
});

describe('bakedShadingScore and uvDelightAndSharpen', () => {
  it('removes baked directional sun shading across multi-facing walls while preserving intrinsic material detail and gating sharpening by importance', () => {
    const S = 64, N = S * S;
    const pos = new Float32Array(N * 4);
    const nrm = new Float32Array(N * 4);
    const rgba = new Uint8ClampedArray(N * 4);
    const importance = new Float32Array(N);
    const sun: [number, number, number] = [0.7, 0.6, 0.38];
    const sLen = Math.hypot(...sun);
    const [sx, sy, sz] = sun.map((v) => v / sLen);

    // One stone building part (`part = 0`) wrapping 4 walls with normals (+X, -X, +Z, -Z) and heavy baked sun shading!
    const normals: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
    for (let w = 0; w < 4; w++) {
      const [nx, ny, nz] = normals[w];
      const ndotl = Math.max(0, nx * sx + ny * sy + nz * sz);
      // Heavy baked lighting: sunlit wall 1.55x brighter in linear light than shaded wall!
      const bakedLight = 0.55 + 0.95 * ndotl;
      for (let y = 4; y < 60; y++) {
        for (let x = w * 15 + 2; x < w * 15 + 14; x++) {
          const i = y * S + x;
          pos.set([x * 0.1, y * 0.1, w * 2, 1], 4 * i);
          nrm.set([nx, ny, nz, 1], 4 * i);
          importance[i] = w < 2 ? 0.9 : 0.1;   // walls 0..1 high importance, walls 2..3 low importance (< gate 0.35)
          const checker = ((x >> 1) + (y >> 1)) % 2 === 0 ? 1.07 : 0.93;
          const linToU8 = (lin: number) => Math.max(0, Math.min(255, Math.round(Math.pow(Math.max(0, Math.min(1, lin)), 1 / 2.2) * 255)));
          rgba[4 * i] = linToU8(0.42 * bakedLight * checker);
          rgba[4 * i + 1] = linToU8(0.36 * bakedLight * checker);
          rgba[4 * i + 2] = linToU8(0.28 * bakedLight * checker);
          rgba[4 * i + 3] = 255;
        }
      }
    }

    const graph = buildUvSeamGraph(pos, nrm, S);
    const before = bakedShadingScore(rgba, graph.covered, pos, nrm, S, sun);
    expect(before.correlation).toBeGreaterThan(0.75);
    expect(before.directionalSpread).toBeGreaterThan(0.5);

    const refined = uvDelightAndSharpen(rgba, pos, nrm, importance, S, graph, {
      delight: 0.95, sharpen: 0.6, importanceGate: 0.35, sunDir: sun,
    });
    const after = bakedShadingScore(refined.rgba, graph.covered, pos, nrm, S, sun);
    expect(after.correlation).toBeLessThan(before.correlation * 0.3);
    expect(after.directionalSpread).toBeLessThan(before.directionalSpread * 0.3);
    expect(refined.highImportanceShare).toBeCloseTo(0.5, 2);
  });
});
