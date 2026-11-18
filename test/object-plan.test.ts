import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';
import { MATERIAL_PRESETS } from '../src/core/material-presets';
import { fibonacciSphereViews, objectEyes, objectFeatureViews } from '../src/core/object-plan';
import type { Level } from '../src/core/scene';
import { suggestPresetsFromWeights, surfaceWeights } from '../src/core/surface-weights';
import { viewDirection } from '../src/core/views';
import { prompts } from '../src/providers/models';

/** A discrete multi-part vehicle/weapon prop floating in space with no walkable floor: hull, barrel, wheel wells, tarp and face visor. */
function makePropLevel(): Level {
  const parts: [THREE.BufferGeometry, string][] = [
    [new THREE.BoxGeometry(1.4, 0.7, 2.4), 'armour chassis'],
    [new THREE.CylinderGeometry(0.08, 0.08, 1.4, 16).rotateX(Math.PI / 2).translate(0, 0.25, -1.7), 'brushed steel barrel'],
    [new THREE.CylinderGeometry(0.32, 0.32, 0.25, 16).rotateZ(Math.PI / 2).translate(0.78, -0.25, 0.7), 'rubber wheel'],
    [new THREE.CylinderGeometry(0.32, 0.32, 0.25, 16).rotateZ(Math.PI / 2).translate(-0.78, -0.25, 0.7), 'rubber wheel'],
    [new THREE.SphereGeometry(0.28, 16, 12).translate(0, 0.55, 0.2), 'organic creature face'],
    [new THREE.BoxGeometry(0.9, 0.12, 0.8).translate(0, 0.42, 0.8), 'canvas tarp cover'],
  ];
  const labels = parts.map(([, name]) => name);
  const geos = parts.map(([g], k) => {
    const n = g.toNonIndexed();
    const uv = n.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (k + uv.getX(i) * 0.9) / parts.length, uv.getY(i) * 0.9);
    n.setAttribute('label', new THREE.Float32BufferAttribute(new Float32Array(n.getAttribute('position').count).fill(k), 1));
    return n;
  });
  const geometry = mergeGeometries(geos)!;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const bvh = new MeshBVH(geometry);
  const pos = geometry.getAttribute('position').array;
  let area = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < pos.length / 9; t++) {
    a.fromArray(pos, 9 * t); b.fromArray(pos, 9 * t + 3); c.fromArray(pos, 9 * t + 6);
    area += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return { name: 'rover-prop', labels, geometry, bvh, bounds: geometry.boundingBox!.clone(), triangles: pos.length / 9, surfaceArea: area, mode: 'object' };
}

describe('objectEyes and fibonacciSphereViews', () => {
  const level = makePropLevel();
  const centre = level.bounds.getCenter(new THREE.Vector3());
  const radius = level.bounds.getSize(new THREE.Vector3()).length() / 2;

  it('encloses the asset across upper, equatorial and underside hemispheres without sitting inside the mesh', () => {
    const eyes = objectEyes(level, 36);
    expect(eyes.length).toBe(36);
    let top = 0, bottom = 0, mid = 0;
    for (const e of eyes) {
      expect(e.distanceTo(centre)).toBeGreaterThan(radius * 1.4);
      const y = (e.y - centre.y) / e.distanceTo(centre);
      if (y > 0.5) top++;
      else if (y < -0.5) bottom++;
      else mid++;
    }
    expect(top).toBeGreaterThanOrEqual(6);
    expect(bottom).toBeGreaterThanOrEqual(6);
    expect(mid).toBeGreaterThanOrEqual(12);

    const views = fibonacciSphereViews(level, 32);
    expect(views.length).toBeGreaterThan(36);
    for (const v of views) {
      expect(Number.isFinite(v.yaw)).toBe(true);
      expect(Number.isFinite(v.pitch)).toBe(true);
      expect(v.fov).toBeGreaterThanOrEqual(38);
      expect(v.fov).toBeLessThanOrEqual(72);
      // Every sphere camera aims inward toward the bounding center
      const toCentre = centre.clone().sub(new THREE.Vector3(...v.position)).normalize();
      expect(viewDirection(v).dot(toCentre)).toBeGreaterThan(0.98);
    }
  });
});

describe('objectFeatureViews', () => {
  const level = makePropLevel();

  it('places dedicated close-up probes on user-tagged parts (barrel, face, wheel) and high-curvature features', () => {
    const unfocused = objectFeatureViews(level, { maxTargets: 6 });
    const focused = objectFeatureViews(level, { focusParts: ['barrel', 'face', 'wheel'], maxTargets: 6 });
    expect(focused.length).toBeGreaterThan(unfocused.length);

    // At least one probe aims directly near the barrel at (0, 0.25, -1.7)
    const barrelTarget = new THREE.Vector3(0, 0.25, -1.7);
    const hitsBarrel = focused.some((v) => {
      const origin = new THREE.Vector3(...v.position);
      const toBarrel = barrelTarget.clone().sub(origin).normalize();
      return origin.distanceTo(barrelTarget) < 4 && viewDirection(v).dot(toBarrel) > 0.92;
    });
    expect(hitsBarrel).toBe(true);
  });
});

describe('object material presets and prompts', () => {
  it('exposes hard-surface, metal, fabric and organic presets and maps object parts to them', () => {
    for (const key of ['hard-surface', 'metal', 'fabric', 'organic'] as const) {
      expect(MATERIAL_PRESETS[key]).toBeDefined();
    }
    expect(MATERIAL_PRESETS.metal.metalness).toBeGreaterThan(0.7);
    expect(MATERIAL_PRESETS['hard-surface'].metalness).toBe(0);
    expect(MATERIAL_PRESETS.fabric.roughness).toBeGreaterThan(0.8);

    const level = makePropLevel();
    const sw = surfaceWeights(level);
    const presets = suggestPresetsFromWeights(level.labels, level.geometry.getAttribute('label').array, sw.faceClass);
    expect(presets['armour chassis']).toBe('hard-surface');
    expect(presets['brushed steel barrel']).toBe('metal');
    expect(presets['canvas tarp cover']).toBe('fabric');
    expect(presets['organic creature face']).toBe('organic');
  });

  it('uses clean discrete-object silhouette wording without architectural windows, doors or paving', () => {
    const text = prompts.caption({
      look: 'weathered painted steel patrol rover with rubber tyres',
      roofLook: '',
      parts: 'armour chassis (center), steel barrel (left)',
      mode: 'first',
      floor: false,
      overcast: true,
      object: true,
    });
    expect(text).toMatch(/silhouette/);
    expect(text).not.toMatch(/windows, doors, shutters/);
    expect(text).not.toMatch(/bare paving/);
  });
});
