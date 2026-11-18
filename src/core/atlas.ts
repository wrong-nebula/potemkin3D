/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import * as THREE from 'three';
import { byteTarget, floatTarget, passMaterial, type Gpu } from './gpu';
import type { Level } from './scene';

/**
 * The texture being painted, in UV space. Each texel stores sRGB colour and the quality it was captured at
 * (cos(view angle) / distance; 0 = not painted). Projection passes rasterise the level in UV space and pull
 * colour from a view's composited image wherever that view sees the texel better than what is stored.
 *
 * The texture can be several: a grid of pages that together are the one square the level's texture coordinates
 * run over (core/layout.ts pagedLayout puts every island wholly on one page). Each pass here runs page by page,
 * with the same inputs and the same rules, so a view paints all the pages it sees at once and nothing about a
 * texel depends on which page it is on. `page` is the page being drawn: its column, its row, and the pages a side.
 */
const UV_VERT = /* glsl */ `
uniform vec3 page;
in float label;
out vec3 vWorld;
out vec3 vNormal;
flat out float vLabel;
void main() {
  vLabel = label;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = vec4((uv * page.z - page.xy) * 2.0 - 1.0, 0.0, 1.0);   // the other pages' faces fall outside and are clipped
}`;

/**
 * For a shader that shows the texture: the texel at a place in the level's texture space, from the page it is on.
 * (`atlasGrid`: pages a side. The pages are the layers of one array texture, row by row.)
 */
export const ATLAS_GLSL = /* glsl */ `
uniform float atlasGrid;
vec4 atlasTexel(highp sampler2DArray pages, vec2 uv) {
  vec2 g = uv * atlasGrid, t = clamp(floor(g), 0.0, atlasGrid - 1.0);
  return texture(pages, vec3(g - t, t.y * atlasGrid + t.x));
}`;

