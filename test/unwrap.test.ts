import fs from 'node:fs';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { uvIslands } from '../src/core/layout';
import { loadLevel } from '../src/core/scene';
import { atlasMeshes, partitionUvCharts, unwrap, uvHealth, type XatlasRunner } from '../src/core/unwrap';
import { nodeXatlas } from './xatlas-node';

/** Triangles of some boxes and a floor (non-indexed, world space), each a part of its own, with three.js's UVs. */
function blockout() {
  const parts = [
    new THREE.PlaneGeometry(20, 20, 4, 4).rotateX(-Math.PI / 2),
    new THREE.BoxGeometry(2, 3, 2).translate(0, 1.5, 0),
    new THREE.BoxGeometry(4, 1, 1).translate(5, 0.5, -3),
    new THREE.CylinderGeometry(0.5, 0.5, 2, 16).translate(-4, 1, 4),
  ].map((g, k) => {
    const n = g.toNonIndexed();
    n.setAttribute('label', new THREE.Float32BufferAttribute(new Float32Array(n.getAttribute('position').count).fill(k), 1));
    return n;
  });
  const g = mergeGeometries(parts)!;
  return { position: g.getAttribute('position').array as Float32Array, uv: g.getAttribute('uv').array as Float32Array,
    label: g.getAttribute('label').array as Float32Array };
}

/** World area over texture area per triangle: texels per square metre, up to a constant. */
function density(position: ArrayLike<number>, uv: ArrayLike<number>) {
  const out: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < position.length / 9; t++) {
    a.fromArray(position, 9 * t); b.fromArray(position, 9 * t + 3); c.fromArray(position, 9 * t + 6);
    const world = b.sub(a).cross(c.sub(a)).length() / 2;
    const q = 6 * t;
    const tex = Math.abs((uv[q + 2] - uv[q]) * (uv[q + 5] - uv[q + 1]) - (uv[q + 4] - uv[q]) * (uv[q + 3] - uv[q + 1])) / 2;
    if (world > 1e-6) out.push(tex / world);
  }
  return out;
}

const median = (x: number[]) => [...x].sort((p, q) => p - q)[Math.floor(x.length / 2)];

describe('uvHealth', () => {
  it('passes UVs laid out without overlaps', () => {
    // one quad per half of the square
    const position = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 2, 1, 0, 2, 1, 1, 2, 0, 0, 2, 1, 1, 2, 0, 1, 2];
    const uv = [0, 0, 0.45, 0, 0.45, 1, 0, 0, 0.45, 1, 0, 1, 0.55, 0, 1, 0, 1, 1, 0.55, 0, 1, 1, 0.55, 1];
    const h = uvHealth(position, uv, 128);
    expect(h.problem).toBeUndefined();
    expect(h.overlap).toBe(0);
  });

  it('finds missing, collapsed, tiling and stacked UVs', () => {
    const { position, uv } = blockout();
    expect(uvHealth(position, new Float32Array(uv.length)).missing).toBe(true);
    expect(uvHealth(position, uv, 256, true).problem).toBe('no texture coordinates');
    // three.js gives every part the whole square: they are stacked on each other
    const stacked = uvHealth(position, uv, 256);
    expect(stacked.overlap).toBeGreaterThan(0.5);
    expect(stacked.problem).toMatch(/overlapping/);
    const tiled = uvHealth(position, uv.map((x) => x * 4), 256);
    expect(tiled.outside).toBeGreaterThan(0.5);
    expect(tiled.problem).toMatch(/tiling/);
    const flat = Float32Array.from(uv);
    for (let t = 0; t < flat.length / 6; t += 2) for (let c = 0; c < 6; c++) flat[6 * t + c] = 0.5;
    expect(uvHealth(position, flat, 256).degenerate).toBeGreaterThan(0.3);
  });
});

describe('atlasMeshes', () => {
  it('welds corners per part and splits a part over meshes when it has too many vertices', () => {
    const { position, label } = blockout();
    const meshes = atlasMeshes(position, label);
    expect(meshes.length).toBe(4);
    // the floor's 4 x 4 grid has 25 corners, a box's 8 are joined across faces
    expect(meshes[0].vertices.length / 3).toBe(25);
    expect(meshes[1].vertices.length / 3).toBe(8);
    const all = meshes.flatMap((m) => [...m.triangles]).sort((a, b) => a - b);
    expect(all).toEqual([...Array(position.length / 9).keys()]);
    const small = atlasMeshes(position, label, 10);
    expect(small.length).toBeGreaterThan(4);
    for (const m of small) expect(m.vertices.length / 3).toBeLessThanOrEqual(10);
    // every triangle still lands in exactly one mesh, with its own corners
    expect(small.flatMap((m) => [...m.triangles]).sort((a, b) => a - b)).toEqual(all);
    for (const m of small) {
      for (let f = 0; f < m.triangles.length; f++) {
        for (let c = 0; c < 3; c++) {
          const v = m.index[3 * f + c], p = 9 * m.triangles[f] + 3 * c;
          expect(m.vertices[3 * v]).toBeCloseTo(position[p], 4);
          expect(m.vertices[3 * v + 2]).toBeCloseTo(position[p + 2], 4);
        }
      }
    }
  });
});

