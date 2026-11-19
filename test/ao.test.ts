import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';
import {
  aoImage,
  bakeFastSdf,
  bentNormalImage,
  bentSpecularOcclusion,
  buildFastContactBvh,
  compareAoMethods,
  contactHitDistance,
  decodeBentNormalImage,
  fastSdfTracedOpenness,
  finishAo,
  hemisphere,
  openness,
  sampleFastSdf,
  withOcclusion,
  type AoMap,
} from '../src/core/ao';
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

describe('Fast-SDF-AO (Lipschitz isotropic R16F SDF + quantized SAH Contact BVH + Halton(2,3))', () => {
  it('bakes an exact 1-Lipschitz-culled signed SDF for watertight geometry and unsigned SDF for open shells', () => {
    const box = new THREE.BoxGeometry(2, 2, 2).toNonIndexed();
    const vol = bakeFastSdf(box, { maxRes: 48, reach: 1.12, signed: true });
    expect(vol.signed).toBe(true);
    // Centre of [-1, 1]^3 box is 1.0 m inside -> negative distance ~ -1.0
    expect(sampleFastSdf(vol, 0, 0, 0)).toBeLessThan(-0.85);
    // Point 0.5 m outside +X face (x = 1.5, y = 0, z = 0) -> exact distance ~ +0.5
    expect(sampleFastSdf(vol, 1.5, 0, 0)).toBeCloseTo(0.5, 1);
    // Far-space blocks are culled via 1-Lipschitz bounds
    expect(vol.stats.culledVoxels).toBeGreaterThan(0);
  });

  it('resolves 4 cm thin plates and avoids false occlusion from thin bars behind unclosed blockout walls', () => {
    // Open single-sided wall at z = 0 facing +Z, with a thin 4 cm bar 15 cm BEHIND it (z = -0.15)
    // and another 4 cm overhang bar IN FRONT of it at (x = 2, y = 1.2, z = +0.18)
    const wall = new THREE.PlaneGeometry(8, 4).translate(0, 2, 0);
    const backBar = new THREE.BoxGeometry(0.04, 4, 0.04).translate(-2, 2, -0.15);
    const frontPlate = new THREE.BoxGeometry(1.5, 0.04, 0.4).translate(2, 1.2, 0.2);
    const merged = mergeGeometries([wall, backBar, frontPlate].map((g) => g.toNonIndexed()))!;
    const bvh = new MeshBVH(merged);

    const vol = bakeFastSdf(merged, { maxRes: 128, reach: 1.12 });
    const cbvh = buildFastContactBvh(merged, { gridSize: 1.0, range: 0.35, bias: 0.0003 });

    // Contact ray straight into frontPlate from (2, 1.05, 0.2) along +Y hits at ~0.13 m
    const hitDist = contactHitDistance(cbvh, 2, 1.05, 0.2, 0, 1, 0, 0, 1, 0, 0.35);
    expect(hitDist).toBeCloseTo(0.13, 2);

    // Point on front of open wall right in front of `backBar` (-2, 2, 0, normal +Z): ZERO occlusion (open = 1.0)!
    const bent = new Float32Array(3);
    const openInFrontOfBackBar = fastSdfTracedOpenness(vol, cbvh, -2, 2, 0, 0, 0, 1, {
      rays: 32,
      radius: 1.12,
      falloff: 'linear',
      outBent: bent,
    });
    expect(openInFrontOfBackBar).toBeGreaterThan(0.97);
    expect(bent[2]).toBeGreaterThan(0.95);

    // Point tucked directly under `frontPlate` on the wall (2, 1.05, 0, normal +Z): strongly occluded, bent normal tilts -Y!
    const bentUnder = new Float32Array(3);
    const openUnderOverhang = fastSdfTracedOpenness(vol, cbvh, 2, 1.05, 0, 0, 0, 1, {
      rays: 32,
      radius: 1.12,
      falloff: 'linear',
      outBent: bentUnder,
    });
    const gtUnder = openness(bvh, new THREE.Vector3(2, 1.05, 0), new THREE.Vector3(0, 0, 1), hemisphere(256), 1.12);
    expect(openUnderOverhang).toBeLessThan(0.85);
    expect(Math.abs(openUnderOverhang - gtUnder)).toBeLessThan(0.04);
    expect(bentUnder[1]).toBeLessThan(-0.08);
  });

  it('matches 256-ray exact BVH ground truth closely across open, corner and overhang sample points', () => {
    const bvh = world();
    const pts: { position: THREE.Vector3; normal: THREE.Vector3 }[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3(1, 0, 0);
    for (const x of [0.05, 0.12, 0.25, 0.5, 0.9, 1.6, 3.0, 6.0]) {
      for (const z of [-6, -2, 0, 2, 6]) {
        pts.push({ position: new THREE.Vector3(x, 0, z), normal: up });
      }
    }
    for (const y of [0.08, 0.25, 0.6, 1.2, 2.5]) {
      pts.push({ position: new THREE.Vector3(0, y, 0), normal: right });
    }
    const cmp = compareAoMethods(bvh, pts, { radius: 2.5, rays: 24, gridRes: 128, falloff: 'linear' });
    expect(cmp.fastSdfTraced.correlation).toBeGreaterThan(0.96);
    expect(cmp.fastSdfTraced.mae).toBeLessThan(0.035);
  });

  it('encodes/decodes bent_normal.png with gutter dilation and computes Jimenez cone specular occlusion', () => {
    const s = 8;
    const data = new Uint8ClampedArray(s * s).fill(180);
    const bentNormals = new Float32Array(s * s * 3);
    // Island interior at [2..5, 2..5] tilted toward an open side portal (0.6, 0.8, 0.0)
    for (let y = 2; y <= 5; y++) {
      for (let x = 2; x <= 5; x++) {
        const i = 3 * (y * s + x);
        bentNormals[i] = 0.6;
        bentNormals[i + 1] = 0.8;
        bentNormals[i + 2] = 0;
      }
    }
    const ao: AoMap = { size: s, data, rays: 24, radius: 2.5, seconds: 0.01, bentNormals };
    const img = bentNormalImage(ao, 2)!;
    expect(img).toBeDefined();
    // 1-texel gutter outside island (x = 1, y = 3) receives dilated portal direction instead of neutral [128, 255, 128]
    const gutterIdx = 4 * (3 * s + 1);
    expect(img[gutterIdx]).toBeGreaterThan(180);

    const decoded = decodeBentNormalImage(img, s);
    const insideIdx = 3 * (3 * s + 3);
    expect(decoded[insideIdx]).toBeCloseTo(0.6, 1);
    expect(decoded[insideIdx + 1]).toBeCloseTo(0.8, 1);

    // Specular reflection aligned with open bent cone stays bright (~1.0); reflection into occluded ceiling is attenuated!
    const openSpec = bentSpecularOcclusion([0.6, 0.8, 0], [0.6, 0.8, 0], 0.2);
    const blockedSpec = bentSpecularOcclusion([-0.6, -0.8, 0], [0.6, 0.8, 0], 0.2);
    expect(openSpec).toBeGreaterThan(0.98);
    expect(blockedSpec).toBeLessThan(0.2);
  });
});