const PROJECT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D prev;
uniform sampler2D gPos;
uniform sampler2D comp;
uniform mat4 viewProj;
uniform vec3 camPos;
uniform float ratio;
uniform float detail;
uniform float minCos;
uniform float guard;
uniform float margin;
uniform vec2 texel;
uniform float edgeRadius;
in vec3 vWorld;
in vec3 vNormal;
layout(location = 0) out vec4 outColor;
void main() {
  vec4 old = texelFetch(prev, ivec2(gl_FragCoord.xy), 0);
  outColor = old;
  vec4 clip = viewProj * vec4(vWorld, 1.0);
  if (clip.w <= 0.0) return;
  vec3 ndc = clip.xyz / clip.w;
  // the rim of an image is where the model lets things peek in (a sliver of a door, half a window): not painted from
  if (abs(ndc.x) > 0.999 - 2.0 * margin || abs(ndc.y) > 0.999 - 2.0 * margin) return;
  vec2 suv = ndc.xy * 0.5 + 0.5;
  vec3 toCam = camPos - vWorld;
  float dist = length(toCam);
  float cosv = dot(normalize(vNormal), toCam / dist);
  // a surface seen at too low an angle comes out stretched: leave it to a view that sees it better
  if (cosv < minCos) return;
  vec4 g = texture(gPos, suv);
  bool sky = g.w <= 0.0;
  if (!sky && dist > g.w + 0.02 + 0.01 * dist) return;
  // detail: under 1 when the image holds fewer pixels of real detail than its size (a model that paints small)
  float q = detail * cosv / max(dist, 0.5);
  // Near a silhouette the model's image is least trustworthy (slight misalignment paints the wrong side onto
  // the edge), so capture it at reduced quality: a view that sees it away from an edge will replace it.
  float edge = 0.0;
  for (int k = 0; k < 8; k++) {
    float a = 0.7853982 * float(k);
    vec4 n = texture(gPos, suv + vec2(cos(a), sin(a)) * edgeRadius * texel);
    if (n.w <= 0.0 || abs(n.w - g.w) > 0.04 * g.w) edge = 1.0;
  }
  q *= mix(1.0, 0.3, edge);
  // Right beside something nearer (a glazing bar in front of a building, a column in front of a wall) the image
  // belongs to that nearer thing as often as not, and would be painted onto this surface as a ghost of it. Skip it:
  // a gap can be found and filled, a ghost cannot.
  if (guard > 0.0) {
    for (int k = 0; k < 8; k++) {
      float a = 0.7853982 * float(k);
      for (int r = 1; r <= 2; r++) {
        vec4 n = texture(gPos, suv + vec2(cos(a), sin(a)) * guard * 0.5 * float(r) * texel);
        if (n.w > 0.0 && n.w < 0.96 * g.w - 0.02) return;
      }
    }
  }
  if (old.a > 0.0 && old.a >= ratio * q) return;
  // comp is premultiplied: pixels a view must not project (alpha 0) drop out, also from the filtered edge
  vec4 c = texture(comp, vec2(suv.x, 1.0 - suv.y));
  if (c.a < 0.5) return;
  outColor = vec4(c.rgb / c.a, q);
}`;

/**
 * World position and normal per texel, for baking in texture space. The normal's a is 1 where a triangle covers the
 * texel; the position's a is the part's label + 1 there.
 */
const TEXEL_FRAG = /* glsl */ `
in vec3 vWorld;
in vec3 vNormal;
flat in float vLabel;
layout(location = 0) out vec4 outPos;
layout(location = 1) out vec4 outNrm;
void main() {
  outPos = vec4(vWorld, vLabel + 1.0);   // a: the part's label + 1
  outNrm = vec4(normalize(vNormal), 1.0);
}`;

const ISLAND_FRAG = /* glsl */ `
layout(location = 0) out vec4 outColor;
void main() { outColor = vec4(1.0); }`;

const COPY_FRAG = /* glsl */ `
uniform sampler2D src;
layout(location = 0) out vec4 outColor;
void main() { outColor = texelFetch(src, ivec2(gl_FragCoord.xy), 0); }`;
const COPY_LAYER_FRAG = /* glsl */ `
uniform highp sampler2DArray src;
uniform int layer;
layout(location = 0) out vec4 outColor;
void main() { outColor = texelFetch(src, ivec3(gl_FragCoord.xy, layer), 0); }`;

const DILATE_FRAG = /* glsl */ `
uniform sampler2D src;
uniform sampler2D islands;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 hi = textureSize(src, 0) - 1;
  vec4 c = texelFetch(src, p, 0);
  if (c.a > 0.0 || texelFetch(islands, p, 0).r > 0.5) { outColor = c; return; }
  vec4 acc = vec4(0.0);
  float n = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec4 s = texelFetch(src, clamp(p + ivec2(dx, dy), ivec2(0), hi), 0);
      if (s.a > 0.0) { acc += s; n += 1.0; }
    }
  }
  outColor = n > 0.0 ? acc / n : c;
}`;

/** The finishing fill: unpainted texels on the level take the fill's colour, at a quality any real view beats. */
const FILL_FRAG = /* glsl */ `
uniform sampler2D src;
uniform sampler2D islands;
uniform sampler2D fill;
uniform float quality;
uniform vec3 page;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(src, p, 0);
  outColor = c;
  if (c.a > 0.0 || texelFetch(islands, p, 0).r < 0.5) return;
  vec4 f = texture(fill, (page.xy + gl_FragCoord.xy / vec2(textureSize(src, 0))) / page.z);   // the fill covers all the pages
  if (f.a > 0.5) outColor = vec4(f.rgb / f.a, quality);
}`;

/** Replace painted texel RGB from a consolidated atlas while keeping per-texel capture quality `c.a` intact. */
const UPDATE_PAINT_FRAG = /* glsl */ `
uniform sampler2D src;
uniform sampler2D paint;
uniform vec3 page;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(src, p, 0);
  outColor = c;
  if (c.a <= 0.0003) return;
  vec4 u = texture(paint, (page.xy + gl_FragCoord.xy / vec2(textureSize(src, 0))) / page.z);
  if (u.a > 0.5) outColor = vec4(u.rgb / u.a, c.a);
}`;

/** Apply a signed RGB seam-consolidation offset (`128/255` = 0, `±1` over `±127/255`) across all pages, blending smoothly into `paint.rgb` right across sub-cell view-boundary ribbons (`paint.a > 0.52`). */
const CONSOLIDATE_PAINT_FRAG = /* glsl */ `
uniform sampler2D src;
uniform sampler2D paint;
uniform sampler2D delta;
uniform vec3 page;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(src, p, 0);
  outColor = c;
  if (c.a <= 0.0003) return;
  vec2 uv = (page.xy + gl_FragCoord.xy / vec2(textureSize(src, 0))) / page.z;
  vec4 d = texture(delta, uv);
  if (d.a < 0.5) return;
  vec3 off = (d.rgb - vec3(128.0 / 255.0)) * (255.0 / 127.0);
  vec3 corrected = clamp(c.rgb + off, 0.0, 1.0);
  vec4 u = texture(paint, uv);
  float seam = clamp((u.a - 0.52) / 0.45, 0.0, 1.0);
  outColor = vec4(mix(corrected, u.rgb, seam), c.a);
}`;

/** Paint3D-style UV refinement writeback: fills unpainted island texels at `quality` (> PAINTED) from `inpaint` and applies signed delighting/sharpening `delta` onto already-painted texels without losing native 4K/8K detail. */
const UV_REFINE_FRAG = /* glsl */ `
uniform sampler2D src;
uniform sampler2D islands;
uniform sampler2D inpaint;
uniform sampler2D delta;
uniform float quality;
uniform vec3 page;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(src, p, 0);
  outColor = c;
  vec2 uv = (page.xy + gl_FragCoord.xy / vec2(textureSize(src, 0))) / page.z;
  if (c.a <= 0.0003) {
    if (texelFetch(islands, p, 0).r < 0.5) return;
    vec4 f = texture(inpaint, uv);
    if (f.a > 0.5) outColor = vec4(f.rgb / f.a, quality);
    return;
  }
  vec4 d = texture(delta, uv);
  if (d.a < 0.5) return;
  vec3 off = (d.rgb - vec3(128.0 / 255.0)) * (255.0 / 127.0);
  outColor = vec4(clamp(c.rgb + off, 0.0, 1.0), c.a);
}`;

/** A part's own texture drawn into the level's layout: each corner carries where it is in both. */
const PART_VERT = /* glsl */ `
uniform vec3 page;
in vec2 theirs;
out vec2 vTheirs;
void main() {
  vTheirs = theirs;
  gl_Position = vec4((uv * page.z - page.xy) * 2.0 - 1.0, 0.0, 1.0);
}`;
const PART_FRAG = /* glsl */ `
uniform sampler2D map;
in vec2 vTheirs;
layout(location = 0) out vec4 outColor;
void main() { outColor = vec4(texture(map, vTheirs).rgb, 1.0); }`;
const MERGE_FRAG = /* glsl */ `
uniform sampler2D src;
uniform sampler2D part;
uniform float quality;
uniform float below;
uniform vec3 gain;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(src, p, 0);
  vec4 t = texelFetch(part, p, 0);
  outColor = t.a > 0.5 && c.a < below ? vec4(clamp(t.rgb * gain, 0.0, 1.0), quality) : c;
}`;

/**
 * The ground laid from tiles (core/ground.ts). Each texel of ground takes its colour from its place in the world:
 * the ground is divided into a triangle grid of patches, each patch has a tile, a turn and a shift of its own, and a
 * texel blends the three patches around it. The blend keeps the tiles' contrast (weights sharpened, the result
 * rescaled about the mean colour), so the seams between patches are not gray mush. The tiles are one stretch of
 * ground in three states of wear; which state shows where is decided texel by texel, in zones a few metres across.
 */
const GROUND_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D prev;
uniform sampler2D tile0;
uniform sampler2D tile1;
uniform sampler2D tile2;
uniform int tiles;
uniform float span;
uniform float cell;
uniform float seed;
uniform float floorY;
uniform float band;
uniform float quality;
uniform float turn;
uniform vec3 mean0;
uniform vec3 mean1;
uniform vec3 mean2;
uniform sampler2D edges;
uniform sampler2D tone;
uniform vec4 field;      // world x, z of the fields' corner and 1 / their size in x and z
uniform float dirt;
uniform float labels[8];
uniform int labelCount;
uniform float uAny;      // 1: every face of the named parts, whichever way it faces
uniform float uMirror;   // 1: the tile repeated, mirrored at each edge, in place of random patches
in vec3 vWorld;
in vec3 vNormal;
flat in float vLabel;
layout(location = 0) out vec4 outColor;

vec2 hash2(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973) + seed * 0.137);
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i).x, hash2(i + vec2(1, 0)).x, f.x), mix(hash2(i + vec2(0, 1)).x, hash2(i + vec2(1, 1)).x, f.x), f.y);
}
// the tiles show the same surface in three states of wear, so they mix texel by texel without a seam
vec3 tileAt(vec2 uv, vec2 gx, vec2 gy, float dirty, float worn) {
  vec3 c = textureGrad(tile0, uv, gx, gy).rgb;
  if (tiles > 2 && worn > 0.0) c = mix(c, textureGrad(tile2, uv, gx, gy).rgb, worn);
  if (tiles > 1 && dirty > 0.0) c = mix(c, textureGrad(tile1, uv, gx, gy).rgb, dirty);
  return c;
}
vec3 patchColour(vec2 id, vec2 p, vec2 dx, vec2 dy, float dirty, float worn) {
  vec2 h = hash2(id), h2 = hash2(id + 71.3);
  float a = turn > 1.5 ? 6.2831853 * h.x : turn > 0.5 ? 1.5707963 * floor(4.0 * h.x) : 0.0;
  mat2 r = mat2(cos(a), sin(a), -sin(a), cos(a));
  // the patch's centre goes somewhere in the middle half of the tile, so the patch never reaches the tile's edge
  vec2 centre = (id.x * vec2(1.0, 0.0) + id.y * vec2(0.5, 0.8660254)) * cell;
  return tileAt(r * ((p - centre) / span) + 0.25 + 0.5 * h2, r * dx / span, r * dy / span, dirty, worn);
}
void main() {
  vec4 old = texelFetch(prev, ivec2(gl_FragCoord.xy), 0);
  outColor = old;
  bool mine = false;
  vec3 n = normalize(vNormal);
  if (labelCount > 0) {
    for (int k = 0; k < 8; k++) if (k < labelCount && abs(vLabel - labels[k]) < 0.5) mine = true;
    if (!mine || (uAny < 0.5 && n.y < 0.7)) return;
  } else if (n.y < 0.85 || abs(vWorld.y - floorY) > band) return;
  // the plane the tile is laid in: the ground's, or for any face the one it lies nearest to (so a joist's sides
  // take the boards along their length, not smeared down them)
  vec3 an = abs(n);
  vec2 p = uAny < 0.5 || (an.y >= an.x && an.y >= an.z) ? vWorld.xz : an.x > an.z ? vWorld.zy : vWorld.xy;
  vec2 dx = dFdx(p), dy = dFdy(p);
  // triangle grid: skew to a square grid, find the triangle, weights are the barycentric coordinates
  vec2 s = vec2(p.x - p.y * 0.5773503, p.y * 1.1547005) / cell;
  vec2 base = floor(s), f = fract(s);
  float up = step(f.x + f.y, 1.0);
  vec2 id0 = base + vec2(1.0 - up), id1 = base + vec2(1.0, 0.0), id2 = base + vec2(0.0, 1.0);
  vec3 w = up > 0.5 ? vec3(1.0 - f.x - f.y, f.x, f.y) : vec3(f.x + f.y - 1.0, 1.0 - f.y, 1.0 - f.x);
  // where the ground is dirtier and where more worn: zones a few metres across, and dirt gathers towards walls
  vec2 fuv = (p - field.xy) * field.zw;
  float e = texture(edges, fuv).r * dirt;
  float n1 = 0.65 * noise(p / 4.3) + 0.35 * noise(p / 1.3 + 9.0);
  float n2 = 0.65 * noise(p / 5.1 + 31.0) + 0.35 * noise(p / 1.7 + 4.0);
  float dirty = smoothstep(0.5, 0.8, 0.8 * n1 + 0.7 * e);
  float worn = smoothstep(0.5, 0.75, n2) * (1.0 - dirty);
  vec3 c0 = patchColour(id0, p, dx, dy, dirty, worn), c1 = patchColour(id1, p, dx, dy, dirty, worn), c2 = patchColour(id2, p, dx, dy, dirty, worn);
  // sharpen, and let the lighter sample lead: a stone's face wins over the joint beside it, so stones stay whole
  vec3 lum = vec3(dot(c0, vec3(0.3, 0.6, 0.1)), dot(c1, vec3(0.3, 0.6, 0.1)), dot(c2, vec3(0.3, 0.6, 0.1)));
  w = pow(w, vec3(4.0)) * pow(lum + 0.05, vec3(2.0));
  w /= max(w.x + w.y + w.z, 1e-6);
  vec3 m = mean0;
  if (tiles > 2) m = mix(m, mean2, worn);
  if (tiles > 1) m = mix(m, mean1, dirty);
  vec3 c = m + ((c0 - m) * w.x + (c1 - m) * w.y + (c2 - m) * w.z) / sqrt(dot(w, w));
  // a material with a grain (boards, bricks) is not cut into patches: the tile repeats, turned over at each edge so
  // that it meets itself there, and the zones of wear and of tone are what keep the repeat from showing
  if (uMirror > 0.5) c = tileAt(p / span, dx / span, dy / span, dirty, worn);
  // the level's own variation: the tone the views gave this stretch of ground, a slow drift, a shadow of grime at walls
  vec3 t = texture(tone, fuv).rgb * (255.0 / 127.0);
  c *= t * (0.95 + 0.1 * noise(p / 3.7 + 50.0));
  e *= 0.6 + 0.8 * noise(p * 1.9 + 17.0);
  c = mix(c, c * vec3(0.5, 0.47, 0.43), clamp(0.7 * e, 0.0, 0.6));
  outColor = vec4(clamp(c, 0.0, 1.0), quality);
}`;

