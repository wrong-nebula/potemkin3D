import * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import { splitParts } from './parts';
import { lookAt, type ViewSpec } from './views';

/**
 * The prop pass: a prop (a barrel, a bench, a crate) painted on its own by the same model that paints the room,
 * from a few cameras standing round it. Each camera's render carries a note that says what the object is (core/
 * notes.ts) and comes with the earlier pictures that show it (core/references.ts), and only the prop's own pixels
 * go onto the level. Room-wide views see a prop small, from one side, and often paint the wall or the paving across
 * it; a camera that is there for the prop sees it large and is told what it is.
 */

/**
 * Cameras round a prop: player spots that see its middle with nothing in the way, near enough to see it large and
 * far enough to hold it in frame, spread round it as evenly as the spots allow.
 * @param box the prop's bounds; `eyes`: where players' eyes can be
 * @param count how many cameras at most
 * @param samples points on the prop's own surface. With them a spot must see some of them, and the first
 *   camera is the one that sees the most, and the others must see at least 0.6 of what it sees: the ray to the middle
 *   (which allows the prop's own radius of slack) lets a spot behind a gantry or under a mezzanine pass for a prop
 *   several metres across.
 */
export function propCameras(box: THREE.Box3, eyes: THREE.Vector3[], bvh: MeshBVH, count = 3, samples?: THREE.Vector3[]): ViewSpec[] {
  const centre = box.getCenter(new THREE.Vector3()), radius = Math.max(0.15, box.getSize(new THREE.Vector3()).length() / 2);
  const near = Math.max(1.2, 1.6 * radius), far = Math.max(6, 4 * radius);
  const ray = new THREE.Ray();
  const spots: { eye: THREE.Vector3; d: number; azimuth: number; seen: number }[] = [];
  for (const eye of eyes) {
    const d = eye.distanceTo(centre);
    if (d < near || d > far) continue;
    ray.origin.copy(eye);
    ray.direction.subVectors(centre, eye).divideScalar(d);
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
    if (hit && hit.distance < d - radius - 0.1) continue;   // something else stands in the way
    let seen = 1;
    if (samples?.length) {
      let n = 0;
      for (const s of samples) {
        const ds = eye.distanceTo(s);
        ray.direction.subVectors(s, eye).divideScalar(ds);
        const h = bvh.raycastFirst(ray, THREE.DoubleSide);
        if (!h || h.distance > ds - 0.12) n++;
      }
      seen = n / samples.length;
      if (seen < 0.08) continue;   // next to nothing of it in sight from here
    }
    spots.push({ eye, d, azimuth: Math.atan2(eye.x - centre.x, eye.z - centre.z), seen });
  }
  if (!spots.length) return [];
  if (samples?.length) {
    // Of a truck, no spot sees half the points: its far side, its underside and the faces inside it are never in
    // sight. So a spot is held to what the best spot sees, not to a share of the whole.
    const most = Math.max(...spots.map((s) => s.seen));
    for (let i = spots.length - 1; i >= 0; i--) if (spots[i].seen < 0.6 * most) spots.splice(i, 1);
  }
  const apart = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  const picked = [spots.reduce((best, s) => (samples?.length ? (s.seen > best.seen + 0.02 || (Math.abs(s.seen - best.seen) <= 0.02 && s.d < best.d)) : s.d < best.d) ? s : best)];
  while (picked.length < count) {
    // the spot furthest round the prop from those taken; of equals, the nearer
    let best: (typeof spots)[number] | undefined, bestGap = 0;
    for (const s of spots) {
      const gap = Math.min(...picked.map((p) => apart(s.azimuth, p.azimuth)));
      if (gap > bestGap + 1e-3 || (best && Math.abs(gap - bestGap) <= 1e-3 && s.d < best.d)) { best = s; bestGap = gap; }
    }
    if (!best || bestGap < THREE.MathUtils.degToRad(40)) break;   // no new side of it to see
    picked.push(best);
  }
  return picked.map((s, k) => {
    // the prop fills a little over half the frame's height
    const fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(radius / s.d)) * 1.7, 30, 85);
    return { ...lookAt(s.eye, centre, fov, k), kind: 'clean' as const };
  });
}

