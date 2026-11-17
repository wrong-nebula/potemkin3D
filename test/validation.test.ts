import { describe, expect, it } from 'vitest';
import { coverageOverlay, crossViewAgreement, imageAgreement, surfaceLowPass, type ValidationFrame } from '../src/core/validation';

function plane(id = 0, offset = 0): ValidationFrame {
  const width = 16, height = 16, color = new Uint8ClampedArray(1024), position = new Float32Array(1024), normal = new Float32Array(1024);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = 4 * (y * width + x);
    color.set([80 + (x % 3) * 25 + offset, 120 + offset, 160 + offset, 255], p);
    position.set([(x + .5) / 8 - 1, 1 - (y + .5) / 8, 0, 2], p); normal.set([0, 0, 1, 1], p);
  }
  return { id, width, height, color, position, normal, eye: [0, 0, 2], projection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
}

describe('multiview validation', () => {
  it('recovers an exactly matching surface and a known color shift', () => {
    const same = crossViewAgreement([plane(), plane(1)], { stride: 1 });
    expect(same.score.mae).toBe(0); expect(same.score.highBandCorrelation).toBeCloseTo(1);
    const shifted = crossViewAgreement([plane(), plane(1, 20)], { stride: 1 });
    expect(shifted.score.mae).toBeCloseTo(20); expect(shifted.score.lowBandMae).toBeCloseTo(20);
    expect(shifted.score.highBandMae).toBeCloseTo(0);
  });
  it('does not reward missing correspondences, other objects, or occluded points', () => {
    const a = plane(), b = plane(1);
    for (let p = 3; p < b.normal.length; p += 4) b.normal[p] = 2;
    expect(crossViewAgreement([a, b]).score.mae).toBeNull();
    for (let p = 3; p < b.normal.length; p += 4) b.normal[p] = 1;
    for (let p = 2; p < b.position.length; p += 4) b.position[p] = .8;
    expect(crossViewAgreement([a, b]).score.samples).toBe(0);
  });
  it('keeps filtering inside part boundaries', () => {
    const c = new Uint8ClampedArray([0,0,0,255, 255,255,255,255]), n = new Float32Array([0,0,1,1, 0,0,1,2]);
    expect([...surfaceLowPass(c, n, 2, 1)]).toEqual([0,0,0,255,255,255]);
  });
  it('reports support independently from held-out error and never treats fill as observed', () => {
    const a = plane(), eligible = new Uint8Array(256).fill(1), observed = new Uint8Array(256);
    expect(imageAgreement(a.color, a.color, a.normal, eligible, observed, 16, 16).mae).toBeNull();
    observed.fill(1, 0, 128);
    const s = imageAgreement(a.color, a.color, a.normal, eligible, observed, 16, 16);
    expect(s.mae).toBe(0); expect(s.support).toBe(.5);
    const before = a.color.slice(); coverageOverlay(a.color, eligible, observed);
    expect(a.color).toEqual(before);
  });
});
