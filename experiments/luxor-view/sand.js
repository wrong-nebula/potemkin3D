// Sand and dust for a level that stands in a desert, in three layers:
//   - on the surfaces (sandLayer): sand lies where it would settle, on what faces up and low down, in drifts that
//     thin out to bare stone, banked against the foot of walls, with wind ripples and grains that flash in the sun;
//     thin veils of it blow along the ground in gusts. The same hook gives the stone its grain when the camera is
//     close: speckle in its colour, pits, and a fine relief the sun rakes across. It also makes the stone old:
//     its tone wanders from block to block, streaks run down the upright faces, dirt sits in the corners (read
//     from the baked occlusion), a film of dust lightens it at a glance, whatever the texture draws dark (joints,
//     carved lines, cracks) is cut into the surface, and the outward edges are worn and chipped (edges.js says
//     where they are);
//   - in the air (RAYS_FRAG, DUST_FRAG): a haze of dust that thickens towards the ground and with distance, lit only
//     where the sun reaches it, so shafts of light stand between the columns; far off and low down the hot air
//     makes what is behind it waver;
//   - motes (makeMotes): grains near the camera that drift on the wind and catch the sun.
//
// All of the noise in it comes out of one small texture (makeNoise): a lookup costs a fraction of working the noise
// out per pixel, and the texture's own mipmaps fade fine detail out with distance instead of letting it shimmer.
import * as THREE from 'three';

/**
 * 256 px of noise that tiles, four kinds in its four channels: r, g: cloudy (three octaves, two different seeds);
 * b: smooth (one octave); a: white, a different value for every texel. Sixteen cells of the first octave to a tile.
 */
export function makeNoise(size = 256, cells = 16) {
  const hash = (x, y, seed) => { const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453; return s - Math.floor(s); };
  const smooth = (x, y, period, seed) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const at = (i, j) => hash(((xi + i) % period + period) % period, ((yi + j) % period + period) % period, seed);
    return (at(0, 0) * (1 - u) + at(1, 0) * u) * (1 - v) + (at(0, 1) * (1 - u) + at(1, 1) * u) * v;
  };
  const cloudy = (x, y, seed) => (smooth(x, y, cells, seed) * 4 + smooth(x * 2, y * 2, cells * 2, seed + 1) * 2 + smooth(x * 4, y * 4, cells * 4, seed + 2)) / 7;
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const x = (i / size) * cells, y = (j / size) * cells, k = 4 * (j * size + i);
    data[k] = 255 * cloudy(x, y, 1); data[k + 1] = 255 * cloudy(x, y, 9); data[k + 2] = 255 * smooth(x, y, cells, 17); data[k + 3] = 255 * hash(i, j, 23);
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}
export const noise = makeNoise();
/** Noise of `f` cells a metre at p: texture(tNoise, p * f * CELL). */
const CELL = '0.0625';

/** What the sand layer reads, shared by every material it is put on: set `uSand.value` (0 to 1) and tick `uSandTime`. */
export const sandUniforms = {
  uSand: { value: 0.5 }, uSandTime: { value: 0 }, uWind: { value: new THREE.Vector2(0.94, 0.34) }, uDetail: { value: 1 },
  uSandColor: { value: new THREE.Color(0.62, 0.44, 0.22) },   // linear: pale, warm sand
  uAge: { value: 1 },     // the stone's weathering (tone, streaks, dirt, dust film, carved lines cut in): 0 leaves the texture as painted
  uChips: { value: 1 },   // how worn the edges are: 0 leaves them as the blockout has them
  tSandNoise: { value: noise },
};

