// Texture levels of detail for a level whose textures are too big to load at once. The level comes up on a small
// copy (2048 px a page). The sharp textures (./hi/, made by scripts/web_glb.py --split) are then fetched page by
// page, the page the camera needs most first: what it sees nearest, measured by rays through the frame. A page
// nobody has looked at stays small. The colour and the normal map go up; the roughness map stays small, where
// nothing is lost by it.
//
// (The other level of detail, by distance within a texture, is the GPU's own: every texture carries its mipmaps
// and is sampled across them, with the most anisotropy the device gives.)
import * as THREE from 'three';
import { setPomHeight } from './pom.js';

export class TextureLod {
  /**
   * @param meshes the level's meshes, one a page, in the order of textures.json
   * @param budget how many pages may be sharp at once (colour + normal + single-channel height: about 190 MB at 4K)
   */
  constructor(renderer, camera, meshes, { base = './hi/', budget = 4 } = {}) {
    this.renderer = renderer; this.camera = camera; this.meshes = meshes; this.base = base; this.budget = budget;
    this.pages = meshes.map((mesh) => ({ mesh, need: 0, state: 'low',
      low: { map: mesh.material.map, normalMap: mesh.material.normalMap, heightMap: null }, high: null, heightError: null }));
    this.list = null; this.loading = false; this.heightLoading = true; this.since = 0;
    this.ray = new THREE.Raycaster();
    this.ray.firstHitOnly = true;
    this.loader = new THREE.ImageBitmapLoader();
    this.loader.setOptions({ imageOrientation: 'none', premultiplyAlpha: 'none' });
    this.dataLoader = new THREE.ImageBitmapLoader();
    this.dataLoader.setOptions({ imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    this.ready = this.loadManifest();
  }

  async loadManifest() {
    try {
      const response = await fetch(`${this.base}textures.json`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Texture manifest: ${response.status}`);
      this.list = await response.json();
      for (const [i, page] of this.pages.entries()) {
        try {
          const file = this.list[i]?.heightLow;
          if (!file) throw new Error('No generated height map');
          const texture = await this.loadHeight(file);
          this.renderer.initTexture(texture);
          page.low.heightMap = texture;
          setPomHeight(page.mesh.material, texture);
          await new Promise((r) => requestAnimationFrame(r));
        } catch (e) { page.heightError = e.message; }
      }
    } catch (e) {
      for (const page of this.pages) page.heightError = e.message;
    } finally { this.heightLoading = false; }
  }

  /** Height is data: decode without colour conversion and upload only R8, not a four-channel colour texture. */
  async loadHeight(file) {
    const bitmap = await this.dataLoader.loadAsync(this.base + file);
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      const rgba = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const data = new Uint8Array(bitmap.width * bitmap.height);
      for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4];
      const texture = new THREE.DataTexture(data, bitmap.width, bitmap.height, THREE.RedFormat);
      texture.colorSpace = THREE.NoColorSpace; texture.flipY = false;
      texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter; texture.generateMipmaps = true;
      texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      texture.needsUpdate = true;
      return texture;
    } finally { bitmap.close(); }
  }

  /** How many pages are sharp, of how many, and their size: for a readout. */
  get status() {
    const sharp = this.pages.filter((p) => p.state === 'high').length;
    const heights = this.pages.map((p) => (p.state === 'high' ? p.high : p.low)?.heightMap?.image.width ?? 0);
    return { sharp, pages: this.pages.length, size: this.list?.[0]?.size ?? 0, loading: this.loading || this.heightLoading,
      heightPages: heights.filter(Boolean).length, heightSizes: heights, heightLoading: this.heightLoading,
      heightErrors: this.pages.map((p) => p.heightError).filter(Boolean) };
  }

  /** Call every frame: measures every half second, and has at most one page on its way at a time. */
  update(dt, frameHeight) {
    this.since += dt;
    if (this.since < 0.5) return;
    this.since = 0;
    // how many pixels a metre of surface covers, for the nearest thing each page shows in the frame
    const perMetre = frameHeight / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    for (const p of this.pages) p.need *= 0.8;   // what was needed a moment ago still counts for a while
    let nearest = Infinity, farthest = 0;
    for (let y = -0.8; y <= 0.81; y += 0.32) {
      for (let x = -0.9; x <= 0.91; x += 0.3) {
        this.ray.setFromCamera(new THREE.Vector2(x, y), this.camera);
        this.ray.far = 120;
        const hit = this.ray.intersectObjects(this.meshes, false)[0];
        if (!hit) { farthest = Infinity; continue; }
        nearest = Math.min(nearest, hit.distance); farthest = Math.max(farthest, hit.distance);
        const page = this.pages[this.meshes.indexOf(hit.object)];
        page.need = Math.max(page.need, perMetre / Math.max(hit.distance, 0.5));
      }
    }
    // how near and how far the frame reaches (the sky counts as endlessly far): the viewer's focus pass reads these
    this.nearest = nearest; this.farthest = farthest;
    if (this.loading || this.heightLoading || !this.list || this.budget <= 0) return;
    const sharp = this.pages.filter((p) => p.state === 'high');
    const wanted = this.pages.filter((p) => p.state === 'low' && p.need > 12).sort((a, b) => b.need - a.need)[0];
    if (!wanted) return;
    if (sharp.length >= this.budget) {
      // over budget: the sharp page needed least gives way, if the wanted one is needed clearly more
      const least = sharp.sort((a, b) => a.need - b.need)[0];
      if (least.need * 1.5 > wanted.need) return;
      this.lower(least);
    }
    void this.raise(wanted);
  }

  async raise(page) {
    const entry = this.list[this.pages.indexOf(page)];
    if (!entry) return;
    this.loading = true;
    const staged = [];
    try {
      const material = page.mesh.material;
      const load = async (file, like) => {
        const bitmap = await this.loader.loadAsync(this.base + file);
        const t = new THREE.Texture(bitmap);
        // as the texture it replaces: same colour space, wrapping and filtering, glTF's orientation
        t.colorSpace = like.colorSpace; t.wrapS = like.wrapS; t.wrapT = like.wrapT; t.flipY = false;
        t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true;
        t.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        t.needsUpdate = true;
        return t;
      };
      const map = await load(entry.base, page.low.map);
      staged.push(map);
      const normalMap = entry.normal && page.low.normalMap ? await load(entry.normal, page.low.normalMap) : null;
      if (normalMap) staged.push(normalMap);
      const heightMap = entry.height ? await this.loadHeight(entry.height) : null;
      if (heightMap) staged.push(heightMap);
      // one texture a frame goes to the GPU, so the walk does not hitch on a page arriving
      this.renderer.initTexture(map);
      await new Promise((r) => requestAnimationFrame(r));
      if (normalMap) this.renderer.initTexture(normalMap);
      await new Promise((r) => requestAnimationFrame(r));
      if (heightMap) this.renderer.initTexture(heightMap);
      // Switch the three fields together only after every texture has arrived.
      page.high = { map, normalMap, heightMap };
      material.map = map;
      if (normalMap) material.normalMap = normalMap;
      setPomHeight(material, heightMap);
      if (heightMap) page.heightError = null;
      page.state = 'high';
    } catch {
      for (const texture of staged) { texture.dispose(); texture.image?.close?.(); }
      page.need = 0;   // could not be fetched: the small one stays
    } finally {
      this.loading = false;
    }
  }

  lower(page) {
    const material = page.mesh.material;
    material.map = page.low.map;
    if (page.low.normalMap) material.normalMap = page.low.normalMap;
    setPomHeight(material, page.low.heightMap);
    page.high?.map.dispose();
    page.high?.map.image?.close?.();
    page.high?.normalMap?.dispose();
    page.high?.normalMap?.image?.close?.();
    page.high?.heightMap?.dispose();
    page.high = null;
    page.state = 'low';
  }
}
