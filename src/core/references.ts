import * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import { makeCamera, type ViewSpec } from './views';

/**
 * Reference pictures for a view that fills gaps. A model that takes several images can be shown how the place
 * looks from elsewhere: the earlier views that look at the spot this view is to paint. With one to three of them a
 * gap's content comes out as it is in those views (a table's base as the wood of the table, not as white blocks).
 * With many, the picture stops being an edit of the view and becomes a new picture of the room, so few are sent.
 */

/**
 * Where a view's unpainted surface is: the mean position of its unpainted pixels seen at a usable angle, or
 * nothing when there are too few to speak of.
 * @param pos per pixel: world position; `unknown`: 1 where the view shows surface nothing has painted;
 *   `cos`: how squarely each pixel's surface faces the camera
 */
export function focusOf(pos: ArrayLike<number>, unknown: ArrayLike<number>, cos: ArrayLike<number>, minShare = 0.005): [number, number, number] | undefined {
  let x = 0, y = 0, z = 0, n = 0;
  for (let i = 0; i < unknown.length; i++) {
    if (!unknown[i] || cos[i] < 0.3) continue;
    x += pos[4 * i]; y += pos[4 * i + 1]; z += pos[4 * i + 2];
    n++;
  }
  return n >= minShare * unknown.length ? [x / n, y / n, z / n] : undefined;
}

/**
 * The earlier views that look at a place: those that have it in frame with nothing in the way, the nearest and
 * those holding it nearest the middle of their picture first.
 */
export function pickReferences<T extends { spec: ViewSpec }>(focus: [number, number, number], earlier: T[], max: number, bvh?: MeshBVH): T[] {
  const p = new THREE.Vector3(), ray = new THREE.Ray();
  const scored: { v: T; score: number }[] = [];
  for (const v of earlier) {
    const cam = makeCamera(v.spec);
    p.set(...focus).project(cam);
    if (p.z < -1 || p.z > 1 || Math.abs(p.x) > 0.85 || Math.abs(p.y) > 0.85) continue;
    const off = Math.max(Math.abs(p.x), Math.abs(p.y));
    const d = cam.position.distanceTo(p.set(...focus));
    if (d < 0.3) continue;
    if (bvh) {
      ray.origin.copy(cam.position);
      ray.direction.copy(p).sub(cam.position).normalize();
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
      if (hit && hit.distance < d - Math.max(0.4, 0.1 * d)) continue;   // a wall stands between
    }
    scored.push({ v, score: d * (1 + 0.5 * off) });
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, Math.max(0, max)).map((s) => s.v);
}
