import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';
import { edgeField, floorHeight, isGround, matchTiles, meanColour, tileGrain, toneField } from '../src/core/ground';
import { bareLook, prompts } from '../src/providers/models';

describe('ground', () => {
  it('takes the floor most players stand on, not the level\'s lowest point', () => {
    const eyes = [1.6, 1.6, 1.6, 2.2, 1.61].map((y) => ({ y }));
    expect(floorHeight(eyes, 1.6, -0.2)).toBe(0);
    expect(floorHeight([], 1.6, -0.2)).toBe(-0.2);
  });

  it('counts as ground what faces up at the floor, or what faces up on a named part', () => {
    expect(isGround(1, 0.02, 3, 0)).toBe(true);
    expect(isGround(1, 0.5, 3, 0)).toBe(false);      // a step
    expect(isGround(0.2, 0, 3, 0)).toBe(false);      // a wall's foot
    expect(isGround(1, 2.8, 3, 0, [3])).toBe(true);  // a mezzanine named as ground
    expect(isGround(1, 0, 4, 0, [3])).toBe(false);
  });

  it('darkens towards a wall and not in the open', () => {
    // a 10 m floor with a wall along x = 5
    const wall = new THREE.PlaneGeometry(10, 3).rotateY(-Math.PI / 2).translate(5, 1.5, 0);
    const bvh = new MeshBVH(wall);
    const f = edgeField(bvh, new THREE.Box3(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 3, 5)), 0, 0.5);
    const at = (x: number, z: number) => f.data[Math.floor((z + 5) / 0.5) * f.width + Math.floor((x + 5) / 0.5)];
    expect(at(4.8, 0)).toBeGreaterThan(200);
    expect(at(4.3, 0)).toBeLessThan(at(4.8, 0));
    expect(at(0, 0)).toBe(0);
  });

  it('keeps where the painted ground is lighter and darker, without its colour', () => {
    // painted ground: dark red on the left half, light green on the right
    const samples: number[] = [];
    for (let x = 0; x < 20; x += 0.25) for (let z = 0; z < 10; z += 0.25) samples.push(x, z, ...(x < 10 ? [100, 20, 20] : [60, 200, 60]));
    const f = { origin: [0, 0] as [number, number], cell: 0.5, width: 40, height: 20 };
    const t = toneField(samples, f, [1, 1, 1], 1);
    const at = (x: number) => [...t.slice(4 * (10 * f.width + x), 4 * (10 * f.width + x) + 3)];
    expect(at(4)[0]).toBeLessThan(127);
    expect(at(36)[0]).toBeGreaterThan(127);
    expect(new Set(at(4)).size).toBe(1);             // the same gain on every channel: no tint
    expect(at(4)[0]).toBeGreaterThanOrEqual(Math.round(0.85 * 127));   // and only within limits
    expect([...toneField([], f).slice(0, 3)]).toEqual([127, 127, 127]);
  });

  it('takes a colour cast out of the later tiles but leaves them darker', () => {
    const tile = (r: number, g: number, b: number) => { const t = new Uint8ClampedArray(16); for (let i = 0; i < 16; i += 4) t.set([r, g, b, 255], i); return t; };
    const [, dirty] = matchTiles([tile(160, 140, 120), tile(100, 110, 130)]);
    const m = meanColour(dirty);
    expect(m[0] / m[2]).toBeCloseTo(160 / 120, 1);   // the first tile's balance of colours
    expect(m[1]).toBeLessThan(140 / 255);            // still the darker of the two
  });

  it('finds the grain of rows and none in speckle', () => {
    const n = 256, rows = new Uint8ClampedArray(4 * n * n), speckle = new Uint8ClampedArray(4 * n * n);
    let seed = 1;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const blobs = Array.from({ length: 400 }, () => [rnd() * n, rnd() * n, 3 + rnd() * 5]);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = 4 * (y * n + x);
      rows.fill(y % 16 < 2 || (x + (Math.floor(y / 16) % 2) * 12) % 24 < 2 ? 40 : 190, i, i + 3);
      speckle.fill(blobs.some(([bx, by, r]) => (x - bx) ** 2 + (y - by) ** 2 < r * r) ? 190 : 40, i, i + 3);
    }
    expect(tileGrain(rows, n)).toBeGreaterThan(0.5);
    expect(tileGrain(speckle, n)).toBeLessThan(0.2);
  });
});

describe('gap-filling prompts', () => {
  const look = 'a Mediterranean hill village: weathered limestone and ochre plaster walls, wooden doors and shutters, worn cobblestone paving';
  it('drop the look\'s clauses about doors, shutters and windows', () => {
    expect(bareLook(look)).toBe('a Mediterranean hill village: weathered limestone and ochre plaster walls, worn cobblestone paving');
    expect(bareLook('old doors and windows')).toBe('old doors and windows');   // nothing else to say: kept as it is
  });
  it('name nothing a wall could be given', () => {
    const c = { look, roofLook: '', parts: 'house wall (most of the frame)', mode: 'fill' as const, floor: false, plain: true };
    for (const text of [prompts.caption(c), prompts.instruction(c)]) expect(text).not.toMatch(/door|shutter|window/i);
    expect(prompts.caption({ ...c, plain: false })).toMatch(/doors and shutters/);
  });
});
