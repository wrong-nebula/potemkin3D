import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';
import { nearScaled, pagedLayout, seenDistance, stripLayout, uvIslands } from '../src/core/layout';

type V3 = [number, number, number];
const S = 0.1;   // texture units a metre

/** A flat rectangle (corners in order round it) as two triangles, drawn to scale with its first corner at `at` in the texture. */
function face(c: [V3, V3, V3, V3], at: [number, number], scale = S) {
  const [a, b, , d] = c.map((p) => new THREE.Vector3(...p));
  const ex = b.clone().sub(a), ey = d.clone().sub(a);
  const w = ex.length(), h = ey.length();
  ex.normalize(); ey.normalize();
  const uvOf = (p: V3) => { const v = new THREE.Vector3(...p).sub(a); return [at[0] + v.dot(ex) * scale, at[1] + v.dot(ey) * scale]; };
  const order = [0, 1, 2, 0, 2, 3];
  return { position: order.flatMap((i) => c[i]), uv: order.flatMap((i) => uvOf(c[i])), w, h };
}

/** A bar 0.1 x 0.1 m and 2 m long along z: four long sides and two ends, each face an island of its own. */
function bar() {
  const x = 0.1, y = 0.1, z = 2;
  const faces = [
    face([[0, 0, 0], [0, 0, z], [x, 0, z], [x, 0, 0]], [0.0, 0.0]),     // bottom
    face([[x, 0, 0], [x, 0, z], [x, y, z], [x, y, 0]], [0.0, 0.1]),     // right
    face([[x, y, 0], [x, y, z], [0, y, z], [0, y, 0]], [0.0, 0.2]),     // top
    face([[0, y, 0], [0, y, z], [0, 0, z], [0, 0, 0]], [0.0, 0.3]),     // left
    face([[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0]], [0.5, 0.0]),     // one end
    face([[0, 0, z], [x, 0, z], [x, y, z], [0, y, z]], [0.5, 0.1]),     // the other
  ];
  return { position: faces.flatMap((f) => f.position), uv: faces.flatMap((f) => f.uv) };
}

const edge = (a: ArrayLike<number>, i: number, j: number, n: number) => {
  let s = 0;
  for (let k = 0; k < n; k++) s += (a[i + k] - a[j + k]) ** 2;
  return Math.sqrt(s);
};

describe('stripLayout', () => {
  it("joins a bar's four sides into one band and leaves its ends", () => {
    const { position, uv } = bar();
    const l = stripLayout(position, uv, undefined, 1);
    expect(l.before).toBe(6);
    expect(l.strips).toBe(1);
    expect(l.joined).toBe(4);
    expect(l.islands).toBe(3);
    expect(uvIslands(position, l.uv).count).toBe(3);
    // nothing is stretched: every edge is as long in the texture as on the bar, to scale
    for (let t = 0; t < position.length / 9; t++) {
      for (const [p, q] of [[0, 1], [1, 2], [2, 0]]) {
        expect(edge(l.uv, 6 * t + 2 * p, 6 * t + 2 * q, 2)).toBeCloseTo(edge(position, 9 * t + 3 * p, 9 * t + 3 * q, 3) * S, 5);
      }
    }
    // the band is the bar's girth by its length
    const us: number[] = [], vs: number[] = [];
    for (let i = 0; i < 4 * 12; i += 2) { us.push(l.uv[i]); vs.push(l.uv[i + 1]); }
    const size = [Math.max(...us) - Math.min(...us), Math.max(...vs) - Math.min(...vs)].sort((a, b) => a - b);
    expect(size[0]).toBeCloseTo(0.4 * S, 5);
    expect(size[1]).toBeCloseTo(2 * S, 5);
    // and its faces do not lie over each other: the band's area is the four sides' area
    let area = 0;
    for (let t = 0; t < 8; t++) {
      const q = 6 * t;
      area += Math.abs((l.uv[q + 2] - l.uv[q]) * (l.uv[q + 5] - l.uv[q + 1]) - (l.uv[q + 4] - l.uv[q]) * (l.uv[q + 3] - l.uv[q + 1])) / 2;
    }
    expect(area).toBeCloseTo(size[0] * size[1], 6);
  });

  it('joins only faces of one part, drawn at one scale, and never past the longest allowed', () => {
    const two = (scale2 = S) => {
      const a = face([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], [0, 0]);
      const b = face([[1, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0]], [0.5, 0], scale2);
      return { position: [...a.position, ...b.position], uv: [...a.uv, ...b.uv] };
    };
    const g = two();
    expect(stripLayout(g.position, g.uv, undefined, 1).islands).toBe(1);
    expect(stripLayout(g.position, g.uv, [0, 0, 1, 1], 1).islands).toBe(2);       // two parts
    expect(stripLayout(g.position, g.uv, undefined, 0.15).islands).toBe(2);       // 2 m at this scale is 0.2: too long
    const h = two(S / 2);
    expect(stripLayout(h.position, h.uv, undefined, 1).islands).toBe(2);          // one drawn at half the scale
  });

  it('packs to more room than the faces had apart', () => {
    const { position, uv } = bar();
    const apart = pagedLayout(position, uv, 1), joined = pagedLayout(position, stripLayout(position, uv, undefined, 1).uv, 1);
    expect(joined.islands).toBe(3);
    expect(joined.gain).toBeGreaterThanOrEqual(apart.gain - 1e-6);
  });
});

