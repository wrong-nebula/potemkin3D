/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { splitParts, type Part } from './parts';
import type { SurfaceWeights, SurfaceWeightsSummary } from './surface-weights';

/** A level flattened into one world-space mesh with a single UV set (TEXCOORD_0). */
export interface Level {
  name: string;
  /**
   * Part names; the `label` vertex attribute indexes this. From the file (glTF material, else mesh name) when it
   * names more than one part. Otherwise the level is split into its connected shapes (`shapes`), whose names start
   * out empty and are filled in by core/naming.ts or by hand.
   */
  labels: string[];
  /** Set when the parts are the level's connected shapes rather than names from the file. */
  shapes?: Part[];
  geometry: THREE.BufferGeometry;
  bvh: MeshBVH;
  bounds: THREE.Box3;
  triangles: number;
  surfaceArea: number;
  /**
   * Where players can be, when the level has more floor than that (the neighbours' rooftops outside a loft's
   * windows): camera spots are only placed with the eye inside this box.
   */
  playArea?: THREE.Box3;
  /**
   * Eye positions given by hand, kept beside whatever the planner finds. The planner joins standing spots by straight
   * walks of a few metres, so a floor reached only by a long flight of stairs (a mezzanine, a gantry deck) is a play
   * area of its own, too small to keep, and gets no camera: name a few spots on it. They ride along with the play
   * area wherever that goes: the triples after its six numbers.
   */
  spots?: THREE.Vector3[];
  /** Set when the texture coordinates aren't the file's own but a layout weighted by what players see (core/layout.ts). */
  layout?: LevelLayout;
  /** Set when the texture is several: the islands were packed again over a grid of pages (core/layout.ts pagedLayout). */
  pages?: LevelPages;
  /** Names of the meshes that came without texture coordinates (their UVs start at 0 and must be unwrapped). */
  missingUV?: string[];
  /** Set when the texture coordinates were made from scratch (core/unwrap.ts), before any layout above. */
  unwrap?: LevelUnwrap;
  /** Cached geometry prepass weights for the current triangles (core/surface-weights.ts). */
  surfaceWeights?: SurfaceWeights;
  /** Summary of geometry prepass weights when enabled on load (`weights: true`). */
  weights?: SurfaceWeightsSummary;
}

export interface LevelUnwrap {
  /** Why: the file's UVs failed the health check (or 'asked' when unwrapping was asked for regardless). */
  reason: string;
  meshes: number;
  charts: number;
  /** Share of the texture the charts fill. */
  fill: number;
  /** Fingerprint of the texture coordinates it made. */
  hash: string;
  seconds: number;
}

export interface LevelPages {
  /** Pages along each side: the texture is `grid` x `grid` textures. */
  grid: number;
  /** How many times larger each island is on its page than it was in the one texture, along each axis. */
  gain: number;
  islands: number;
  /** The share of each page its islands' boxes take. */
  fill: number[];
  /** Islands too long for a page that were cut, and the pieces they are now (core/layout.ts cutIslands). */
  cut?: number;
  pieces?: number;
  /** Fingerprint of the texture coordinates in use. */
  hash: string;
  seconds: number;
}

export interface LevelLayout {
  /**
   * 'seen' (when unset): faces nobody sees shrunk and all packed again. 'near': faces joined into strips, each island
   * sized by how near a player gets to it, and all packed again.
   */
  kind?: 'seen' | 'near';
  /** With 'near': the strips made of the file's islands, and how many islands went into them. */
  strips?: number;
  joined?: number;
  /** With 'near': the islands the file had, and how many are drawn at full size (a player gets near them). */
  before?: number;
  full?: number;
  /** With 'near': islands too long for a page that were cut, and the pieces they are now (core/layout.ts cutIslands). */
  cut?: number;
  pieces?: number;
  /** Enclosed islands drawn smaller (Session.load `cavity`): the smallest scale, the share of the surface shrunk, and
   * the share of their texels those islands keep before packing. */
  cavity?: { minScale: number; shrunkSurface: number; kept: number; seconds: number };
  /** Full geometry prepasses (openness, convex curvature, static light, semantic class) weighted the layout and planner. */
  weights?: SurfaceWeightsSummary;
  /** False when the weighted layout gained too little and the file's own was kept. */
  applied: boolean;
  /** How much denser the faces players see are than in the file's layout, along each axis. */
  gain: number;
  /** Share of the level's surface, and of the file's texture, that players can see. */
  seenSurface: number;
  seenTexture: number;
  islands: number;
  /** Fingerprint of the texture coordinates in use. */
  hash: string;
  seconds: number;
}

/**
 * Give a level other triangles for the same surface (core/layout.ts cutIslands cuts faces in pieces): its geometry,
 * the tree its rays are cast through, and its counts.
 */
