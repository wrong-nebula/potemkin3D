import { describe, expect, it } from 'vitest';
import { buildAlignedMaps, unpackLinearPbrChannels, validateAlignedSource, type AlignedMapSource } from '../src/core/aligned-maps';
import { alignedHeightSource, estimateIntrinsicPbr, pbrMetadata } from '../src/core/pbr';
import { MATERIAL_PRESETS, suggestMaterialPreset, validateMaterialAssignments } from '../src/core/material-presets';

const size = 32;
function image(value: [number, number, number, number]) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < data.length; i += 4) data.set(value, i);
  return data;
}
function geometry(split = false) {
  const pos = new Float32Array(size * size * 4), nrm = new Float32Array(pos.length);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    pos.set([x * .0001, -y * .0001, 0, split && x >= size / 2 ? 2 : 1], i);
    nrm.set([0, 0, 1, 1], i);
  }
  return { pos, nrm };
}
const pixel = (x: number, y = 16) => 4 * (y * size + x);
const base: AlignedMapSource = { size, layoutHash: 'fixture', kind: 'flat', roughnessBase: .92 };

describe('aligned material responses', () => {
  it('gives each preset its own roughness and metalness without making paint or timber metallic', () => {
    for (const [id, preset] of Object.entries(MATERIAL_PRESETS)) {
      const { normal, orm } = buildAlignedMaps(base, geometry(), ['surface'], { surface: id as keyof typeof MATERIAL_PRESETS });
      expect(orm[pixel(16) + 1]).toBe(Math.round(preset.roughness * 255));
      expect(orm[pixel(16) + 2]).toBe(id === 'metal' ? Math.round(preset.metalness * 255) : 0);
      expect(Array.from(normal.slice(pixel(16), pixel(16) + 3))).toEqual([128, 128, 255]);
    }
  });
  it('derives the normal from dedicated height even when a conflicting normal map is supplied', () => {
    const height = image([128, 128, 128, 255]);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) height[pixel(x, y)] = x / (size - 1) * 255;
    const source: AlignedMapSource = { ...base, kind: 'dedicated-height', height, normal: image([240, 30, 70, 255]) };
    const a = buildAlignedMaps(source, geometry(), ['surface'], { surface: 'limestone' });
    const b = buildAlignedMaps({ ...source, normal: undefined }, geometry(), ['surface'], { surface: 'limestone' });
    expect(a.normal).toEqual(b.normal);
    const i = pixel(16), n = Array.from(a.normal.slice(i, i + 3), v => v / 127.5 - 1);
    expect(n[0]).toBeLessThan(-.2); // normal opposes the increasing height
    expect(Math.abs(n[1])).toBeLessThan(.01);
    expect(Math.hypot(...n)).toBeCloseTo(1, 2);
  });
  it('does not turn a material boundary into a height ridge', () => {
    const source: AlignedMapSource = { ...base, kind: 'dedicated-height', height: image([220, 220, 220, 255]) };
    const { normal } = buildAlignedMaps(source, geometry(true), ['a', 'b'], { a: 'glazed-tile', b: 'painted-metal' });
    for (const x of [14, 15, 16, 17]) expect(Array.from(normal.slice(pixel(x), pixel(x) + 3))).toEqual([128, 128, 255]);
  });
  it('retains the glaze/grout contrast of an authored absolute roughness map', () => {
    const roughness = image([255, 82, 0, 255]);
    for (let y = 0; y < size; y++) roughness[pixel(16, y) + 1] = 225;
    const source: AlignedMapSource = { ...base, roughness, roughnessMode: 'absolute' };
    const { orm } = buildAlignedMaps(source, geometry(), ['floor'], { floor: 'glazed-tile' });
    expect(orm[pixel(8) + 1]).toBe(82);
    expect(orm[pixel(16) + 1]).toBe(225);
  });
  it('keeps original legacy maps exact when unassigned and restrains their relief when assigned', () => {
    const source: AlignedMapSource = { ...base, kind: 'legacy-normal', normal: image([230, 100, 170, 255]), roughness: image([180, 225, 0, 255]), roughnessBase: 225 / 255 };
    const before = source.normal!.slice();
    const original = buildAlignedMaps(source, geometry(), ['surface'], {});
    expect(original.normal).toEqual(source.normal);
    expect(original.orm).toEqual(source.roughness);
    const painted = buildAlignedMaps(source, geometry(), ['surface'], { surface: 'painted-metal' });
    expect(Math.abs(painted.normal[pixel(16)] - 128)).toBeLessThan(25);
    expect(source.normal).toEqual(before);
    expect(painted.orm[pixel(16)]).toBe(180); // existing AO retained
  });
  it('is deterministic across repeated preset changes without modifying source fields', () => {
    const source: AlignedMapSource = { ...base, kind: 'legacy-normal', normal: image([190, 130, 220, 255]), roughness: image([255, 180, 0, 255]) };
    const first = buildAlignedMaps(source, geometry(), ['surface'], { surface: 'timber' });
    buildAlignedMaps(source, geometry(), ['surface'], { surface: 'glazed-tile' });
    expect(buildAlignedMaps(source, geometry(), ['surface'], { surface: 'timber' })).toEqual(first);
  });
  it('rejects missing and mismatched channels instead of silently resizing them', () => {
    expect(() => validateAlignedSource({ ...base, kind: 'dedicated-height' })).toThrow('height source');
    expect(() => validateAlignedSource({ ...base, normal: new Uint8ClampedArray(16) })).toThrow('dimensions');
    expect(() => validateMaterialAssignments({ absent: 'timber' }, ['surface'])).toThrow('Unknown material surface');
  });
});

