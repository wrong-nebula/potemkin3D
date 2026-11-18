import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';
import type { Lighting } from '../src/core/clay';
import { applyScreenshotArtifacts, critiqueRun, scoreDiagnosticFrames } from '../src/core/critic';
import type { Engine } from '../src/core/engine';
import type { RunMetrics } from '../src/core/metrics';
import type { RunRecord } from '../src/core/pipeline';

const SUNNY: Lighting = {
  name: 'sunny',
  sunAzimuth: 38,
  sunElevation: 42,
  sunIntensity: 2.2,
  skyIntensity: 0.7,
  bounce: 0.25,
  exposure: 1,
  sky: [0.65, 0.75, 0.9],
};

function makeMockEngine(opts: {
  paintShare: number;
  qualityVal?: number;
  sunBaked?: boolean;
}) {
  // Simple open courtyard floor (12x12 at y=0) + wall along z=-6 facing +z
  const floor = new THREE.PlaneGeometry(12, 12).rotateX(-Math.PI / 2);
  const wall = new THREE.PlaneGeometry(12, 4).translate(0, 2, -6);
  const posList: number[] = [];
  const nrmList: number[] = [];
  const uvList: number[] = [];
  const labelList: number[] = [];

  for (const [gi, g] of [floor, wall].entries()) {
    const nonIdx = g.toNonIndexed();
    const p = nonIdx.getAttribute('position');
    const n = nonIdx.getAttribute('normal');
    const u = nonIdx.getAttribute('uv');
    const triCount = p.count / 3;
    for (let i = 0; i < p.count; i++) {
      posList.push(p.getX(i), p.getY(i), p.getZ(i));
      nrmList.push(n.getX(i), n.getY(i), n.getZ(i));
      uvList.push(u.getX(i) * 0.45 + (gi === 1 ? 0.5 : 0.02), u.getY(i) * 0.9 + 0.05);
    }
    for (let t = 0; t < triCount; t++) labelList.push(gi + 1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(posList, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nrmList, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvList, 2));
  geometry.setAttribute('label', new THREE.Float32BufferAttribute(
    labelList.flatMap((l) => [l, l, l]), 1,
  ));
  geometry.computeBoundingBox();
  const bvh = new MeshBVH(geometry);
  const triangles = posList.length / 9;

  const level = {
    geometry,
    bvh,
    bounds: geometry.boundingBox!,
    triangles,
    labels: ['stone floor', 'stone wall'],
    mode: 'level' as const,
    surfaceWeights: {
      openness: new Float32Array(triangles).fill(0.85),
      curvature: new Float32Array(triangles).fill(0),
      light: new Float32Array(triangles).fill(0.8),
      faceClass: new Uint8Array(triangles).fill(1),
      importance: new Float32Array(triangles).fill(0.85),
    },
    playerPaths: {
      rank: new Float32Array(triangles).fill(0.8),
      hits: new Uint32Array(triangles).fill(12),
      poses: 48,
      nodes: 16,
    },
  };

  const makeGrid = (G: number) => {
    const pos = new Float32Array(G * G * 4);
    const nrm = new Float32Array(G * G * 4);
    const qual = new Float32Array(G * G);
    const rgba = new Uint8ClampedArray(G * G * 4);
    let covCount = 0, paintCount = 0;
    for (let y = 0; y < G; y++) {
      for (let x = 0; x < G; x++) {
        const i = y * G + x;
        const u = x / G, v = y / G;
        if (v < 0.05 || v > 0.95) continue;
        const isWall = u >= 0.5;
        covCount++;
        const px = ((u % 0.5) / 0.5 - 0.5) * 10;
        if (isWall) {
          pos[4 * i] = px; pos[4 * i + 1] = 1.6 + (v - 0.5) * 2.5; pos[4 * i + 2] = -6; pos[4 * i + 3] = 2;
          // Vary wall normal across u so baked directional sun correlation is measurable
          const nx = Math.sin((u - 0.75) * 2.4), nz = Math.cos((u - 0.75) * 2.4);
          nrm[4 * i] = nx; nrm[4 * i + 1] = 0; nrm[4 * i + 2] = nz; nrm[4 * i + 3] = 1;
        } else {
          pos[4 * i] = px; pos[4 * i + 1] = 0; pos[4 * i + 2] = (v - 0.5) * 10; pos[4 * i + 3] = 1;
          nrm[4 * i] = 0; nrm[4 * i + 1] = 1; nrm[4 * i + 2] = 0; nrm[4 * i + 3] = 1;
        }
        const painted = (covCount % 100) < Math.round(opts.paintShare * 100);
        if (painted) {
          paintCount++;
          qual[i] = opts.qualityVal ?? 0.35;
        }
        const sunBoost = opts.sunBaked ? Math.max(0, nrm[4 * i] * 70 + nrm[4 * i + 2] * 55) : 0;
        const grain = ((x * 17 + y * 31) % 19) - 9;
        rgba[4 * i] = Math.min(255, Math.max(0, Math.round(150 + sunBoost + grain)));
        rgba[4 * i + 1] = Math.min(255, Math.max(0, Math.round(142 + sunBoost + grain)));
        rgba[4 * i + 2] = Math.min(255, Math.max(0, Math.round(130 + sunBoost + grain)));
        rgba[4 * i + 3] = 255;
      }
    }
    return { pos, nrm, qual, rgba, coverage: covCount ? paintCount / covCount : 0 };
  };

  const engine = {
    size: 1024,
    options: { qualityRatio: 0.4, minCos: 0.15, frameMargin: 0.04 },
    clay: { lighting: SUNNY },
    level,
    atlas: {
      size: 1024,
      texelGeometry: (G: number) => {
        const g = makeGrid(G);
        return { pos: g.pos, nrm: g.nrm };
      },
      cellQuality: (G: number) => makeGrid(G).qual,
      readBytes: (_bg: [number, number, number], G = 256) => ({ data: makeGrid(G).rgba }),
      coverage: () => makeGrid(128).coverage,
    },
  } as unknown as Engine;

  return engine;
}

function makeMetrics(seenPainted: number, highRankSurface = 64): RunMetrics {
  return {
    views: [],
    cost: 0.054,
    coverage: seenPainted,
    productive: 0.48,
    productivePlanned: 0.48,
    wasted: 0,
    sampling: {
      p10: 0.6, p50: 0.9, p90: 1.2, under1: 0.55, under05: 0.08, cells: 8000,
      detail: 0.85, full: 0.45, texels: 85, surface: highRankSurface, surfaceMean: highRankSurface, surface75: highRankSurface * 1.15,
    },
    seen: { share: 0.9, painted: seenPainted, filled: 0 },
    highRank: { share: 0.35, painted: seenPainted, surface: highRankSurface, surfaceMean: highRankSurface, surface75: highRankSurface * 1.15, texels: 96 },
  } as unknown as RunMetrics;
}

describe('Critic scoring and targeted repair gating (item 10)', () => {
  it('flags unpainted coverage & seam ratio deficits before authorizing extra spend, then passes once repaired', () => {
    const engineLow = makeMockEngine({ paintShare: 0.45, sunBaked: true });
    const recordLow = {
      views: [
        { index: 0, spec: {} as never, gen: new Uint8ClampedArray(0), comp: new Uint8ClampedArray(0), model: 'flux3-klein', mode: 'first', price: 0.009, seconds: 1, left: 0.35, ignored: 0.02, merged: 0.01 },
      ],
    } as unknown as RunRecord;

    const r1 = critiqueRun(engineLow, recordLow, makeMetrics(0.45, 28), {
      minSeenPainted: 0.88,
      minHighRankPxPerM: 45,
      maxSeamRatio: 1.35,
    });
    expect(r1.verdict).toBe('needs-repair');
    expect(r1.actions.some((a) => a.op === 'topUp')).toBe(true);
    expect(r1.actions.some((a) => a.op === 'uvRefine')).toBe(true);
    expect(r1.defectRegions.length).toBeGreaterThan(0);
    expect(r1.diagnosticCameras.length).toBeGreaterThan(0);

    // After repair + consolidation + UV refinement: coverage reaches 96%, high-rank 72 px/m, clean seams -> pass!
    const engineGood = makeMockEngine({ paintShare: 0.99, sunBaked: false });
    const recordGood = {
      views: recordLow.views,
      consolidated: {
        size: 512,
        flow: true,
        lambda: 0.02,
        before: { step: 0.08, interiorStep: 0.04, ratio: 2.0, boundaryEdges: 420 },
        after: { step: 0.044, interiorStep: 0.04, ratio: 1.1, boundaryEdges: 420 },
      },
      uvRefined: { size: 512, delight: 0.85, sharpen: 0.45, importanceGate: true },
    } as unknown as RunRecord;

    const r2 = critiqueRun(engineGood, recordGood, makeMetrics(0.96, 72), {
      minSeenPainted: 0.88,
      minHighRankPxPerM: 45,
      maxSeamRatio: 1.35,
    });
    expect(r2.verdict).toBe('pass');
    expect(r2.score).toBeGreaterThan(r1.score + 15);
    expect(r2.actions.filter((a) => a.estimatedCalls > 0)).toEqual([]);
  });

  it('prescribes targeted 3D-box repair when SAM/MoGe ignored residuals are high despite passable coverage', () => {
    const engine = makeMockEngine({ paintShare: 0.9 });
    const record = {
      views: [
        { index: 0, spec: {} as never, gen: new Uint8ClampedArray(0), comp: new Uint8ClampedArray(0), model: 'flux3-klein', mode: 'first', price: 0.009, seconds: 1, left: 0.05, ignored: 0.24, merged: 0.04 },
        { index: 1, spec: {} as never, gen: new Uint8ClampedArray(0), comp: new Uint8ClampedArray(0), model: 'flux3-klein', mode: 'fill', price: 0.009, seconds: 1, left: 0.04, ignored: 0.19, merged: 0.03 },
      ],
      consolidated: {
        size: 512, flow: true, lambda: 0.02,
        before: { step: 0.05, interiorStep: 0.04, ratio: 1.25, boundaryEdges: 200 },
        after: { step: 0.042, interiorStep: 0.04, ratio: 1.05, boundaryEdges: 200 },
      },
      uvRefined: { size: 512, delight: 0.85, sharpen: 0.45, importanceGate: true },
    } as unknown as RunRecord;

    const rep = critiqueRun(engine, record, makeMetrics(0.91, 60), { maxIgnoredShare: 0.08 });
    expect(rep.metrics.samIgnoredMean).toBeGreaterThan(0.2);
    expect(rep.metrics.highArtifactViews).toEqual([0, 1]);
    expect(rep.verdict).toBe('needs-repair');
    expect(rep.actions.some((a) => a.op === 'repair')).toBe(true);
  });

  it('scores diagnostic screenshot clay & clipping artifacts and gates topUp when clay patches remain visible', () => {
    const W = 64, H = 64;
    const clayFrame = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      // 30% neutral unpainted clay [128,128,128], 70% textured stone with natural variation
      if (i < W * H * 0.3) {
        clayFrame[4 * i] = 128; clayFrame[4 * i + 1] = 128; clayFrame[4 * i + 2] = 128; clayFrame[4 * i + 3] = 255;
      } else {
        const g = (i * 13) % 29;
        clayFrame[4 * i] = 165 + g; clayFrame[4 * i + 1] = 142 + g; clayFrame[4 * i + 2] = 112 + g; clayFrame[4 * i + 3] = 255;
      }
    }
    const art = scoreDiagnosticFrames([{ data: clayFrame, width: W, height: H }]);
    expect(art.clayShare).toBeGreaterThan(0.25);
    expect(art.clippedShare).toBe(0);

    const engineGood = makeMockEngine({ paintShare: 0.99 });
    const recordGood = {
      views: [],
      consolidated: { size: 512, flow: true, lambda: 0.02, before: { step: 0, interiorStep: 0, ratio: 1, boundaryEdges: 0 }, after: { step: 0, interiorStep: 0, ratio: 1, boundaryEdges: 0 } },
      uvRefined: { size: 512, delight: 0.85, sharpen: 0.45, importanceGate: true },
    } as unknown as RunRecord;
    const base = critiqueRun(engineGood, recordGood, makeMetrics(0.96, 70));
    expect(base.verdict).toBe('pass');

    const withShot = applyScreenshotArtifacts(base, art);
    expect(withShot.verdict).toBe('needs-repair');
    expect(withShot.actions.some((a) => a.op === 'topUp')).toBe(true);
    expect(withShot.score).toBeLessThan(base.score);
  });
});
