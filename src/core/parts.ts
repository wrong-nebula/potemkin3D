/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import * as THREE from 'three';

/**
 * Parts of a level that came without part names (one mesh, one material): its connected shapes. Triangles that
 * share a corner belong to the same shape, so a house built as one box is one part, and a bollard standing on the
 * ground is another. Each part can then be given a name (core/naming.ts), which is what the prompts read.
 */
export interface Part {
  /** Surface area in m². */
  area: number;
  /** Bounding sphere, for pointing a camera at it. */
  center: [number, number, number];
  radius: number;
  triangles: number;
}

export interface PartSplit {
  /** Part index per triangle; parts are numbered from the largest surface down. */
  of: Int32Array;
  parts: Part[];
}

/**
 * @param position world-space corners of non-indexed triangles (9 numbers each)
 * @param weld corners closer than this (m) count as the same corner
 */
export function splitParts(position: ArrayLike<number>, weld = 0.001): PartSplit {
  const tris = Math.floor(position.length / 9);
  const parent = new Int32Array(tris);
  for (let t = 0; t < tris; t++) parent[t] = t;
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const first = new Map<string, number>();   // corner -> a triangle that has it
  for (let t = 0; t < tris; t++) {
    for (let c = 0; c < 3; c++) {
      const i = 9 * t + 3 * c;
      const key = `${Math.round(position[i] / weld)},${Math.round(position[i + 1] / weld)},${Math.round(position[i + 2] / weld)}`;
      const other = first.get(key);
      if (other === undefined) first.set(key, t);
      else parent[find(t)] = find(other);
    }
  }
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), tri = new THREE.Triangle();
  const groups = new Map<number, { area: number; box: THREE.Box3; triangles: number[] }>();
  for (let t = 0; t < tris; t++) {
    const root = find(t);
    let g = groups.get(root);
    if (!g) groups.set(root, (g = { area: 0, box: new THREE.Box3(), triangles: [] }));
    a.fromArray(position, 9 * t); b.fromArray(position, 9 * t + 3); c.fromArray(position, 9 * t + 6);
    g.area += tri.set(a, b, c).getArea();
    g.box.expandByPoint(a).expandByPoint(b).expandByPoint(c);
    g.triangles.push(t);
  }
  const sorted = [...groups.values()].sort((x, y) => y.area - x.area);
  const of = new Int32Array(tris);
  const sphere = new THREE.Sphere();
  const parts = sorted.map((g, k) => {
    for (const t of g.triangles) of[t] = k;
    g.box.getBoundingSphere(sphere);
    return { area: g.area, center: sphere.center.toArray() as [number, number, number], radius: sphere.radius, triangles: g.triangles.length };
  });
  return { of, parts };
}

/** A name fit for a prompt from whatever a model answered: a few plain lower-case words, or '' if it isn't one. */
export function cleanName(answer: string): string {
  const line = answer.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const words = line.toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/\s+/).filter(Boolean)
    .filter((w) => !/^(a|an|the|pink|highlighted|gray|grey|untextured|shape|blockout|it|is|this|likely|probably)$/.test(w));
  return words.length && words.length <= 5 ? words.join(' ') : '';
}
