import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { mipBytes, validateFloorDetail, type FloorDetailSpec } from '../src/core/floor-detail';
import { layoutHash } from '../src/core/layout';

const geometry = new THREE.PlaneGeometry(1, 1).toNonIndexed();
const level = { geometry, labels: ['wall', 'floor'] };
const spec: FloorDetailSpec = { label: 'floor', layoutHash: layoutHash(geometry.getAttribute('uv').array),
  packedUrl: '/packed.png', protectUrl: '/protect.png', statisticsUrl: '/stats.png',
  regions: 169, spanMetres: 1, heightMetres: .002, sourceAtlasSize: 2048 };

describe('paint-safe floor material assignment', () => {
  it('binds the explicitly named surface and its reviewed UV layout', () => {
    expect(validateFloorDetail(spec, level)).toBe(1);
  });
  it('rejects a mask after repacking the atlas', () => {
    const geometry = level.geometry.clone();
    const uv = geometry.getAttribute('uv'); uv.setX(0, uv.getX(0) + .25);
    expect(() => validateFloorDetail(spec, { ...level, geometry })).toThrow('another UV layout');
  });
  it('never silently applies floor detail to an unrelated material', () => {
    expect(() => validateFloorDetail(spec, { ...level, labels: ['wall', 'ceiling'] })).toThrow('absent');
  });
  it.each([{ spanMetres: 0 }, { heightMetres: NaN }, { sourceAtlasSize: 0 }, { regions: 256 }])('rejects invalid material values %o', change => {
    expect(() => validateFloorDetail({ ...spec, ...change }, level)).toThrow('invalid');
  });
  it('accounts for packed fields, a one-channel mask and unmipped region statistics', () => {
    expect(mipBytes(1024, 1024, 4) + mipBytes(1024, 1024, 1) + 256 * 4).toBe(6991529);
  });
});
