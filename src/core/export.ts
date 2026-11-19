/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { aoImage, withOcclusion } from './ao';
import type { Engine } from './engine';
import { toCanvas } from './image';
import { encodeUastcKtx2, rewriteGlbWithKtx2 } from './ktx2';

export interface ExportOptions {
  /** Texture container inside the GLB: `'png'` (default) or `'ktx2'` (Khronos UASTC 4×4 `KHR_texture_basisu`). */
  format?: 'png' | 'ktx2';
  /** Generate a box-filtered mipmap pyramid inside each KTX2 texture when `format === 'ktx2'` (default true). */
  mipmaps?: boolean;
}

/**
 * The level as one mesh with the painted texture. Painted under overcast light it is albedo, so it goes on a lit
 * material for the engine to light, with the normal and roughness maps when they've been made (core/pbr.ts) and the
 * baked ambient occlusion when there is one (core/ao.ts);
 * painted with a sun the lighting is baked in, so it goes on an unlit one (KHR_materials_unlit).
 *
 * A level painted over several textures comes out as one mesh with a material for each page (glTF: a primitive
 * each), its faces carrying their coordinates on their own page; maps made over the whole texture space are cut
 * to the pages.
 */
export async function exportGlb(engine: Engine, opts: ExportOptions = {}): Promise<ArrayBuffer> {
  const useKtx2 = opts.format === 'ktx2';
  const mipmaps = opts.mipmaps ?? true;
  const atlas = engine.atlas, grid = atlas.grid;
  const textures: THREE.Texture[] = [];
  const ktx2ByName = new Map<string, Uint8Array>();
  let texCounter = 0;
  const texture = (pixels: Uint8ClampedArray, s: number, colour = false) => {
    const t = new THREE.CanvasTexture(toCanvas(pixels, s, s)); // rows already in glTF order (first row = v 0)
    t.flipY = false;
    t.name = `pk_tex_${texCounter++}`;
    if (colour) t.colorSpace = THREE.SRGBColorSpace;
    textures.push(t);
    if (useKtx2) {
      ktx2ByName.set(t.name, encodeUastcKtx2(pixels, s, s, { srgb: colour, mipmaps }));
    }
    return t;
  };
  const { pbr, ao } = engine;
  // one image for occlusion (R, when baked), roughness (G) and metalness (B): joint-bilateral upsampled when ao.size < pbr.size
  const ormGuide = pbr && ao && ao.size !== pbr.size && ao.guide ? atlas.texelGeometry(pbr.size) : undefined;
  const ormAll = pbr ? (ao ? withOcclusion(pbr.orm, pbr.size, ao, ormGuide) : pbr.orm) : undefined;
  const aoAll = ao && !pbr ? aoImage(ao) : undefined;
  const material = (k: number): THREE.Material => {
    const map = texture(grid === 1 ? atlas.readBytes().data : atlas.pageBytes(k), atlas.pageSize, true);
    if (!engine.clay.lighting.overcast && !pbr && !engine.ao) return new THREE.MeshBasicMaterial({ map });
    if (pbr) {
      const pageOrm = pageOf(ormAll!, pbr.size, grid, k);
      const orm = texture(pageOrm, pbr.size / grid);
      let hasMetal = false;
      for (let i = 2; i < pageOrm.length; i += 4) if (pageOrm[i] > 0) { hasMetal = true; break; }
      return new THREE.MeshStandardMaterial({ map, normalMap: texture(pageOf(pbr.normal, pbr.size, grid, k), pbr.size / grid),
        roughnessMap: orm, metalnessMap: orm, roughness: 1, metalness: hasMetal ? 1 : 0, ...(ao ? { aoMap: orm } : {}) });
    }
    return new THREE.MeshStandardMaterial({ map, roughness: 0.92, metalness: 0, ...(ao ? { aoMap: texture(pageOf(aoAll!, ao.size, grid, k), ao.size / grid) } : {}) });
  };
  let mesh: THREE.Mesh;
  let made: THREE.BufferGeometry | undefined;
  if (grid === 1) mesh = new THREE.Mesh(engine.level.geometry, material(0));
  else {
    const paged = pagedGeometry(engine.level.geometry, grid);
    made = paged.geometry;
    mesh = new THREE.Mesh(paged.geometry, paged.pages.map(material));
  }
  mesh.name = engine.level.name;
  const glb = (await new GLTFExporter().parseAsync(mesh, { binary: true, maxTextureSize: atlas.pageSize })) as ArrayBuffer;
  for (const t of textures) t.dispose();
  made?.dispose();
  return useKtx2 ? rewriteGlbWithKtx2(glb, ktx2ByName) : glb;
}

/** The part of a square map (`size` px, made over the whole texture space) that lies on page `k`. */
export function pageOf(pixels: Uint8ClampedArray, size: number, grid: number, k: number): Uint8ClampedArray {
  if (grid === 1) return pixels;
  const n = Math.floor(size / grid), x0 = (k % grid) * n, y0 = Math.floor(k / grid) * n;
  const out = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) out.set(pixels.subarray(((y0 + y) * size + x0) * 4, ((y0 + y) * size + x0 + n) * 4), y * n * 4);
  return out;
}

/**
 * The level's faces sorted by the page they are on, each page a group of its own (a material each), with texture
 * coordinates that run 0-1 over that page. `pages`: the pages that have faces, in the groups' order.
 */
export function pagedGeometry(g: THREE.BufferGeometry, grid: number): { geometry: THREE.BufferGeometry; pages: number[] } {
  const pos = g.getAttribute('position').array, nrm = g.getAttribute('normal').array, uv = g.getAttribute('uv').array;
  const tris = Math.floor(pos.length / 9);
  const lists: number[][] = Array.from({ length: grid * grid }, () => []);
  for (let t = 0; t < tris; t++) {
    const u = (uv[6 * t] + uv[6 * t + 2] + uv[6 * t + 4]) / 3, v = (uv[6 * t + 1] + uv[6 * t + 3] + uv[6 * t + 5]) / 3;
    const x = Math.min(grid - 1, Math.max(0, Math.floor(u * grid))), y = Math.min(grid - 1, Math.max(0, Math.floor(v * grid)));
    lists[y * grid + x].push(t);
  }
  const P = new Float32Array(tris * 9), N = new Float32Array(tris * 9), U = new Float32Array(tris * 6);
  const geometry = new THREE.BufferGeometry();
  const pages: number[] = [];
  let at = 0;
  lists.forEach((list, k) => {
    if (!list.length) return;
    geometry.addGroup(at * 3, list.length * 3, pages.length);
    pages.push(k);
    for (const t of list) {
      P.set(pos.subarray(9 * t, 9 * t + 9), 9 * at);
      N.set(nrm.subarray(9 * t, 9 * t + 9), 9 * at);
      for (let c = 0; c < 3; c++) {
        U[6 * at + 2 * c] = uv[6 * t + 2 * c] * grid - (k % grid);
        U[6 * at + 2 * c + 1] = uv[6 * t + 2 * c + 1] * grid - Math.floor(k / grid);
      }
      at++;
    }
  });
  geometry.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  return { geometry, pages };
}