/** Put the sand and the close-up grain on a standard material (once; it then follows `sandUniforms`). */
export function sandLayer(material) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sandUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 edge; varying vec3 vSandPos; varying vec3 vSandNormal; varying vec3 vSandEdge;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSandPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vSandNormal = normalize(mat3(modelMatrix) * objectNormal); vSandEdge = edge;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
varying vec3 vSandPos; varying vec3 vSandNormal; varying vec3 vSandEdge;
uniform float uSand, uSandTime, uDetail, uChips, uAge; uniform vec2 uWind; uniform vec3 uSandColor; uniform sampler2D tSandNoise;
// sandBump: a height's change over one pixel; sandSlope: a slope in metres a metre, along the pixel's two directions
float sandMask = 0.0, sandGlint = 0.0, sandChip = 0.0; vec2 sandBump = vec2(0.0), sandSlope = vec2(0.0);
#define SAND_GRAIN(q) (texture2D(tSandNoise, (q) * 70.0).b * 0.55 + texture2D(tSandNoise, (q) * 230.0 + 0.37).g * 0.45)
// A texture read smoothly when it is enlarged. Close to a wall one texel covers many pixels, and the ordinary lookup
// draws each as a little pyramid: carved lines turn to staircases. Here the sixteen texels around the point are
// weighed by a cubic curve (in four lookups, each between two texels), which rounds the steps off. Where the
// texture is not enlarged the ordinary lookup, with its mipmaps, is the right one and is used.
vec4 sandSmooth(sampler2D t, vec2 uv) {
  vec2 size = vec2(textureSize(t, 0)), px = uv * size;
  vec2 grow = fwidth(px);
  vec4 plain = texture2D(t, uv);
  if (max(grow.x, grow.y) > 0.7) return plain;
  px -= 0.5;
  vec2 f = fract(px), i = px - f, f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0, w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0, w3 = f3 / 6.0, w2 = 1.0 - w0 - w1 - w3;
  vec2 s0 = w0 + w1, s1 = w2 + w3;
  vec2 t0 = (i - 0.5 + w1 / s0) / size, t1 = (i + 1.5 + w3 / s1) / size;
  vec4 smoothed = (textureLod(t, vec2(t0.x, t0.y), 0.0) * s0.x + textureLod(t, vec2(t1.x, t0.y), 0.0) * s1.x) * s0.y
    + (textureLod(t, vec2(t0.x, t1.y), 0.0) * s0.x + textureLod(t, vec2(t1.x, t1.y), 0.0) * s1.x) * s1.y;
  // eased in as the enlargement grows, so there is no line where one lookup hands over to the other
  return mix(smoothed, plain, smoothstep(0.35, 0.7, max(grow.x, grow.y)));
}
// a fine relief from a height's change across the pixel (three's own bump mapping, for a height not in a texture)
vec3 sandRelief(vec3 at, vec3 n, vec2 dH, float facing) {
  vec3 sx = normalize(dFdx(at)), sy = normalize(dFdy(at));
  vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1) * facing;
  return normalize(abs(det) * n - sign(det) * (dH.x * r1 + dH.y * r2));
}`)
      .replace('#include <map_fragment>', /* glsl */ `${THREE.ShaderChunk.map_fragment.replace('texture2D( map, vMapUv )', 'sandSmooth( map, vMapUv )')}
{
  vec3 sp = vSandPos; vec3 sn = normalize(vSandNormal);
  float away = distance(cameraPosition, sp);
  // the stone's grain, close up only. One flat lookup stands in for noise through the stone: the plane it is read
  // on is tilted, so walls facing any way get two changing coordinates.
  float near = (1.0 - smoothstep(2.0, 9.0, away)) * uDetail;
  vec2 gp = (sp.xz + sp.y * vec2(0.37, 0.61)) * ${CELL};
  // The grain is read for every pixel, near or far (far off its mipmaps have smoothed it to nothing, at next to no
  // cost), so that its relief can come from how it changes across the pixel and not from reading it three times.
  float grain = SAND_GRAIN(gp);
  vec2 grainWay = vec2(dFdx(grain), dFdy(grain));
  // What the texture draws dark is lower: a joint, a carved line, a crack. Its brightness, taken as a height, gives
  // those a wall and a floor for the sun to light and shade, at the size the screen shows them.
  float lum = dot(diffuseColor.rgb, vec3(0.3, 0.6, 0.1));
  sandBump = clamp(vec2(dFdx(lum), dFdy(lum)), -0.07, 0.07) * 2.4 * (1.0 - smoothstep(10.0, 30.0, away)) * uDetail * uAge;
#if defined(TROMPE_POM) && defined(USE_MAP)
  sandBump = mix(sandBump, pomBump() * uDetail, pomWeight);
#endif
  if (uAge > 0.0) {
    // No two blocks weathered alike: the tone wanders over a few metres, the colour (warmer, cooler) over more
    // (one lookup for both: its two cloudy channels are unrelated to each other)
    vec2 drifted = texture2D(tSandNoise, gp * 0.27).rg;
    diffuseColor.rgb *= 0.89 + 0.24 * drifted.x;
    diffuseColor.rgb *= mix(vec3(1.035, 1.0, 0.95), vec3(0.97, 1.0, 1.045), drifted.y);
    // and on upright faces, streaks where water and dust have run down
    float upright = 1.0 - abs(sn.y);
    diffuseColor.rgb *= 1.0 - 0.16 * upright * smoothstep(0.50, 0.80, texture2D(tSandNoise, vec2((sp.x + sp.z) * 2.3, sp.y * 0.085) * ${CELL}).b);
    // a film of dust: seen at a glance the stone is paler, as dusty things are
    vec3 toEye = normalize(cameraPosition - sp);
    diffuseColor.rgb = mix(diffuseColor.rgb, uSandColor * 1.15, 0.22 * pow(1.0 - abs(dot(sn, toEye)), 3.0));
  }
  // how far the nearest edge that can chip is, and which way across the pixel it lies (worked out here, where every
  // pixel passes: a slope taken inside a branch is not to be trusted)
  float toEdge = min(vSandEdge.x, min(vSandEdge.y, vSandEdge.z));
  vec2 edgeWay = vec2(dFdx(toEdge), dFdy(toEdge)) / max(vec2(length(dFdx(sp)), length(dFdy(sp))), vec2(1e-5));
  if (near > 0.001) {
    float pit = smoothstep(0.66, 0.76, texture2D(tSandNoise, gp * 31.0 + 0.11).g);
    diffuseColor.rgb *= 1.0 + near * (0.34 * (grain - 0.5) - 0.12 * pit);
    // the same grain as a relief, for the light to catch
    sandBump += grainWay * near * 1.5;
  }
  if (uSand > 0.001) {
    float up = smoothstep(0.55, 0.95, sn.y);
    float low = 1.0 - smoothstep(0.05, 2.2, sp.y);
    float lying = 0.0, foot = 0.0;
    vec2 xz = sp.xz * ${CELL};
    vec2 across = vec2(-uWind.y, uWind.x);
    // (each part is worked out only where it can show: most of a wall is neither ground nor foot)
    if (up > 0.01) {
      // where the drifts lie: big patches, their edges broken up, more of them the more sand there is
      float drift = texture2D(tSandNoise, xz * 0.21 + 0.37).r * 0.72 + texture2D(tSandNoise, xz * 2.6).g * 0.28;
      lying = up * (0.18 + 0.82 * low) * smoothstep(0.60 - 0.36 * uSand, 0.72 - 0.36 * uSand, drift);
    }
    // banked against the foot of whatever stands on the ground
    if (up < 0.99 && sp.y < 0.9) foot = (1.0 - up) * (1.0 - smoothstep(0.0, 0.10 + 0.55 * uSand * texture2D(tSandNoise, (sp.xz * 1.7 + sp.y) * ${CELL}).b, sp.y)) * 0.8;
    sandMask = clamp(max(lying, foot), 0.0, 1.0);
    if (sandMask > 0.001) {
      // ripples across the wind (they fade out a few metres off: further away they are finer than a pixel)
      float fine = 1.0 - smoothstep(3.0, 11.0, away);
      float ripple = sin(dot(sp.xz, uWind) * 26.0 + texture2D(tSandNoise, xz * 1.3).r * 9.0 + dot(sp.xz, across) * 3.0) * 0.5 + 0.5;
      vec3 sand = uSandColor * (1.0 - 0.14 * fine * (1.0 - ripple)) * (0.92 + 0.16 * texture2D(tSandNoise, xz * 23.0).b);
      diffuseColor.rgb = mix(diffuseColor.rgb, sand, sandMask * 0.92);
      // one grain in a few dozen is a clean face of quartz: it mirrors the sun where the rest only scatter it
      sandGlint = step(0.972, texture2D(tSandNoise, xz * 190.0).a) * sandMask * fine * up;
    }
    // veils of sand blowing along the ground: long streaks that run with the wind and come in gusts
    if (up * low > 0.01 && away < 45.0) {
      float gust = smoothstep(0.30, 0.70, texture2D(tSandNoise, vec2(uSandTime * 0.11, 4.2) * ${CELL} + xz * 0.03).b);
      float streak = texture2D(tSandNoise, vec2(dot(sp.xz, uWind) * 0.35 - uSandTime * 1.6, dot(sp.xz, across) * 2.4) * ${CELL}).g;
      float veil = up * low * smoothstep(0.50, 0.66, streak) * gust * min(1.0, uSand * 1.4) * (1.0 - smoothstep(18.0, 45.0, away));
      diffuseColor.rgb = mix(diffuseColor.rgb, uSandColor * 1.12, veil * 0.6);
    }
  }
  // Worn and chipped edges. Every outward edge has lost its arris (a centimetre, rounded off); here and there a
  // piece has broken away, up to a hand wide, with small nicks between. The broken face slopes down to the edge
  // and shows the stone as it is inside: paler, without the carving.
  if (uChips > 0.0 && toEdge < 0.14 && away < 42.0) {
    float piece = texture2D(tSandNoise, gp * 7.0 + 0.3).r, nick = texture2D(tSandNoise, gp * 43.0).g;
    float width = (0.011 + 0.105 * smoothstep(0.50, 0.74, piece) + 0.024 * nick) * uChips;
    sandChip = (1.0 - smoothstep(0.72 * width, width, toEdge)) * (1.0 - sandMask) * (1.0 - smoothstep(26.0, 42.0, away));
    sandSlope = edgeWay * 0.95 * sandChip;
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.22 + vec3(0.035, 0.028, 0.018), sandChip * (0.45 + 0.4 * nick));
  }
}`)
      .replace('#include <roughnessmap_fragment>', /* glsl */ `#include <roughnessmap_fragment>