describe('shared prediction fields', () => {
  it('removes broad height/roughness drift while preserving an aligned local feature', () => {
    const raw = image([180, 80, 0, 255]), mask = new Uint8Array(size * size).fill(1);
    for (let y = 0; y < size; y++) { raw[pixel(16, y)] = 230; raw[pixel(16, y) + 1] = 150; }
    const source = alignedHeightSource(raw, mask, size, 'fixture');
    expect(source.height![pixel(8)]).toBe(128);
    expect(source.roughness![pixel(8) + 1]).toBe(128);
    expect(source.height![pixel(16)]).toBeGreaterThan(160);
    expect(source.roughness![pixel(16) + 1]).toBeGreaterThan(160);
  });
  it('stores source descriptions without serializing the image arrays into run JSON', () => {
    const source = { ...base, kind: 'dedicated-height' as const, height: image([128, 128, 128, 255]) };
    const maps = buildAlignedMaps(source, geometry(), ['surface'], {});
    const meta = pbrMetadata({ ...maps, source, size, tiles: 0, cost: 0, seconds: 0 });
    expect(meta.source?.height).toBe(true);
    expect(JSON.stringify(meta).length).toBeLessThan(400);
  });
  it('leaves ambiguous, painted timber and bare chrome names for explicit assignment', () => {
    expect(suggestMaterialPreset('glazed tile floor')).toBe('glazed-tile');
    expect(suggestMaterialPreset('painted steel railing')).toBe('painted-metal');
    expect(suggestMaterialPreset('painted timber window frame')).toBeUndefined();
    expect(suggestMaterialPreset('chrome tap')).toBeUndefined();
  });

  it('decomposes consolidated albedo + geometry into metallic, roughness, POM height, refined normal and edge wear, and unpacks separate linear maps', () => {
    // Left half (`part = 0`, 'steel beam'): brushed metallic grey with a rusty patch at x = 4..7 and convex ridge at x = 12.
    // Right half (`part = 1`, 'sandstone wall'): warm dielectric stone.
    const albedo = image([170, 174, 180, 255]);
    const mask = new Uint8Array(size * size).fill(1);
    const curv = new Float32Array(size * size);
    const open = new Float32Array(size * size).fill(0.85);
    const geom = geometry(true);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const p = y * size + x, i = 4 * p;
        if (x >= size / 2) {
          albedo.set([196, 168, 132, 255], i);   // dielectric sandstone
        } else if (x >= 4 && x <= 7) {
          albedo.set([138, 72, 34, 255], i);     // oxidized rust patch on steel -> non-metallic & rough!
        } else if (x === 12) {
          curv[p] = 0.85;                        // exposed convex steel flange -> worn shiny ridge
        }
      }
    }

    const src = estimateIntrinsicPbr(albedo, mask, geom, 'fixture', {
      size,
      labels: ['steel beam', 'sandstone wall'],
      openness: open,
      curvature: curv,
    });
    const built = buildAlignedMaps(src, geom, ['steel beam', 'sandstone wall'], {});
    const cleanSteel = pixel(10, 16);
    const rustySteel = pixel(5, 16);
    const wornRidge = pixel(12, 16);
    const sandstone = pixel(24, 16);

    // Clean steel reads strongly metallic (> 200) and smooth; rust drops metallic (< 70) and roughens; sandstone stays 0 metallic!
    expect(built.orm[cleanSteel + 2]).toBeGreaterThan(200);
    expect(built.orm[rustySteel + 2]).toBeLessThan(70);
    expect(built.orm[rustySteel + 1]).toBeGreaterThan(built.orm[cleanSteel + 1] + 25);
    expect(built.orm[wornRidge + 1]).toBeLessThanOrEqual(built.orm[cleanSteel + 1]);
    expect(built.orm[sandstone + 2]).toBe(0);

    // Separate linear channels match ORM packing pixel for pixel while retaining POM height
    const sep = unpackLinearPbrChannels({ ...built, size, source: src });
    expect(sep.metalness[cleanSteel]).toBe(built.orm[cleanSteel + 2]);
    expect(sep.roughness[cleanSteel]).toBe(built.orm[cleanSteel + 1]);
    expect(sep.occlusion[cleanSteel]).toBe(255);
    expect(sep.height[cleanSteel + 3]).toBe(255);
  });
});
