import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';
import { gapNotes, labelPlace, noteComposite, notesInView, pinNotes, type Note } from '../src/core/notes';

// a wall 10 m wide and 4 m high in the plane z = 0, facing +z, and a camera's view of it
const wall = new THREE.PlaneGeometry(10, 4).translate(0, 2, 0);
const bvh = new MeshBVH(wall);
const S = 96;

function view(from: [number, number, number], at: [number, number, number], fov = 60) {
  const camera = new THREE.PerspectiveCamera(fov, 1, 0.05, 100);
  camera.position.set(...from);
  camera.lookAt(...at);
  camera.updateMatrixWorld(true);
  const pos = new Float32Array(4 * S * S), nrm = new Float32Array(4 * S * S);
  const ray = new THREE.Raycaster();
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    ray.setFromCamera(new THREE.Vector2(((x + 0.5) / S) * 2 - 1, 1 - ((y + 0.5) / S) * 2), camera);
    const hit = bvh.raycastFirst(ray.ray, THREE.DoubleSide);
    if (!hit) continue;
    pos.set([hit.point.x, hit.point.y, hit.point.z, 1], 4 * (y * S + x));
    nrm.set([0, 0, 1, 1], 4 * (y * S + x));
  }
  return { camera, pos, nrm };
}

describe('pinned notes', () => {
  const poster: Note = { text: 'add a poster here', at: [0, 1.6, 0.3], size: 1.2 };

  it('snap onto the nearest surface and take its normal', () => {
    const stripeNote: Note = { text: 'a painted stripe', at: [-3, 0.5, 0.2], to: [3, 0.5, 0.2] };
    const [p, stripe] = pinNotes([poster, stripeNote], wall, bvh);
    expect(p.at[2]).toBeCloseTo(0);
    expect(p.at[1]).toBeCloseTo(1.6);
    expect(Math.abs(p.normal[2])).toBeCloseTo(1);
    expect(stripe.size).toBe(0.4);
    expect(stripe.to![2]).toBeCloseTo(0);
  });

  it('are carried out by a view that sees the spot squarely and whole', () => {
    const pinned = pinNotes([poster], wall, bvh).map((n) => ({ ...n, normal: [0, 0, 1] as [number, number, number] }));
    const v = view([0, 1.6, 4], [0, 1.6, 0]);
    const [n] = notesInView(pinned, v.camera, v.pos, v.nrm, new Uint8Array(S * S), S);
    expect(n.well).toBe(true);
    expect(n.open).toBe(1);
    // a 1.2 m disc at 4 m, 60 degrees across 96 px: about 25 px across, in the middle of the frame
    expect(n.pixels).toBeGreaterThan(350);
    expect(n.pixels).toBeLessThan(650);
    expect(n.footprint[(S / 2) * S + S / 2]).toBe(1);
    expect(n.footprint[5 * S + 5]).toBe(0);
  });

  it('count as carried out once the spot is painted', () => {
    const pinned = pinNotes([poster], wall, bvh).map((n) => ({ ...n, normal: [0, 0, 1] as [number, number, number] }));
    const v = view([0, 1.6, 4], [0, 1.6, 0]);
    const [n] = notesInView(pinned, v.camera, v.pos, v.nrm, new Uint8Array(S * S).fill(1), S);
    expect(n.open).toBe(0);
  });

  it('wait for a better view when seen at a graze or cut by the frame, and are absent when out of sight', () => {
    const pinned = pinNotes([poster], wall, bvh).map((n) => ({ ...n, normal: [0, 0, 1] as [number, number, number] }));
    const graze = view([4.6, 1.6, 0.8], [0, 1.6, 0]);
    const [g] = notesInView(pinned, graze.camera, graze.pos, graze.nrm, new Uint8Array(S * S), S);
    expect(g.well).toBe(false);
    const cut = view([1.4, 1.6, 3], [1.4, 1.6, 0], 40);   // the spot cut by the left edge of the frame
    const [c] = notesInView(pinned, cut.camera, cut.pos, cut.nrm, new Uint8Array(S * S), S);
    expect(c).toBeDefined();
    expect(c.well).toBe(false);
    const away = view([0, 1.6, 4], [0, 1.6, 8]);          // looking the other way
    expect(notesInView(pinned, away.camera, away.pos, away.nrm, new Uint8Array(S * S), S)).toEqual([]);
  });

  it('put the label under the spot, or over it at the bottom of the frame, and inside the frame', () => {
    const mid = labelPlace([[400, 400], [600, 400], [600, 600], [400, 600]], 300, 40, 1000);
    expect(mid.y).toBeGreaterThan(600);
    expect(mid.x).toBeCloseTo(350);
    expect(mid.tip).toEqual([500, 600]);
    const low = labelPlace([[20, 900], [120, 900], [120, 980], [20, 980]], 300, 40, 1000);
    expect(low.y).toBeLessThan(900 - 40);
    expect(low.x).toBeGreaterThanOrEqual(10);
    expect(low.tip).toEqual([70, 900]);
  });

  it('change their own spot and fade out around it, whatever else the model repainted', () => {
    const n = 64, before = new Uint8ClampedArray(4 * n * n).fill(100), after = new Uint8ClampedArray(4 * n * n).fill(200);
    const footprint = new Uint8Array(n * n), allow = new Uint8Array(n * n).fill(1);
    for (let y = 24; y < 40; y++) for (let x = 24; x < 40; x++) footprint[y * n + x] = 1;   // a 16 px square
    allow.fill(0, 0, 22 * n);                                                              // a wall above it
    const c = noteComposite(before, after, footprint, n, allow);
    const at = (x: number, y: number) => [c[4 * (y * n + x)], c[4 * (y * n + x) + 3]];
    expect(at(32, 32)).toEqual([200, 255]);                // the middle: the model's picture
    expect(at(24, 32)[0]).toBeGreaterThanOrEqual(175);     // the footprint's own edge: still mostly it
    const justOut = at(21, 32)[0];
    expect(justOut).toBeGreaterThan(100);                  // the band: a blend
    expect(justOut).toBeLessThan(200);
    expect(at(5, 32)).toEqual([0, 0]);                     // far away: not projected at all
    expect(at(32, 21)).toEqual([0, 0]);                    // on the wall: not reached
  });

  it('name the biggest gaps of a hole view, each with a box round it', () => {
    const n = 100, label = new Int16Array(n * n).fill(-1), unknown = new Uint8Array(n * n);
    const fill = (l: number, x0: number, y0: number, x1: number, y1: number, open: boolean) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { label[y * n + x] = l; unknown[y * n + x] = open ? 1 : 0; }
    };
    fill(0, 0, 0, 100, 100, false);    // a painted wall
    fill(1, 10, 10, 40, 30, true);     // an unpainted sofa
    fill(2, 60, 60, 70, 70, true);     // an unpainted crate, smaller
    fill(3, 80, 10, 82, 12, true);     // a sliver: too small for a note
    fill(4, 50, 80, 70, 95, true);     // a shape with no name
    fill(5, 0, 40, 100, 42, true); fill(5, 0, 96, 100, 100, true);   // gaps in the floor: scenery, left to the prompt
    const notes = gapNotes(label, unknown, ['wall', 'sofa', 'wooden crate', 'pipe', '', 'floor'], n, 3, 0.004, undefined, 0.3, (l) => l === 5);
    expect(notes.map((x) => x.note.text)).toEqual(['this gray part: sofa', 'this gray part: wooden crate']);
    expect(notes[0].pixels).toBe(600);
    const [[x0, y0], , [x1, y1]] = notes[0].outline;
    expect(x0).toBeLessThanOrEqual(10); expect(y0).toBeLessThanOrEqual(10); expect(x1).toBeGreaterThanOrEqual(39); expect(y1).toBeGreaterThanOrEqual(29);
    expect(notes[0].footprint[20 * n + 20]).toBe(1);
    expect(notes[0].footprint[65 * n + 65]).toBe(0);
  });
});