/** The capture quality a part textured on its own is stored at: painted, but a view that sees it well still wins. */
export const PART_QUALITY = 0.02;
/** Capture quality for position/normal-conditioned UV-space inpainting (core/uv-refine.ts): counts as painted (`> PAINTED`), while closer camera views still win. */
export const UV_REFINE_QUALITY = 0.015;

/**
 * The capture quality the finishing fill is stored at, and the quality from which a texel counts as painted by a
 * view. A real capture is never this poor (the worst is about 4e-4), so any view replaces a filled texel.
 */
export const FILL_QUALITY = 2e-4;
export const PAINTED = 3e-4;

const BYTES_FRAG = /* glsl */ `
uniform highp sampler2DArray src;
uniform int layer;
uniform vec3 fill;
uniform int cell;
uniform float keepAlpha;
layout(location = 0) out vec4 outColor;
void main() {
  // average the painted texels of each cell x cell block (cell 1: the texel itself)
  ivec2 base = ivec2(gl_FragCoord.xy) * cell;
  vec3 acc = vec3(0.0);
  float n = 0.0;
  for (int y = 0; y < cell; y++) for (int x = 0; x < cell; x++) {
    vec4 c = texelFetch(src, ivec3(base + ivec2(x, y), layer), 0);
    if (c.a > 0.0) { acc += c.rgb; n += 1.0; }
  }
  outColor = vec4(n > 0.0 ? acc / n : fill, keepAlpha > 0.5 && n == 0.0 ? 0.0 : 1.0);
}`;

