// Where the level's stone has edges that could chip: the outward corners of blocks, steps, bases and gateways.
//
// A blockout's edges are perfect, which is the one thing old stone never is. The surface shader (sand.js) breaks
// them, and for that it has to know, at every pixel, how far the nearest such edge is. That is worked out here,
// once, when the level loads: every edge two faces share is looked at; where the faces meet at an angle and the
// corner points outwards, both faces are told so. Each triangle then carries, corner by corner, the distance in
// metres to each of its own edges that is one (and a large number for those that are not), which the GPU
// interpolates across it: the least of the three is the distance to the nearest chippable edge of that triangle.
//
// Not found, on purpose: inward corners (a wall meeting the floor: dirt gathers there, nothing breaks off), the
// soft creases of a round column, and the line where one solid stands on another without sharing an edge.
import * as THREE from 'three';

const FAR = 10;   // "no such edge": further than any chip reaches

/**
 * Gives every mesh an `edge` attribute (three numbers a corner). The meshes are taken as parts of one surface: an
 * edge whose two faces lie in different meshes (different texture pages) counts like any other.
 * @param angle faces meeting at less than this many degrees are one smooth surface
 */
export function markEdges(meshes, angle = 38) {
  const cosLimit = Math.cos(THREE.MathUtils.degToRad(angle));
  const faces = [];          // per triangle, over all meshes: its normal and centre
  const shared = new Map();  // an edge's two ends -> the triangles on it, as [face, which of its edges]
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const key = (v) => `${Math.round(v.x * 2000)},${Math.round(v.y * 2000)},${Math.round(v.z * 2000)}`;
  for (const mesh of meshes) {
    if (mesh.geometry.index) mesh.geometry = mesh.geometry.toNonIndexed();
    mesh.updateWorldMatrix(true, false);
    const pos = mesh.geometry.getAttribute('position');
    mesh.userData.firstFace = faces.length;
    for (let t = 0; t < pos.count / 3; t++) {
      a.fromBufferAttribute(pos, 3 * t).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, 3 * t + 1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, 3 * t + 2).applyMatrix4(mesh.matrixWorld);
      const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      const area = normal.length() / 2;
      normal.normalize();
      const keys = [key(a), key(b), key(c)];
      // edge k lies opposite corner k
      const lengths = [b.distanceTo(c), c.distanceTo(a), a.distanceTo(b)];
      const face = { normal, centre: new THREE.Vector3().add(a).add(b).add(c).divideScalar(3), area, lengths, hard: [false, false, false] };
      faces.push(face);
      if (area < 1e-10) continue;
      for (let k = 0; k < 3; k++) {
        const p = keys[(k + 1) % 3], q = keys[(k + 2) % 3];
        if (p === q) continue;
        const id = p < q ? `${p}|${q}` : `${q}|${p}`;
        const on = shared.get(id);
        if (on) on.push([face, k]); else shared.set(id, [[face, k]]);
      }
    }
  }
  let found = 0;
  for (const on of shared.values()) {
    if (on.length !== 2) continue;   // an open edge, or three faces on one: not a corner of a block
    const [[f, fk], [g, gk]] = on;
    if (f.normal.dot(g.normal) > cosLimit) continue;
    // outward: each face's centre lies behind the other's plane
    if (f.normal.dot(a.subVectors(g.centre, f.centre)) > -1e-5) continue;
    f.hard[fk] = g.hard[gk] = true;
    found++;
  }
  for (const mesh of meshes) {
    const count = mesh.geometry.getAttribute('position').count;
    const edge = new Float32Array(count * 3).fill(FAR);
    for (let t = 0; t < count / 3; t++) {
      const face = faces[mesh.userData.firstFace + t];
      for (let k = 0; k < 3; k++) {
        if (!face.hard[k]) continue;
        // the distance to edge k: the triangle's height over it at corner k, nothing at the edge's own two ends
        const height = (2 * face.area) / Math.max(face.lengths[k], 1e-6);
        for (let v = 0; v < 3; v++) edge[3 * (3 * t + v) + k] = v === k ? height : 0;
      }
    }
    mesh.geometry.setAttribute('edge', new THREE.BufferAttribute(edge, 3));
  }
  return found;
}
