// Parallax occlusion mapping from dedicated, linear height maps (white = high). Height, cavity shadows and
// bump slopes share that field; albedo is only colour. Missing height data disables POM for that material.
// This changes texture visibility, not silhouettes, collision or the shadow mesh.
// Ray/height intersection: https://doi.org/10.1145/1111411.1111423 (Tatarchuk, 2006).
import * as THREE from 'three';

/** Distance to another island in mask texels. Eight-neighbour distance is conservative (never longer than
 * Euclidean distance). Capping it at 15 leaves room in alpha for fractional filtering in the shader. */
export function featherPomAtlas(data, size) {
  const ids = new Uint32Array(size * size), distance = new Uint8Array(size * size);
  for (let i = 0; i < ids.length; i++) {
    ids[i] = data[4 * i] + data[4 * i + 1] * 256 + data[4 * i + 2] * 65536;
    distance[i] = ids[i] ? 15 : 0;
  }
  const neighbours = [[[-1, 0], [-1, -1], [0, -1], [1, -1]], [[1, 0], [-1, 1], [0, 1], [1, 1]]];
  const visit = (x, y, backwards) => {
    const i = y * size + x, id = ids[i];
    if (!id) return;
    let d = Math.min(distance[i], x, y, size - 1 - x, size - 1 - y);
    for (const [dx, dy] of neighbours[backwards ? 1 : 0]) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= size || yy >= size) { d = 0; continue; }
      const j = yy * size + xx;
      d = Math.min(d, ids[j] === id ? distance[j] + 1 : 0);
    }
    distance[i] = d;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) visit(x, y, false);
  for (let y = size - 1; y >= 0; y--) for (let x = size - 1; x >= 0; x--) visit(x, y, true);
  for (let i = 0; i < distance.length; i++) data[4 * i + 3] = distance[i] * 17;
}

/** Rasterize UV island IDs once. A ray may never read another island, including inside non-rectangular packs.
 * Call after any geometry re-layout (markEdges). The returned texture belongs to the caller. */
export function makePomAtlas(geometry, size = 1024) {
  const uv = geometry.getAttribute('uv'), pos = geometry.getAttribute('position');
  if (geometry.index) throw new Error('POM atlas needs non-indexed triangles');
  const count = pos.count / 3, parents = Array.from({ length: count }, (_, i) => i), edges = new Map();
  const root = (i) => { while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; } return i; };
  const key = (i) => [pos.getX(i), pos.getY(i), pos.getZ(i), uv.getX(i), uv.getY(i)].map((v) => Math.round(v * 1e6)).join(',');
  for (let t = 0; t < count; t++) {
    const keys = [key(t * 3), key(t * 3 + 1), key(t * 3 + 2)];
    for (let k = 0; k < 3; k++) {
      const a = keys[k], b = keys[(k + 1) % 3], edge = a < b ? `${a}|${b}` : `${b}|${a}`;
      const other = edges.get(edge);
      if (other !== undefined) parents[root(t)] = root(other); else edges.set(edge, t);
    }
  }
  const ids = new Map(), attribute = new Float32Array(pos.count), data = new Uint8Array(size * size * 4);
  for (let t = 0; t < count; t++) {
    const group = root(t);
    if (!ids.has(group)) ids.set(group, ids.size + 1); // zero is unused atlas space
    const id = ids.get(group);
    attribute.fill(id, t * 3, t * 3 + 3);
    const x = [0, 1, 2].map((k) => uv.getX(t * 3 + k) * size), y = [0, 1, 2].map((k) => uv.getY(t * 3 + k) * size);
    const area = (x[1] - x[0]) * (y[2] - y[0]) - (y[1] - y[0]) * (x[2] - x[0]);
    if (Math.abs(area) < 1e-8) continue;
    const xmin = Math.max(0, Math.floor(Math.min(...x))), xmax = Math.min(size - 1, Math.ceil(Math.max(...x)));
    const ymin = Math.max(0, Math.floor(Math.min(...y))), ymax = Math.min(size - 1, Math.ceil(Math.max(...y)));
    for (let j = ymin; j <= ymax; j++) for (let i = xmin; i <= xmax; i++) {
      const a = ((x[1] - i - 0.5) * (y[2] - j - 0.5) - (y[1] - j - 0.5) * (x[2] - i - 0.5)) / area;
      const b = ((x[2] - i - 0.5) * (y[0] - j - 0.5) - (y[2] - j - 0.5) * (x[0] - i - 0.5)) / area;
      if (a < -1e-6 || b < -1e-6 || a + b > 1.000001) continue;
      const p = 4 * (j * size + i);
      data[p] = id & 255; data[p + 1] = (id >> 8) & 255; data[p + 2] = (id >> 16) & 255; data[p + 3] = 255;
    }
  }
  geometry.setAttribute('pomIsland', new THREE.BufferAttribute(attribute, 1));
  featherPomAtlas(data, size);
  const texture = new THREE.DataTexture(data, size, size);
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export const pomUniforms = { uPomDepth: { value: 0.025 }, uPomEnabled: { value: 1 }, uPomShadow: { value: 0.8 } };
const materialHeights = new WeakMap();
const flatHeight = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat);
flatHeight.needsUpdate = true;