const CELL_FRAG = /* glsl */ `
uniform sampler2D src;
uniform int cell;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * cell;
  float q = 0.0;
  for (int y = 0; y < cell; y++) for (int x = 0; x < cell; x++) q = max(q, texelFetch(src, base + ivec2(x, y), 0).a);
  outColor = vec4(q, 0.0, 0.0, 1.0);
}`;

const STATS_FRAG = /* glsl */ `
uniform sampler2D src;
uniform sampler2D islands;
uniform float step;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 p = ivec2((gl_FragCoord.xy - 0.5) * step + 0.5 * step);
  float island = texelFetch(islands, p, 0).r;
  float known = texelFetch(src, p, 0).a > 0.0003 ? 1.0 : 0.0;   // painted by a view (not the finishing fill)
  outColor = vec4(island, known * island, 0.0, 1.0);
}`;

/** One page: the texture as painted (`a`) and where the level's faces are on it (`islands`). */
interface Page { a: THREE.WebGLRenderTarget; islands: THREE.WebGLRenderTarget }

export class Atlas {
  /** Changes whenever paint changes. Runtime material masks are bound to one revision. */
  revision = 0;
  /** The texture's size along a side, all its pages together. */
  readonly size: number;
  private readonly pages: Page[] = [];
  /** Two working textures, shared by all the pages: a page is worked on alone. */
  private b: THREE.WebGLRenderTarget;
  private readonly temp: THREE.WebGLRenderTarget;
  /** Padded copies (UV gutters filled) used for display, state renders and export: one layer a page, row by row. */
  readonly display: THREE.WebGLArrayRenderTarget;
  /** The page being drawn (column, row, pages a side); (0, 0, 1) draws the whole texture space into one target. */
  private readonly pageU = { value: new THREE.Vector3(0, 0, 1) };
  private readonly uvScene = new THREE.Scene();
  private readonly uvMesh: THREE.Mesh;
  private readonly uvCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly projectMat: THREE.ShaderMaterial;
  private readonly islandMat: THREE.ShaderMaterial;
  private readonly copyMat = passMaterial(COPY_FRAG, { src: { value: null } });
  private readonly copyLayerMat = passMaterial(COPY_LAYER_FRAG, { src: { value: null }, layer: { value: 0 } });
  private readonly dilateMat = passMaterial(DILATE_FRAG, { src: { value: null }, islands: { value: null } });
  private readonly bytesMat = passMaterial(BYTES_FRAG, { src: { value: null }, layer: { value: 0 }, fill: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
    cell: { value: 1 }, keepAlpha: { value: 0 } });
  private readonly cellMat = passMaterial(CELL_FRAG, { src: { value: null }, cell: { value: 32 } });
  private readonly statsMat = passMaterial(STATS_FRAG, { src: { value: null }, islands: { value: null }, step: { value: 8 } });

