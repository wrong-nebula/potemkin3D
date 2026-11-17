/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import { describe, expect, it } from 'vitest';
import { checkView, faceIou, facesToPaint, GRID, ignoredPixels, offCells, offPlane, scoreFaces, toCameraSpace, viewFaces, type Planes, type Segment } from '../src/core/fidelity';

const S = 512;   // view size in the tests (2 px per grid cell)

/**
 * Geometry buffers of a simple view: sky on top, a wall facing the camera below it, a floor under the wall, and a
 * box standing in front of the wall (nearer, so its outline is a depth jump).
 */
function scene() {
  const pos = new Float32Array(S * S * 4), nrm = new Float32Array(S * S * 4);
  const put = (x: number, y: number, n: [number, number, number], dist: number) => {
    const i = 4 * (y * S + x);
    nrm.set([...n, 1], i);
    pos[i + 3] = dist;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (y < 96) continue;                                                            // sky
      if (x >= 200 && x < 300 && y >= 240 && y < 400) put(x, y, [0, 0, 1], 5);          // the box
      else if (y < 352) put(x, y, [0, 0, 1], 10);                                       // the wall
      else put(x, y, [0, 1, 0], 10 - (y - 352) * 0.01);                                 // the floor
    }
  }
  return { pos, nrm };
}

const cell = (px: number) => Math.floor((px * GRID) / S);
const maskOf = (inside: (cx: number, cy: number) => boolean) => {
  const m = new Uint8Array(GRID * GRID);
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) m[y * GRID + x] = inside(x, y) ? 1 : 0;
  return m;
};

describe('viewFaces', () => {
  it('splits a view at silhouettes and creases, and skips the sky', () => {
    const { pos, nrm } = scene();
    const f = viewFaces(pos, nrm, S);
    expect(f.faces).toHaveLength(3);
    const at = (x: number, y: number) => f.labels[cell(y) * GRID + cell(x)];
    const wall = at(50, 200), floor = at(50, 450), box = at(250, 300);
    expect(new Set([wall, floor, box]).size).toBe(3);
    expect(Math.min(wall, floor, box)).toBeGreaterThan(0);
    expect(at(50, 40)).toBe(0);              // sky
    expect(at(400, 200)).toBe(wall);         // the wall continues round the box
    expect(at(250, 239)).toBe(0);            // the cells along the box's top edge belong to no face
  });

  it('clicks deep inside each face', () => {
    const { pos, nrm } = scene();
    const f = viewFaces(pos, nrm, S);
    const box = f.faces.find((face) => face.id === f.labels[cell(300) * GRID + cell(250)])!;
    expect(box.point[0]).toBeGreaterThan(cell(215));
    expect(box.point[0]).toBeLessThan(cell(285));
    expect(box.point[1]).toBeGreaterThan(cell(255));
    expect(box.point[1]).toBeLessThan(cell(385));
  });

  it('leaves faces too small to judge unlabelled', () => {
    const { pos, nrm } = scene();
    expect(viewFaces(pos, nrm, S, { minShare: 0.2 }).faces).toHaveLength(2);   // the box is 6% of the frame
  });
});

describe('facesToPaint', () => {
  it('keeps only faces the view still has to paint', () => {
    const { pos, nrm } = scene();
    const f = viewFaces(pos, nrm, S);
    const unknown = new Uint8Array(S * S);
    for (let y = 352; y < S; y++) for (let x = 0; x < S; x++) unknown[y * S + x] = 1;   // only the floor's rows are unpainted
    const todo = facesToPaint(f, unknown, S);
    const floor = f.labels[cell(450) * GRID + cell(50)], box = f.labels[cell(300) * GRID + cell(250)];
    expect(todo.map((t) => t.id).sort()).toEqual([floor, box].sort());   // the box reaches below the wall's foot too
  });
});

