import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';
import { nearScaled, pagedLayout, seenLayout, uvIslands } from '../src/core/layout';
import { INDOOR_SOFT, OUTDOOR } from '../src/core/clay';
import {
  cavityScale, cellWeights, compareAoPrepass, FACE_CLASSES, faceClass, faceCurvature, faceLight, faceOpenness,
  openness4, suggestPresetsFromWeights, surfaceWeights, tracedOpenness, weightOverlayColors, weightScale, writeWeightAttribute,
} from '../src/core/surface-weights';

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

describe('faceCurvature', () => {
  it('recovers 1/R on a convex cylinder, marks flipped cylinders concave, and leaves flat planes at 0', () => {
    const r = 0.5;
    const cyl = new THREE.CylinderGeometry(r, r, 4, 32, 1, true).toNonIndexed();
    const pos = cyl.getAttribute('position').array;
    const c = faceCurvature(pos);
    for (let t = 0; t < c.raw.length; t++) {
      expect(c.raw[t]).toBeCloseTo(1 / r, 1);   // 2.0 m^-1 regardless of facet width
      expect(c.value[t]).toBeCloseTo((1 / r) / (1 / r + 1.5), 2);
      expect(c.concave[t]).toBe(0);
      expect(c.smooth[t]).toBe(1);
    }
    // Flip winding so normals point inward (a hollow pipe interior: purely concave)
    const flipped = Float32Array.from(pos);
    for (let t = 0; t < flipped.length; t += 9) {
      for (let k = 0; k < 3; k++) { const tmp = flipped[t + 3 + k]; flipped[t + 3 + k] = flipped[t + 6 + k]; flipped[t + 6 + k] = tmp; }
    }
    const inside = faceCurvature(flipped);
    for (let t = 0; t < inside.raw.length; t++) {
      expect(inside.raw[t]).toBe(0);
      expect(inside.concave[t]).toBeGreaterThan(0.5);
    }
    // Flat subdivided plane has 0 convex and 0 concave curvature everywhere
    const flat = new THREE.PlaneGeometry(10, 10, 4, 4).toNonIndexed();
    const fc = faceCurvature(flat.getAttribute('position').array);
    expect(Math.max(...fc.value)).toBe(0);
    expect(Math.max(...fc.concave)).toBe(0);
  });
});

describe('faceLight', () => {
  it('distinguishes sunlit open faces, walls in cast shadow, and enclosed crevices', () => {
    // Sun in OUTDOOR is at azimuth 45°, elevation 50° (+X, +Y, +Z side); a tall blocker at (+3, y, +3) shades (0, 0, 0).
    const floor = new THREE.PlaneGeometry(30, 30).rotateX(-Math.PI / 2).toNonIndexed();
    const blocker = new THREE.BoxGeometry(6, 10, 0.5).rotateY(-Math.PI / 4).translate(2, 5, 2).toNonIndexed();
    const sunlitPatch = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(10, 0.02, 10).toNonIndexed();
    const shadedPatch = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0.02, 0).toNonIndexed();
    const g = mergeGeometries([floor, blocker, sunlitPatch, shadedPatch])!;
    const bvh = new MeshBVH(g);
    const pos = g.getAttribute('position').array;
    const outdoor = faceLight(pos, bvh, OUTDOOR);
    const n = pos.length / 9;
    const sunlit = (outdoor.value[n - 4] + outdoor.value[n - 3]) / 2;
    const shaded = (outdoor.value[n - 2] + outdoor.value[n - 1]) / 2;
    expect(sunlit).toBeGreaterThan(0.85);
    expect(shaded).toBeLessThan(sunlit - 0.35);

    // Under indirect indoor lighting, direct sun rays are off so the blocker casts no hard sun shadow
    const indoor = faceLight(pos, bvh, INDOOR_SOFT);
    const inLit = (indoor.value[n - 4] + indoor.value[n - 3]) / 2;
    const inShaded = (indoor.value[n - 2] + indoor.value[n - 1]) / 2;
    expect(inLit - inShaded).toBeLessThan(sunlit - shaded);
  });
});

