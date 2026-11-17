import type * as THREE from 'three';

/**
 * The part pass: parts the room-wide painting cannot finish are textured on their own. A mesh-texturing model is
 * given one part (the stairs, the window frames, the beams) as a mesh of its own and returns it textured on every
 * face, in one material; that texture is then copied into the level's texture for the part's texels.
 *
 * What the painting leaves is mostly thin, uniform structure that no camera in the room sees well. A model that
 * works on the object, not on views of the room, has no such blind sides, and cannot paint one beam black and the
 * next one gray.
 */
export interface PartMesh {
  /** Index of the part in the level's labels. */
  label: number;
  /** World-space corners of its triangles (9 numbers each), their normals, and their texture coordinates in the level's layout (6 each). */
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
}

/** The triangles of one part of a level, as a mesh of their own. */
export function partMesh(geometry: THREE.BufferGeometry, label: number): PartMesh {
  const pos = geometry.getAttribute('position'), nrm = geometry.getAttribute('normal'), uv = geometry.getAttribute('uv');
  const lab = geometry.getAttribute('label'), index = geometry.index;
  const tris = (index ? index.count : pos.count) / 3;
  const P: number[] = [], N: number[] = [], U: number[] = [];
  for (let t = 0; t < tris; t++) {
    const v0 = index ? index.getX(3 * t) : 3 * t;
    if (Math.round(lab.getX(v0)) !== label) continue;
    for (let k = 0; k < 3; k++) {
      const v = index ? index.getX(3 * t + k) : 3 * t + k;
      P.push(pos.getX(v), pos.getY(v), pos.getZ(v));
      N.push(nrm.getX(v), nrm.getY(v), nrm.getZ(v));
      U.push(uv.getX(v), uv.getY(v));
    }
  }
  return { label, position: new Float32Array(P), normal: new Float32Array(N), uv: new Float32Array(U) };
}

/** A binary glTF of a triangle soup: three corners per triangle, in order, with normals and no material. */
export function toGlb(position: Float32Array, normal: Float32Array): ArrayBuffer {
  const n = position.length / 3;
  const index = new Uint32Array(n);
  for (let i = 0; i < n; i++) index[i] = i;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.length; i++) { lo[i % 3] = Math.min(lo[i % 3], position[i]); hi[i % 3] = Math.max(hi[i % 3], position[i]); }
  const parts = [new Uint8Array(position.buffer, position.byteOffset, position.byteLength), new Uint8Array(normal.buffer, normal.byteOffset, normal.byteLength),
    new Uint8Array(index.buffer)];
  const offsets: number[] = [];
  let length = 0;
  for (const p of parts) { offsets.push(length); length += p.byteLength; }
  const json = JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
    buffers: [{ byteLength: length }],
    bufferViews: parts.map((p, k) => ({ buffer: 0, byteOffset: offsets[k], byteLength: p.byteLength, target: k < 2 ? 34962 : 34963 })),
    accessors: [{ bufferView: 0, componentType: 5126, count: n, type: 'VEC3', min: lo, max: hi },
      { bufferView: 1, componentType: 5126, count: n, type: 'VEC3' }, { bufferView: 2, componentType: 5125, count: n, type: 'SCALAR' }],
  });
  const text = new TextEncoder().encode(json);
  const jsonLength = text.length + ((4 - (text.length % 4)) % 4);
  const out = new ArrayBuffer(12 + 8 + jsonLength + 8 + length);
  const view = new DataView(out), bytes = new Uint8Array(out);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, out.byteLength, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20, 20 + jsonLength);
  bytes.set(text, 20);
  view.setUint32(20 + jsonLength, length, true); view.setUint32(24 + jsonLength, 0x004e4942, true);
  let at = 28 + jsonLength;
  for (const p of parts) { bytes.set(p, at); at += p.byteLength; }
  return out;
}

