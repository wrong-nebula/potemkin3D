import * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import { PAINTED } from './atlas';

/**
 * What is still wrong with a painted texture, where a player can see it. Two kinds of defect can be read off the
 * texture itself: cells nothing painted, and cells painted from so far off or at such a low angle that a camera at
 * the best spot a player can stand in would capture them several times better (those are the smears). The clean-up
 * pass aims cameras at clusters of both and paints only them.
 */
export interface DefectMap {
  grid: number;
  /** Per cell: 0 fine, or not seen by any player; 1 unpainted; 2 poorly captured. */
  cls: Uint8Array;
  /** Cells a player can see, and how many of them are unpainted or poorly captured. */
  seen: number;
  unpainted: number;
  poor: number;
}

export const UNPAINTED = 1, POOR = 2;

/**
 * @param pos world position per texture cell (xyz + anything), grid x grid
 * @param nrm world normal per cell (a = 0 where no triangle covers the cell)
 * @param quality capture quality per cell (cos / distance; 0 = unpainted, and so is the finishing fill's token
 *   quality), as the texture stores it
 * @param eyes where players' eyes can be
 * @param ratio a painted cell is poor when its quality is under this share of the best a player's eye could get
 * @param reach the furthest a surface counts as seen from (m)
 * @param cap per cell, the capture quality at which the texture holds all the detail it can there (`fullDetail`):
 *   a cell captured that well is fine however much closer a player could get
 */
export function defectMap(pos: ArrayLike<number>, nrm: ArrayLike<number>, quality: ArrayLike<number>, bvh: MeshBVH,
  eyes: THREE.Vector3[], ratio = 0.4, reach = 60, cap?: ArrayLike<number>): DefectMap {
  const n = pos.length / 4;
  const cls = new Uint8Array(n);
  const p = new THREE.Vector3(), normal = new THREE.Vector3();
  const ray = new THREE.Ray();
  const order = eyes.map((e) => ({ e, d: 0 }));
  let seen = 0, unpainted = 0, poor = 0;
  for (let i = 0; i < n; i++) {
    if (nrm[4 * i + 3] < 0.5) continue;
    p.set(pos[4 * i], pos[4 * i + 1], pos[4 * i + 2]);
    normal.set(nrm[4 * i], nrm[4 * i + 1], nrm[4 * i + 2]);
    for (const o of order) o.d = o.e.distanceTo(p);
    order.sort((a, b) => a.d - b.d);
    // the best a player's eye could capture this cell at: nearest eyes first, and none further off can beat 1 / distance
    let best = 0;
    for (const { e, d } of order) {
      if (d > reach || 1 / Math.max(d, 0.5) <= best) break;
      if (d < 0.1) continue;
      ray.origin.copy(e);
      ray.direction.subVectors(p, e).divideScalar(d);
      const cos = Math.abs(normal.dot(ray.direction));
      if (cos < 0.15 || cos / Math.max(d, 0.5) <= best) continue;
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
      if (hit && hit.distance < d - 0.05) continue;
      best = cos / Math.max(d, 0.5);
      if (!(quality[i] > PAINTED)) break;   // unpainted: seen at all is all that matters
    }
    if (!(best > 0)) continue;
    seen++;
    if (!(quality[i] > PAINTED)) { cls[i] = UNPAINTED; unpainted++; } else if (quality[i] < ratio * Math.min(best, cap?.[i] || Infinity)) { cls[i] = POOR; poor++; }
  }
  return { grid: Math.round(Math.sqrt(n)), cls, seen, unpainted, poor };
}

/**
 * The capture quality (cos / distance) at which a view puts one of its pixels on each texel: more than that and the
 * texture cannot hold the extra detail.
 * @param density texels per metre at each cell (core/planner.ts `cellDensity`)
 * @param pixelsPerMetre view pixels across one metre seen head-on from 1 m
 * @returns per cell, and the median over the cells that have a density
 */
export function fullDetail(density: ArrayLike<number>, pixelsPerMetre: number): { cells: Float32Array; median: number } {
  const cells = new Float32Array(density.length);
  const known: number[] = [];
  for (let i = 0; i < cells.length; i++) if (density[i] > 0) { cells[i] = density[i] / pixelsPerMetre; known.push(cells[i]); }
  known.sort((a, b) => a - b);
  return { cells, median: known.length ? known[known.length >> 1] : Infinity };
}
