import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';
import { nearScaled, pagedLayout, uvIslands } from '../src/core/layout';
import { sampling } from '../src/core/metrics';
import { bakeNavGraph, navShortestPath, pathLayoutScale, playerImportance, rankTier, splitUvByRank, walkBots } from '../src/core/player-paths';
import type { Level } from '../src/core/scene';

/**
 * An L-shaped corridor/plaza level with a hidden room sealed behind a wall:
 * bots walk the main hall and turn the corner, so main-route walls score high while the sealed back room scores 0.
 */
function corridorWithSealedRoom(): Level {
  const parts = [
    new THREE.PlaneGeometry(24, 16, 6, 4).rotateX(-Math.PI / 2),                // walkable floor (-12..12, -8..8)
    new THREE.BoxGeometry(24, 4, 0.3).translate(0, 2, -8),                      // north outer wall
    new THREE.BoxGeometry(24, 4, 0.3).translate(0, 2, 8),                       // south outer wall
    new THREE.BoxGeometry(0.3, 4, 16).translate(-12, 2, 0),                     // west outer wall
    new THREE.BoxGeometry(0.3, 4, 16).translate(12, 2, 0),                      // east outer wall
    new THREE.BoxGeometry(0.4, 4, 10).translate(4, 2, -3),                      // interior divider leaving a south passage
    // Sealed chamber outside at x = 22 (unreachable and occluded from the playable hall)
    new THREE.BoxGeometry(4, 3, 4).translate(22, 1.5, 0),
  ].map((g, k) => {
    const n = g.toNonIndexed();
    const uv = n.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (k + uv.getX(i) * 0.9) / 7, uv.getY(i) * 0.9);
    n.setAttribute('label', new THREE.Float32BufferAttribute(new Float32Array(n.getAttribute('position').count).fill(k), 1));
    return n;
  });
  const geometry = mergeGeometries(parts)!;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const bvh = new MeshBVH(geometry);
  const pos = geometry.getAttribute('position').array;
  let area = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < pos.length / 9; t++) {
    a.fromArray(pos, 9 * t); b.fromArray(pos, 9 * t + 3); c.fromArray(pos, 9 * t + 6);
    area += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return { name: 'corridor', labels: parts.map((_, k) => `part-${k}`), geometry, bvh, bounds: geometry.boundingBox!.clone(), triangles: pos.length / 9, surfaceArea: area };
}

describe('bakeNavGraph and walkBots', () => {
  const level = corridorWithSealedRoom();

  it('bakes a connected walkable graph with wall clearance, landmarks and shortest paths around obstacles', () => {
    const nav = bakeNavGraph(level, { spacing: 1.5 });
    expect(nav.nodes.length).toBeGreaterThan(25);
    expect(nav.landmarks.length).toBeGreaterThanOrEqual(4);
    for (const node of nav.nodes) {
      expect(node.clearance).toBeGreaterThanOrEqual(0.32);
      expect(node.eye.x).toBeLessThan(12);   // sealed chamber at x = 22 excluded
    }
    const route = navShortestPath(nav, nav.landmarks[0], nav.landmarks[1]);
    expect(route.length).toBeGreaterThanOrEqual(2);

    const poses = walkBots(level, nav, { bots: 6, stepsPerBot: 20 });
    expect(poses.length).toBeGreaterThan(80);
    for (const p of poses) expect(p.dir.length()).toBeCloseTo(1, 4);
  });

  it('uses spherical turntable orbits when the asset is in object mode', () => {
    const prop: Level = { ...level, mode: 'object' };
    const nav = bakeNavGraph(prop);
    expect(nav.nodes.length).toBe(0);
    const poses = walkBots(prop, nav);
    expect(poses.length).toBeGreaterThan(60);
  });
});