export function setTriangles(level: Level, t: { position: Float32Array; normal: Float32Array; uv: Float32Array; label: Float32Array; weight?: Float32Array }) {
  const g = level.geometry;
  g.setIndex(null);   // the tree's own, over the old triangles
  g.setAttribute('position', new THREE.BufferAttribute(t.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(t.normal, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(t.uv, 2));
  g.setAttribute('label', new THREE.BufferAttribute(t.label, 1));
  if (t.weight) g.setAttribute('weight', new THREE.BufferAttribute(t.weight, 1));
  else g.deleteAttribute('weight');
  g.computeBoundingBox();
  g.computeBoundingSphere();
  level.bvh = new MeshBVH(g);
  level.triangles = t.position.length / 9;
  level.surfaceWeights = undefined;
  if (level.shapes) {
    for (const s of level.shapes) s.triangles = 0;
    for (let i = 0; i < t.label.length; i += 3) { const s = level.shapes[t.label[i]]; if (s) s.triangles++; }
  }
}

/**
 * @param opts.allowMissingUV take meshes without texture coordinates (with UVs at 0, listed in `missingUV`) instead
 *   of refusing them: for a level that will be unwrapped (core/unwrap.ts)
 */
export async function loadLevel(source: string | ArrayBuffer, name = 'level', opts: { allowMissingUV?: boolean } = {}): Promise<Level> {
  const loader = new GLTFLoader();
  const gltf = typeof source === 'string'
    ? await loader.loadAsync(source)
    : await loader.parseAsync(source, '');
  gltf.scene.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  const labels: string[] = [];
  const missingUV: string[] = [];
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const label = partName(mesh);
    if (!labels.includes(label)) labels.push(label);
    let g = mesh.geometry.clone();
    g.applyMatrix4(mesh.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    if (!g.getAttribute('uv')) {
      if (!opts.allowMissingUV) throw new Error(`mesh "${mesh.name}" has no UVs; unwrap the level first`);
      missingUV.push(mesh.name || label);
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(2 * g.getAttribute('position').count), 2));
    }
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    for (const k of Object.keys(g.attributes)) {
      if (k !== 'position' && k !== 'normal' && k !== 'uv' && k !== 'label') g.deleteAttribute(k);
    }
    g.morphAttributes = {};
    g.setAttribute('label', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(labels.indexOf(label)), 1));
    parts.push(g);
  });
  if (!parts.length) throw new Error('no meshes in the file');
  const geometry = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  if (!geometry) throw new Error('could not merge meshes');
  // A file that names nothing (one mesh, one material) still has parts: its connected shapes.
  let shapes: Part[] | undefined;
  if (labels.length === 1) {
    const split = splitParts(geometry.getAttribute('position').array);
    if (split.parts.length > 1) {
      const label = geometry.getAttribute('label');
      for (let v = 0; v < label.count; v++) label.setX(v, split.of[Math.floor(v / 3)]);
      label.needsUpdate = true;
      shapes = split.parts;
      labels.length = 0;
      labels.push(...split.parts.map(() => ''));
    }
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const bvh = new MeshBVH(geometry);
  const pos = geometry.getAttribute('position');
  const tri = new THREE.Triangle();
  let area = 0;
  const triangles = (geometry.index ? geometry.index.count : pos.count) / 3;
  const idx = geometry.index;
  for (let t = 0; t < triangles; t++) {
    const a = idx ? idx.getX(3 * t) : 3 * t;
    const b = idx ? idx.getX(3 * t + 1) : 3 * t + 1;
    const c = idx ? idx.getX(3 * t + 2) : 3 * t + 2;
    tri.setFromAttributeAndIndices(pos, a, b, c);
    area += tri.getArea();
  }
  return { name, labels, shapes, geometry, bvh, bounds: geometry.boundingBox!.clone(), triangles, surfaceArea: area,
    ...(missingUV.length ? { missingUV } : {}) };
}

/** A readable part name: material name if it isn't a default, else the mesh name, without numeric suffixes. */
function partName(mesh: THREE.Mesh): string {
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const raw = (mat?.name && !/^(material|default|clay)?[._ -]?\d*$/i.test(mat.name) ? mat.name : mesh.name) || 'surface';
  return raw.replace(/[._-]\d+$/, '').replace(/[_-]+/g, ' ').trim().toLowerCase() || 'surface';
}

/** Iterate triangles as (a, b, c, normal, area) in world space. */
export function forEachTriangle(level: Level, fn: (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3,
  n: THREE.Vector3, area: number) => void) {
  const g = level.geometry;
  const pos = g.getAttribute('position');
  const idx = g.index;
  const count = (idx ? idx.count : pos.count) / 3;
  const tri = new THREE.Triangle();
  const n = new THREE.Vector3();
  for (let t = 0; t < count; t++) {
    const a = idx ? idx.getX(3 * t) : 3 * t;
    const b = idx ? idx.getX(3 * t + 1) : 3 * t + 1;
    const c = idx ? idx.getX(3 * t + 2) : 3 * t + 2;
    tri.setFromAttributeAndIndices(pos, a, b, c);
    tri.getNormal(n);
    fn(tri.a, tri.b, tri.c, n, tri.getArea());
  }
}