/** Swap an actual height map with its texture LOD. Null disables relief; no brightness fallback. */
export function setPomHeight(material, texture) {
  const uniforms = materialHeights.get(material);
  if (!uniforms) throw new Error('Install pomLayer before setting its height map');
  if (texture && texture.colorSpace !== THREE.NoColorSpace) throw new Error('POM height maps must use linear data');
  uniforms.tPomHeight.value = texture ?? flatHeight;
  uniforms.uPomHeightReady.value = texture ? 1 : 0;
}

const declarations = /* glsl */ `
uniform sampler2D tPomIslands, tPomHeight;
uniform float uPomDepth, uPomEnabled, uPomShadow, uPomHeightReady;
flat varying float vPomIsland;
float pomWeight = 0.0, pomThickness = 0.0, pomHitDepth = 0.0;
vec2 pomHitUv = vec2(0.0), pomDx = vec2(0.0), pomDy = vec2(0.0), pomPixelMetres = vec2(1.0);
vec3 pomGradU = vec3(0.0), pomGradV = vec3(0.0), pomNormal = vec3(0.0);
#ifdef USE_MAP
bool pomInside(vec2 uv) {
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return false;
  float id = dot(floor(texture2D(tPomIslands, uv).rgb * 255.0 + 0.5), vec3(1.0, 256.0, 65536.0));
  return abs(id - vPomIsland) < 0.5;
}
float pomClearanceAt(ivec2 cell) {
  ivec2 size = textureSize(tPomIslands, 0);
  if (any(lessThan(cell, ivec2(0))) || any(greaterThanEqual(cell, size))) return 0.0;
  vec4 mask = texelFetch(tPomIslands, cell, 0);
  float id = dot(floor(mask.rgb * 255.0 + 0.5), vec3(1.0, 256.0, 65536.0));
  return abs(id - vPomIsland) < 0.5 ? mask.a * 15.0 : 0.0;
}
float pomClearance(vec2 uv) {
  vec2 cell = uv * vec2(textureSize(tPomIslands, 0)) - 0.5, f = fract(cell);
  ivec2 i = ivec2(floor(cell));
  return mix(mix(pomClearanceAt(i), pomClearanceAt(i + ivec2(1, 0)), f.x),
    mix(pomClearanceAt(i + ivec2(0, 1)), pomClearanceAt(i + ivec2(1, 1)), f.x), f.y);
}
// Reconstruct enlarged height texels with a cubic filter, avoiding angular cavity rims. No derivatives
// inside a march; explicit gradients select the mip consistently for view, bump and shadow samples.
vec4 pomSmooth(sampler2D t, vec2 uv, vec2 dx, vec2 dy) {
  vec2 size = vec2(textureSize(t, 0));
  float footprint = max(length(dx * size), length(dy * size));
  vec4 plain = textureGrad(t, uv, dx, dy);
  if (footprint >= 0.8) return plain;
  vec2 px = uv * size - 0.5, f = fract(px), i = floor(px), f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0, w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0;
  vec2 w3 = f3 / 6.0, w2 = 1.0 - w0 - w1 - w3, s0 = w0 + w1, s1 = w2 + w3;
  vec2 t0 = (i - 0.5 + w1 / s0) / size, t1 = (i + 1.5 + w3 / s1) / size;
  vec4 cubic = (textureLod(t, vec2(t0.x, t0.y), 0.0) * s0.x + textureLod(t, vec2(t1.x, t0.y), 0.0) * s1.x) * s0.y
    + (textureLod(t, vec2(t0.x, t1.y), 0.0) * s0.x + textureLod(t, vec2(t1.x, t1.y), 0.0) * s1.x) * s1.y;
  return mix(cubic, plain, smoothstep(0.35, 0.8, footprint));
}
float pomDepthAt(vec2 uv, vec2 dx, vec2 dy) {
  return 1.0 - clamp(pomSmooth(tPomHeight, uv, dx, dy).r, 0.0, 1.0);
}
vec2 pomTrace(vec2 uv, vec3 at) {
  vec3 px = dFdx(at), py = dFdy(at);
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec3 crossed = cross(px, py);
  float area = length(crossed);
  if (area < 1e-12 || uPomEnabled < 0.5 || uPomDepth <= 0.0 || uPomHeightReady < 0.5) return vec2(0.0);
  vec3 n = crossed / area, view = normalize(-at);
  float facing = abs(dot(n, view));
  float fade = (1.0 - smoothstep(8.0, 22.0, length(at))) * smoothstep(0.08, 0.24, facing);
  float amount = uPomDepth * fade;
  if (amount < 0.00001 || !pomInside(uv)) return vec2(0.0);
  // Dual basis converts metres along the view ray into atlas UVs: no tangents required, and both mirrored
  // islands and differently scaled islands retain the same physical depth.
  vec3 r1 = cross(py, n), r2 = cross(n, px);
  vec3 gradU = (dx.x * r1 + dy.x * r2) / area, gradV = (dx.y * r1 + dy.y * r2) / area;
  vec2 travel = -vec2(dot(gradU, view), dot(gradV, view)) * amount / max(facing, 0.10);
  vec2 size = vec2(textureSize(tPomHeight, 0));
  // Keep a fixed UV limit across texture streaming. Feather before tracing instead of snapping all the way
  // back to zero when a ray hits the edge of a packed island. Reserve a texel for filtering as well.
  float limit = min(1.0, (12.0 / 4096.0) / max(length(travel), 1e-8));
  travel *= limit; amount *= limit;
  float seam = smoothstep(0.0, 2.0 + length(travel * vec2(textureSize(tPomIslands, 0))), max(0.0, pomClearance(uv) - 1.0));
  travel *= seam; amount *= seam;
  if (amount < 0.00001) return vec2(0.0);
  pomWeight = fade * seam;
  pomThickness = amount; pomDx = dx; pomDy = dy;
  pomGradU = gradU; pomGradV = gradV; pomNormal = n;
  pomPixelMetres = max(vec2(length(px), length(py)), vec2(1e-6));
  pomHitUv = uv;
  float first = pomDepthAt(uv, dx, dy);
  // Straight-on viewing still needs a depth for cavity shadows and matching bump shading.
  if (length(travel * size) < 0.02 || first < 0.0001) { pomHitDepth = first; return vec2(0.0); }
  float layers = ceil(clamp(12.0 + length(travel * size) * 2.0, 12.0, 40.0)), stepDepth = 1.0 / layers;
  float before = 0.0, after = 0.0;
  for (int i = 0; i < 40; i++) {
    after = min(1.0, float(i + 1) * stepDepth);
    vec2 sampleUv = uv + travel * after;
    if (!pomInside(sampleUv)) { pomWeight = pomThickness = 0.0; return vec2(0.0); }
    if (after >= pomDepthAt(sampleUv, dx, dy)) break;
    before = after;
  }
  // Refine the first crossing, so even a close, grazing view does not expose the march's layers.
  for (int i = 0; i < 5; i++) {
    float middle = (before + after) * 0.5;
    vec2 sampleUv = uv + travel * middle;
    if (!pomInside(sampleUv)) { pomWeight = pomThickness = 0.0; return vec2(0.0); }
    if (middle < pomDepthAt(sampleUv, dx, dy)) before = middle; else after = middle;
  }
  // A secant between the final bracket samples removes the remaining discrete depth steps.
  float a = pomDepthAt(uv + travel * before, dx, dy) - before;
  float b = pomDepthAt(uv + travel * after, dx, dy) - after;
  pomHitDepth = mix(before, after, clamp(a / max(a - b, 1e-6), 0.0, 1.0));
  pomHitUv = uv + travel * pomHitDepth;
  return travel * pomHitDepth;
}

// Differentiate the height field at the intersection, not the warped screen image. Screen-space differences
// across a visibility jump made the old shader draw black outlines and changed its bump strength with view.
vec2 pomBump() {
  if (pomThickness <= 0.0) return vec2(0.0);
  vec2 texel = 1.0 / vec2(textureSize(tPomHeight, 0));
  float u = pomDepthAt(pomHitUv + vec2(texel.x, 0.0), pomDx, pomDy) - pomDepthAt(pomHitUv - vec2(texel.x, 0.0), pomDx, pomDy);
  float v = pomDepthAt(pomHitUv + vec2(0.0, texel.y), pomDx, pomDy) - pomDepthAt(pomHitUv - vec2(0.0, texel.y), pomDx, pomDy);
  vec2 slope = -pomThickness * vec2(u, v) / (2.0 * texel);
  return clamp(vec2(dot(slope, pomDx), dot(slope, pomDy)) / pomPixelMetres, -0.65, 0.65);
}

// March from the visible recess towards the light. Only direct light is attenuated; skylight still fills
// the carving. A growing bias/penumbra keeps shallow cuts soft and avoids self-shadow acne.
float pomVisibility(vec3 light) {
  if (pomThickness <= 0.0 || pomHitDepth < 0.01 || uPomShadow <= 0.0) return 1.0;
  float above = dot(pomNormal, light);
  if (above <= 0.04) return 1.0;
  vec2 travel = vec2(dot(pomGradU, light), dot(pomGradV, light)) * pomThickness * pomHitDepth / above;
  float occlusion = 0.0;
  for (int i = 1; i <= 12; i++) {
    float t = float(i) / 12.0;
    vec2 uv = pomHitUv + travel * t;
    if (!pomInside(uv)) break;
    float rayDepth = pomHitDepth * (1.0 - t);
    float surface = pomDepthAt(uv, pomDx, pomDy);
    occlusion = max(occlusion, smoothstep(0.015, 0.055 + t * 0.08, rayDepth - surface));
  }
  return 1.0 - occlusion * uPomShadow * pomWeight * smoothstep(0.04, 0.16, above);
}
#endif
`;

