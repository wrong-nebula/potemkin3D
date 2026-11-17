import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';
import { boundsOf, propCameras, propGroups } from '../src/core/proppass';

describe('prop cameras', () => {
  // a crate 1 m across standing at the origin, and a wall 2 m to its north (z = -2)
  const crate = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const wall = new THREE.PlaneGeometry(12, 4).translate(0, 2, -2);
  const box = boundsOf(crate.getAttribute('position').array);
  const ring = (r: number, n: number) => Array.from({ length: n }, (_, k) => new THREE.Vector3(r * Math.sin((k / n) * 2 * Math.PI), 1.6, r * Math.cos((k / n) * 2 * Math.PI)));

  it('stand round the prop, spread apart, each looking at it', () => {
    const bvh = new MeshBVH(crate);
    const cams = propCameras(box, [...ring(3, 12), new THREE.Vector3(0, 1.6, 30), new THREE.Vector3(0.3, 1.6, 0.4)], bvh, 3);
    expect(cams.length).toBe(3);
    for (const c of cams) expect(Math.hypot(c.position[0], c.position[2])).toBeCloseTo(3, 1);   // not the far spot, not the one on top of it
    const az = cams.map((c) => Math.atan2(c.position[0], c.position[2]));
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      expect(Math.abs(Math.atan2(Math.sin(az[i] - az[j]), Math.cos(az[i] - az[j])))).toBeGreaterThan(THREE.MathUtils.degToRad(80));   // front, back and a side
    }
    expect(cams[0].pitch).toBeLessThan(0);          // looking down at it from eye height
    expect(cams[0].fov).toBeGreaterThan(30);
    expect(cams[0].fov).toBeLessThan(60);
  });

  it('skip spots a wall hides the prop from, and give fewer cameras when there are no more sides to see', () => {
    const both = new THREE.BufferGeometry();
    const a = crate.toNonIndexed().getAttribute('position').array, b = wall.toNonIndexed().getAttribute('position').array;
    both.setAttribute('position', new THREE.BufferAttribute(new Float32Array([...a, ...b]), 3));
    const cams = propCameras(box, ring(3, 12), new MeshBVH(both), 4);
    for (const c of cams) expect(c.position[2]).toBeGreaterThan(-2);   // none from behind the wall
    expect(propCameras(box, [new THREE.Vector3(0, 1.6, 3), new THREE.Vector3(0.4, 1.6, 3)], new MeshBVH(crate), 3).length).toBe(1);
    expect(propCameras(box, [], new MeshBVH(crate), 3)).toEqual([]);
  });
});

describe('prop cameras that are told what the prop is made of', () => {
  // a crate at the origin and a screen 1.2 m high and 3 m wide standing 1 m south of it: it hides the crate from the south
  const crate = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const screen = new THREE.BoxGeometry(3, 2.4, 0.1).translate(0, 1.2, 1);
  const soup = (g: THREE.BufferGeometry) => g.toNonIndexed().getAttribute('position').array as Float32Array;
  const both = new THREE.BufferGeometry();
  both.setAttribute('position', new THREE.BufferAttribute(new Float32Array([...soup(crate), ...soup(screen)]), 3));
  const box = boundsOf(soup(crate));
  const eyes = Array.from({ length: 12 }, (_, k) => new THREE.Vector3(3 * Math.sin((k / 12) * 2 * Math.PI), 1.6, 3 * Math.cos((k / 12) * 2 * Math.PI)));

  it('leave out the spots that see too little of it', () => {
    const samples = propGroups([{ label: 0, position: soup(crate) }])[0].samples;
    const cams = propCameras(box, eyes, new MeshBVH(both), 4, samples);
    expect(cams.length).toBeGreaterThan(0);
    for (const c of cams) expect(c.position[2]).toBeLessThan(2.2);   // none from due south, behind the screen
  });
});

describe('props gathered from parts', () => {
  const at = (x: number, z: number, s = 1) => new THREE.BoxGeometry(s, s, s).translate(x, s / 2, z).toNonIndexed().getAttribute('position').array as Float32Array;
  const join = (...a: Float32Array[]) => new Float32Array(a.flatMap((x) => [...x]));

  it('makes two props of one part that stands in two places, and one of two parts that touch', () => {
    const drums = join(at(0, 0), at(1.2, 0), at(20, 0), at(21.2, 0));   // two pairs, 0.2 m apart within a pair
    const lorry = at(0, 10, 2), tyres = at(1.3, 10, 0.6);             // a small part against a large one
    const groups = propGroups([{ label: 3, position: drums }, { label: 5, position: lorry }, { label: 6, position: tyres }]);
    expect(groups.length).toBe(3);
    expect(groups[0].labels).toEqual([5, 6]);                         // the larger surface names it
    expect(groups.filter((g) => g.labels[0] === 3).length).toBe(2);
    for (const g of groups) expect(g.samples.length).toBeGreaterThan(0);
  });

  it('leaves out what is too small for cameras of its own', () => {
    expect(propGroups([{ label: 0, position: at(0, 0, 0.3) }])).toEqual([]);
  });
});