describe('scoring', () => {
  const { pos, nrm } = scene();
  const f = viewFaces(pos, nrm, S);
  const id = (x: number, y: number) => f.labels[cell(y) * GRID + cell(x)];
  const box = f.faces.find((face) => face.id === id(250, 300))!;
  const wall = f.faces.find((face) => face.id === id(50, 200))!;
  const boxMask = maskOf((x, y) => x >= cell(200) && x < cell(300) && y >= cell(240) && y < cell(400));
  // the wall with the box on it painted as one surface (the box reaches below the wall's foot)
  const wallAndBox = maskOf((x, y) => y >= cell(96) && (y < cell(352) || (x >= cell(200) && x < cell(300) && y < cell(400))));

  it('measures overlap as intersection over union', () => {
    expect(faceIou(f.labels, box.id, boxMask)).toBeGreaterThan(0.85);
    expect(faceIou(f.labels, box.id, wallAndBox)).toBeLessThan(0.2);
  });

  it('respects a face when any of the offered masks matches it', () => {
    const [s] = scoreFaces(f, [box], [[maskOf(() => false), wallAndBox, boxMask]]);
    expect(s.kind).toBe('ok');
    expect(s.iou).toBeGreaterThan(0.85);
  });

  it('calls a face merged when the painting carries a neighbour across it', () => {
    // the model painted the box as more wall: every mask for a click on it is the wall, box and all
    const [s] = scoreFaces(f, [box], [[wallAndBox, wallAndBox, maskOf(() => true)]]);
    expect(s.kind).toBe('merged');
    expect(s.cover).toBeGreaterThan(0.95);
  });

  it('calls a face replaced when no mask even contains it', () => {
    // the model painted a scene onto the wall: a click finds a house on its left third, or a strip of sky
    const house = maskOf((x, y) => x < cell(170) && y >= cell(96) && y < cell(352));
    const sky = maskOf((_, y) => y >= cell(96) && y < cell(150));
    const [s] = scoreFaces(f, [wall], [[house, sky]]);
    expect(s.kind).toBe('replaced');
    expect(s.cover).toBeLessThan(0.5);
  });

  it('holds a painted-over face back with its outline, and nothing of its neighbours', () => {
    const scores = scoreFaces(f, [box, wall], [[wallAndBox], [maskOf((x, y) => f.labels[y * GRID + x] === wall.id)]]);
    expect(scores.map((s) => s.kind)).toEqual(['merged', 'ok']);
    const drop = ignoredPixels(f, scores, S);
    expect(drop[300 * S + 250]).toBe(1);     // inside the box
    expect(drop[239 * S + 250]).toBe(1);     // the edge along its top
    expect(drop[200 * S + 50]).toBe(0);      // the wall
    expect(drop[450 * S + 50]).toBe(0);      // the floor
    expect(ignoredPixels(f, scores.map((s) => ({ ...s, kind: 'ok' as const })), S).some((v) => v)).toBe(false);
  });

  it('lets merged faces through on a last go, and never replaced ones', () => {
    const merged = scoreFaces(f, [box], [[wallAndBox]]);
    expect(ignoredPixels(f, merged, S, true).some((v) => v)).toBe(false);
    const replaced = scoreFaces(f, [wall], [[maskOf((x, y) => x < cell(170) && y >= cell(96) && y < cell(352))]]);
    expect(replaced[0].kind).toBe('replaced');
    expect(ignoredPixels(f, replaced, S, true)[200 * S + 50]).toBe(1);
  });
});

