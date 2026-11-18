import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';
import {
  adaptiveLookViews, budgetAdvice, combinedPlanWeights, deficitTargets,
  fisherUtility, geodesicDistance, geodesicWeight, selectFisherViews,
} from '../src/core/adaptive-plan';
import { DEFAULT_PLAN, type CellList } from '../src/core/planner';
import type { Level } from '../src/core/scene';
import type { ViewSpec } from '../src/core/views';

describe('geodesicDistance and geodesicWeight', () => {
  it('propagates along connected surfaces, bridges resting props, and decays smoothly with distance', () => {
    const corridor = new THREE.PlaneGeometry(30, 4, 30, 4).rotateX(-Math.PI / 2).translate(15, 0, 0).toNonIndexed();
    // A crate sitting 0.05 m above the floor at x = 3 (no shared vertices, bridged across contact)
    const nearCrate = new THREE.BoxGeometry(1, 1, 1).translate(3, 0.55, 0).toNonIndexed();
    // An isolated floating block 25 m up in the sky (unreachable)
    const skyBlock = new THREE.BoxGeometry(1, 1, 1).translate(3, 25, 0).toNonIndexed();
    const g = mergeGeometries([corridor, nearCrate, skyBlock])!;
    const pos = g.getAttribute('position').array;
    const spots = [new THREE.Vector3(1, 1.65, 0)];
    const d = geodesicDistance(pos, spots);
    const w = geodesicWeight(d);

    const corridorTris = corridor.getAttribute('position').count / 3;
    let nearFloor = Infinity, farFloor = 0;
    for (let t = 0; t < corridorTris; t++) {
      const x = (pos[9 * t] + pos[9 * t + 3] + pos[9 * t + 6]) / 3;
      if (x < 2) nearFloor = Math.min(nearFloor, d[t]);
      if (x > 27) farFloor = Math.max(farFloor, d[t]);
    }
    expect(nearFloor).toBeLessThan(2);
    expect(farFloor).toBeGreaterThan(24);

    // Near crate bridged onto the floor gets finite distance and high weight; sky block stays Infinity at minWeight
    const crateDist = d[corridorTris];
    const skyDist = d[d.length - 1];
    expect(Number.isFinite(crateDist)).toBe(true);
    expect(crateDist).toBeLessThan(5);
    expect(w[corridorTris]).toBeGreaterThan(0.85);
    expect(skyDist).toBe(Infinity);
    expect(w[d.length - 1]).toBeCloseTo(0.28, 5);
  });
});

describe('fisherUtility and selectFisherViews', () => {
  it('exhibits diminishing returns past sharp coverage while strongly rewarding initial and blurry-to-sharp gains', () => {
    expect(fisherUtility(0)).toBe(0);
    expect(fisherUtility(1)).toBeCloseTo(1, 6);
    const g1 = fisherUtility(0.25) - fisherUtility(0);     // unpainted -> coarse: ~0.38
    const g2 = fisherUtility(0.75) - fisherUtility(0.25);  // coarse -> sharp: ~0.46
    const g3 = fisherUtility(1.0) - fisherUtility(0.75);   // sharp -> saturated: ~0.16
    expect(g1).toBeGreaterThan(0.35);
    expect(g2).toBeGreaterThan(0.4);
    expect(g3).toBeLessThan(0.2);
  });

  it('picks a wide framing view first when context is 0, then unlocks a close-up high-detail view once context is painted', () => {
    // View 0: wide 90° framing shot seeing 80 cells coarsely (q = 0.15) across 4 faces (maxFace = 0.3 -> paintability 1.0 at ctx 0).
    // View 1: tight 60° close-up seeing 45 of those cells sharply (q = 0.6) on 1 big face (maxFace = 0.65 -> penalized 0.3x at ctx 0, 1.0x once ctx >= 0.3!).
    // View 2: wide 90° shot seeing 25 low-weight crevice cells.
    const spec = (id: number, fov: number): ViewSpec => ({ id, position: [0, 1.65, 0], yaw: 0, pitch: 0, fov });
    const specs = [spec(0, 90), spec(1, 60), spec(2, 90)];
    const lists: CellList[] = [
      { cells: Int32Array.from({ length: 80 }, (_, i) => i), q: new Float32Array(80).fill(0.12), shape: { sky: 0.15, faces: 4, maxFace: 0.3 } },
      { cells: Int32Array.from({ length: 45 }, (_, i) => i), q: new Float32Array(45).fill(0.5), shape: { sky: 0.05, faces: 2, maxFace: 0.65 } },
      { cells: Int32Array.from({ length: 25 }, (_, i) => 100 + i), q: new Float32Array(25).fill(0.2), shape: { sky: 0.2, faces: 3, maxFace: 0.3 } },
    ];
    const density = new Float32Array(256).fill(600);
    const weights = new Float32Array(256).fill(1);
    weights.fill(1.6, 0, 45);     // important hero wall
    weights.fill(0.3, 100, 125);  // low-importance recess

    const one = selectFisherViews(lists, specs, { ...DEFAULT_PLAN, grid: 16, maxViews: 1 }, { density, weights, viewSize: 1024 });
    expect(one.order).toEqual([0]);   // framing view goes first because view 1 has 0 context on a 65% blank face

    const two = selectFisherViews(lists, specs, { ...DEFAULT_PLAN, grid: 16, maxViews: 2 }, { density, weights, viewSize: 1024 });
    expect(two.order).toEqual([0, 1]);   // once view 0 paints context, view 1 unlocks and beats the low-weight recess view 2
  });
});