  /**
   * @param pageSize px along a side of each texture
   * @param grid textures along each side of the level's texture space: 1 (one texture), 2 (four) or 4 (sixteen).
   *   More than one needs a layout whose islands each lie on one page (core/layout.ts pagedLayout).
   */
  constructor(private readonly gpu: Gpu, level: Level, readonly pageSize = 4096, readonly grid = 1) {
    if (![1, 2, 4].includes(grid)) throw new Error(`a texture is 1, 4 or 16 pages (1, 2 or 4 a side), not ${grid} a side`);
    this.size = pageSize * grid;
    this.b = floatTarget(pageSize, pageSize, { half: true, linear: true });
    this.temp = floatTarget(pageSize, pageSize, { half: true, linear: true });
    this.display = new THREE.WebGLArrayRenderTarget(pageSize, pageSize, grid * grid, { type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false });
    this.projectMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: UV_VERT, fragmentShader: PROJECT_FRAG, side: THREE.DoubleSide,
      depthTest: false, depthWrite: false,
      uniforms: { page: this.pageU, prev: { value: null }, gPos: { value: null }, comp: { value: null }, viewProj: { value: new THREE.Matrix4() }, detail: { value: 1 }, minCos: { value: 0.08 }, guard: { value: 0 }, margin: { value: 0 },
        camPos: { value: new THREE.Vector3() }, ratio: { value: 0.4 }, texel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        edgeRadius: { value: 6 } },
    });
    this.islandMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: UV_VERT, fragmentShader: ISLAND_FRAG, side: THREE.DoubleSide,
      depthTest: false, depthWrite: false, uniforms: { page: this.pageU },
    });
    this.uvMesh = new THREE.Mesh(level.geometry, this.islandMat);
    this.uvMesh.frustumCulled = false;
    this.uvScene.add(this.uvMesh);
    for (let k = 0; k < grid * grid; k++) {
      this.pages.push({ a: floatTarget(pageSize, pageSize, { half: true, linear: true }), islands: byteTarget(pageSize, pageSize, { linear: false }) });
    }
    this.eachPage((page) => this.gpu.draw(this.uvScene, this.uvCam, page.islands, 0x000000, 0));
    this.reset();
  }

  /** The padded texture to sample, a layer a page (rgb = sRGB colour, a = capture quality, 0 = unpainted): see ATLAS_GLSL. */
  get texture(): THREE.Texture {
    return this.display.texture;
  }

  /** How many textures the level's texture is. */
  get pageCount() {
    return this.pages.length;
  }

  /** Run `fn` for each page in turn, with the UV-space shaders drawing that page. */
  private eachPage(fn: (page: Page, k: number) => void) {
    for (let k = 0; k < this.pages.length; k++) {
      this.pageU.value.set(k % this.grid, Math.floor(k / this.grid), this.grid);
      fn(this.pages[k], k);
    }
    this.pageU.value.set(0, 0, 1);
  }

  /** What was just drawn into the shared working texture becomes the page; the page's old texture is the working one now. */
  private swap(page: Page) {
    [page.a, this.b] = [this.b, page.a];
  }

  /** The pages some texture coordinates (2 per corner, over the whole texture space) fall on. */
  private pagesOf(uv: ArrayLike<number>): Set<number> {
    const on = new Set<number>();
    for (let t = 0; t + 5 < uv.length; t += 6) {
      const u = (uv[t] + uv[t + 2] + uv[t + 4]) / 3, v = (uv[t + 1] + uv[t + 3] + uv[t + 5]) / 3;
      const x = Math.min(this.grid - 1, Math.max(0, Math.floor(u * this.grid))), y = Math.min(this.grid - 1, Math.max(0, Math.floor(v * this.grid)));
      on.add(y * this.grid + x);
    }
    return on;
  }

  reset() {
    const empty = new THREE.Scene();
    for (const t of [...this.pages.map((p) => p.a), this.b, this.temp]) this.gpu.draw(empty, this.uvCam, t, 0x000000, 0);
    for (let k = 0; k < this.pages.length; k++) this.gpu.draw(empty, this.uvCam, this.display, 0x000000, 0, k);
    this.revision++;
  }

  /**
   * Paint from one view: `gPos` is that view's position/distance buffer, `comp` its composited image. Every page is
   * painted from the same image by the same rule.
   * @param detail the share of the image's pixels along a side that are real detail (1 unless it was scaled up)
   * @param minCos surfaces seen at a lower angle than this (cosine to the normal) are not painted
   * @param guard how close to a nearer surface's outline (px at a 1024 px view) a farther surface is left unpainted; 0 = off
   * @param margin the share of the image's side along each border that is not painted from
   */
  project(camera: THREE.Camera, gPos: THREE.Texture, comp: THREE.Texture, ratio: number, detail = 1, minCos = 0.08, guard = 0, margin = 0) {
    const u = this.projectMat.uniforms;
    u.gPos.value = gPos;
    u.comp.value = comp;
    u.viewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    u.camPos.value.setFromMatrixPosition(camera.matrixWorld);
    u.ratio.value = ratio;
    u.detail.value = detail;
    u.minCos.value = minCos;
    u.margin.value = margin;
    const img = gPos.image as { width: number; height: number };
    u.texel.value.set(1 / img.width, 1 / img.height);
    u.edgeRadius.value = (6 * img.width) / 1024;   // same angular band at any view size
    u.guard.value = (guard * img.width) / 1024;
    this.uvMesh.material = this.projectMat;
    this.eachPage((page, k) => {
      this.copyMat.uniforms.src.value = page.a.texture;
      this.gpu.pass(this.copyMat, this.b);
      u.prev.value = page.a.texture;
      this.gpu.draw(this.uvScene, this.uvCam, this.b, null);
      this.swap(page);
      this.padPage(page, k);
    });
    this.uvMesh.material = this.islandMat;
    this.revision++;
  }

  /** Fill UV gutters around islands so bilinear sampling never pulls in unpainted texels. */
  pad(iterations = 6) {
    this.eachPage((page, k) => this.padPage(page, k, iterations));
  }

  private padPage(page: Page, k: number, iterations = 6) {
    this.dilateMat.uniforms.islands.value = page.islands.texture;
    let src = page.a, dst = this.temp;
    for (let i = 0; i < iterations; i++) {
      this.dilateMat.uniforms.src.value = src.texture;
      this.gpu.pass(this.dilateMat, dst);
      src = dst;
      dst = dst === this.temp ? this.b : this.temp;
    }
    this.copyMat.uniforms.src.value = src.texture;
    this.gpu.pass(this.copyMat, this.display, true, k);
  }

  /** A texture to keep a copy of the padded texture in (`copyDisplay`), for comparing before and after. */
  makeDisplayCopy(): THREE.WebGLArrayRenderTarget {
    return new THREE.WebGLArrayRenderTarget(this.pageSize, this.pageSize, this.pages.length, { type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false });
  }

  copyDisplay(to: THREE.WebGLArrayRenderTarget) {
    this.copyLayerMat.uniforms.src.value = this.display.texture;
    for (let k = 0; k < this.pages.length; k++) {
      this.copyLayerMat.uniforms.layer.value = k;
      this.gpu.pass(this.copyLayerMat, to, true, k);
    }
  }

  /**
   * The finishing fill (core/finish.ts): give every unpainted texel on the level the colour `rgba` has for it
   * (n x n over the whole texture space, first row = v 0, alpha 0 where it has none). Filled texels stay targets
   * for any later view.
   */
  fillUnpainted(rgba: Uint8ClampedArray, n: number, quality = FILL_QUALITY) {
    const tex = new THREE.DataTexture(rgba, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.premultiplyAlpha = false;
    tex.needsUpdate = true;
    // premultiplied by hand, so the filtered edge of the fill doesn't darken towards cells it has nothing for
    for (let i = 0; i < rgba.length; i += 4) if (!rgba[i + 3]) rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
    const mat = passMaterial(FILL_FRAG, { src: { value: null }, islands: { value: null }, fill: { value: tex },
      quality: { value: quality }, page: this.pageU });
    this.eachPage((page, k) => {
      mat.uniforms.src.value = page.a.texture;
      mat.uniforms.islands.value = page.islands.texture;
      this.gpu.pass(mat, this.b);
      this.swap(page);
      this.padPage(page, k);
    });
    mat.dispose();
    tex.dispose();
    this.revision++;
  }

  /** Import a prepared paint atlas in the level's current UV layout, without relighting or colour conversion. */
  importPaint(rgba: Uint8ClampedArray, size: number) {
    if (!Number.isInteger(size) || size < 1 || rgba.length !== size * size * 4)
      throw new Error('Paint atlas dimensions do not match its pixels');
    this.reset();
    this.fillUnpainted(new Uint8ClampedArray(rgba), size, 1);
  }

  /** Update painted texels' RGB from a consolidated `n` x `n` RGBA8 map (first row = v 0), keeping capture quality `a`. */
  updatePaint(rgba: Uint8ClampedArray, n: number) {
    const copy = new Uint8ClampedArray(rgba);
    for (let i = 0; i < copy.length; i += 4) if (!copy[i + 3]) copy[i] = copy[i + 1] = copy[i + 2] = 0;
    const tex = new THREE.DataTexture(copy, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.premultiplyAlpha = false;
    tex.needsUpdate = true;
    const mat = passMaterial(UPDATE_PAINT_FRAG, { src: { value: null }, paint: { value: tex }, page: this.pageU });
    this.eachPage((page, k) => {
      mat.uniforms.src.value = page.a.texture;
      this.gpu.pass(mat, this.b);
      this.swap(page);
      this.padPage(page, k);
    });
    mat.dispose();
    tex.dispose();
    this.revision++;
  }

  /** Apply a consolidated low-frequency offset across all pages while blending `paintRgba` across sub-cell view-boundary ribbons (`paint.a = 255` on seams, `128` inside). */
  applyConsolidation(paintRgba: Uint8ClampedArray, deltaRgba: Uint8ClampedArray, n: number) {
    const paintTex = new THREE.DataTexture(paintRgba, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
    paintTex.minFilter = paintTex.magFilter = THREE.LinearFilter;
    paintTex.premultiplyAlpha = false;
    paintTex.needsUpdate = true;
    const deltaTex = new THREE.DataTexture(deltaRgba, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
    deltaTex.minFilter = deltaTex.magFilter = THREE.LinearFilter;
    deltaTex.premultiplyAlpha = false;
    deltaTex.needsUpdate = true;
    const mat = passMaterial(CONSOLIDATE_PAINT_FRAG, { src: { value: null }, paint: { value: paintTex }, delta: { value: deltaTex }, page: this.pageU });
    this.eachPage((page, k) => {
      mat.uniforms.src.value = page.a.texture;
      this.gpu.pass(mat, this.b);
      this.swap(page);
      this.padPage(page, k);
    });
    mat.dispose();
    paintTex.dispose();
    deltaTex.dispose();
    this.revision++;
  }

  /** Apply UV-space inpainting to unpainted island texels (at `quality > PAINTED`, driving unpainted share to ~0 without `finish.ts`) and signed delighting/sharpening deltas to painted texels. */
  applyUvRefinement(inpaintRgba: Uint8ClampedArray, deltaRgba: Uint8ClampedArray, n: number, quality = UV_REFINE_QUALITY) {
    const inpaintCopy = new Uint8ClampedArray(inpaintRgba);
    for (let i = 0; i < inpaintCopy.length; i += 4) if (!inpaintCopy[i + 3]) inpaintCopy[i] = inpaintCopy[i + 1] = inpaintCopy[i + 2] = 0;
    const inpaintTex = new THREE.DataTexture(inpaintCopy, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
    inpaintTex.minFilter = inpaintTex.magFilter = THREE.LinearFilter;
    inpaintTex.premultiplyAlpha = false;
    inpaintTex.needsUpdate = true;
    const deltaTex = new THREE.DataTexture(deltaRgba, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
    deltaTex.minFilter = deltaTex.magFilter = THREE.LinearFilter;
    deltaTex.premultiplyAlpha = false;
    deltaTex.needsUpdate = true;
    const mat = passMaterial(UV_REFINE_FRAG, {
      src: { value: null }, islands: { value: null }, inpaint: { value: inpaintTex }, delta: { value: deltaTex },
      quality: { value: quality }, page: this.pageU,
    });
    this.eachPage((page, k) => {
      mat.uniforms.src.value = page.a.texture;
      mat.uniforms.islands.value = page.islands.texture;
      this.gpu.pass(mat, this.b);
      this.swap(page);
      this.padPage(page, k);
    });
    mat.dispose();
    inpaintTex.dispose();
    deltaTex.dispose();
    this.revision++;
  }

  /**
   * The part pass (core/partpass.ts): copy a part's own texture into the level's texture.
   * @param ours where each corner of the part's triangles is in the level's layout (2 per corner)
   * @param theirs where the same corner is in the part's own texture (2 per corner, glTF's v down)
   * @param map the part's texture, as loaded (not flipped, not colour-converted)
   * @param below only texels captured worse than this are replaced (Infinity: the whole part)
   * @param gain multiplies the part's colours, to bring them to the tone the room's painting gave the part
   * @returns the part texture's mean colour (0..1, before `gain`) over the part's texels
   */
  bakePart(ours: Float32Array, theirs: Float32Array, map: THREE.Texture, below = Infinity, gain: [number, number, number] = [1, 1, 1],
    measureOnly = false): [number, number, number] {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((ours.length / 2) * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(ours, 2));
    g.setAttribute('theirs', new THREE.BufferAttribute(theirs, 2));
    const mat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: PART_VERT, fragmentShader: PART_FRAG, side: THREE.DoubleSide,
      depthTest: false, depthWrite: false, uniforms: { map: { value: map }, page: this.pageU } });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    // its mean colour, from a small copy
    const small = floatTarget(512, 512);
    this.gpu.draw(scene, this.uvCam, small, 0x000000, 0);
    const px = this.gpu.readF32(small, 0, false);
    small.dispose();
    const mean: [number, number, number] = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 0.5) { mean[0] += px[i]; mean[1] += px[i + 1]; mean[2] += px[i + 2]; n++; }
    if (n) for (let k = 0; k < 3; k++) mean[k] /= n;
    if (!measureOnly) {
      const merge = passMaterial(MERGE_FRAG, { src: { value: null }, part: { value: this.temp.texture }, quality: { value: PART_QUALITY },
        below: { value: Number.isFinite(below) ? below : 1e9 }, gain: { value: new THREE.Vector3(...gain) } });
      const on = this.pagesOf(ours);
      this.eachPage((page, k) => {
        if (!on.has(k)) return;
        this.gpu.draw(scene, this.uvCam, this.temp, 0x000000, 0);
        merge.uniforms.src.value = page.a.texture;
        this.gpu.pass(merge, this.b);
        this.swap(page);
        this.padPage(page, k);
      });
      merge.dispose();
      this.revision++;
    }
    g.dispose();
    mat.dispose();
    return mean;
  }

  /**
   * The ground pass (core/ground.ts): lay tiles of one material over the ground, each texel from its place in the
   * world. Ground is what faces up at `floorY` (within `band`), or the up-facing faces of the parts in `labels`.
   * @param tiles one to three square RGBA images of the material seen from straight above: the same stretch of it as
   *   it is, dirtier, and more worn
   * @param span metres of ground a tile shows across; `cell`: the size of the patches it is laid in (m)
   * @param any with `labels`: every face of those parts, not only the ones facing up (a ceiling, the sides of its joists);
   *   `mirror`: lay the tile as a mirrored repeat and not in random patches (for a material with a grain)
   * @param turn 0: patches keep the tile's direction (planks, bricks); 1: quarter turns; 2: any angle (stone, earth)
   * @param edges nearness of walls per cell and `tone` the ground's slow colour drift (rgb gain, 127 = none), both over `field`
   */
  layGround(o: { tiles: { data: Uint8ClampedArray; size: number }[]; span: number; cell: number; seed: number; floorY: number; band?: number; turn?: number;
    labels?: number[]; quality: number; dirt?: number; any?: boolean; mirror?: boolean;
    edges: { data: Uint8Array; width: number; height: number }; tone: { data: Uint8Array; width: number; height: number };
    field: { origin: [number, number]; size: [number, number] } }) {
    const tex = o.tiles.map((t) => {
      const x = new THREE.DataTexture(t.data, t.size, t.size, THREE.RGBAFormat, THREE.UnsignedByteType);
      x.wrapS = x.wrapT = THREE.MirroredRepeatWrapping;
      x.minFilter = THREE.LinearMipmapLinearFilter;
      x.magFilter = THREE.LinearFilter;
      x.generateMipmaps = true;
      x.anisotropy = 8;
      x.needsUpdate = true;
      return x;
    });
    const means = o.tiles.map((t) => {
      const m = [0, 0, 0];
      for (let i = 0; i < t.data.length; i += 4) { m[0] += t.data[i]; m[1] += t.data[i + 1]; m[2] += t.data[i + 2]; }
      return new THREE.Vector3(...m.map((v) => v / (t.data.length / 4) / 255));
    });
    const fieldTex = (f: { data: Uint8Array; width: number; height: number }, channels: 1 | 4) => {
      const x = new THREE.DataTexture(f.data, f.width, f.height, channels === 1 ? THREE.RedFormat : THREE.RGBAFormat, THREE.UnsignedByteType);
      x.minFilter = x.magFilter = THREE.LinearFilter;
      x.needsUpdate = true;
      return x;
    };
    const edges = fieldTex(o.edges, 1), tone = fieldTex(o.tone, 4);
    const labels = new Array(8).fill(-10);
    (o.labels ?? []).slice(0, 8).forEach((l, k) => { labels[k] = l; });
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: UV_VERT, fragmentShader: GROUND_FRAG, side: THREE.DoubleSide, depthTest: false, depthWrite: false,
      uniforms: { page: this.pageU, prev: { value: null }, tile0: { value: tex[0] }, tile1: { value: tex[1] ?? tex[0] }, tile2: { value: tex[2] ?? tex[0] },
        tiles: { value: tex.length }, span: { value: o.span }, cell: { value: o.cell }, seed: { value: o.seed }, floorY: { value: o.floorY },
        band: { value: o.band ?? 0.15 }, quality: { value: o.quality }, turn: { value: o.turn ?? 2 },
        mean0: { value: means[0] }, mean1: { value: means[1] ?? means[0] }, mean2: { value: means[2] ?? means[0] },
        edges: { value: edges }, tone: { value: tone }, dirt: { value: o.dirt ?? 1 },
        field: { value: new THREE.Vector4(o.field.origin[0], o.field.origin[1], 1 / o.field.size[0], 1 / o.field.size[1]) },
        labels: { value: labels }, labelCount: { value: Math.min(8, o.labels?.length ?? 0) }, uAny: { value: o.any ? 1 : 0 }, uMirror: { value: o.mirror ? 1 : 0 } },
    });
    this.uvMesh.material = mat;
    this.eachPage((page, k) => {
      this.copyMat.uniforms.src.value = page.a.texture;
      this.gpu.pass(this.copyMat, this.b);
      mat.uniforms.prev.value = page.a.texture;
      this.gpu.draw(this.uvScene, this.uvCam, this.b, null);
      this.swap(page);
      this.padPage(page, k);
    });
    this.uvMesh.material = this.islandMat;
    mat.dispose();
    for (const t of [...tex, edges, tone]) t.dispose();
    this.revision++;
  }

  /** Share of island texels painted so far (sampled every 8th texel). */
  coverage(): number {
    const n = Math.floor(this.pageSize / 8);
    const rt = byteTarget(n, n, { linear: false });
    let island = 0;
    let known = 0;
    for (const page of this.pages) {
      this.statsMat.uniforms.src.value = page.a.texture;
      this.statsMat.uniforms.islands.value = page.islands.texture;
      this.gpu.pass(this.statsMat, rt);
      const px = this.gpu.readU8(rt, 0, false);
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] > 127) island++;
        if (px[i + 1] > 127) known++;
      }
    }
    rt.dispose();
    return island ? known / island : 0;
  }

  /** `tile` (n x n, `ch` numbers a cell) into its page's place in `out` (n * grid cells a side). */
  private place<T extends Float32Array | Uint8ClampedArray>(out: T, tile: ArrayLike<number>, n: number, ch: number, k: number) {
    const N = n * this.grid, x0 = (k % this.grid) * n, y0 = Math.floor(k / this.grid) * n;
    for (let y = 0; y < n; y++) {
      const row = (tile as unknown as T).subarray(y * n * ch, (y + 1) * n * ch);
      out.set(row as never, ((y0 + y) * N + x0) * ch);
    }
  }

  /** Best capture quality per UV cell (grid x grid over the whole texture space, row = v), for planning views that fill what's missing. */
  cellQuality(grid: number): Float32Array {
    const n = grid / this.grid;
    if (!Number.isInteger(n) || n < 1) throw new Error(`a ${grid} cell grid does not divide over ${this.grid} pages a side`);
    const rt = floatTarget(n, n);
    const q = new Float32Array(grid * grid);
    const one = new Float32Array(n * n);
    this.cellMat.uniforms.cell.value = Math.floor(this.pageSize / n);
    this.pages.forEach((page, k) => {
      this.cellMat.uniforms.src.value = page.a.texture;
      this.gpu.pass(this.cellMat, rt);
      const px = this.gpu.readF32(rt, 0, false);
      for (let i = 0; i < one.length; i++) one[i] = px[4 * i];
      this.place(q, one, n, 1, k);
    });
    rt.dispose();
    return q;
  }

  /**
   * RGBA8 export of the padded texture in glTF image order (first row = v 0), all its pages side by side as the one
   * square they are. `size` (the texture's size divided by a whole number) averages it down; with `alpha`, unpainted
   * texels come back with alpha 0 instead of 255.
   */
  readBytes(fill: [number, number, number] = [0.5, 0.5, 0.5], size = this.size, alpha = false): { data: Uint8ClampedArray; size: number } {
    const cell = Math.max(1, Math.round(this.size / size));
    const n = Math.floor(this.pageSize / cell);
    if (this.pages.length === 1) return { data: this.pageBytes(0, fill, alpha, cell), size: n };
    const data = new Uint8ClampedArray(n * this.grid * n * this.grid * 4);
    for (let k = 0; k < this.pages.length; k++) this.place(data, this.pageBytes(k, fill, alpha, cell), n, 4, k);
    return { data, size: n * this.grid };
  }

  /** One page of the padded texture (see `readBytes`), each `cell` x `cell` texels averaged into one. */
  pageBytes(k: number, fill: [number, number, number] = [0.5, 0.5, 0.5], alpha = false, cell = 1): Uint8ClampedArray {
    const n = Math.floor(this.pageSize / cell);
    const rt = byteTarget(n, n, { linear: false });
    const u = this.bytesMat.uniforms;
    u.src.value = this.display.texture;
    u.layer.value = k;
    u.fill.value.set(...fill);
    u.cell.value = cell;
    u.keepAlpha.value = alpha ? 1 : 0;
    this.gpu.pass(this.bytesMat, rt);
    const data = this.gpu.readU8(rt, 0, false);
    rt.dispose();
    return data;
  }

  /**
   * World position and normal of the surface under each texel of a `size` px map of the whole texture space, rows
   * in glTF image order (first row = v 0). The normal's a is 1 where a triangle covers the texel's centre and 0 elsewhere.
   */
  texelGeometry(size: number): { pos: Float32Array; nrm: Float32Array } {
    const rt = floatTarget(size, size, { count: 2 });
    const mat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: UV_VERT, fragmentShader: TEXEL_FRAG,
      side: THREE.DoubleSide, depthTest: false, depthWrite: false, uniforms: { page: this.pageU } });
    this.uvMesh.material = mat;
    this.gpu.draw(this.uvScene, this.uvCam, rt, 0x000000, 0);
    this.uvMesh.material = this.islandMat;
    const out = { pos: this.gpu.readF32(rt, 0, false), nrm: this.gpu.readF32(rt, 1, false) };
    rt.dispose();
    mat.dispose();
    return out;
  }

  dispose() {
    for (const t of [...this.pages.flatMap((p) => [p.a, p.islands]), this.b, this.temp, this.display]) t.dispose();
    for (const m of [this.projectMat, this.islandMat, this.copyMat, this.copyLayerMat, this.dilateMat, this.bytesMat, this.cellMat, this.statsMat]) m.dispose();
  }
}