describe('seenDistance and nearScaled', () => {
  it('measures how near an eye gets to what it sees', () => {
    const floor = new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2);
    const crate = new THREE.BoxGeometry(2, 3, 2).translate(0, 1.5, 0);
    const g = mergeGeometries([floor, crate].map((x) => x.toNonIndexed()))!;
    const position = g.getAttribute('position').array;
    const d = seenDistance(position, new MeshBVH(g), [new THREE.Vector3(6, 1.65, 0)]);
    const normal = (t: number) => {
      const a = new THREE.Vector3().fromArray(position, 9 * t), b = new THREE.Vector3().fromArray(position, 9 * t + 3), c = new THREE.Vector3().fromArray(position, 9 * t + 6);
      return b.sub(a).cross(c.sub(a)).normalize();
    };
    for (let t = 2; t < position.length / 9; t++) {
      const n = normal(t);
      if (n.x > 0.9) { expect(d[t]).toBeGreaterThan(4.5); expect(d[t]).toBeLessThan(6); }   // the side facing the eye, 5 m off
      if (n.x < -0.9) expect(d[t]).toBe(Infinity);                                           // the side behind
    }
    expect(Math.min(d[0], d[1])).toBeLessThan(8);   // the floor
  });

  it('draws islands smaller the further off their nearest onlooker is', () => {
    const a = face([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], [0, 0]);
    const b = face([[5, 0, 0], [6, 0, 0], [6, 1, 0], [5, 1, 0]], [0.3, 0]);
    const c = face([[9, 0, 0], [10, 0, 0], [10, 1, 0], [9, 1, 0]], [0.6, 0]);
    const position = [...a.position, ...b.position, ...c.position], uv = [...a.uv, ...b.uv, ...c.uv];
    const l = nearScaled(position, uv, [2, 2, 6, 12, Infinity, Infinity], { near: 3, farScale: 0.3, unseenScale: 0.2 });
    const width = (k: number) => { const us = [0, 1, 2, 3, 4, 5].map((i) => l.uv[12 * k + 2 * i]); return Math.max(...us) - Math.min(...us); };
    expect(width(0)).toBeCloseTo(0.1, 6);           // within reach: as it was
    expect(width(1)).toBeCloseTo(0.05, 6);          // nearest eye 6 m off: half
    expect(width(2)).toBeCloseTo(0.02, 6);          // unseen
    expect([l.islands, l.full, l.unseen]).toEqual([3, 1, 1]);

    // `weight` shrinks seen islands further (lowest weight in the island wins) and leaves unseen islands at unseenScale
    const w = nearScaled(position, uv, [2, 2, 6, 12, Infinity, Infinity],
      { near: 3, farScale: 0.3, unseenScale: 0.2, weight: [1, 0.7, 0.8, 1, 0.5, 0.5] });
    const wWidth = (k: number) => { const us = [0, 1, 2, 3, 4, 5].map((i) => w.uv[12 * k + 2 * i]); return Math.max(...us) - Math.min(...us); };
    expect(wWidth(0)).toBeCloseTo(0.07, 6);         // near, weighted by min(1, 0.7)
    expect(wWidth(1)).toBeCloseTo(0.04, 6);         // 0.5 * min(0.8, 1)
    expect(wWidth(2)).toBeCloseTo(0.02, 6);         // unseen: still unseenScale (0.2), not 0.2 * 0.5
    expect([w.islands, w.full, w.unseen]).toEqual([3, 0, 1]);
  });
});