roughnessFactor = mix(mix(roughnessFactor, 0.96, sandMask), 0.22, sandGlint);
#ifdef USE_ROUGHNESSMAP
  // dirt gathers where the baked occlusion says little light gets in (it is the red of the lookup just made)
  diffuseColor.rgb *= mix(vec3(1.0), vec3(0.58, 0.51, 0.44), clamp((1.0 - texelRoughness.r) * 1.5, 0.0, 1.0) * (1.0 - sandMask) * (1.0 - sandChip) * uAge);
#endif`)
      // sand fills the carving: the relief flattens out under it; bare stone gets its grain's relief on top
      .replace('#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps.replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz', 'vec3 mapN = sandSmooth( normalMap, vNormalMapUv ).xyz') + '\nnormal = normalize(mix(normal, nonPerturbedNormal, max(sandMask * 0.85, sandChip * 0.75)));\nnormal = sandRelief(-vViewPosition, normal, sandBump * (1.0 - sandMask) * (1.0 - sandChip) + sandSlope, faceDirection);');
  };
  material.customProgramCacheKey = () => 'sand-layer-6';
  material.needsUpdate = true;
}

// Light shafts: where something stands between the sun and the dust, the dust is dark; where the sun gets through
// (between two columns, through a gateway) it is lit. For every pixel the line of sight is walked in steps and each
// step is looked up in the sun's own shadow map. It is worked out at half the frame's size, with the steps shifted
// from pixel to pixel and frame to frame so that few of them are enough. r: how much of the dust along the line
// is in the sun (weighted by how thick it is there), g: how much dust there is along it at all.
export const RAYS_FRAG = /* glsl */ `
precision highp sampler2DShadow;
uniform sampler2D tDepth; uniform sampler2DShadow tShadow; uniform mat4 uInvViewProj, uShadowMatrix; uniform vec3 uCam; uniform float uReach, uFrame;
varying vec2 vUv;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  float d = texture2D(tDepth, vUv).x;
  vec4 w = uInvViewProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec3 ray = w.xyz / w.w - uCam;
  float dist = d > 0.99999 ? uReach : min(length(ray), uReach);
  vec3 dir = normalize(ray);
  const int N = 12;
  float stepLen = dist / float(N), jitter = ign(gl_FragCoord.xy + 5.588238 * uFrame);
  // the line's two ends in the shadow map: every step lies on the straight line between them (the sun's map is flat)
  vec4 s0 = uShadowMatrix * vec4(uCam, 1.0), s1 = uShadowMatrix * vec4(uCam + dir * dist, 1.0);
  float lit = 0.0, whole = 0.0;
  for (int i = 0; i < N; i++) {
    float t = (float(i) + jitter) / float(N);
    float thick = exp(-max(uCam.y + dir.y * dist * t, 0.0) / 7.0);
    vec3 sc = mix(s0.xyz, s1.xyz, t);
    float inSun = all(greaterThan(sc, vec3(0.0))) && all(lessThan(sc, vec3(1.0))) ? texture(tShadow, vec3(sc.xy, sc.z - 0.0015)) : 1.0;
    lit += inSun * thick; whole += thick;
  }
  gl_FragColor = vec4(lit * stepLen, whole * stepLen, 0.0, 1.0);
}`;

