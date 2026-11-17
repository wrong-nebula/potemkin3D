import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { pagedGeometry, pageOf } from '../src/core/export';
import { pagedLayout, uvIslands } from '../src/core/layout';

/** Rectangles side by side in the world (each two triangles), each with its own rectangle of the texture. */
function quads(boxes: [number, number, number, number][]) {
  const position: number[] = [], uv: number[] = [];
  boxes.forEach(([u0, v0, u1, v1], k) => {
    const x = k * 3;
    position.push(x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 0, 0, x + 1, 1, 0, x, 1, 0);
    uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
  });
  return { position, uv };
}

/** A layout one texture holds: islands of several sizes, some of them across the middle lines where pages will meet. */
const boxes: [number, number, number, number][] = [
  [0.02, 0.02, 0.62, 0.42], [0.64, 0.02, 0.98, 0.3], [0.02, 0.44, 0.3, 0.98], [0.32, 0.44, 0.7, 0.7], [0.72, 0.32, 0.98, 0.7],
  [0.32, 0.72, 0.5, 0.98], [0.52, 0.72, 0.6, 0.8], [0.62, 0.72, 0.7, 0.8], [0.72, 0.72, 0.8, 0.8], [0.82, 0.72, 0.9, 0.8],
  [0.52, 0.82, 0.6, 0.9], [0.62, 0.82, 0.7, 0.9], [0.72, 0.82, 0.8, 0.9], [0.82, 0.82, 0.9, 0.9],
];

describe('pagedLayout', () => {
  for (const grid of [2, 4]) {
    it(`puts every island wholly on one of ${grid * grid} pages, all at one scale`, () => {
      const { position, uv } = quads(boxes);
      const l = pagedLayout(position, uv, grid);
      expect(l.islands).toBe(boxes.length);
      const margin = 0.003;
      const seen = new Map<number, [number, number, number, number][]>();
      boxes.forEach((b, k) => {
        const us = [0, 1, 2, 3, 4, 5].map((c) => l.uv[12 * k + 2 * c]), vs = [0, 1, 2, 3, 4, 5].map((c) => l.uv[12 * k + 2 * c + 1]);
        const u0 = Math.min(...us) * grid, u1 = Math.max(...us) * grid, v0 = Math.min(...vs) * grid, v1 = Math.max(...vs) * grid;
        // on one page, and clear of its edges by half the gap between islands
        const px = Math.floor(u0), py = Math.floor(v0);
        expect(u0 - px).toBeGreaterThanOrEqual(margin / 2 - 1e-6);
        expect(v0 - py).toBeGreaterThanOrEqual(margin / 2 - 1e-6);
        expect(u1 - px).toBeLessThanOrEqual(1 - margin / 2 + 1e-6);
        expect(v1 - py).toBeLessThanOrEqual(1 - margin / 2 + 1e-6);
        // the same shape, larger by the same factor as every other island
        expect((u1 - u0) / (b[2] - b[0])).toBeCloseTo(l.gain, 4);
        expect((v1 - v0) / (b[3] - b[1])).toBeCloseTo(l.gain, 4);
        const page = py * grid + px;
        seen.set(page, [...(seen.get(page) ?? []), [u0, v0, u1, v1]]);
      });
      // no two islands of a page overlap
      for (const list of seen.values()) {
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          expect(a[2] <= b[0] + 1e-6 || b[2] <= a[0] + 1e-6 || a[3] <= b[1] + 1e-6 || b[3] <= a[1] + 1e-6).toBe(true);
        }
      }
      // more pages: more room for each island
      expect(l.gain).toBeGreaterThan(1);
      expect(Math.max(...l.fill)).toBeLessThanOrEqual(1);
    });
  }

  it('gives four pages about twice the size along each axis, and never more than the largest island allows', () => {
    const { position, uv } = quads(boxes);
    const two = pagedLayout(position, uv, 2), four = pagedLayout(position, uv, 4);
    expect(two.gain).toBeGreaterThan(1.5);
    expect(four.gain).toBeGreaterThan(two.gain - 1e-4);   // here the widest island already fills a page of four
    expect(four.gain * 0.6).toBeLessThanOrEqual(1);   // the 0.6-wide island still has to fit one page
  });

  it('keeps the islands of a small part on one page', () => {
    const { position, uv } = quads(boxes);
    const part = boxes.flatMap((_, k) => [k >= 6 ? 7 : k, k >= 6 ? 7 : k]);   // the eight small ones are one part
    const l = pagedLayout(position, uv, 2, part);
    const pages = new Set(boxes.map((_, k) => (k >= 6 ? Math.floor(l.uv[12 * k + 1] * 2) * 2 + Math.floor(l.uv[12 * k] * 2) : -1)).filter((p) => p >= 0));
    expect(pages.size).toBe(1);
  });

  it('leaves the islands as they are found', () => {
    const { position, uv } = quads(boxes);
    const l = pagedLayout(position, uv, 2);
    expect(uvIslands(position, l.uv).count).toBe(boxes.length);
  });
});

describe('a paged level for export', () => {
  it('groups faces by page and gives them coordinates on that page', () => {
    const { position, uv } = quads(boxes);
    const l = pagedLayout(position, uv, 2);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(position.map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(l.uv, 2));
    const { geometry, pages } = pagedGeometry(g, 2);
    expect(geometry.groups.length).toBe(pages.length);
    expect(geometry.groups.reduce((s, x) => s + x.count, 0)).toBe(boxes.length * 6);
    const out = geometry.getAttribute('uv').array;
    for (const v of out) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    // a face keeps its place in the world
    expect(geometry.getAttribute('position').count).toBe(g.getAttribute('position').count);
  });

  it('cuts a map made over the whole texture to one page', () => {
    const size = 4, px = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) px[4 * (y * size + x)] = 10 * y + x;
    const k3 = pageOf(px, size, 2, 3);   // second row, second column
    expect([k3[0], k3[4], k3[8], k3[12]]).toEqual([22, 23, 32, 33]);
    expect(pageOf(px, size, 1, 0)).toBe(px);
  });
});
