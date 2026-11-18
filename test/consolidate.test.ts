import { describe, expect, it } from 'vitest';
import {
  backProjectView, consolidateProjectedViews, depthContinuity,
  poissonStitch, registerAndAdvectView, seamMetric, surfaceLinks, type ProjectedAtlasView,
} from '../src/core/consolidate';

/** Build a flat 64x64 wall in atlas space (`part = 0` on `x < 52`, `part = 1` on `x >= 52` to test part-boundary isolation). */
function wallAtlas(size = 64) {
  const N = size * size;
  const pos = new Float32Array(N * 4), nrm = new Float32Array(N * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = 4 * (y * size + x);
      const part = x < Math.floor(size * 0.8) ? 1 : 2;   // pos.w = label + 1
      pos.set([(x / size) * 6 - 3, (y / size) * 6 - 3, 0, part], i);
      nrm.set([0, 0, 1, 1], i);
    }
  }
  return { pos, nrm, size };
}

/** Brick-course procedural pattern at `(x, y)` with an optional `(sx, sy)` shift and `(dr, dg, db)` parallel-view colour drift. */
function brickRgb(x: number, y: number, sx = 0, sy = 0, drift: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const u = x - sx, v = y - sy;
  const course = Math.sin(v * 0.65) * 18 + Math.cos((u + (Math.floor(v / 5) % 2) * 3) * 0.55) * 14;
  return [
    Math.min(255, Math.max(0, 145 + course + drift[0])),
    Math.min(255, Math.max(0, 132 + course * 0.9 + drift[1])),
    Math.min(255, Math.max(0, 118 + course * 0.8 + drift[2])),
  ];
}

describe('depthContinuity and backProjectView', () => {
  it('down-weights occlusion silhouettes while keeping continuous interiors near 1', () => {
    const S = 16;
    const gPos = new Float32Array(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const d = x < 8 ? 3.0 : 9.0;   // occlusion cliff at x = 7|8
        gPos.set([0, 0, -d, d], 4 * (y * S + x));
      }
    }
    const cont = depthContinuity(gPos, S, S);
    expect(cont[8 * S + 3]).toBeCloseTo(1, 3);      // continuous interior
    expect(cont[8 * S + 7]).toBeLessThan(0.15);     // foreground silhouette edge
    expect(cont[8 * S + 8]).toBeLessThan(0.15);     // background right beside silhouette
  });

  it('back-projects a view onto covered atlas texels with cosθ/d × depth-continuity confidence', () => {
    const { pos, nrm, size } = wallAtlas(32);
    const covered = Int32Array.from({ length: size * size }, (_, i) => i);
    const gSize = 32;
    const gPos = new Float32Array(gSize * gSize * 4);
    const comp = new Uint8ClampedArray(gSize * gSize * 4);
    for (let i = 0; i < gSize * gSize; i++) {
      gPos.set([0, 0, 0, 10], 4 * i);   // clear line of sight out to 10 m
      comp.set([180, 150, 120, 255], 4 * i);
    }
    const spec = { id: 0, position: [0, 0, 4] as [number, number, number], yaw: 0, pitch: 0, fov: 90 };
    const pv = backProjectView(pos, nrm, size, covered, spec, gPos, gSize, comp, gSize);
    const centre = (size >> 1) * size + (size >> 1);
    expect(pv.rgba[4 * centre]).toBe(180);
    expect(pv.weight[centre]).toBeGreaterThan(0.15);
  });
});

describe('registerAndAdvectView', () => {
  it('recovers a 2-texel structural shift between overlapping views even under +40 RGB exposure drift', () => {
    const { pos, nrm, size } = wallAtlas(64);
    const links = surfaceLinks(pos, nrm, size);
    const N = size * size;
    const refRgb = new Float32Array(N * 3), refW = new Float32Array(N);
    const view: ProjectedAtlasView = { rgba: new Uint8ClampedArray(N * 4), weight: new Float32Array(N) };

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < 50; x++) {
        const i = y * size + x;
        if (x < 40) {
          const [r, g, b] = brickRgb(x, y, 0, 0, [0, 0, 0]);
          refRgb[3 * i] = r; refRgb[3 * i + 1] = g; refRgb[3 * i + 2] = b;
          refW[i] = 1;
        }
        if (x >= 16) {
          // Shifted by (+1.6, -1.2) texels AND drifted +40 warmer/brighter!
          const [r, g, b] = brickRgb(x, y, 1.6, -1.2, [42, 28, -12]);
          view.rgba.set([r, g, b, 255], 4 * i);
          view.weight[i] = 1;
        }
      }
    }

    const hpBefore = (() => {
      let err = 0, n = 0;
      for (let y = 8; y < size - 8; y++) for (let x = 20; x < 36; x++) {
        const i = y * size + x;
        // Compare brick contrast (relative to each view's mean) before advection
        err += Math.abs((view.rgba[4 * i] - 42) - refRgb[3 * i]);
        n++;
      }
      return err / n;
    })();
    const adv = registerAndAdvectView(view, refRgb, refW, links, size, 3);
    expect(adv.moved).toBe(true);
    let errAfter = 0, cnt = 0;
    for (let y = 8; y < size - 8; y++) for (let x = 20; x < 36; x++) {
      const i = y * size + x;
      errAfter += Math.abs((adv.rgba[4 * i] - 42) - refRgb[3 * i]);
      cnt++;
    }
    errAfter /= cnt;
    expect(errAfter).toBeLessThan(hpBefore * 0.75);
  });
});

