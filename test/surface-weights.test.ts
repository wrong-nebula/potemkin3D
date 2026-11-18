import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';
import { nearScaled, pagedLayout, seenLayout, uvIslands } from '../src/core/layout';
import { cavityScale, faceOpenness, openness4, tracedOpenness } from '../src/core/surface-weights';

/** Points spread over a triangle's inside, matching `faceOpenness`'s sample points so the 256-ray reference tests the ray count alone. */
const SPREAD: [number, number][] = [
  [1 / 3, 1 / 3], [0.6, 0.2], [0.2, 0.6], [0.2, 0.2], [0.45, 0.45], [0.1, 0.45], [0.45, 0.1], [0.7, 0.1], [0.1, 0.7],
  [0.3, 0.55], [0.55, 0.3], [0.15, 0.15], [0.8, 0.1], [0.1, 0.8], [0.35, 0.1], [0.1, 0.35],
];

/**
 * A floor with two walls meeting at (0, y, 0), a crate tucked into that corner with a 0.25 m slot behind it, and a
 * free-standing wall out in the open. Each part has non-overlapping UVs of its own.
 */
function cornerWithBox() {
  const parts = [
    new THREE.BoxGeometry(16, 0.3, 16, 4, 1, 4).translate(8, -0.15, 8),
    new THREE.BoxGeometry(0.3, 4, 16, 1, 2, 4).translate(-0.15, 2, 8),
    new THREE.BoxGeometry(16, 4, 0.3, 4, 2, 1).translate(8, 2, -0.15),
    new THREE.BoxGeometry(1.5, 2, 1.5).translate(1.0, 1, 1.0),   // 0.25 m from both walls
    new THREE.PlaneGeometry(3, 3).translate(10, 2, 10),          // out in the clear
  ].map((g, k) => {
    const n = g.toNonIndexed();
    const uv = n.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (k + uv.getX(i) * 0.9) / 5, uv.getY(i) * 0.9);
    return n;
  });
  const geometry = mergeGeometries(parts)!;
  return {
    geometry,
    bvh: new MeshBVH(geometry),
    position: geometry.getAttribute('position').array as Float32Array,
    uv: geometry.getAttribute('uv').array as Float32Array,
  };
}

describe('faceOpenness', () => {
  const { bvh, position } = cornerWithBox();
  const tris = position.length / 9;

  it('orders open walls, creases and narrow slots, and agrees closely with 256 rays per point', () => {
    const fast = faceOpenness(position, bvh);
    expect(fast.value.length).toBe(tris);
    expect(fast.points).toBeGreaterThan(tris);

    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3(), mid = new THREE.Vector3();
    let errSum = 0;
    const slotFaces: number[] = [], clearFaces: number[] = [], buriedFaces: number[] = [];

    for (let t = 0; t < tris; t++) {
      expect(Number.isFinite(fast.value[t])).toBe(true);
      expect(fast.value[t]).toBeGreaterThanOrEqual(0);
      expect(fast.value[t]).toBeLessThanOrEqual(1);

      a.fromArray(position, 9 * t); b.fromArray(position, 9 * t + 3); c.fromArray(position, 9 * t + 6);
      ab.subVectors(b, a); ac.subVectors(c, a);
      n.crossVectors(ab, ac);
      const area = n.length() / 2;
      n.normalize();
      mid.copy(a).add(b).add(c).divideScalar(3);

      const k = Math.max(1, Math.min(SPREAD.length, Math.round(area / 0.5)));
      let ref = 0;
      for (let i = 0; i < k; i++) {
        const p = a.clone().addScaledVector(ab, SPREAD[i][0]).addScaledVector(ac, SPREAD[i][1]);
        ref += tracedOpenness(bvh, p, n, 256);
      }
      ref /= k;
      errSum += Math.abs(fast.value[t] - ref);

      // the crate's two faces looking into the 0.25 m slot against x = 0 and z = 0
      if (mid.x > 0.1 && mid.x < 1.8 && mid.z > 0.1 && mid.z < 1.8 && mid.y > 0.2 && mid.y < 1.8 && (n.x < -0.9 || n.z < -0.9)) slotFaces.push(fast.value[t]);
      // the crate's underside sitting flat on the floor
      if (mid.x > 0.3 && mid.x < 1.7 && mid.z > 0.3 && mid.z < 1.7 && mid.y < 0.05 && n.y < -0.9) buriedFaces.push(fast.value[t]);
      // the free-standing slab out at (10, 2, 10)
      if (mid.x > 8 && mid.z > 8 && Math.abs(mid.y - 2) < 1 && n.z > 0.9) clearFaces.push(fast.value[t]);
    }

    expect(errSum / tris).toBeLessThan(0.03);
    expect(clearFaces).toEqual([1, 1]);
    expect(slotFaces.length).toBe(4);
    for (const v of slotFaces) expect(v).toBeLessThan(0.35);
    expect(buriedFaces.length).toBe(2);
    for (const v of buriedFaces) expect(v).toBeLessThan(0.15);
  });

  it('gives 1 on degenerate zero-area triangles without NaN', () => {
    const deg = new Float32Array([1, 2, 3, 1, 2, 3, 4, 2, 3]);
    const out = faceOpenness(deg, bvh);
    expect([...out.value]).toEqual([1]);
  });
});