// The air: dust between the camera and what it sees. Its density falls off with height (most of it hangs within a
// few metres of the ground), so the far end of a court is veiled and the sky near the horizon is pale and warm.
// It is lit by the sun where the sun reaches it (the rays above). Far off and near the ground, hot air bends the
// light a little, this way and that: what is behind it wavers.
export const DUST_FRAG = /* glsl */ `
uniform sampler2D tSrc, tDepth, tRays, tNoise; uniform vec2 uRaysTexel; uniform mat4 uInvViewProj; uniform vec3 uCam, uSun, uDustColor;
uniform float uDensity, uTime, uFar, uShafts, uHeat;
varying vec2 vUv;
void main() {
  float d = texture2D(tDepth, vUv).x;
  vec4 w = uInvViewProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec3 ray = w.xyz / w.w - uCam;
  float dist = length(ray); vec3 dir = ray / max(dist, 1e-4);
  if (d > 0.99999) dist = uFar;   // the sky: dust all the way out
  // heat haze: stronger with distance, strongest just over the ground, rising
  float shimmer = uHeat * smoothstep(14.0, 70.0, dist) * exp(-max(uCam.y + dir.y * min(dist, 80.0), 0.0) / 2.5);
  vec2 wob = texture2D(tNoise, vUv * vec2(9.0, 5.0) + vec2(0.0, -uTime * 0.35)).rg - 0.5;
  vec3 col = texture2D(tSrc, vUv + wob * shimmer * 0.006).rgb;
  // density falls off with height (scale 7 m): its integral along the ray, in closed form
  const float H = 7.0;
  float a = max(uCam.y, 0.0) / H, b = dir.y * dist / H;
  float through = dist * exp(-a) * (abs(b) > 1e-3 ? (1.0 - exp(-b)) / b : 1.0);
  // it is not even: slow banks of it drift past
  float banks = 0.7 + 0.6 * texture2D(tNoise, dir.xz * 0.15 + vec2(uTime * 0.0013, dir.y * 0.19)).b;
  float keep = exp(-uDensity * through * banks);
  float mu = dot(dir, normalize(uSun));
  float lit = 0.55 + 0.20 * (1.0 + mu * mu) + 1.6 * pow(max(mu, 0.0), 10.0);
  // the shafts: the dust's sunlit share along this line (four taps of the half-size rays, which smooths their grain)
  vec4 rays = (texture2D(tRays, vUv + uRaysTexel * vec2(0.5, 0.5)) + texture2D(tRays, vUv + uRaysTexel * vec2(-0.5, 0.5))
    + texture2D(tRays, vUv + uRaysTexel * vec2(0.5, -0.5)) + texture2D(tRays, vUv + uRaysTexel * vec2(-0.5, -0.5))) * 0.25;
  float inSun = uShafts > 0.0 ? rays.r / max(rays.g, 1e-3) : 1.0;
  // dust in shade is lit by the sky alone; dust in the sun glows, most of all looking up the beam
  vec3 haze = uDustColor * lit * mix(1.0, 0.22 + 0.78 * inSun, min(uShafts, 1.0)) * (1.0 - keep);
  // (the beam is what stands out against shade: it counts by how much of the line is in the sun and how much is not)
  float contrast = inSun * (1.0 - inSun) * 4.0;
  vec3 beam = uDustColor * uShafts * (0.5 + 0.5 * (1.0 + mu * mu) * 0.5 + 3.0 * pow(max(mu, 0.0), 6.0)) * (0.25 + 0.75 * contrast) * (1.0 - exp(-uDensity * 7.0 * rays.r * banks));
  gl_FragColor = vec4(col * keep + haze + beam, 1.0);
}`;

