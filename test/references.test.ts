import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';
import { focusOf, pickReferences } from '../src/core/references';
import { lookAt } from '../src/core/views';

const view = (from: [number, number, number], at: [number, number, number], id: number) => ({ id, spec: lookAt(new THREE.Vector3(...from), new THREE.Vector3(...at), 90, id) });

describe('reference views', () => {
  const focus: [number, number, number] = [0, 1, 0];
  const near = view([0, 1.6, 3], [0, 1, 0], 0), far = view([0, 1.6, 9], [0, 1, 0], 1), away = view([0, 1.6, 3], [0, 1, 9], 2);
  const side = view([2, 1.6, 3], [6, 1, 0], 3);   // has the spot at the left edge of its picture

  it('are the views that look at the place, nearest first', () => {
    expect(pickReferences(focus, [far, away, near], 3).map((v) => v.id)).toEqual([0, 1]);
    expect(pickReferences(focus, [far, away, near], 1).map((v) => v.id)).toEqual([0]);
    expect(pickReferences(focus, [far, near], 0)).toEqual([]);
  });

  it('leave out a view that only has the place at the edge of its picture, or behind a wall', () => {
    expect(pickReferences(focus, [side], 3)).toEqual([]);
    const wall = new MeshBVH(new THREE.PlaneGeometry(6, 6).translate(0, 1, 1.5));   // between `near` and the spot
    expect(pickReferences(focus, [near, far], 3, wall)).toEqual([]);
    expect(pickReferences(focus, [near], 3, new MeshBVH(new THREE.PlaneGeometry(6, 6).translate(0, 1, -2))).length).toBe(1);   // a wall behind the spot is no matter
  });

  it('find where a view\'s unpainted surface is', () => {
    const pos = new Float32Array(4 * 100), unknown = new Uint8Array(100), cos = new Float32Array(100).fill(1);
    for (let i = 0; i < 100; i++) pos.set([i < 50 ? 2 : 8, 1, 0, 1], 4 * i);
    unknown.fill(1, 0, 50);
    expect(focusOf(pos, unknown, cos)).toEqual([2, 1, 0]);
    cos.fill(0.1, 0, 49);                                   // all but one seen at a graze: too little left
    expect(focusOf(pos, unknown, cos, 0.05)).toBeUndefined();
  });
});