describe('openness4', () => {
  const { bvh } = cornerWithBox();

  it('reads open space as 1, drops in a slot, and catches a thin barrier in front via the normal ray', () => {
    expect(openness4(bvh, new THREE.Vector3(8, 0.01, 8), new THREE.Vector3(0, 1, 0))).toBeCloseTo(1, 5);
    const inSlot = openness4(bvh, new THREE.Vector3(0.25, 1, 1), new THREE.Vector3(-1, 0, 0));
    expect(inSlot).toBeLessThan(0.35);
    // a thin sheet 0.3 m ahead: taps beyond 0.3 m lie behind the sheet and must count as occluded even in open air
    const sheet = new THREE.PlaneGeometry(4, 4).translate(0, 0, 0.3).toNonIndexed();
    const sheetBvh = new MeshBVH(sheet);
    expect(openness4(sheetBvh, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1))).toBeLessThan(0.4);
  });
});

describe('cavityScale', () => {
  it('maps island area-weighted openness between minScale and 1 without tearing islands', () => {
    // Island 0: a big open triangle (area 8, openness 1) joined in UV to a small crease triangle (area 0.5, openness 0.2).
    // Island 1: a slot quad elsewhere in UV (openness 0.3 <= 0.45 -> minScale).
    // Island 2: a partly enclosed quad elsewhere in UV (openness 0.625, halfway from 0.45 to 0.8 -> halfway scale).
    const position = [
      0, 0, 0, 4, 0, 0, 0, 4, 0,     // area 8
      0, 0, 0, 0, 4, 0, -0.25, 0, 0, // area 0.5, shares edge (0,0,0)-(0,4,0)
      10, 0, 0, 11, 0, 0, 10, 1, 0,  // slot
      20, 0, 0, 21, 0, 0, 20, 1, 0,  // halfway
    ];
    const uv = [
      0.1, 0.1, 0.5, 0.1, 0.1, 0.5,
      0.1, 0.1, 0.1, 0.5, 0.05, 0.1,
      0.6, 0.1, 0.7, 0.1, 0.6, 0.2,
      0.8, 0.1, 0.9, 0.1, 0.8, 0.2,
    ];
    expect(uvIslands(position, uv).count).toBe(3);
    const scale = cavityScale(position, uv, [1, 0.2, 0.3, 0.625], { minScale: 0.6, closed: 0.45, open: 0.8 });
    // Island 0's area-weighted openness is (8 * 1 + 0.5 * 0.2) / 8.5 = 0.953 >= 0.8: both triangles stay at 1
    expect(scale[0]).toBe(1);
    expect(scale[1]).toBe(1);
    expect(scale[2]).toBeCloseTo(0.6, 5);
    expect(scale[3]).toBeCloseTo(0.8, 5);
    // Degenerate threshold range (closed === open) never produces NaN
    const step = cavityScale(position, uv, [1, 0.2, 0.3, 0.625], { minScale: 0.6, closed: 0.5, open: 0.5 });
    for (const x of step) expect(Number.isFinite(x)).toBe(true);
  });

  it('gives open seen islands more texels per metre when enclosed ones shrink in both layouts', () => {
    const { bvh, position, uv } = cornerWithBox();
    const open = faceOpenness(position, bvh);
    const weight = cavityScale(position, uv, open.value, { minScale: 0.6 });
    const tris = position.length / 9;
    const seen = new Uint8Array(tris).fill(1);
    const dist = new Float32Array(tris).fill(2);

    const plainSeen = seenLayout(position, uv, seen, { minGain: 0 });
    const cavSeen = seenLayout(position, uv, seen, { weight, minGain: 0 });
    expect(cavSeen.gain).toBeGreaterThan(plainSeen.gain);

    const plainNear = pagedLayout(position, nearScaled(position, uv, dist).uv, 1);
    const cavNear = pagedLayout(position, nearScaled(position, uv, dist, { weight }).uv, 1);
    expect(cavNear.gain).toBeGreaterThan(plainNear.gain);
  });
});
