import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';
import { layoutHash, packBoxes, seenCells, seenLayout, seenTriangles, uvIslands } from '../src/core/layout';

/** Two triangles making the rectangle (x0, y0)-(x1, y1) in the plane z = `z`, with the UV rectangle given. */
function quad(z: number, uv: [number, number, number, number]) {
  const [u0, v0, u1, v1] = uv;
  return {
    position: [0, 0, z, 1, 0, z, 1, 1, z, 0, 0, z, 1, 1, z, 0, 1, z],
    uv: [u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1],
  };
}

describe('seenTriangles', () => {
  it('finds the faces a player has a clear line to', () => {
    // a 3 m crate on a floor, a player standing to its +x side
    const floor = new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2);
    const crate = new THREE.BoxGeometry(2, 3, 2).translate(0, 1.5, 0);
    const g = mergeGeometries([floor, crate].map((x) => x.toNonIndexed()))!;
    const position = g.getAttribute('position').array;
    const seen = seenTriangles(position, new MeshBVH(g), [new THREE.Vector3(6, 1.65, 0)]);
    const facing = (t: number) => {
      const a = new THREE.Vector3().fromArray(position, 9 * t), b = new THREE.Vector3().fromArray(position, 9 * t + 3), c = new THREE.Vector3().fromArray(position, 9 * t + 6);
      return b.sub(a).cross(c.sub(a)).normalize();
    };
    const of = (pick: (n: THREE.Vector3, t: number) => boolean) => [...seen.keys()].filter((t) => t >= 2 && pick(facing(t), t)).map((t) => seen[t]);
    expect(seen[0] + seen[1]).toBeGreaterThan(0);                 // the floor
    expect(of((n) => n.x > 0.9)).toEqual([1, 1]);                // the side facing the player
    expect(of((n) => n.x < -0.9)).toEqual([0, 0]);               // the far side
    expect(of((n) => n.y > 0.9)).toEqual([0, 0]);                // the top, above eye height
    expect(of((n) => n.y < -0.9)).toEqual([0, 0]);               // the underside
  });
});

describe('uvIslands', () => {
  const a = quad(0, [0, 0, 0.5, 1]);
  const position = [...a.position], uv = [...a.uv];

  it('joins triangles that share a corner on the level and in the texture', () => {
    expect(uvIslands(position, uv).count).toBe(1);
  });

  it('keeps triangles of different classes apart, and triangles that only meet on the level', () => {
    expect(uvIslands(position, uv, [1, 0]).count).toBe(2);
    const apart = [...uv.slice(0, 6), ...uv.slice(6).map((x, i) => (i % 2 ? x : x + 0.5))];   // the second triangle elsewhere in the texture
    expect(uvIslands(position, apart).count).toBe(2);
  });
});

describe('packBoxes', () => {
  it('packs boxes into the strip without overlap', () => {
    const w = [0.5, 0.5, 0.3, 0.3, 0.3, 0.9], h = [0.4, 0.2, 0.2, 0.2, 0.1, 0.1];
    const p = packBoxes(w, h);
    for (let i = 0; i < w.length; i++) {
      expect(p.x[i]).toBeGreaterThanOrEqual(0);
      expect(p.x[i] + w[i]).toBeLessThanOrEqual(1 + 1e-6);
      for (let j = 0; j < i; j++) {
        const apart = p.x[i] + w[i] <= p.x[j] + 1e-6 || p.x[j] + w[j] <= p.x[i] + 1e-6 || p.y[i] + h[i] <= p.y[j] + 1e-6 || p.y[j] + h[j] <= p.y[i] + 1e-6;
        expect(apart).toBe(true);
      }
    }
    expect(p.height).toBeLessThanOrEqual(0.8 + 1e-6);            // the boxes cover 0.52 of the strip's width times that
    expect(packBoxes([1.2], [0.1]).height).toBe(Infinity);
  });
});