describe('checkView', () => {
  it('clicks each face to paint once and reports how much of the work was painted over', async () => {
    const { pos, nrm } = scene();
    const f = viewFaces(pos, nrm, S);
    const unknown = new Uint8Array(S * S);
    for (let i = 0; i < unknown.length; i++) unknown[i] = nrm[4 * i + 3] > 0.5 ? 1 : 0;   // nothing painted yet
    const clicks: [number, number][] = [];
    // a painter that kept the wall and the floor but painted the box away
    const segment: Segment = async (_image, size, points) => {
      clicks.push(...points);
      return { grid: GRID, masks: points.map(([x, y]) => {
        const here = f.labels[cell((y * S) / size) * GRID + cell((x * S) / size)];
        const boxId = f.labels[cell(300) * GRID + cell(250)];
        return [here === boxId ? maskOf((cx, cy) => cy >= cell(96) && (cy < cell(352) || (cx >= cell(200) && cx < cell(300) && cy < cell(400))))
          : maskOf((cx, cy) => f.labels[cy * GRID + cx] === here)];
      }) };
    };
    const c = await checkView(segment, new Uint8ClampedArray(S * S * 4), S, f, unknown);
    expect(clicks).toHaveLength(3);
    expect(c.scores.filter((s) => s.kind === 'merged')).toHaveLength(1);
    expect(c.merged).toBeGreaterThan(0.06);       // the box is about 8% of the geometry in view
    expect(c.merged).toBeLessThan(0.12);
    expect(c.replaced).toBe(0);
    expect(c.heldOfFrame).toBeLessThan(c.merged); // the sky is frame too
    expect(c.dropMerged[300 * S + 250]).toBe(1);  // held back while the view has a second go coming
    expect(c.drop.some((v) => v)).toBe(false);    // and accepted when it has none
  });

  it('asks for nothing when the view has nothing to paint', async () => {
    const { pos, nrm } = scene();
    const segment: Segment = async () => { throw new Error('not called'); };
    const c = await checkView(segment, new Uint8ClampedArray(S * S * 4), S, viewFaces(pos, nrm, S), new Uint8Array(S * S));
    expect(c).toMatchObject({ scores: [], replaced: 0, merged: 0, heldOfFrame: 0 });
  });
});

