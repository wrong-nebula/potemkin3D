import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';
import { frameUse, sampling, summarise, type ViewMetrics } from '../src/core/metrics';
import { paintability } from '../src/core/paintability';
import { cellDensity, DEFAULT_PLAN, floorTest, floorViews, holeLookViews, holeTargets, lookViews, pixelsPerMetre, selectViews, type CellList } from '../src/core/planner';
import type { Level } from '../src/core/scene';
import { viewDirection } from '../src/core/views';

describe('frameUse', () => {
  // ten pixels: 2 sky, 8 level; of those 3 already painted, 1 unpainted at a graze, 4 unpainted and well seen (1 not kept)
  const geometry = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1];
  const known = [0, 0, 1, 1, 1, 0, 0, 0, 0, 0];
  const cos = [0, 0, 0.9, 0.9, 0.9, 0.1, 0.8, 0.8, 0.8, 0.8];
  const kept = [0, 0, 1, 1, 1, 1, 1, 1, 1, 0];

  it('splits a frame into sky, context, grazing and productive pixels', () => {
    const u = frameUse(geometry, known, cos, kept);
    expect(u.sky).toBeCloseTo(0.2);
    expect(u.fresh).toBeCloseTo(0.5);
    expect(u.context).toBeCloseTo(3 / 8);
    expect(u.grazing).toBeCloseTo(1 / 8);
    expect(u.productive).toBeCloseTo(0.3);       // unpainted, well seen and kept
  });

  it('counts every well-seen unpainted pixel when nothing says what was kept', () => {
    expect(frameUse(geometry, known, cos).productive).toBeCloseTo(0.4);
  });
});

describe('sampling', () => {
  it('reports view pixels per texel for painted cells only', () => {
    const grid = 4;
    const pos = new Float32Array(grid * grid * 4), covered = new Uint8Array(grid * grid).fill(1), quality = new Float32Array(grid * grid);
    for (let y = 0; y < grid; y++) for (let x = 0; x < grid; x++) pos.set([x * 0.5, 0, y * 0.5, 0], 4 * (y * grid + x));   // cells half a metre apart
    quality.fill(0.1, 0, 8);    // the top half painted, seen head-on from 10 m
    // 512 px per metre at 1 m head-on -> 51.2 px per metre here; 8 texels per cell over 0.5 m -> 16 texels per metre
    const s = sampling(quality, pos, covered, grid, 8, 512);
    expect(s.cells).toBe(6);    // three neighbouring pairs in each of the two painted rows
    expect(s.p50).toBeCloseTo(3.2, 3);
    expect(s.under1).toBe(0);
    expect(sampling(quality, pos, covered, grid, 80, 512).under1).toBe(1);   // a ten times denser texture is undersampled
    // over the whole texture: half of it is painted, all of that at full detail
    expect(s.detail).toBeCloseTo(0.5);
    expect(s.full).toBeCloseTo(0.5);
    // on the surface: the views captured 51.2 px per metre, the texture holds 16 texels per metre, so 16 is what a player gets
    expect(s.surface).toBeCloseTo(16);
    expect(s.texels).toBeCloseTo(16);
    expect(sampling(quality, pos, covered, grid, 80, 512).surface).toBeCloseTo(51.2);   // a denser texture: the views are the limit
    expect(sampling(quality, pos, covered, grid, 80, 512).detail).toBeCloseTo(0.16);   // 0.32 px per texel on half of it
  });
});

describe('summarise', () => {
  it('separates planned views from second goes and hole views, and counts the wasted ones', () => {
    const v = (index: number, kind: string, productive: number, context: number): ViewMetrics =>
      ({ index, kind, model: 'm', pitch: 0, faces: 3, maxFace: 0.3, sky: 0.2, fresh: 0.5, context, grazing: 0.1, productive, price: 0.01 });
    const m = summarise([v(0, 'ground', 0.6, 0), v(1, 'ground', 0.4, 0.2), v(2, 'again', 0.01, 0.9), v(3, 'fill', 0.02, 0.3)],
      { p10: 0, p50: 0, p90: 0, under1: 0, under05: 0, cells: 0, detail: 0, full: 0, surface: 0, texels: 0, surfaceMean: 0, surface75: 0 }, 0.2, 0.5);
    expect(m.productivePlanned).toBeCloseTo(0.5);
    expect(m.productive).toBeCloseTo(1.03 / 4);
    expect(m.context).toBeCloseTo(0.2);          // of the planned views after the first
    expect(m.wasted).toBe(2);
  });
});

