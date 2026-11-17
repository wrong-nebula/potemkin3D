import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { computeBoundsTree } from 'three-mesh-bvh';
import { featherPomAtlas, makePomAtlas, pomLayer, setPomHeight } from '../experiments/luxor-view/pom.js';
import { sandLayer } from '../experiments/luxor-view/sand.js';
import { TextureLod } from '../experiments/luxor-view/lod.js';

const geometry = (triangles) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(triangles.flatMap((t) => t.flatMap(([x, y]) => [x, y, 0])), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(triangles.flat(2), 2));
  return g;
};
const at = (texture, u, v) => {
  const { data, width } = texture.image, k = 4 * (Math.floor(v * width) * width + Math.floor(u * width));
  return data[k] + data[k + 1] * 256 + data[k + 2] * 65536;
};

describe('POM atlas boundaries', () => {
  it('feathers touching islands independently, without requiring empty space between them', () => {
    const size = 32, data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data[4 * (y * size + x)] = x < 16 ? 1 : 2;
    featherPomAtlas(data, size);
    const distance = (x, y) => data[4 * (y * size + x) + 3] / 17;
    expect([distance(14, 16), distance(15, 16), distance(16, 16), distance(17, 16)]).toEqual([1, 0, 0, 1]);
    expect(distance(0, 16)).toBe(0);
    expect(distance(31, 16)).toBe(0);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      expect(data[4 * (y * size + x)]).toBe(x < 16 ? 1 : 2); // ID channels remain exact
    }
  });

  it('keeps clearance conservative around diagonal boundaries and holes', () => {
    const size = 20, data = new Uint8Array(size * size * 4), outside = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const inside = x + y < 27 && !(x >= 5 && x <= 7 && y >= 5 && y <= 7);
      data[4 * (y * size + x)] = inside ? 1 : 0;
      if (!inside) outside.push([x, y]);
    }
    featherPomAtlas(data, size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const d = data[4 * (y * size + x) + 3] / 17;
      const nearest = Math.min(x, y, size - 1 - x, size - 1 - y, ...outside.map(([a, b]) => Math.hypot(a - x, b - y)));
      expect(d).toBeLessThanOrEqual(nearest);
    }
  });

  it('joins an internal diagonal but keeps separate packed islands distinct', () => {
    const g = geometry([
      [[.05, .05], [.45, .05], [.45, .45]], [[.05, .05], [.45, .45], [.05, .45]],
      [[.55, .05], [.95, .05], [.55, .45]],
    ]);
    const texture = makePomAtlas(g, 64), ids = g.getAttribute('pomIsland');
    expect(ids.getX(0)).toBe(ids.getX(3));
    expect(ids.getX(0)).not.toBe(ids.getX(6));
    expect(at(texture, .2, .3)).toBe(ids.getX(0));
    expect(at(texture, .3, .2)).toBe(ids.getX(0));
    expect(at(texture, .6, .1)).toBe(ids.getX(6));
    // Within the second island's bounding box, but outside its triangular shape.
    expect(at(texture, .9, .4)).toBe(0);
    expect(at(texture, .5, .5)).toBe(0);
    texture.dispose(); g.dispose();
  });

  it('rasterizes mirrored UVs and skips zero-area faces without filling unused space', () => {
    const g = geometry([[[.1, .1], [.1, .7], [.7, .1]], [[.8, .8], [.8, .8], [.8, .8]]]);
    const texture = makePomAtlas(g, 32);
    expect(at(texture, .2, .2)).toBe(1);
    expect(at(texture, .65, .65)).toBe(0);
    expect(at(texture, .8, .8)).toBe(0);
    texture.dispose(); g.dispose();
  });

  it('preserves island attributes when the collision BVH adds and reorders indices', () => {
    const g = geometry([[[.1, .1], [.4, .1], [.1, .4]], [[.6, .6], [.9, .6], [.6, .9]]]);
    const texture = makePomAtlas(g, 32);
    computeBoundsTree.call(g);
    expect(g.index).not.toBeNull();
    for (let i = 0; i < g.index.count; i += 3) {
      const ids = [0, 1, 2].map((k) => g.getAttribute('pomIsland').getX(g.index.getX(i + k)));
      expect(new Set(ids).size).toBe(1);
    }
    texture.dispose(); g.dispose();
  });
});

