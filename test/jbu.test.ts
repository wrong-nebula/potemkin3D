import { describe, expect, it } from 'vitest';
import { withOcclusion, type AoMap } from '../src/core/ao';
import { jointBilateralUpsampleRgba, type AtlasGuide } from '../src/core/jbu';

/**
 * Build a synthetic L-corner UV chart at `size × size`:
 * - Left half (`x < size/2`): horizontal floor (`y = 0`, normal `+Y`, dark contact AO near `x = size/2 - 1`)
 * - Right half (`x >= size/2`): open top of a raised ledge (`y = 1.2`, normal `+Z`, completely unoccluded `ao = 250`)
 * Plain bilinear upsampling blurs the dark floor-corner AO onto the perpendicular/stepped face across `x = size/2`;
 * Joint Bilateral Upsampling (`mrdoob/three.js#35602`) rejects cross-normal & cross-plane taps!
 */
function makeCornerGuide(size: number): AtlasGuide {
  const pos = new Float32Array(size * size * 4);
  const nrm = new Float32Array(size * size * 4);
  const half = size >> 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = 4 * (y * size + x);
      // Leave 2-texel outer border as empty UV gutter (`nrm.w = 0`)
      if (x < 1 || y < 1 || x >= size - 1 || y >= size - 1) continue;
      if (x < half) {
        // Slanted floor ramp (`y = 0.3 * u`) to verify plane-distance stays 0 along slanted surfaces!
        const wx = (x / half) * 4;
        pos.set([wx, 0.3 * wx, (y / size) * 4, 1], i);
        const ny = 1 / Math.hypot(0.3, 1), nx = -0.3 * ny;
        nrm.set([nx, ny, 0, 1], i);
      } else {
        // Perpendicular vertical wall (`normal = +X`) meeting at `x = half`
        const wy = ((x - half) / half) * 4;
        pos.set([4, 1.2 + wy, (y / size) * 4, 1], i);
        nrm.set([1, 0, 0, 1], i);
      }
    }
  }
  return { pos, nrm, size };
}

describe('Joint Bilateral Upsampling for AO & Atlas Maps (mrdoob/three.js#35602)', () => {
  it('prevents reduced-resolution AO from leaking across 90-degree creases and UV gutters while staying smooth on slanted planes', () => {
    const lowS = 16, fullS = 64;
    const lowGuide = makeCornerGuide(lowS);
    const fullGuide = makeCornerGuide(fullS);

    const lowAo = new Uint8ClampedArray(lowS * lowS).fill(255); // gutter = 255
    for (let y = 1; y < lowS - 1; y++) {
      for (let x = 1; x < lowS - 1; x++) {
        // Left slanted floor is occluded (`60`); right perpendicular wall is open (`245`)
        lowAo[y * lowS + x] = x < lowS / 2 ? 60 : 245;
      }
    }

    const aoMap: AoMap = { size: lowS, data: lowAo, rays: 16, radius: 1.5, seconds: 0.01, guide: lowGuide };
    const blankOrm = new Uint8ClampedArray(fullS * fullS * 4);
    for (let i = 0; i < fullS * fullS; i++) blankOrm.set([255, 180, 0, 255], 4 * i);

    const bilinearOrm = withOcclusion(blankOrm, fullS, { ...aoMap, guide: undefined });
    const jbuOrm = withOcclusion(blankOrm, fullS, aoMap, fullGuide);

    // Check full-res texel right on the open wall side of the 90° crease (`fx = fullS / 2`, `fy = fullS / 2`)
    const wallCreaseIdx = 4 * ((fullS >> 1) * fullS + (fullS >> 1));
    // Plain bilinear leaks dark floor AO (`(60 * 0.375 + 245 * 0.625) ≈ 176`), darkening the open wall by ~70 units!
    expect(bilinearOrm[wallCreaseIdx]).toBeLessThan(190);
    // Joint Bilateral Upsampling rejects the perpendicular floor tap (`normalPower = 8`), keeping the wall crisp at ~245!
    expect(jbuOrm[wallCreaseIdx]).toBeGreaterThanOrEqual(244);

    // Check full-res texel right inside the UV island rim next to the `255` gutter (`fx = 4`, `fy = fullS / 2`)
    const rimIdx = 4 * ((fullS >> 1) * fullS + 4);
    // Plain bilinear pulls white `255` gutter into the dark `60` island rim; JBU rejects uncovered (`nrm.w = 0`) gutter taps!
    expect(jbuOrm[rimIdx]).toBeLessThanOrEqual(62);
    expect(bilinearOrm[rimIdx]).toBeGreaterThan(120);

    // Along the slanted ramp interior (`fx = 16`, `fy = 32`), planeDistance = 0 so JBU stays smooth (`60`)
    const rampIdx = 4 * (32 * fullS + 16);
    expect(jbuOrm[rampIdx]).toBe(60);
  });

  it('weights RGBA8 coverage alpha cleanly without pulling empty gutter black into island borders', () => {
    const lowS = 16, fullS = 64;
    const lowGuide = makeCornerGuide(lowS);
    const fullGuide = makeCornerGuide(fullS);
    const lowRgba = new Uint8ClampedArray(lowS * lowS * 4);
    for (let y = 1; y < lowS - 1; y++) {
      for (let x = 1; x < lowS - 1; x++) {
        const c = x < lowS / 2 ? [190, 140, 95, 255] : [45, 95, 210, 255];
        lowRgba.set(c, 4 * (y * lowS + x));
      }
    }
    const up = jointBilateralUpsampleRgba(lowRgba, lowGuide, fullGuide, { coverage: true });
    // Rim texel at fx = 4 (next to alpha=0 black gutter) preserves exact [190, 140, 95] without darkening!
    const rim4 = 4 * (32 * fullS + 4);
    expect(up[rim4]).toBeGreaterThanOrEqual(189);
    expect(up[rim4 + 3]).toBeGreaterThan(200);
    // Crease texel at fx = 32 (right side of 90° corner) preserves cobalt [45, 95, 210] without sandstone bleed!
    const crease4 = 4 * (32 * fullS + 32);
    expect(up[crease4]).toBeLessThanOrEqual(46);
    expect(up[crease4 + 2]).toBeGreaterThanOrEqual(209);
  });
});