describe('paintability', () => {
  const view = { pitch: 0.1, sky: 0.2, faces: 5, maxFace: 0.3, context: 0.1 };

  it('is high for a level view with several faces', () => {
    expect(paintability(view)).toBe(1);
  });

  it('drops steeply with pitch', () => {
    const steep = paintability({ ...view, pitch: THREE.MathUtils.degToRad(-55) });
    expect(steep).toBeLessThan(0.15);
    expect(paintability({ ...view, pitch: THREE.MathUtils.degToRad(-35) })).toBeGreaterThan(steep);
  });

  it('marks down a blank face with no context, a single face, and a frame of sky', () => {
    expect(paintability({ ...view, maxFace: 0.7 })).toBeLessThan(0.5);
    expect(paintability({ ...view, maxFace: 0.7, context: 0.5 })).toBe(1);   // with something painted around it, it is a fill
    expect(paintability({ ...view, faces: 1 })).toBeLessThan(0.5);
    expect(paintability({ ...view, sky: 0.6 })).toBeLessThan(0.7);
  });
});

describe('hole cameras', () => {
  /** A floor with a wall along x = 0 facing +x; texture cells laid out over the wall's face. */
  function setup() {
    const floor = new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2);
    const wall = new THREE.BoxGeometry(0.2, 6, 20).translate(-0.1, 3, 0);
    const g = mergeGeometries([floor, wall].map((x) => x.toNonIndexed()))!;
    const level = { bvh: new MeshBVH(g) } as unknown as Level;
    const n = 6, pos = new Float32Array(n * n * 4), nrm = new Float32Array(n * n * 4), quality = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = y * n + x;
      pos.set([0, 1 + y * 0.4, -1 + x * 0.4, 0], 4 * i);
      nrm.set([1, 0, 0, 1], 4 * i);
    }
    return { level, pos, nrm, quality };
  }

  it('gathers unpainted cells into patches and leaves painted ones out', () => {
    const { pos, nrm, quality } = setup();
    quality.fill(0.2, 0, 18);                       // the lower half is painted
    const t = holeTargets(pos, nrm, quality);
    expect(t.reduce((a, x) => a + x.cells, 0)).toBe(18);
    expect(t[0].normal.x).toBeCloseTo(1);
    expect(t[0].center.y).toBeGreaterThan(2);
    expect(holeTargets(pos, nrm, quality.fill(0.2))).toEqual([]);
  });

  it('looks at a patch from the front, near level, from spots with a clear line', () => {
    const { level, pos, nrm, quality } = setup();
    const targets = holeTargets(pos, nrm, quality);
    const eye = (x: number, z: number) => new THREE.Vector3(x, 1.65, z);
    const views = holeLookViews(level, targets, [eye(6, 0), eye(-6, 0), eye(1, 0), eye(30, 0)]);
    expect(views.length).toBeGreaterThan(0);
    for (const v of views) {
      expect(v.position[0]).toBe(6);                // not from behind the wall, too close, or too far
      expect(Math.abs(v.pitch)).toBeLessThanOrEqual(THREE.MathUtils.degToRad(25) + 1e-9);
      expect(viewDirection(v).x).toBeLessThan(-0.9);   // facing the wall
      expect(v.kind).toBe('fill');
    }
  });
});