/** The bounds of a set of triangle corners (3 numbers each). */
export function boundsOf(position: ArrayLike<number>): THREE.Box3 {
  const box = new THREE.Box3(), p = new THREE.Vector3();
  for (let i = 0; i < position.length; i += 3) box.expandByPoint(p.set(position[i], position[i + 1], position[i + 2]));
  return box;
}

/** A prop made of parts: the parts it has a share in (the one with the most surface first), its bounds, points on it. */
export interface PropGroup {
  labels: number[];
  box: THREE.Box3;
  area: number;
  samples: THREE.Vector3[];
}

/**
 * Props out of parts, by where they stand. A part is a name, not an object: "oil drums" may be two clusters at
 * opposite ends of a hall, and a truck is three parts (body, tyres, load). Each part is split into its connected
 * shapes, and shapes whose bounds are within `gap` metres of one another, of whatever part, make one prop. Props
 * under `minSize` metres across (a stool, a lamp on a stand) are left out: too small for cameras of their own.
 * @param parts each part's label and the world-space corners of its triangles (9 numbers a triangle)
 */
export function propGroups(parts: { label: number; position: ArrayLike<number> }[], gap = 0.4, minSize = 1.2): PropGroup[] {
  const shapes: { label: number; box: THREE.Box3; area: number; points: THREE.Vector3[] }[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (const part of parts) {
    const split = splitParts(part.position);
    const mine = split.parts.map((s) => ({ label: part.label, box: new THREE.Box3(), area: s.area, points: [] as THREE.Vector3[] }));
    for (let t = 0; t < split.of.length; t++) {
      a.fromArray(part.position, 9 * t); b.fromArray(part.position, 9 * t + 3); c.fromArray(part.position, 9 * t + 6);
      const s = mine[split.of[t]];
      s.box.expandByPoint(a).expandByPoint(b).expandByPoint(c);
      s.points.push(new THREE.Vector3().add(a).add(b).add(c).divideScalar(3));
    }
    shapes.push(...mine);
  }
  const parent = shapes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const apart = (p: THREE.Box3, q: THREE.Box3) => Math.hypot(Math.max(0, p.min.x - q.max.x, q.min.x - p.max.x),
    Math.max(0, p.min.y - q.max.y, q.min.y - p.max.y), Math.max(0, p.min.z - q.max.z, q.min.z - p.max.z));
  for (let i = 0; i < shapes.length; i++) for (let j = i + 1; j < shapes.length; j++) {
    if (find(i) !== find(j) && apart(shapes[i].box, shapes[j].box) <= gap) parent[find(i)] = find(j);
  }
  const groups = new Map<number, { byLabel: Map<number, number>; box: THREE.Box3; area: number; points: THREE.Vector3[] }>();
  shapes.forEach((s, i) => {
    const root = find(i);
    let g = groups.get(root);
    if (!g) groups.set(root, (g = { byLabel: new Map(), box: new THREE.Box3(), area: 0, points: [] }));
    g.byLabel.set(s.label, (g.byLabel.get(s.label) ?? 0) + s.area);
    g.box.union(s.box);
    g.area += s.area;
    g.points.push(...s.points);
  });
  return [...groups.values()]
    .filter((g) => g.box.getSize(a).length() >= minSize)
    .sort((x, y) => y.area - x.area)
    .map((g) => {
      const step = Math.max(1, Math.floor(g.points.length / 48));   // a few dozen points say what a camera sees of it
      return { labels: [...g.byLabel.entries()].sort((x, y) => y[1] - x[1]).map(([l]) => l), box: g.box, area: g.area,
        samples: g.points.filter((_, k) => k % step === 0) };
    });
}