describe('seenLayout', () => {
  // four walls of the same size, each with a quarter of the texture; players see only the first
  const walls = [quad(0, [0, 0, 0.5, 0.5]), quad(5, [0.5, 0, 1, 0.5]), quad(10, [0, 0.5, 0.5, 1]), quad(15, [0.5, 0.5, 1, 1])];
  const position = walls.flatMap((w) => w.position), uv = walls.flatMap((w) => w.uv);
  const extent = (u: ArrayLike<number>, from: number, to: number, k: 0 | 1) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = from + k; i < to; i += 2) { lo = Math.min(lo, u[i]); hi = Math.max(hi, u[i]); }
    return hi - lo;
  };

  it('gives the seen faces the room the unseen ones had', () => {
    const l = seenLayout(position, uv, [1, 1, 0, 0, 0, 0, 0, 0]);
    expect(l.applied).toBe(true);
    expect(l.seenSurface).toBeCloseTo(0.25);
    expect(l.seenTexture).toBeCloseTo(0.25);
    expect(l.gain).toBeGreaterThan(1.4);                          // the seen wall beside a column of the three shrunk ones
    expect(extent(l.uv, 0, 12, 0)).toBeCloseTo(0.5 * l.gain, 4);
    expect(extent(l.uv, 12, 24, 0)).toBeCloseTo(0.5 * l.gain * 0.3, 4);   // the unseen wall, shrunk
    for (const x of l.uv) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1); }
    // no two islands overlap: one ends before the other starts, along u or v
    const box = (from: number) => {
      const us = [], vs = [];
      for (let i = from; i < from + 12; i += 2) { us.push(l.uv[i]); vs.push(l.uv[i + 1]); }
      return [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
    };
    const boxes = [0, 12, 24, 36].map(box);
    for (let i = 0; i < 4; i++) for (let j = 0; j < i; j++) {
      const p = boxes[i], q = boxes[j];
      expect(p[1] < q[0] || q[1] < p[0] || p[3] < q[2] || q[3] < p[2]).toBe(true);
    }
    expect(layoutHash(l.uv)).not.toBe(layoutHash(uv));
  });

  it("keeps the file's layout when everything is seen", () => {
    const l = seenLayout(position, uv, [1, 1, 1, 1, 1, 1, 1, 1]);
    expect(l.applied).toBe(false);
    expect([...l.uv]).toEqual(uv.map((x) => Math.fround(x)));
  });

  it('applies triangle weights only to seen islands, using the lowest weight in each island', () => {
    // Wall 0: seen and open (weight 1). Wall 1: seen, one triangle weighted 0.5 -> whole island scales by 0.5.
    // Walls 2 and 3: unseen, carrying weight 0.5, which must not shrink them past unseenScale (0.3).
    const l = seenLayout(position, uv, [1, 1, 1, 1, 0, 0, 0, 0], { weight: [1, 1, 1, 0.5, 0.5, 0.5, 1, 1], minGain: 0 });
    expect(l.applied).toBe(true);
    expect(extent(l.uv, 0, 12, 0)).toBeCloseTo(0.5 * l.gain, 4);
    expect(extent(l.uv, 12, 24, 0)).toBeCloseTo(0.5 * l.gain * 0.5, 4);
    expect(extent(l.uv, 12, 24, 1)).toBeCloseTo(0.5 * l.gain * 0.5, 4);   // uniform across both triangles of wall 1
    expect(extent(l.uv, 24, 36, 0)).toBeCloseTo(0.5 * l.gain * 0.3, 4);   // unseen: unseenScale, not 0.3 * 0.5
    expect(extent(l.uv, 36, 48, 0)).toBeCloseTo(0.5 * l.gain * 0.3, 4);
  });
});

describe('seenCells', () => {
  it('marks the texture cells a player has a clear line to', () => {
    // a wall along x = 0 with a player on its +x side; three cells: on the wall facing the player, behind a screen, and uncovered
    const wall = new THREE.PlaneGeometry(10, 4).rotateY(Math.PI / 2).translate(0, 2, 0);
    const screen = new THREE.PlaneGeometry(1, 4).rotateY(Math.PI / 2).translate(2, 2, 3);
    const bvh = new MeshBVH(mergeGeometries([wall, screen].map((x) => x.toNonIndexed()))!);
    const pos = new Float32Array([0, 1.5, 0, 0, 0, 1.5, 3, 0, 0, 1.5, -3, 0]);
    const nrm = new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0]);
    expect([...seenCells(pos, nrm, bvh, [new THREE.Vector3(6, 1.65, 3)])]).toEqual([1, 0, 0]);
    expect([...seenCells(pos, nrm, bvh, [new THREE.Vector3(6, 1.65, 3), new THREE.Vector3(1, 1.65, 3)])]).toEqual([1, 1, 0]);
  });
});