/** Compose after sandLayer. All material maps use the same untransformed UV0 atlas, as Luxor's export does. */
export function pomLayer(material, islands, uniforms = pomUniforms) {
  const previous = material.onBeforeCompile, cacheKey = material.customProgramCacheKey();
  const height = { tPomHeight: { value: flatHeight }, uPomHeightReady: { value: 0 } };
  materialHeights.set(material, height);
  material.defines = { ...material.defines, TROMPE_POM: 1 };
  material.onBeforeCompile = function (shader, renderer) {
    previous.call(this, shader, renderer);
    Object.assign(shader.uniforms, uniforms, height, { tPomIslands: { value: islands } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float pomIsland; flat varying float vPomIsland;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPomIsland = pomIsland;');
    // The map sampler must be declared before the POM functions.
    shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_pars_fragment>', '#include <clipping_planes_pars_fragment>\n' + declarations);
    for (const chunk of ['map_fragment', 'normal_fragment_maps', 'roughnessmap_fragment', 'metalnessmap_fragment', 'aomap_fragment']) {
      shader.fragmentShader = shader.fragmentShader.replace(`#include <${chunk}>`, THREE.ShaderChunk[chunk]);
    }
    // Move every atlas lookup together; leave the normal map's tangent frame on the original UV derivatives.
    shader.fragmentShader = shader.fragmentShader.replace(/(texture2D|sandSmooth)\(\s*(map|normalMap|roughnessMap|metalnessMap|aoMap)\s*,\s*(v\w+Uv)\s*\)/g, '$1( $2, $3 + pomOffset )')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
vec2 pomOffset = vec2(0.0);
#ifdef USE_MAP
pomOffset = pomTrace(vMapUv, -vViewPosition);
#endif`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>',
      THREE.ShaderChunk.lights_fragment_begin.replace('getDirectionalLightInfo( directionalLight, directLight );', `getDirectionalLightInfo( directionalLight, directLight );
#ifdef USE_MAP
directLight.color *= pomVisibility(directLight.direction);
#endif`));
  };
  material.customProgramCacheKey = () => `${cacheKey}|pom-height-3`;
  material.needsUpdate = true;
}
