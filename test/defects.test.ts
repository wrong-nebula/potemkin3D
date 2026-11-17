import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';
import { defectMap, fullDetail, POOR, UNPAINTED } from '../src/core/defects';

describe('defectMap', () => {
  // a wall along x = 0 facing +x, four texture cells on it at eye height, and a fifth no triangle covers
  const wall = new THREE.PlaneGeometry(40, 6).rotateY(Math.PI / 2).translate(0, 3, 0);
  const bvh = new MeshBVH(wall.toNonIndexed());
  const pos = new Float32Array([0, 1.65, 0, 0, 0, 1.65, 1, 0, 0, 1.65, 2, 0, 0, 1.65, 3, 0, 0, 1.65, 4, 0]);
  const nrm = new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0]);
  const near = [new THREE.Vector3(2, 1.65, 1.5)];   // a player two metres off the wall: best capture about 0.5

  it('tells unpainted cells from poorly captured ones and leaves good ones alone', () => {
    // cell 0 unpainted; cell 1 painted from 20 m (0.05); cell 2 painted from 3 m (0.33); cell 3 from 2 m (0.5)
    const d = defectMap(pos, nrm, [0, 0.05, 0.33, 0.5, 0], bvh, near);
    expect([...d.cls]).toEqual([UNPAINTED, POOR, 0, 0, 0]);
    expect(d).toMatchObject({ seen: 4, unpainted: 1, poor: 1 });
  });

  it('asks no more of a cell than the texture can hold', () => {
    // 51.2 texels per metre against 1024 view pixels per metre at 1 m: full detail from a capture quality of 0.05
    const full = fullDetail([51.2, 51.2, 51.2, 51.2, 0], 1024);
    expect(full.median).toBeCloseTo(0.05);
    // so the cell painted from 20 m is fine after all, however close the player can get
    expect([...defectMap(pos, nrm, [0, 0.05, 0.33, 0.5, 0], bvh, near, 0.4, 60, full.cells).cls]).toEqual([UNPAINTED, 0, 0, 0, 0]);
  });

  it('asks no more of a cell than a player could see of it', () => {
    // the only place to stand is 20 m off: a capture from 20 m is as good as it gets
    const far = [new THREE.Vector3(20, 1.65, 1.5)];
    expect(defectMap(pos, nrm, [0.05, 0.05, 0.05, 0.05, 0], bvh, far).poor).toBe(0);
    // and with something between the player and the cells nothing is seen, so nothing is a defect
    const screen = new THREE.PlaneGeometry(40, 6).rotateY(Math.PI / 2).translate(1, 3, 0);
    expect(defectMap(pos, nrm, [0, 0, 0, 0, 0], new MeshBVH(screen.toNonIndexed()), near).seen).toBe(0);
  });
});