/** Grains in the air round the camera, drifting on the wind; they are drawn into the scene, so focus blurs them. */
export function makeMotes(count = 2600, box = 18) {
  const seed = new Float32Array(count * 3), size = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    seed[3 * i] = Math.random(); seed[3 * i + 1] = Math.random(); seed[3 * i + 2] = Math.random();
    size[i] = 0.4 + 1.6 * Math.random() ** 3;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(seed, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    uniforms: { uTime: { value: 0 }, uBox: { value: box }, uHeight: { value: 800 }, uAmount: { value: 1 }, uWind: sandUniforms.uWind,
      uSun: { value: new THREE.Vector3(0, 1, 0) }, uLight: { value: new THREE.Color(3.2, 2.5, 1.7) } },
    vertexShader: /* glsl */ `
attribute float aSize; uniform float uTime, uBox, uHeight; uniform vec2 uWind;
varying float vFade; varying float vGlint;
void main() {
  // a box of grains that travels with the camera: each drifts on the wind, sinks a little, and wraps round
  vec3 drift = vec3(uWind.x, -0.06, uWind.y) * uTime * 0.55 + 0.25 * sin(uTime * vec3(0.31, 0.23, 0.37) + position * 40.0);
  vec3 p = cameraPosition + (fract(position + (drift - cameraPosition) / uBox) - 0.5) * uBox;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float dist = -mv.z;
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * 0.012 * uHeight / max(dist, 0.3), 1.0, 7.0);
  // none right at the lens, none at the box's edge, fewer underfoot than at eye height
  vFade = smoothstep(0.5, 1.6, dist) * (1.0 - smoothstep(0.38 * uBox, 0.5 * uBox, dist)) * smoothstep(-0.2, 0.8, p.y);
  vGlint = 0.6 + 0.8 * fract(sin(dot(position, vec3(12.9, 78.2, 37.7))) * 43758.5 + uTime * 0.7);
}`,
    fragmentShader: /* glsl */ `
uniform vec3 uLight; uniform float uAmount; varying float vFade; varying float vGlint;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = (1.0 - smoothstep(0.2, 1.0, r)) * vFade * uAmount;
  gl_FragColor = vec4(uLight * vGlint * a * 0.22, a);
}`,
  });
  const points = new THREE.Points(g, material);
  points.frustumCulled = false;
  return points;
}
