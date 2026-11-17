import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';
import { aoImage, finishAo, hemisphere, openness, withOcclusion, type AoMap } from '../src/core/ao';
import { pickSwatches, wantsSwatches } from '../src/core/swatches';

/** A floor with a tall wall along x = 0. */
function world() {
  const floor = new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2);
  const wall = new THREE.BoxGeometry(0.2, 6, 40).translate(-0.1, 3, 0);
  return new MeshBVH(mergeGeometries([floor, wall].map((g) => g.toNonIndexed()))!);
}

describe('hemisphere', () => {
  it('gives unit directions on the upper side, more of them near the pole', () => {
    const d = hemisphere(64);
    let up = 0;
    for (let i = 0; i < 64; i++) {
      expect(Math.hypot(d[3 * i], d[3 * i + 1], d[3 * i + 2])).toBeCloseTo(1, 5);
      expect(d[3 * i + 2]).toBeGreaterThan(0);
      up += d[3 * i + 2];
    }
    expect(up / 64).toBeCloseTo(2 / 3, 1);   // the mean height of a cosine-weighted hemisphere
  });
});

describe('openness', () => {
  const bvh = world();
  const dirs = hemisphere(48);
  const up = new THREE.Vector3(0, 1, 0);

  it('is 1 out in the open', () => {
    expect(openness(bvh, new THREE.Vector3(10, 0, 0), up, dirs, 2.5)).toBe(1);
  });

  it('drops at the foot of a wall, and less so a step away from it', () => {
    const foot = openness(bvh, new THREE.Vector3(0.1, 0, 0), up, dirs, 2.5);
    const near = openness(bvh, new THREE.Vector3(1, 0, 0), up, dirs, 2.5);
    expect(foot).toBeLessThan(0.75);
    expect(near).toBeGreaterThan(foot);
    expect(near).toBeLessThan(1);
    expect(openness(bvh, new THREE.Vector3(3, 0, 0), up, dirs, 2.5)).toBe(1);   // beyond the radius the wall no longer counts
  });

  it('does not depend much on how the ray set is turned', () => {
    const a = openness(bvh, new THREE.Vector3(0.5, 0, 0), up, dirs, 2.5, 0);
    const b = openness(bvh, new THREE.Vector3(0.5, 0, 0), up, dirs, 2.5, 1.3);
    expect(Math.abs(a - b)).toBeLessThan(0.08);
  });
});

describe('finishAo', () => {
  it('carries baked values into the gutter and leaves the rest open', () => {
    const size = 16;
    const value = new Float32Array(size * size), baked = new Uint8Array(size * size);
    for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) { value[y * size + x] = 0.5; baked[y * size + x] = 1; }
    const out = finishAo(value, baked, size, 2);
    expect(out[5 * size + 5]).toBe(128);          // inside the island
    expect(out[5 * size + 9]).toBe(128);          // two texels out: the gutter
    expect(out[5 * size + 12]).toBe(255);         // further out: untouched
  });
});

describe('withOcclusion', () => {
  it('writes the occlusion into R and leaves roughness and metalness alone', () => {
    const ao: AoMap = { size: 2, data: Uint8ClampedArray.from([0, 0, 255, 255]), rays: 1, radius: 1, seconds: 0 };
    const orm = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < 16; i++) orm.set([255, 200, 0, 255], 4 * i);
    const out = withOcclusion(orm, 4, ao);
    expect(out[0]).toBe(0);                        // top row: occluded
    expect(out[4 * 12]).toBe(255);                 // bottom row: open
    expect(out[4 * 4]).toBeGreaterThan(0);         // in between: blended
    expect(out[4 * 4]).toBeLessThan(255);
    expect([out[1], out[2], out[3]]).toEqual([200, 0, 255]);
    expect(orm[0]).toBe(255);                      // the input is not changed
    expect(Array.from(aoImage(ao).slice(0, 4))).toEqual([0, 0, 0, 255]);
  });
});

describe('material swatches', () => {
  /** A 240 px texture: three painted squares of different colours and one unpainted quarter. */
  function texture() {
    const size = 240, data = new Uint8ClampedArray(size * size * 4);
    const fill = (x0: number, y0: number, c: [number, number, number]) => {
      for (let y = y0; y < y0 + 120; y++) for (let x = x0; x < x0 + 120; x++) data.set([...c, 255], 4 * (y * size + x));
    };
    fill(0, 0, [200, 160, 90]); fill(120, 0, [120, 120, 120]); fill(0, 120, [90, 60, 40]);
    return { data, size };
  }

  it('picks squares that are painted throughout, not on top of each other', () => {
    const { data, size } = texture();
    const side = 96;
    const at = pickSwatches(data, size, side);
    expect(at.length).toBeGreaterThanOrEqual(2);
    expect(at.length).toBeLessThanOrEqual(4);
    for (const [x, y] of at) {
      for (const [dx, dy] of [[0, 0], [side - 1, 0], [0, side - 1], [side - 1, side - 1]]) expect(data[4 * ((y + dy) * size + x + dx) + 3]).toBe(255);
    }
    for (let i = 0; i < at.length; i++) {
      for (let j = i + 1; j < at.length; j++) expect(Math.abs(at[i][0] - at[j][0]) >= side || Math.abs(at[i][1] - at[j][1]) >= side).toBe(true);
    }
  });

  it('finds none in an empty texture', () => {
    expect(pickSwatches(new Uint8ClampedArray(64 * 64 * 4), 64, 24)).toEqual([]);
  });

  it('only gives a reference to views with enough in them', () => {
    expect(wantsSwatches([0.3, 0.3, 0.2])).toBe(true);
    expect(wantsSwatches([0.28, 0.26])).toBe(true);        // two walls and sky
    expect(wantsSwatches([0.71, 0.29])).toBe(false);       // one blank wall and a strip of ground
    expect(wantsSwatches([0.7, 0.1, 0.1])).toBe(false);    // one face fills the frame
    expect(wantsSwatches([0.4])).toBe(false);
  });
});