describe('deficitTargets, adaptiveLookViews and budgetAdvice', () => {
  it('focuses refinement cameras with tighter FOVs on high-density deficit patches and reports spend bottlenecks', () => {
    const floor = new THREE.PlaneGeometry(24, 24).rotateX(-Math.PI / 2);
    const column = new THREE.CylinderGeometry(0.4, 0.4, 3, 16).translate(0, 1.5, -4);
    const geos = [floor, column].map((g, k) => {
      const n = g.toNonIndexed();
      const uv = n.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (k + uv.getX(i) * 0.9) / 2, uv.getY(i) * 0.9);
      n.setAttribute('label', new THREE.Float32BufferAttribute(new Float32Array(n.getAttribute('position').count).fill(k), 1));
      return n;
    });
    const geometry = mergeGeometries(geos)!;
    const bvh = new MeshBVH(geometry);
    const bounds = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute);
    let area = 0;
    const posArr = geometry.getAttribute('position').array;
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
    for (let t = 0; t < posArr.length / 9; t++) {
      va.fromArray(posArr, 9 * t); vb.fromArray(posArr, 9 * t + 3); vc.fromArray(posArr, 9 * t + 6);
      area += vb.sub(va).cross(vc.sub(va)).length() / 2;
    }
    const level: Level = { name: 'test', labels: ['stone floor', 'carved column'], geometry, bvh, bounds, triangles: posArr.length / 9, surfaceArea: area };
    const points = [new THREE.Vector3(0, 1.65, 1), new THREE.Vector3(3, 1.65, -2)];
    const cw = combinedPlanWeights(level, points, 16);
    expect(cw.some((x) => x > 0)).toBe(true);

    // Grid with an under-covered dense column patch at (0, 1.5, -3.6) facing +Z
    const G = 8, pos = new Float32Array(G * G * 4), nrm = new Float32Array(G * G * 4), haveR = new Float32Array(G * G).fill(0.9);
    const density = new Float32Array(G * G).fill(40), weights = new Float32Array(G * G).fill(0.8);
    for (let i = 0; i < 6; i++) {
      pos.set([0.1 * (i % 3), 1.3 + 0.2 * Math.floor(i / 3), -3.6, 2], 4 * i);
      nrm.set([0, 0, 1, 1], 4 * i);
      haveR[i] = 0.1;
      density[i] = 140;
      weights[i] = 1.5;
    }
    for (let i = 6; i < 20; i++) {
      pos.set([5, 0, 5, 1], 4 * i);
      nrm.set([0, 1, 0, 1], 4 * i);
    }
    const patches = deficitTargets(pos, nrm, haveR, { weights, density });
    expect(patches.length).toBe(1);
    expect(patches[0].density).toBeCloseTo(140);

    const cams = adaptiveLookViews(level, patches, points, 1024);
    expect(cams.length).toBeGreaterThan(0);
    for (const cam of cams) {
      expect(cam.fov).toBeGreaterThanOrEqual(62);
      expect(cam.fov).toBeLessThanOrEqual(86);
    }
    expect(cams.some((c) => c.fov < 78)).toBe(true);   // includes tightened close-up lens for the dense column

    const advice = budgetAdvice({
      marginalShares: [0.28, 0.16, 0.09, 0.02, 0.005],
      weightedCoverage: 0.86,
      medianRatio: 1.15,
      surface: { pos, nrm, texelsPerCell: 512 },
      weights,
      grid: G,
      atlasSize: 4096,
      rounds: 3,
      probedCandidates: 48,
    });
    expect(advice.recommendedViews).toBe(4);
    expect(advice.extraViewsWorthIt).toBe(false);
    expect(advice.bottleneck).toBe('layout');
    expect(advice.localModelTailViews).toBe(1);
    expect(advice.sparseHeightTiles.active).toBeLessThanOrEqual(advice.sparseHeightTiles.total);
  });
});