/** Corner positions moved to their bounding box's centre and scaled by its longest side: comparable between a part and what came back for it. */
export function normalised(position: ArrayLike<number>): Float32Array {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.length; i++) { lo[i % 3] = Math.min(lo[i % 3], position[i]); hi[i % 3] = Math.max(hi[i % 3], position[i]); }
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const out = new Float32Array(position.length);
  for (let i = 0; i < position.length; i++) out[i] = (position[i] - (lo[i % 3] + hi[i % 3]) / 2) / size;
  return out;
}

/**
 * For each corner of our part, the corner of the returned mesh that is the same point. The models return the same
 * triangles in the same order (moved and scaled) when they can; when one drops or adds triangles, each of ours is
 * matched to the nearest of theirs by its centre, and each corner to the nearest corner of that triangle.
 * @param ours corner positions, 9 per triangle
 * @param theirs the same for the returned mesh (any position and scale)
 * @returns per corner of ours, a corner index into theirs; `exact` when the order was kept
 */
export function matchCorners(ours: ArrayLike<number>, theirs: ArrayLike<number>): { corner: Int32Array; exact: boolean; worst: number } {
  const a = normalised(ours), b = normalised(theirs);
  const n = a.length / 3;
  const corner = new Int32Array(n);
  const d2 = (i: number, j: number) => (a[3 * i] - b[3 * j]) ** 2 + (a[3 * i + 1] - b[3 * j + 1]) ** 2 + (a[3 * i + 2] - b[3 * j + 2]) ** 2;
  if (a.length === b.length) {
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, d2(i, i));
    if (worst < 1e-4) {   // within 1% of the part's size
      for (let i = 0; i < n; i++) corner[i] = i;
      return { corner, exact: true, worst: Math.sqrt(worst) };
    }
  }
  const theirTris = b.length / 9;
  const centre = (p: Float32Array, t: number, k: number) => (p[9 * t + k] + p[9 * t + 3 + k] + p[9 * t + 6 + k]) / 3;
  let worst = 0;
  for (let t = 0; t < n / 3; t++) {
    let best = 0, bestD = Infinity;
    for (let s = 0; s < theirTris; s++) {
      const d = (centre(a, t, 0) - centre(b, s, 0)) ** 2 + (centre(a, t, 1) - centre(b, s, 1)) ** 2 + (centre(a, t, 2) - centre(b, s, 2)) ** 2;
      if (d < bestD) { bestD = d; best = s; }
    }
    for (let k = 0; k < 3; k++) {
      let c = 3 * best, cD = Infinity;
      for (let m = 0; m < 3; m++) { const d = d2(3 * t + k, 3 * best + m); if (d < cD) { cD = d; c = 3 * best + m; } }
      corner[3 * t + k] = c;
      worst = Math.max(worst, cD);
    }
  }
  return { corner, exact: false, worst: Math.sqrt(worst) };
}

export interface PartStats { label: number; seen: number; unpainted: number; area: number; triangles: number }

/**
 * Which parts to texture on their own: those where a fair share of what players see is still unpainted, largest
 * amount first. Scenery is left to the painting: parts that make up much of the level (walls, floor, ceiling), and
 * parts built of a few huge faces (a house or a wall blocked out as one box). A texturing model given a house-sized
 * box paints it as a small object, and that lands on the wall as a smear.
 * @param minShare the least unpainted share of what is seen of a part
 * @param maxArea parts over this share of the level's surface are left out
 * @param maxFace parts whose triangles average more than this (m²) are left out
 */
export function pickParts(stats: PartStats[], totalArea: number, max: number, minShare = 0.1, maxArea = 0.02, maxFace = 3): number[] {
  return stats.filter((s) => s.seen >= 20 && s.unpainted / s.seen >= minShare && s.area <= maxArea * totalArea && s.area <= maxFace * Math.max(1, s.triangles))
    .sort((x, y) => y.unpainted - x.unpainted).slice(0, max).map((s) => s.label);
}