describe('poissonStitch and consolidateProjectedViews', () => {
  it('eliminates a hard parallel-view seam step while preserving interior brick detail and isolating separate parts', () => {
    const { pos, nrm, size } = wallAtlas(64);
    const N = size * size;
    const v0: ProjectedAtlasView = { rgba: new Uint8ClampedArray(N * 4), weight: new Float32Array(N) };
    const v1: ProjectedAtlasView = { rgba: new Uint8ClampedArray(N * 4), weight: new Float32Array(N) };
    const vPart2: ProjectedAtlasView = { rgba: new Uint8ClampedArray(N * 4), weight: new Float32Array(N) };

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (x >= Math.floor(size * 0.8)) {
          // Separate semantic part (`part = 2`): bright cobalt blue, must NOT bleed into the sandstone wall!
          vPart2.rgba.set([30, 80, 230, 255], 4 * i);
          vPart2.weight[i] = 1;
          continue;
        }
        if (x < 36) {
          const [r, g, b] = brickRgb(x, y, 0, 0, [-22, -18, -14]);
          v0.rgba.set([r, g, b, 255], 4 * i);
          v0.weight[i] = 0.8 - x * 0.01;
        }
        if (x >= 24) {
          const [r, g, b] = brickRgb(x, y, 1.2, 0.8, [26, 20, 14]);
          v1.rgba.set([r, g, b, 255], 4 * i);
          v1.weight[i] = 0.3 + x * 0.015;
        }
      }
    }

    const res = consolidateProjectedViews([v0, v1, vPart2], pos, nrm, size, { qualityRatio: 0.9 });
    expect(res.before.boundaryEdges).toBeGreaterThan(20);
    expect(res.before.step).toBeGreaterThan(30);
    expect(res.after.step).toBeLessThan(res.before.step * 0.35);
    expect(res.after.ratio).toBeLessThan(1.3);

    // Interior brick contrast is preserved (not blurred flat!), and part 2's cobalt blue never bled across x = 51.
    expect(res.after.interiorStep).toBeGreaterThan(res.before.interiorStep * 0.75);
    const wallNextToPart2 = 32 * size + (Math.floor(size * 0.8) - 1);
    const part2Edge = 32 * size + Math.floor(size * 0.8);
    expect(res.stitched[4 * part2Edge + 2]).toBeGreaterThan(220);
    expect(res.stitched[4 * wallNextToPart2 + 2]).toBeLessThan(165);
  });

  it('smooths an abutting zero-overlap seam without inventing a false step', () => {
    const { pos, nrm, size } = wallAtlas(64);
    const links = surfaceLinks(pos, nrm, size);
    const N = size * size;
    const dataRgb = new Float32Array(N * 3), dataW = new Float32Array(N);
    const gx = new Float32Array(N * 3), gy = new Float32Array(N * 3);
    const owner = new Int16Array(N).fill(-1);
    const raw = new Uint8ClampedArray(N * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < 48; x++) {
        const i = y * size + x;
        const val = x < 24 ? 100 : 180;
        dataRgb[3 * i] = dataRgb[3 * i + 1] = dataRgb[3 * i + 2] = val;
        dataW[i] = 1;
        owner[i] = x < 24 ? 0 : 1;
        raw.set([val, val, val, 255], 4 * i);
      }
    }
    const before = seamMetric(raw, owner, links, size);
    const stitched = poissonStitch(dataRgb, dataW, gx, gy, links, size, 0.02);
    const after = seamMetric(stitched, owner, links, size);
    expect(before.step).toBeCloseTo(80, 1);
    expect(after.step).toBeLessThan(12);
  });
});
