import { describe, expect, it } from 'vitest';
import { cutIslands, islandLimit, pagedLayout, uvIslands } from '../src/core/layout';

/** A flat rectangle w x h m at height z (two triangles), drawn 0.1 texture units a metre from (u0, v0). */
function quad(x0: number, w: number, h: number, u0: number, v0: number, label = 0) {
  const c = [[x0, 0, 0], [x0 + w, 0, 0], [x0 + w, h, 0], [x0, h, 0]];
  const order = [0, 1, 2, 0, 2, 3];
  return { position: order.flatMap((i) => c[i]), normal: order.flatMap(() => [0, 0, 1]), label: order.map(() => label),
    uv: order.flatMap((i) => [u0 + (c[i][0] - x0) * 0.1, v0 + c[i][1] * 0.1]) };
}
const join = (...q: ReturnType<typeof quad>[]) => ({ position: q.flatMap((x) => x.position), normal: q.flatMap((x) => x.normal),
  uv: q.flatMap((x) => x.uv), label: q.flatMap((x) => x.label) });
const area2 = (a: ArrayLike<number>, i: number) => Math.abs((a[i + 2] - a[i]) * (a[i + 5] - a[i + 1]) - (a[i + 4] - a[i]) * (a[i + 3] - a[i + 1])) / 2;

describe('cutIslands', () => {
  it('cuts an island longer than the limit into equal pieces, and leaves the others', () => {
    const g = join(quad(0, 4, 1, 0, 0, 3), quad(10, 1, 1, 0.6, 0, 5));   // 0.4 x 0.1 and 0.1 x 0.1 in the texture
    const c = cutIslands(g.position, g.normal, g.uv, g.label, 0.15);
    expect([c.cut, c.pieces]).toEqual([1, 3]);
    const tris = c.position.length / 9;
    expect(uvIslands(c.position, c.uv, c.cls).count).toBe(4);            // three pieces and the small one
    expect(new Set(c.cls).size).toBe(4);
    // the same surface and the same share of the texture
    let world = 0, tex = 0;
    for (let t = 0; t < tris; t++) {
      tex += area2(c.uv, 6 * t);
      const p = c.position, i = 9 * t;
      world += Math.abs((p[i + 3] - p[i]) * (p[i + 7] - p[i + 1]) - (p[i + 6] - p[i]) * (p[i + 4] - p[i + 1])) / 2;   // all in the plane z = 0
    }
    expect(world).toBeCloseTo(5, 5);
    expect(tex).toBeCloseTo(0.05, 6);
    // every piece within its third of the island, every corner where the texture says it is, labels and normals kept
    const lo = new Map<number, number>(), hi = new Map<number, number>();
    for (let t = 0; t < tris; t++) {
      for (let v = 0; v < 3; v++) {
        const u = c.uv[6 * t + 2 * v], w = c.uv[6 * t + 2 * v + 1], k = c.cls[t];
        lo.set(k, Math.min(lo.get(k) ?? Infinity, u)); hi.set(k, Math.max(hi.get(k) ?? -Infinity, u));
        if (c.label[3 * t] === 3) {
          expect(c.position[9 * t + 3 * v]).toBeCloseTo(u / 0.1, 4);
          expect(c.position[9 * t + 3 * v + 1]).toBeCloseTo(w / 0.1, 4);
        }
        expect(c.normal[9 * t + 3 * v + 2]).toBe(1);
      }
      expect([3, 5]).toContain(c.label[3 * t]);
    }
    for (const k of lo.keys()) expect(hi.get(k)! - lo.get(k)!).toBeLessThanOrEqual(0.4 / 3 + 1e-6);
  });

  it('changes nothing when no island is too long', () => {
    const g = join(quad(0, 1, 1, 0, 0), quad(5, 1, 1, 0.3, 0));
    const c = cutIslands(g.position, g.normal, g.uv, g.label, 0.2);
    expect([c.cut, c.pieces]).toEqual([0, 0]);
    expect(Array.from(c.position)).toEqual(g.position);
    expect(Array.from(c.uv).map((v) => +v.toFixed(6))).toEqual(g.uv.map((v) => +v.toFixed(6)));
  });

  it('lets the pages be filled past what the longest island allowed', () => {
    // one long face and many small ones: uncut, the long one alone sets the scale
    const g = join(quad(0, 9, 1, 0, 0), ...Array.from({ length: 40 }, (_, k) => quad(20 + 3 * k, 1, 1, (k % 9) * 0.11, 0.2 + Math.floor(k / 9) * 0.11)));
    const whole = pagedLayout(g.position, g.uv, 2);
    expect(whole.gain).toBeLessThanOrEqual(1 / 0.9);
    const limit = islandLimit(g.position, g.uv, 2);   // half a page at the scale that would fill four pages: 0.175
    const c = cutIslands(g.position, g.normal, g.uv, g.label, limit);
    expect(c.cut).toBe(1);
    expect(c.pieces).toBe(6);
    const cut = pagedLayout(c.position, c.uv, 2, undefined, undefined, c.cls);
    expect(cut.gain).toBeGreaterThan(whole.gain * 1.6);
    // and every piece lies on one page
    for (let t = 0; t < c.position.length / 9; t++) {
      const pages = new Set([0, 1, 2].map((v) => `${Math.floor(cut.uv[6 * t + 2 * v] * 2 - 1e-9)},${Math.floor(cut.uv[6 * t + 2 * v + 1] * 2 - 1e-9)}`));
      expect(pages.size).toBe(1);
    }
  });
});