describe('playerImportance and pathLayoutScale', () => {
  const level = corridorWithSealedRoom();

  it('scores walked hall walls high, leaves sealed chambers at 0, and gives high-rank islands more UV space', () => {
    const imp = playerImportance(level, { spacing: 1.5, bots: 6, stepsPerBot: 24 });
    expect(imp.rank.length).toBe(level.triangles);
    expect(imp.seenShare).toBeGreaterThan(0.35);
    expect(imp.highRankShare).toBeGreaterThan(0.1);

    // The sealed chamber's 12 triangles at the end of the buffer are never seen by any bot (verifies MeshBVH permuted index mapping!)
    expect(level.geometry.getIndex()).not.toBeNull();
    for (let t = level.triangles - 12; t < level.triangles; t++) {
      expect(imp.rank[t]).toBe(0);
      expect(imp.hits[t]).toBe(0);
      expect(imp.minDist[t]).toBe(Infinity);
    }

    const pos = level.geometry.getAttribute('position').array;
    const uv = level.geometry.getAttribute('uv').array;
    const splitUv = splitUvByRank(pos, uv, imp.rank);
    const scale = pathLayoutScale(pos, splitUv, imp.rank);
    expect(scale[level.triangles - 1]).toBeCloseTo(0.3, 4);
    expect(Math.max(...scale)).toBeGreaterThan(1.0);

    const dist = Float32Array.from({ length: level.triangles }, (_, t) => (imp.rank[t] > 0 ? Math.min(2.5, imp.minDist[t]) : Infinity));
    const plain = pagedLayout(pos, nearScaled(pos, uv, new Float32Array(level.triangles).fill(2.5)).uv, 1);
    const weighted = pagedLayout(pos, nearScaled(pos, splitUv, dist, { weight: scale }).uv, 1);
    // High-rank triangle UV density rises measurably over uniform near-scaling
    const bestTri = [...imp.rank.keys()].reduce((best, t) => (imp.rank[t] > imp.rank[best] ? t : best), 0);
    expect(rankTier(imp.rank[bestTri])).toBe(3);
    expect(Number.isFinite(imp.minDist[bestTri])).toBe(true);
    const uvArea = (u: ArrayLike<number>, t: number) => {
      const q = 6 * t;
      return Math.abs((u[q + 2] - u[q]) * (u[q + 5] - u[q + 1]) - (u[q + 4] - u[q]) * (u[q + 3] - u[q + 1])) / 2;
    };
    expect(uvArea(weighted.uv, bestTri)).toBeGreaterThan(uvArea(plain.uv, bestTri) * 1.15);
  });

  it('breaks hollow welded UV ring remnants into compact quadrant charts and filters sampling() by high-rank mask', () => {
    // 4 thin perimeter strips around [0..1]^2 welded at their corners -> hollow square ring with fill < 0.35
    const quads = [
      [[0, 0], [1, 0], [1, 0.1], [0, 0.1]],
      [[0.9, 0.1], [1, 0.1], [1, 0.9], [0.9, 0.9]],
      [[0, 0.9], [1, 0.9], [1, 1], [0, 1]],
      [[0, 0.1], [0.1, 0.1], [0.1, 0.9], [0, 0.9]],
    ];
    const P: number[] = [], U: number[] = [];
    for (const [a, b, c, d] of quads) {
      for (const [p, q, r] of [[a, b, c], [a, c, d]]) {
        for (const [u, v] of [p, q, r]) { P.push(u * 10, 0, v * 10); U.push(u, v); }
      }
    }
    const pos = Float32Array.from(P), uv = Float32Array.from(U);
    expect(uvIslands(pos, uv).count).toBe(1);
    const rank = new Float32Array(pos.length / 9).fill(0.85);
    const split = splitUvByRank(pos, uv, rank);
    expect(uvIslands(pos, split).count).toBeGreaterThanOrEqual(4);

    // Masked sampling() isolates high-rank cells from coarser low-rank cells
    const G = 4;
    const quality = new Float32Array(G * G).fill(0.5);
    const cellPos = new Float32Array(G * G * 4);
    const covered = new Uint8Array(G * G).fill(1);
    const mask = new Uint8Array(G * G);
    for (let y = 0; y < G; y++) {
      for (let x = 0; x < G; x++) {
        const i = y * G + x;
        // Rows 0..1: 0.1 m/cell (sharp high-rank, 100 texels/m); rows 2..3: 1.0 m/cell (coarse low-rank, 10 texels/m)
        const step = y < 2 ? 0.1 : 1.0;
        cellPos[4 * i] = x * step;
        cellPos[4 * i + 2] = y;
        if (y < 2) mask[i] = 1;
      }
    }
    const all = sampling(quality, cellPos, covered, G, 10, 200);
    const high = sampling(quality, cellPos, covered, G, 10, 200, mask);
    expect(high.texels).toBeGreaterThan(all.texels * 5);
    expect(high.surface).toBeGreaterThan(all.surface * 5);
  });
});
