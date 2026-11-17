/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import { describe, expect, it } from 'vitest';
import { quote } from '../src/core/pipeline';
import { detailOf, MODELS, priceOf } from '../src/providers/models';
import type { ViewSpec } from '../src/core/views';

const view = (id: number, kind?: ViewSpec['kind']): ViewSpec => ({ id, position: [0, 0, 0], yaw: 0, pitch: 0, fov: 90, kind });
const plan = { views: [view(0), view(1), view(2, 'aerial'), view(3, 'roof')], waves: [[0], [1], [2], [3]] };
const models = { firstModel: 'flux3-klein', fillModel: 'fibo2' };   // $0.009 and $0.04

describe('quote', () => {
  it('counts the first view at the first-view model and the rest at the dearer one', () => {
    const q = quote(plan, models);
    expect(q.cost).toBeCloseTo(0.009 + 3 * 0.04, 6);
    expect(q.again).toBe(0);
    expect(q.seconds).toBe(40);
  });

  it('adds hole views at the fill model', () => {
    expect(quote(plan, { ...models, holes: 5 }).cost).toBeCloseTo(0.009 + 3 * 0.04 + 5 * 0.04, 6);
  });

  it('adds a second go for every view but the roof views', () => {
    const q = quote(plan, { ...models, secondGoes: 1 });
    expect(q.again).toBeCloseTo(3 * 0.04, 6);
    expect(q.cost).toBeCloseTo(0.009 + 3 * 0.04 + 3 * 0.04, 6);
    expect(q.seconds).toBe(70);
  });

  it('counts floor views at the first-view model, with no second go', () => {
    const floors = { views: [view(0, 'floor'), view(1, 'floor'), view(2), view(3)], waves: [[0], [1], [2], [3]] };
    const q = quote(floors, { ...models, secondGoes: 1 });
    expect(q.again).toBeCloseTo(2 * 0.04, 6);
    expect(q.cost).toBeCloseTo(2 * 0.009 + 2 * 0.04 + 2 * 0.04, 6);
  });

  it('prices views by their size where the model does, and the plane test at a megapixel at most', () => {
    expect(quote(plan, { ...models, viewSize: 2048 }).cost).toBeCloseTo(0.014 + 3 * 0.04, 6);
    const planes = quote(plan, { ...models, viewSize: 2048, planes: true }).planes;
    expect(planes).toBeCloseTo(4 * 0.01 * 1.048576, 6);         // 1024 x 1024 px a call, not 2048 x 2048
  });
});

describe('view sizes', () => {
  it('knows what a model charges and really paints at a size', () => {
    expect(priceOf(MODELS['flux3-klein'], 1024)).toBe(0.009);
    expect(priceOf(MODELS['flux3-klein'], 2048)).toBe(0.014);
    expect(priceOf(MODELS.fibo2, 2048)).toBe(0.04);
    expect(detailOf(MODELS['flux3-klein'], 2048)).toBe(1);
    expect(detailOf(MODELS.fibo2, 2048)).toBe(0.5);              // a megapixel, scaled up
    expect(detailOf(MODELS.fibo2, 1024)).toBe(1);
  });
});