describe('planning by sharpness', () => {
  it('knows how dense the texture is on the surface', () => {
    const grid = 4, pos = new Float32Array(grid * grid * 4), nrm = new Float32Array(grid * grid * 4);
    for (let y = 0; y < grid; y++) for (let x = 0; x < grid; x++) {
      pos.set([x * 0.5, 0, y * 0.5, 0], 4 * (y * grid + x));   // cells half a metre apart
      nrm.set([0, 1, 0, 1], 4 * (y * grid + x));
    }
    nrm[4 * 5 + 3] = 0;                                         // one cell no triangle covers
    const d = cellDensity({ pos, nrm, texelsPerCell: 8 }, grid);
    expect(d[0]).toBeCloseTo(16);                               // 8 texels over half a metre
    expect(d[5]).toBe(0);
    expect(pixelsPerMetre(1024, 90)).toBeCloseTo(512);
  });

  /** Two cameras over a 16 x 16 texture: `wide` sees 100 cells from afar, `close` sees 50 of them from near. */
  function pair() {
    const list = (n: number, q: number): CellList => ({ cells: Int32Array.from({ length: n }, (_, i) => i), q: new Float32Array(n).fill(q) });
    const o = { ...DEFAULT_PLAN, grid: 16, maxViews: 1 };
    const sharp = { density: new Float32Array(256).fill(100), ppm: [100, 100], paint: [1, 1], ppmExisting: 100 };
    return { lists: [list(100, 0.2), list(50, 1)], o, sharp };   // 0.2 and 1 view pixels per texel
  }

  it('prefers the view that adds the most detail, not the one that sees the most cells', () => {
    const { lists, o, sharp } = pair();
    expect(selectViews(lists, o, [], undefined, undefined, sharp).order).toEqual([1]);
    // both, when two are allowed: the wide one still adds detail where the close one doesn't reach
    expect(selectViews(lists, { ...o, maxViews: 2 }, [], undefined, undefined, sharp).order.sort()).toEqual([0, 1]);
  });

  it('weighs a view by how likely it is to be painted faithfully', () => {
    const { lists, o, sharp } = pair();
    expect(selectViews(lists, o, [], undefined, undefined, { ...sharp, paint: [1, 0.2] }).order).toEqual([0]);
  });

  it('counts only the detail a view adds over what is already painted', () => {
    const { lists, o, sharp } = pair();
    const existing = new Float32Array(256);
    existing.fill(1, 0, 50);                                    // the close view's cells are already sharp
    expect(selectViews(lists, o, [], existing, undefined, sharp).order).toEqual([0]);
  });

  it('aims cameras at patches of surface, each given once', () => {
    const floor = new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2);
    const level = { bvh: new MeshBVH(floor.toNonIndexed()) } as unknown as Level;
    const patch = (z: number) => ({ center: new THREE.Vector3(0, 1.65, z), normal: new THREE.Vector3(1, 0, 0), cells: 9 });
    const views = lookViews(level, [patch(1), patch(1.1)], [new THREE.Vector3(6, 1.65, 0)], 2);
    expect(views.length).toBe(1);                               // two patches side by side, one camera
    expect(views[0].kind).toBeUndefined();                      // a planned view like any other
    expect(views[0].fov).toBe(75);
  });

  it('spends camera budget and look-at targets on higher-weight cells first', () => {
    const list = (from: number, n: number, q: number): CellList => ({
      cells: Int32Array.from({ length: n }, (_, i) => from + i),
      q: new Float32Array(n).fill(q),
    });
    const o = { ...DEFAULT_PLAN, grid: 16, maxViews: 1 };
    const weights = new Float32Array(256).fill(0.5);
    weights.fill(1.4, 40, 75);   // 35 high-importance convex/lit cells beat 40 enclosed crevice cells
    const lists = [list(0, 40, 0.5), list(40, 35, 0.5)];
    expect(selectViews(lists, o).order).toEqual([0]);
    expect(selectViews(lists, o, [], undefined, undefined, undefined, weights).order).toEqual([1]);

    const sharp = { density: new Float32Array(256).fill(100), ppm: [100, 100], paint: [1, 1], ppmExisting: 100 };
    expect(selectViews(lists, o, [], undefined, undefined, sharp, weights).order).toEqual([1]);

    // holeTargets orders patches by weighted score rather than raw cell count
    const pos = new Float32Array(8 * 4), nrm = new Float32Array(8 * 4), q = new Float32Array(8);
    for (let i = 0; i < 5; i++) { pos.set([0, 1, 0, 0], 4 * i); nrm.set([1, 0, 0, 1], 4 * i); }
    for (let i = 5; i < 8; i++) { pos.set([10, 1, 0, 0], 4 * i); nrm.set([1, 0, 0, 1], 4 * i); }
    const patchW = Float32Array.from([0.4, 0.4, 0.4, 0.4, 0.4, 1.3, 1.3, 1.3]);
    expect(holeTargets(pos, nrm, q)[0].center.x).toBe(0);
    expect(holeTargets(pos, nrm, q, 3, 24, patchW)[0].center.x).toBe(10);
  });
});

describe('floor cameras', () => {
  // a floor with a low canopy over one of the spots and a very low one over another
  const floor = new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2);
  const canopy = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2).translate(10, 3, 0);
  const shelf = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2).translate(-10, 1.9, 0);
  const level = { bvh: new MeshBVH(mergeGeometries([floor, canopy, shelf].map((x) => x.toNonIndexed()))!) } as unknown as Level;
  const eyes = [new THREE.Vector3(0, 1.65, 0), new THREE.Vector3(10, 1.65, 0), new THREE.Vector3(-10, 1.65, 0)];

  it('hang over each spot looking straight down, lower under a ceiling, and not where there is no room', () => {
    const views = floorViews(level, DEFAULT_PLAN, eyes);
    expect(views.length).toBe(2);
    expect(views[0].position).toEqual([0, 3.5, 0]);
    expect(views[1].position[1]).toBeCloseTo(2.7);                // 0.2 m under the canopy, measured from just above the floor
    for (const v of views) {
      expect(v.kind).toBe('floor');
      expect(v.floor).toBeCloseTo(0);
      expect(viewDirection(v).y).toBeLessThan(-0.99);
    }
  });

  it('know the ground from steps, crate tops and walls', () => {
    const isFloor = floorTest(eyes, 1.65);
    expect(isFloor(0, 1, 0.1)).toBe(true);                        // a kerb
    expect(isFloor(0, 1, 0.9)).toBe(false);                       // the top of a crate
    expect(isFloor(0, 0, 0)).toBe(false);                         // a wall's foot
  });
});