describe('plane test', () => {
  const { pos, nrm } = scene();
  const f = viewFaces(pos, nrm, S);
  const wall = f.faces.find((face) => face.id === f.labels[cell(200) * GRID + cell(50)])!;
  /** A predicted normal map: `at(cx, cy)` gives the camera-space normal per cell, or null for "no surface". */
  const predicted = (at: (cx: number, cy: number) => [number, number, number] | null) => {
    const normals = new Uint8ClampedArray(GRID * GRID * 4), valid = new Uint8Array(GRID * GRID);
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
      const n = at(x, y);
      if (!n) continue;
      valid[y * GRID + x] = 1;
      normals.set([127.5 + 127.5 * n[0], 127.5 + 127.5 * n[1], 127.5 + 127.5 * n[2], 255], 4 * (y * GRID + x));
    }
    return { normals, valid };
  };

  it('knows which faces are flat and which way they face', () => {
    expect(wall.flat).toBe(true);
    expect(wall.normal[2]).toBeCloseTo(1, 3);
    const floor = f.faces.find((face) => face.id === f.labels[cell(450) * GRID + cell(50)])!;
    expect(floor.normal[1]).toBeCloseTo(1, 3);
  });

  it('brings a world direction into camera space', () => {
    // yaw 0 looks down -Z: a wall facing +Z faces the viewer, the floor faces up
    expect(toCameraSpace([0, 0, 1], 0, 0)).toEqual([0, 0, 1]);
    expect(toCameraSpace([0, 1, 0], 0, 0).map((v) => +v.toFixed(6))).toEqual([0, 1, 0]);
    // looking 90 degrees to the left (down -X), that wall is seen edge-on, facing right
    const side = toCameraSpace([0, 0, 1], Math.PI / 2, 0);
    expect(side[0]).toBeCloseTo(-1, 5);
    expect(side[2]).toBeCloseTo(0, 5);
    // looking straight down, the floor faces the viewer
    expect(toCameraSpace([0, 1, 0], 0, -Math.PI / 2)[2]).toBeCloseTo(1, 5);
  });

  it('passes a wall painted as that wall, details and all', () => {
    const p = predicted((x) => (x % 16 === 0 ? [0.5, 0, 0.87] : [0, 0, 1]));   // a window reveal every so often
    expect(offPlane(f.labels, wall.id, p.normals, p.valid, [0, 0, 1])).toBeLessThan(0.1);
  });

  it('fails a wall painted as a corner, as a wall seen from another side, or as sky', () => {
    const corner = predicted((x) => (x < 128 ? [-0.7, 0, 0.7] : [0.7, 0, 0.7]));
    expect(offPlane(f.labels, wall.id, corner.normals, corner.valid, [0, 0, 1])).toBeGreaterThan(0.9);
    const turned = predicted(() => [-0.77, 0, 0.64]);                            // flat, but facing 50 degrees away
    expect(offPlane(f.labels, wall.id, turned.normals, turned.valid, [0, 0, 1])).toBe(1);
    const sky = predicted((_, y) => (y < cell(250) ? null : [0, 0, 1]));
    expect(offPlane(f.labels, wall.id, sky.normals, sky.valid, [0, 0, 1])).toBeGreaterThan(0.4);
  });

  it('finds the patches of a wall painted as something else, and ignores stray cells', () => {
    // wall cells in reading order: a block of them painted facing sideways (a crate against the wall), and one stray cell
    const cells = [...f.labels.keys()].filter((c) => f.labels[c] === wall.id);
    const [px, py] = wall.point;
    const patch = new Set(cells.filter((c) => Math.abs((c % GRID) - px) < 8 && Math.abs(Math.floor(c / GRID) - py) < 8));
    const stray = cells.find((c) => !patch.has(c) && Math.abs((c % GRID) - px) > 20)!;
    const p = predicted((x, y) => (patch.has(y * GRID + x) || y * GRID + x === stray ? [0.9, 0, 0.44] : [0, 0, 1]));
    const off = offCells(f, p.normals, p.valid, 0, 0);
    const onWall = (o: Uint8Array) => cells.reduce((t, c) => t + o[c], 0);
    expect(patch.size).toBeGreaterThan(100);
    expect(onWall(off)).toBe(patch.size);            // the patch, and not the stray cell
    expect(off[stray]).toBe(0);
    // a wall painted as that wall has none (the fixture paints the floor as wall too: that is the floor's business)
    const fine = predicted(() => [0, 0, 1]);
    expect(onWall(offCells(f, fine.normals, fine.valid, 0, 0))).toBe(0);
  });

  it('turns a face the masks passed into a replaced one, and asks the geometry model once', async () => {
    const unknown = new Uint8Array(S * S);
    for (let i = 0; i < unknown.length; i++) unknown[i] = nrm[4 * i + 3] > 0.5 ? 1 : 0;
    const segment: Segment = async (_i, size, points) => ({ grid: GRID, masks: points.map(([x, y]) => {
      const here = f.labels[cell((y * S) / size) * GRID + cell((x * S) / size)];
      return [maskOf((cx, cy) => f.labels[cy * GRID + cx] === here)];           // every face looks respected
    }) });
    let calls = 0;
    // the painting shows a corner building where the wall is, and a proper floor
    const planes: Planes = async () => { calls++; return predicted((x, y) => (y >= cell(352) ? [0, 1, 0] : x < 128 ? [-0.7, 0, 0.7] : [0.7, 0, 0.7])); };
    const c = await checkView(segment, new Uint8ClampedArray(S * S * 4), S, f, unknown, 0.5, planes, { yaw: 0, pitch: 0 });
    expect(calls).toBe(1);
    const byId = new Map(c.scores.map((s) => [s.id, s]));
    expect(byId.get(wall.id)!.kind).toBe('replaced');
    expect(byId.get(wall.id)!.offPlane).toBeGreaterThan(0.9);
    expect(c.scores.filter((s) => s.kind === 'replaced')).toHaveLength(1);       // the floor passed; the box is too small to test
    expect(c.drop[200 * S + 50]).toBe(1);
    // no answer from the geometry model: the masks' verdict stands
    const down = await checkView(segment, new Uint8ClampedArray(S * S * 4), S, f, unknown, 0.5, async () => { throw new Error('down'); });
    expect(down.scores.every((s) => s.kind === 'ok')).toBe(true);
  });
});
