import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { matchCorners, normalised, partMesh, pickParts, toGlb } from '../src/core/partpass';

/** Two triangles labelled 0 and one labelled 1, behind an index that puts the part-1 triangle in the middle. */
function level() {
  const g = new THREE.BufferGeometry();
  const pos = [0, 0, 0, 1, 0, 0, 0, 1, 0, /* */ 5, 0, 0, 6, 0, 0, 5, 1, 0, /* */ 0, 0, 2, 1, 0, 2, 0, 1, 2];
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(27).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0.1, 0, 0, 0.1, 0.5, 0.5, 0.6, 0.5, 0.5, 0.6, 0.2, 0.2, 0.3, 0.2, 0.2, 0.3], 2));
  g.setAttribute('label', new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 1, 0, 0, 0], 1));
  g.setIndex([6, 7, 8, 3, 4, 5, 0, 1, 2]);
  return g;
}

describe('partMesh', () => {
  it("takes a part's triangles, in the order the level has them, with their place in the level's texture", () => {
    const m = partMesh(level(), 0);
    expect(m.position.length).toBe(18);
    expect([...m.position.slice(0, 3)]).toEqual([0, 0, 2]);          // the index's first triangle comes first
    expect([...m.uv.slice(0, 2)].map((v) => +v.toFixed(2))).toEqual([0.2, 0.2]);
    expect(partMesh(level(), 1).position.length).toBe(9);
  });
});

describe('toGlb', () => {
  it('writes a binary glTF that says what it holds', () => {
    const m = partMesh(level(), 0);
    const glb = toGlb(m.position, m.normal);
    const view = new DataView(glb);
    expect(view.getUint32(0, true)).toBe(0x46546c67);                 // 'glTF'
    expect(view.getUint32(8, true)).toBe(glb.byteLength);
    const jsonLength = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength)));
    expect(json.accessors[0]).toMatchObject({ count: 6, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 2] });
    expect(json.accessors[2].count).toBe(6);
    const positions = new Float32Array(glb.slice(28 + jsonLength, 28 + jsonLength + 72));
    expect([...positions]).toEqual([...m.position]);
  });
});

describe('matchCorners', () => {
  const ours = partMesh(level(), 0).position;

  it('takes the same triangles in the same order as they are, however moved and scaled', () => {
    const theirs = ours.map((v, i) => v * 0.37 + [4, -2, 9][i % 3]);
    const m = matchCorners(ours, theirs);
    expect(m.exact).toBe(true);
    expect([...m.corner]).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('matches by position when triangles came back in another order', () => {
    const theirs = new Float32Array([...ours.slice(9), ...ours.slice(0, 9)]).map((v) => v * 2);   // the two triangles swapped
    const m = matchCorners(ours, theirs);
    expect(m.exact).toBe(false);
    expect([...m.corner]).toEqual([3, 4, 5, 0, 1, 2]);
    expect(m.worst).toBeLessThan(1e-6);
  });

  it('normalises to the bounding box', () => {
    const n = normalised([0, 0, 0, 4, 2, 0]);
    expect([...n]).toEqual([-0.5, -0.25, 0, 0.5, 0.25, 0]);
  });
});

describe('pickParts', () => {
  const stats = [
    { label: 0, seen: 1000, unpainted: 300, area: 900, triangles: 400 },   // a wall: much unpainted, but most of the level
    { label: 1, seen: 200, unpainted: 60, area: 20, triangles: 180 },      // stairs
    { label: 2, seen: 400, unpainted: 80, area: 15, triangles: 60 },       // beams
    { label: 3, seen: 300, unpainted: 6, area: 10, triangles: 40 },        // a table that is nearly done
    { label: 4, seen: 5, unpainted: 5, area: 1, triangles: 12 },           // barely seen
    { label: 5, seen: 500, unpainted: 200, area: 19, triangles: 4 },       // a small house blocked out as a few big faces
  ];

  it('picks parts with a fair share unpainted, most unpainted first, and leaves the scenery to the painting', () => {
    expect(pickParts(stats, 1000, 6)).toEqual([2, 1]);
    expect(pickParts(stats, 1000, 1)).toEqual([2]);
  });
});