describe('faceClass and combined surfaceWeights', () => {
  it('tags floor, wall, ceiling, roof, organic and hard-surface faces and maps presets and colours', () => {
    const parts: [THREE.BufferGeometry, string][] = [
      [new THREE.PlaneGeometry(20, 20).rotateX(-Math.PI / 2), 'stone courtyard floor'],
      [new THREE.BoxGeometry(0.4, 4, 12).translate(-6, 2, 0), 'sandstone wall'],
      [new THREE.PlaneGeometry(10, 10).rotateX(Math.PI / 2).translate(0, 3.8, 0), 'plaster ceiling'],
      [new THREE.PlaneGeometry(8, 8).rotateX(-Math.PI / 2 + 0.3).translate(0, 6, -5), 'terracotta roof'],
      [new THREE.SphereGeometry(0.8, 12, 8).translate(-2, 0.8, 2), 'seated colossi statue'],
      [new THREE.CylinderGeometry(0.3, 0.3, 2.5, 16).translate(3, 1.25, -1), 'steel patrol robot'],
    ];
    const labels = parts.map(([, name]) => name);
    const geos = parts.map(([g, ], k) => {
      const n = g.toNonIndexed();
      const uv = n.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (k + uv.getX(i) * 0.85) / parts.length, uv.getY(i) * 0.85);
      n.setAttribute('label', new THREE.Float32BufferAttribute(new Float32Array(n.getAttribute('position').count).fill(k), 1));
      return n;
    });
    const geometry = mergeGeometries(geos)!;
    const bvh = new MeshBVH(geometry);
    const bounds = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute);
    const sw = surfaceWeights({ geometry, bvh, labels, bounds }, OUTDOOR);

    let offset = 0;
    const expected = ['floor', 'wall', 'ceiling', 'roof', 'organic', 'hard-surface'] as const;
    geos.forEach((g, k) => {
      const tris = g.getAttribute('position').count / 3;
      const counts = new Map<string, number>();
      for (let t = offset; t < offset + tris; t++) {
        const name = FACE_CLASSES[sw.faceClass[t]];
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      expect(dominant).toBe(expected[k]);
      offset += tris;
    });

    // Presets from names + classes
    const presets = suggestPresetsFromWeights(labels, geometry.getAttribute('label').array, sw.faceClass);
    expect(presets['sandstone wall']).toBe('limestone');
    expect(presets['seated colossi statue']).toBe('limestone');
    expect(presets['steel patrol robot']).toBe('painted-metal');

    // Weight attribute, packer scale (allowing > 1 on exposed convex features), planner UV grid and overlay colours
    const attr = writeWeightAttribute(geometry, sw.importance);
    expect(attr.length).toBe(geometry.getAttribute('position').count);
    const scale = weightScale(geometry.getAttribute('position').array, geometry.getAttribute('uv').array, sw, { minScale: 0.65, maxScale: 1.25 });
    expect(Math.max(...scale)).toBeGreaterThan(1);   // the open convex robot/statue boosts past 1
    const gridW = cellWeights(geometry.getAttribute('uv').array, sw.importance, 32);
    expect(gridW.some((x) => x > 1)).toBe(true);

    for (const kind of ['openness', 'curvature', 'light', 'class', 'importance'] as const) {
      const col = weightOverlayColors(kind, sw);
      expect(col.length).toBe(sw.importance.length * 9);
      for (const c of col) { expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThanOrEqual(1); }
    }

    // Without part names, geometric heuristics still separate floor, wall, ceiling, roof and curved props
    const unlabelled = faceClass(geometry.getAttribute('position').array, [''], undefined, { bvh });
    expect(unlabelled.shares.floor).toBeGreaterThan(0.1);
    expect(unlabelled.shares.wall).toBeGreaterThan(0.05);
    expect(unlabelled.shares.ceiling).toBeGreaterThan(0.05);
    expect(unlabelled.shares.roof).toBeGreaterThan(0.05);
  });

  it('agrees closely with ao.ts openness while running faster', () => {
    const { bvh, position } = cornerWithBox();
    const cmp = compareAoPrepass(position, bvh);
    expect(cmp.correlation).toBeGreaterThan(0.9);
    expect(cmp.meanAbsDiff).toBeLessThan(0.15);
    expect(cmp.aoValues.length).toBe(position.length / 9);
  });
});
