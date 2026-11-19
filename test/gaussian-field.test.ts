import { describe, expect, it } from 'vitest';
import {
  benchmarkGaussianFieldVsPoisson,
  fitSurfaceGaussianField,
  renderNovelGaussianView,
  runImportanceGatedSdsPolish,
} from '../src/core/gaussian-field';
import type { ProjectedAtlasView } from '../src/core/consolidate';
import type { ViewSpec } from '../src/core/views';

describe('Fixed-Geometry Surface Gaussian Appearance Field & Importance-Gated SDS Polish', () => {
  it('disentangles view-dependent directional glare from intrinsic diffuse albedo and flags hallucinated outlier views', () => {
    const bench = benchmarkGaussianFieldVsPoisson(48);
    // Texture-GS (stride = 1) with degree-1 SH disentangling recovers intrinsic diffuse albedo closer to GT than SH-blind Poisson
    expect(bench.gaussianDense.diffuseRmse).toBeLessThan(bench.poisson.diffuseRmse);
    // Sparse 3DGS (stride = 2, 4x fewer Gaussians) still maintains smooth cross-view transitions
    expect(bench.gaussianSparse.seam.ratio).toBeLessThan(1.35);

    // Inject a hallucinated outlier view (+110 RGB patch) and verify `consistency.outlierViews` flags it automatically
    const S = 32, N = S * S;
    const pos = new Float32Array(N * 4), nrm = new Float32Array(N * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        pos.set([(x / S) * 4 - 2, (y / S) * 4 - 2, 0, 1], 4 * i);
        nrm.set([0, 0, 1, 1], 4 * i);
      }
    }
    const specs: ViewSpec[] = [
      { id: 0, position: [-1, 0, 3], yaw: -0.3, pitch: 0, fov: 80 },
      { id: 1, position: [0, 0, 3], yaw: 0, pitch: 0, fov: 80 },
      { id: 2, position: [1, 0, 3], yaw: 0.3, pitch: 0, fov: 80 },
      { id: 3, position: [0, 1, 3], yaw: 0, pitch: -0.3, fov: 80 },
    ];
    const views: ProjectedAtlasView[] = specs.map((_, v) => {
      const rgba = new Uint8ClampedArray(N * 4);
      const weight = new Float32Array(N).fill(1);
      for (let i = 0; i < N; i++) {
        const c = v === 2 ? 245 : 130; // View 2 is a corrupted/hallucinated outlier!
        rgba.set([c, c, c, 255], 4 * i);
      }
      return { rgba, weight };
    });

    const field = fitSurfaceGaussianField(views, specs, pos, nrm, S, { stride: 2 });
    expect(field.consistency.outlierViews).toContain(2);

    // Novel view render produces clean, non-empty RGBA8 frame
    const gPos = new Float32Array(16 * 16 * 4);
    const gNrm = new Float32Array(16 * 16 * 4);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const i = y * 16 + x;
        gPos.set([(x / 16) * 2 - 1, (y / 16) * 2 - 1, 0, 3], 4 * i);
        gNrm.set([0, 0, 1, 1], 4 * i);
      }
    }
    const novel = renderNovelGaussianView(field, { id: 9, position: [0, 0, 3.2], yaw: 0, pitch: 0, fov: 75 }, gPos, gNrm, 16, 16);
    expect(novel[3]).toBe(255);
    expect(novel[0]).toBeGreaterThan(120);
  });

  it('steers high-importance UV faces toward the diffusion mode while keeping low-importance texels bit-exact', async () => {
    const S = 32, N = S * S;
    const pos = new Float32Array(N * 4), nrm = new Float32Array(N * 4);
    const importance = new Float32Array(N);
    const initRgba = new Uint8ClampedArray(N * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        pos.set([(x / S) * 2 - 1, (y / S) * 2 - 1, 0, 1], 4 * i);
        nrm.set([0, 0, 1, 1], 4 * i);
        // Right half (x >= 16) is hero focal detail (`importance = 0.92`); left half is background (`importance = 0.2`)
        importance[i] = x >= 16 ? 0.92 : 0.2;
        initRgba.set([120, 120, 120, 255], 4 * i);
      }
    }

    const views: ViewSpec[] = [
      { id: 0, position: [0, 0, 2.6], yaw: 0, pitch: 0, fov: 80 },
      { id: 1, position: [0.5, 0, 2.6], yaw: 0.18, pitch: 0, fov: 80 },
    ];

    const res = await runImportanceGatedSdsPolish(
      initRgba,
      pos,
      nrm,
      importance,
      S,
      views,
      ({ renderedRgb, width, height }) => {
        // Target clean mode has crisp carved detail `[175, 155, 135]`
        const target = new Float32Array(width * height * 3);
        for (let i = 0; i < width * height; i++) {
          target[3 * i] = 175;
          target[3 * i + 1] = 155;
          target[3 * i + 2] = 135;
          void renderedRgb;
        }
        return target;
      },
      { steps: 20, importanceGate: 0.55, lr: 3.0, viewSize: 32 },
    );

    expect(res.finalLoss).toBeLessThan(res.initialLoss * 0.45);
    expect(res.activeTexels).toBe(S * (S / 2));
    expect(res.untouchedLowImportanceTexels).toBe(S * (S / 2));

    // Low-importance left half is 100% bit-exact untouched (`120, 120, 120`)
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < 16; x++) {
        const i = 4 * (y * S + x);
        expect([res.rgba[i], res.rgba[i + 1], res.rgba[i + 2]]).toEqual([120, 120, 120]);
      }
    }
    // High-importance hero half converged strongly toward `[175, 155, 135]`
    const heroPx = 4 * (16 * S + 24);
    expect(res.rgba[heroPx]).toBeGreaterThan(158);
    expect(res.rgba[heroPx + 1]).toBeGreaterThan(142);
  });
});