describe('unwrap (xatlas)', () => {
  let run: XatlasRunner;
  beforeAll(async () => { run = await nodeXatlas(); });

  it('lays out a blockout with stacked UVs into charts that are healthy and evenly dense', async () => {
    const { position, label } = blockout();
    const u = await unwrap(position, label, run);
    expect(u.uv.length).toBe(position.length / 9 * 6);
    for (const x of u.uv) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1); }
    const h = uvHealth(position, u.uv, 512);
    expect(h.problem).toBeUndefined();
    expect(h.overlap).toBe(0);
    expect(u.fill).toBeGreaterThan(0.4);
    // parts of different sizes get the same texels per metre: no face is far off the median
    const d = density(position, u.uv), m = median(d);
    const off = d.filter((x) => x < m / 2 || x > m * 2).length / d.length;
    expect(off).toBeLessThan(0.05);
    // no chart spans two parts
    const { of } = uvIslands(position, u.uv);
    const partOf = new Map<number, number>();
    for (let t = 0; t < of.length; t++) {
      const p = partOf.get(of[t]);
      if (p === undefined) partOf.set(of[t], label[3 * t]); else expect(p).toBe(label[3 * t]);
    }
    expect(u.charts).toBe(partOf.size);
  });

  it('gives the same layout for the same level', async () => {
    const { position, label } = blockout();
    const a = await unwrap(position, label, run), b = await unwrap(position, label, run);
    expect(b.uv).toEqual(a.uv);
  });

  it('runs one atlas at a time when asked twice at once', async () => {
    const { position, label } = blockout();
    const [a, b] = await Promise.all([unwrap(position, label, run), unwrap(position, label, run)]);
    expect(b.uv).toEqual(a.uv);
  });

  it('pins valid hand-authored UV seams/charts and runs xatlas only on missing, tiling or stacked parts', async () => {
    // Part 0: curved L-panel with intentional hand-authored seam splitting panel A (2 tris) from panel B (2 tris)
    // Panel A: 2m x 2m in XY at [0.05..0.45, 0.05..0.45]; Panel B: 2m x 2m in YZ meeting at x=2, split across a deliberate UV seam at u=0.55..0.95
    const authoredPos = Float32Array.from([
      // Panel A (2 tris, welded diagonal)
      0, 0, 0,  2, 0, 0,  2, 2, 0,
      0, 0, 0,  2, 2, 0,  0, 2, 0,
      // Panel B (2 tris, 90° corner at x=2, intentionally cut along x=2 seam by artist)
      2, 0, 0,  2, 0, 2,  2, 2, 2,
      2, 0, 0,  2, 2, 2,  2, 2, 0,
    ]);
    const authoredUv = Float32Array.from([
      0.05, 0.05,  0.45, 0.05,  0.45, 0.45,
      0.05, 0.05,  0.45, 0.45,  0.05, 0.45,
      0.55, 0.05,  0.95, 0.05,  0.95, 0.45,
      0.55, 0.05,  0.95, 0.45,  0.55, 0.45,
    ]);
    const gAuthored = new THREE.BufferGeometry();
    gAuthored.setAttribute('position', new THREE.BufferAttribute(authoredPos, 3));
    gAuthored.setAttribute('uv', new THREE.BufferAttribute(authoredUv, 2));
    gAuthored.setAttribute('label', new THREE.Float32BufferAttribute(new Float32Array(12).fill(0), 1));
    gAuthored.computeVertexNormals();

    // Part 1: missing UVs (all 0)
    const gMissing = new THREE.BoxGeometry(2, 2, 2).translate(-4, 1, 0).toNonIndexed();
    gMissing.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(gMissing.getAttribute('position').count * 2), 2));
    gMissing.setAttribute('label', new THREE.Float32BufferAttribute(new Float32Array(gMissing.getAttribute('position').count).fill(1), 1));

    // Part 2: tiling UVs (0..4 outside square)
    const gTiling = new THREE.PlaneGeometry(4, 4, 2, 2).rotateX(-Math.PI / 2).translate(0, 0, 5).toNonIndexed();
    const tUv = gTiling.getAttribute('uv').array as Float32Array;
    for (let i = 0; i < tUv.length; i++) tUv[i] *= 4;
    gTiling.setAttribute('label', new THREE.Float32BufferAttribute(new Float32Array(gTiling.getAttribute('position').count).fill(2), 1));

    // Part 3: stretched/stacked primitive box
    const gStacked = new THREE.BoxGeometry(4, 1, 1).translate(5, 0.5, 0).toNonIndexed();
    gStacked.setAttribute('label', new THREE.Float32BufferAttribute(new Float32Array(gStacked.getAttribute('position').count).fill(3), 1));

    const merged = mergeGeometries([gAuthored, gMissing, gTiling, gStacked])!;
    const position = merged.getAttribute('position').array as Float32Array;
    const uv = merged.getAttribute('uv').array as Float32Array;
    const label = merged.getAttribute('label').array as Float32Array;

    expect(uvHealth(position, uv, 256).problem).toBeDefined();

    const part = partitionUvCharts(position, uv, label);
    expect(part.preservedCharts).toBe(2); // Both artist charts on Part 0 pinned!
    expect(part.pinnedTriangle.slice(0, 4)).toEqual(new Uint8Array([1, 1, 1, 1]));
    expect(part.pinnedTriangle.slice(4).every((v) => v === 0)).toBe(true);

    const u = await unwrap(position, label, run, { uv, preserveSeams: true });
    expect(u.preservedCharts).toBe(2);
    expect(u.meshes).toBe(3); // Only Parts 1, 2, 3 went through xatlas!
    const h = uvHealth(position, u.uv, 512);
    expect(h.problem).toBeUndefined();
    expect(h.overlap).toBe(0);

    // Verify Part 0's hand-authored interior diagonal stays welded AND the deliberate seam between tri 0..1 and tri 2..3 stays split
    const authoredIslandsAfter = uvIslands(position.slice(0, 36), u.uv.slice(0, 24));
    expect(authoredIslandsAfter.count).toBe(2);
    expect(authoredIslandsAfter.of[0]).toBe(authoredIslandsAfter.of[1]);
    expect(authoredIslandsAfter.of[2]).toBe(authoredIslandsAfter.of[3]);
    expect(authoredIslandsAfter.of[0]).not.toBe(authoredIslandsAfter.of[2]);

    // Uniform world texel density across pinned Part 0 and xatlas-unwrapped Parts 1..3
    const d = density(position, u.uv), m = median(d);
    expect(d[0] / m).toBeGreaterThan(0.6);
    expect(d[0] / m).toBeLessThan(1.5);
  });

  it('repacks two independently unwrapped parts overlapping on [0,1]^2 with zero xatlas calls', async () => {
    const p0 = new THREE.PlaneGeometry(3, 3, 2, 2).toNonIndexed();
    p0.setAttribute('label', new THREE.Float32BufferAttribute(new Float32Array(p0.getAttribute('position').count).fill(0), 1));
    const p1 = new THREE.PlaneGeometry(3, 3, 2, 2).translate(5, 0, 0).toNonIndexed();
    p1.setAttribute('label', new THREE.Float32BufferAttribute(new Float32Array(p1.getAttribute('position').count).fill(1), 1));
    const merged = mergeGeometries([p0, p1])!;
    const position = merged.getAttribute('position').array as Float32Array;
    const uv = merged.getAttribute('uv').array as Float32Array;
    const label = merged.getAttribute('label').array as Float32Array;

    expect(uvHealth(position, uv, 256).overlap).toBeGreaterThan(0.9);
    const u = await unwrap(position, label, run, { uv, preserveSeams: true });
    expect(u.meshes).toBe(0); // 0 xatlas calls needed!
    expect(u.preservedCharts).toBe(2);
    expect(u.preservedSurface).toBeCloseTo(1, 5);
    expect(uvHealth(position, u.uv, 512).problem).toBeUndefined();
  });
});

describe('the samples', () => {
  const samples = fs.readdirSync('samples').filter((f) => f.endsWith('.glb'));
  it.each(samples)('%s keeps its own UVs (they pass the health check)', async (file) => {
    const bytes = fs.readFileSync(`samples/${file}`);
    const level = await loadLevel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), file);
    const g = level.geometry;
    const h = uvHealth(g.getAttribute('position').array, g.getAttribute('uv').array);
    expect(h.problem, `${file}: ${JSON.stringify(h)}`).toBeUndefined();
  }, 60_000);
});