it('composes POM with weathering and shifts all material lookups without distorting the tangent frame', () => {
  const material = new THREE.MeshStandardMaterial(), islands = new THREE.Texture();
  sandLayer(material);
  const sandKey = material.customProgramCacheKey();
  pomLayer(material, islands);
  const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} };
  material.onBeforeCompile(shader, null);
  expect(shader.uniforms.tPomIslands.value).toBe(islands);
  expect(shader.uniforms.uSand).toBeDefined();
  expect(shader.uniforms.uPomShadow.value).toBeGreaterThan(0);
  expect(shader.uniforms.uPomHeightReady.value).toBe(0);
  expect(material.customProgramCacheKey()).toContain(sandKey);
  for (const uv of ['vMapUv', 'vNormalMapUv', 'vRoughnessMapUv', 'vMetalnessMapUv', 'vAoMapUv']) {
    expect(shader.fragmentShader).toContain(`${uv} + pomOffset`);
  }
  expect(shader.fragmentShader).toContain('#include <normal_fragment_begin>');
  expect(shader.fragmentShader).toContain('directLight.color *= pomVisibility(directLight.direction)');
  expect(shader.fragmentShader).toContain('sandBump = mix(sandBump, pomBump() * uDetail, pomWeight)');
  expect(shader.fragmentShader).toContain('#include <lights_fragment_maps>'); // skylight remains unshadowed by POM
  expect(shader.fragmentShader.indexOf('vec2 pomOffset =')).toBeLessThan(shader.fragmentShader.indexOf('sandSmooth( map, vMapUv + pomOffset )'));
  material.dispose(); islands.dispose();
});

it('uses a dedicated linear height field and follows swaps, recompiles and missing maps', () => {
  const material = new THREE.MeshStandardMaterial(), islands = new THREE.Texture();
  pomLayer(material, islands);
  const compile = () => {
    const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} };
    material.onBeforeCompile(shader, null);
    return shader;
  };
  const shader = compile(), low = new THREE.DataTexture(new Uint8Array([0, 255]), 2, 1, THREE.RedFormat);
  setPomHeight(material, low);
  expect(shader.uniforms.uPomHeightReady.value).toBe(1);
  expect(shader.uniforms.tPomHeight.value).toBe(low);
  const high = new THREE.DataTexture(new Uint8Array([0, 85, 170, 255]), 4, 1, THREE.RedFormat);
  setPomHeight(material, high);
  expect(compile().uniforms.tPomHeight.value).toBe(high);
  expect(shader.fragmentShader).toContain('pomSmooth(tPomHeight, uv, dx, dy).r');
  expect(shader.fragmentShader).not.toContain('textureSize(map, 0)');
  expect(shader.fragmentShader).not.toContain('pomSmooth(map,');
  high.colorSpace = THREE.SRGBColorSpace;
  expect(() => setPomHeight(material, high)).toThrow('linear data');
  setPomHeight(material, null);
  expect(shader.uniforms.uPomHeightReady.value).toBe(0);
  expect(shader.uniforms.tPomHeight.value).not.toBe(high);
  material.dispose(); islands.dispose(); low.dispose(); high.dispose();
});

it('switches height with the streamed maps and restores the low-resolution field on eviction', async () => {
  const material = new THREE.MeshStandardMaterial({ map: new THREE.Texture(), normalMap: new THREE.Texture() });
  pomLayer(material, new THREE.Texture());
  const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} };
  material.onBeforeCompile(shader, null);
  const lowHeight = new THREE.DataTexture(new Uint8Array([0, 255]), 2, 1, THREE.RedFormat);
  const highHeight = new THREE.DataTexture(new Uint8Array([0, 85, 170, 255]), 4, 1, THREE.RedFormat);
  setPomHeight(material, lowHeight);
  const page = { mesh: { material }, state: 'low', need: 1, low: { map: material.map, normalMap: material.normalMap, heightMap: lowHeight } };
  const lod = Object.assign(Object.create(TextureLod.prototype), {
    pages: [page], list: [{ base: 'colour', normal: 'normal', height: 'height' }], base: '',
    renderer: { initTexture() {}, capabilities: { getMaxAnisotropy: () => 4 } },
    loader: { loadAsync: async () => ({ width: 4, height: 4 }) }, loadHeight: async () => highHeight,
  });
  const previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => { fn(0); return 0; };
  try {
    await lod.raise(page);
    expect(page.state).toBe('high');
    expect(shader.uniforms.tPomHeight.value).toBe(highHeight);
    let disposed = false;
    highHeight.addEventListener('dispose', () => { disposed = true; });
    lod.lower(page);
    expect(page.state).toBe('low');
    expect(shader.uniforms.tPomHeight.value).toBe(lowHeight);
    expect(material.map).toBe(page.low.map);
    expect(disposed).toBe(true);
    lod.loadHeight = async () => { throw new Error('missing height'); };
    await lod.raise(page);
    expect(page.state).toBe('low');
    expect(shader.uniforms.tPomHeight.value).toBe(lowHeight);
    expect(material.map).toBe(page.low.map);
  } finally {
    if (previous) globalThis.requestAnimationFrame = previous; else delete globalThis.requestAnimationFrame;
    lowHeight.dispose(); material.map.dispose(); material.normalMap.dispose(); material.dispose();
  }
});
