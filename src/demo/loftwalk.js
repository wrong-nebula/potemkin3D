// A walk through a textured level as a camera would film it: /loft-walk.html?run=<run id>[&level=loft]
//
// The level's texture is an ordinary 8-bit picture with its light painted in. Four things make it read as footage:
//   - fake HDR: what the painting clipped near white is lifted back over white, and what lies outside the room (the
//     street through the windows, the sky) is put several stops over the interior, as daylight is. An eye-adaptation
//     loop then exposes for what the camera looks at, and an AgX tone curve rolls the highlights off;
//   - a lens: bloom, a dirty front element that catches the light of anything bright in frame, ghosts, a halo and
//     anamorphic streaks from the windows (the lens effect of the Lego homeworld project: bright pass and ghost/halo
//     features after takram's three-geospatial LensFlareEffect (MIT, Shota Matsuda) and John Chapman's pseudo lens
//     flare; the streaks and the procedural dirt are that project's own), a little chromatic fringe, vignette, grain;
//   - depth of field that focuses by itself on what is in the middle of the frame;
//   - motion blur from the camera's own movement (the depth buffer reprojected into the last frame).
// You walk it yourself: W A S D to move (shift to run), click to look with the mouse (or drag), from the middle of the
// room, with a walker's bob and sway. T starts and stops a tour that walks a loop through the run's player spots.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { mountWalkNotesShell } from './walk-notes-shell.js';

THREE.Mesh.prototype.raycast = acceleratedRaycast;

const query = new URLSearchParams(location.search);
// which run, and which of its files: the page says (a site built for one scene), or the address does
const RUN = query.get('run') ?? document.documentElement.dataset.run ?? 'loft-h3-soft-scout';
const BASE = document.documentElement.dataset.base ?? '/runs/';
const canvas = document.getElementById('view');
const hud = document.getElementById('hud');
const msg = document.getElementById('msg');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
// The frame is drawn at the screen's own pixels (up to 2 a point), times a scale that is lowered a little when frames
// run long and raised again when there is time to spare (the page stretches it to the window). Sharpness comes
// first: the scale never goes under 0.75, since a frame stretched further than that reads as a blurred texture.
// ?res=1 (or any number) fixes the scale and switches the governor off.
const MAX_RATIO = Math.min(window.devicePixelRatio, 2);
const FIXED = Number(new URLSearchParams(location.search).get('res')) || 0;
let scale = FIXED || 1;
renderer.setPixelRatio(1);
renderer.autoClear = false;

// (aa: the extra smoothing pass. Off by default: four samples a pixel already smooth the geometry's edges, and on
// a brick wall the pass cost a fifth of the fine detail. In its place the finished frame is sharpened a little.)
// (maps: the run's normal, roughness and height maps, where it has them: surfaces reflect the room, see LEVEL_FRAG.)
const on = { hdr: true, lens: true, dof: true, blur: true, film: true, glass: true, maps: true, clay: false, aa: false, tour: false };

// ---------------------------------------------------------------- shaders
const VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const mat = (frag, uniforms) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, toneMapped: false });

// The level, lifted into scene-referred light. The painting is the surface's colour with the room's light already in
// it; what a painting cannot hold is what changes as you move. That comes from the run's material maps (PATINA's
// reading of the texture): each surface reflects the room (the cube map the glass uses, fitted to the room's box),
// sharply where the map says it is smooth and more at a slant; fine relief tilts the reflection and, from the
// height map, shifts the texture a little with the angle of view; joints and pits reflect less.
const LEVEL_VERT = /* glsl */ `attribute vec3 bary; varying vec2 vUv; varying vec3 vWorld, vNormal, vBary;
void main() { vUv = uv; vBary = bary; vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; vNormal = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;
const LEVEL_FRAG = /* glsl */ `
uniform sampler2D map, tMaps, tRelief; uniform samplerCube tEnv;
uniform vec3 uBoxMin, uBoxMax, uProbe, uRoomMin, uRoomMax;
uniform float uLift, uOutside, uMaps, uRelief, uEnvLod, uGloss, uShow, uClay;
varying vec2 vUv; varying vec3 vWorld, vNormal, vBary;
// how much of the surroundings a surface of this roughness mirrors at this angle (Karis's fit to the split sum)
float mirror(float rough, float nv) {
  vec4 r = rough * vec4(-1.0, -0.0275, -0.572, 0.022) + vec4(1.0, 0.0425, 1.04, -0.04);
  float a = min(r.x * r.x, exp2(-9.28 * nv)) * r.x + r.y;
  vec2 ab = vec2(-1.04, 1.04) * a + r.zw;
  return clamp(0.04 * ab.x + ab.y, 0.0, 1.0);
}
void main() {
  vec2 uv = vUv, dx = dFdx(vUv), dy = dFdy(vUv);
  vec3 d = max(uBoxMin - vWorld, vWorld - uBoxMax);
  float outside = step(0.0, max(d.x, max(d.y, d.z)));
  vec3 env = vec3(0.0); float amount = 0.0;
  vec3 shown = vec3(0.0);
  if (uMaps > 0.5 && outside < 0.5) {
    vec3 V = normalize(cameraPosition - vWorld), p1 = dFdx(vWorld), p2 = dFdy(vWorld);
    vec3 G = normalize(cross(p1, p2));
    if (dot(G, V) < 0.0) G = -G;
    vec3 N = normalize(vNormal);
    if (dot(N, G) < 0.0) N = -N;
    // which way the texture's u and v run across the surface (per metre): no tangents are stored
    vec3 q2 = cross(p2, N), q1 = cross(N, p1);
    vec3 T = q2 * dx.x + q1 * dy.x, B = q2 * dx.y + q1 * dy.y;
    float det = dot(p1, q2);
    if (det > 1e-12 && dot(T, T) > 0.0 && dot(B, B) > 0.0) {
      float nv = clamp(dot(N, V), 0.0, 1.0);
      // relief: a point below the surface is seen a little further along the line of sight
      float h = (textureGrad(tRelief, uv, dx, dy).r - 0.5) * 2.0;
      vec3 along = (V - N * dot(N, V)) / max(nv, 0.35) * h * uRelief;
      uv += vec2(dot(along, T), dot(along, B)) / det;
      vec3 m = textureGrad(tMaps, uv, dx, dy).rgb;
      vec2 tilt = m.rg * 2.0 - 254.0 / 255.0;
      vec3 Np = normalize(N + normalize(T) * tilt.x - normalize(B) * tilt.y);
      float rough = clamp(m.b / uGloss, 0.05, 1.0);
      vec3 R = reflect(-V, Np);
      R -= N * min(dot(R, N), 0.0) * 1.2;   // never into the surface
      vec3 a = (uRoomMax - vWorld) / R, b = (uRoomMin - vWorld) / R, far = max(a, b);
      vec3 dir = vWorld + R * max(min(min(far.x, far.y), far.z), 0.0) - uProbe;
      env = textureLod(tEnv, dir, clamp(2.0 * log2(rough) + uEnvLod, 0.0, uEnvLod)).rgb;
      float pit = smoothstep(-0.9, -0.1, (textureGrad(tRelief, uv, dx, dy).r - 0.5) * 2.0);
      amount = mirror(rough, clamp(dot(Np, V), 0.0, 1.0)) * mix(0.35, 1.0, pit);
      shown = uShow < 1.5 ? Np * 0.5 + 0.5 : uShow < 2.5 ? vec3(rough) : uShow < 3.5 ? vec3(h * 0.5 + 0.5) : env * amount;
    }
  }
  vec3 c = pow(textureGrad(map, uv, dx, dy).rgb, vec3(2.2));
  float l = max(c.r, max(c.g, c.b));
  // the painting's whites were brighter than white before they were clipped
  c *= 1.0 + uLift * pow(l, 5.0);
  // outside the room it is day
  c *= mix(1.0, uOutside, outside);
  c = c * (1.0 - amount) + env * amount;
  if (uShow > 0.5) c = shown;
  if (uClay > 0.5) {
    // the blockout under the paint: plain clay in the room's own light (the cube map, blurred right down), and the
    // model's edges as thin lines
    vec3 Vc = normalize(cameraPosition - vWorld), Nc = normalize(vNormal);
    if (dot(Nc, Vc) < 0.0) Nc = -Nc;
    vec3 light = uEnvLod > 0.0 ? mix(textureLod(tEnv, Nc, uEnvLod - 1.0).rgb, textureLod(tEnv, Nc, uEnvLod - 3.5).rgb, 0.65) * 1.5 + 0.04 : vec3(0.45 + 0.25 * Nc.y);
    light += 0.1 * max(dot(Nc, normalize(vec3(0.35, 0.85, 0.4))), 0.0);
    c = vec3(0.62, 0.6, 0.57) * light * mix(1.0, uOutside, outside);
    vec3 w = fwidth(vBary);
    vec3 e = smoothstep(vec3(0.0), w * 1.25, vBary);
    c *= mix(0.55, 1.0, min(e.x, min(e.y, e.z)));
  }
  gl_FragColor = vec4(c, 1.0);
}`;
// Window glass: old factory panes. Each pane reflects the room (a cube map taken from the middle of the room, fitted
// to the room's box so reflections sit where they should), more at a slant (Fresnel), and each sits a little
// differently in its putty and is not quite flat, so the reflection breaks from pane to pane. A film of dirt,
// thickest at each pane's edges, takes a little of the view and glows a little in the daylight.
const GLASS_VERT = /* glsl */ `attribute vec2 grid; varying vec2 vUv, vGrid; varying vec3 vWorld, vNormal;
void main() { vUv = uv; vGrid = grid; vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; vNormal = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;
const GLASS_FRAG = /* glsl */ `
uniform samplerCube tEnv; uniform vec3 uProbe, uBoxMin, uBoxMax; uniform float uDay;
varying vec2 vUv, vGrid; varying vec3 vWorld, vNormal;
vec2 hash2(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i).x, hash2(i + vec2(1, 0)).x, f.x), mix(hash2(i + vec2(0, 1)).x, hash2(i + vec2(1, 1)).x, f.x), f.y); }
void main() {
  vec3 V = normalize(cameraPosition - vWorld), N = normalize(vNormal);
  float inside = step(0.0, dot(N, V));   // the geometry's normal points into the room
  if (inside < 0.5) N = -N;
  vec3 T = normalize(cross(N, vec3(0.0, 1.0, 0.0))), B = cross(N, T);
  vec2 cell = vUv * vGrid, pane = floor(cell), f = fract(cell);
  vec2 along = vec2(dot(vWorld, T), vWorld.y);
  vec2 tilt = (hash2(pane + along.x * 0.0 + floor(vWorld.xz * 0.37)) - 0.5) * 0.03;
  vec2 wave = (vec2(noise(along * 2.3), noise(along * 2.3 + 17.0)) - 0.5) * 0.02;
  N = normalize(N + T * (tilt.x + wave.x) + B * (tilt.y + wave.y));
  float c = clamp(dot(N, V), 0.0, 1.0);
  float fr = 0.04 + 0.96 * pow(1.0 - c, 5.0);
  fr = 2.0 * fr / (1.0 + fr);   // two faces
  vec3 R = reflect(-V, N);
  // fit the cube map to the room: follow the reflected ray to the room's box
  vec3 a = (uBoxMax - vWorld) / R, b = (uBoxMin - vWorld) / R, far = max(a, b);
  vec3 dir = vWorld + R * min(min(far.x, far.y), far.z) - uProbe;
  // from outside, what the glass reflects is the street and the sky: stand in for it with the day's light
  vec3 env = mix(vec3(0.75, 0.82, 0.95) * uDay * 0.6, textureCube(tEnv, dir).rgb, inside);
  // dirt: a thin film everywhere, more at each pane's edges and in its corners, and a few specks
  float edge = pow(max(abs(f.x - 0.5), abs(f.y - 0.5)) * 2.0, 5.0);
  float film = 0.035 + 0.11 * edge + 0.05 * smoothstep(0.55, 0.9, noise(along * 9.0)) + 0.12 * step(0.985, noise(along * 70.0));
  vec3 haze = vec3(0.9, 0.92, 0.95) * film * uDay * 0.16;
  float through = (1.0 - fr) * (1.0 - 0.7 * film) * 0.94;
  gl_FragColor = vec4(env * fr + haze, 1.0 - through);
}`;
const SKY_FRAG = /* glsl */ `
uniform float uSky; varying vec3 vDir;
void main() {
  float h = clamp(normalize(vDir).y, -0.2, 1.0);
  vec3 c = mix(vec3(1.0, 0.97, 0.92), vec3(0.62, 0.74, 0.95), smoothstep(0.0, 0.7, h));
  gl_FragColor = vec4(c * uSky, 1.0);
}`;

const COMMON = /* glsl */ `
uniform sampler2D tDepth; uniform float uNear, uFar;
float viewZ(vec2 uv) { float z = texture2D(tDepth, uv).x * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }`;

// Depth of field: a thin lens. The blur circle grows with the difference between 1 / focus and 1 / distance.
// The circle is the aperture's shape (seven rounded blades), and each sample counts by its brightness, so a light
// out of focus keeps a crisp-edged disc as it does through glass, where an even blur would smear it to a fog.
// The same twenty samples as an even blur: their pattern turns from frame to frame, so its noise reads as grain.
const DOF_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uFocus, uCoc, uMaxCoc, uFrame;
varying vec2 vUv;
${COMMON}
float coc(float z) { return min(uMaxCoc, uCoc * abs(1.0 / uFocus - 1.0 / max(z, 0.05))); }
void main() {
  float z = viewZ(vUv), c0 = coc(z);
  vec3 acc = texture2D(tSrc, vUv).rgb; float w = 1.0 + 0.5 * min(luma(acc), 6.0);
  acc *= w;
  float spin = ign(gl_FragCoord.xy + 5.588238 * uFrame) * 6.2831853;
  // each sample a golden angle on from the last: one turn of the direction, no sine or cosine per sample
  vec2 dir = vec2(cos(spin), sin(spin));
  const mat2 turn = mat2(-0.73736888, 0.67549029, -0.67549029, -0.73736888);
  for (int i = 1; i <= 20; i++) {
    float r = sqrt(float(i) / 20.0), a = float(i) * 2.39996323 + spin;
    dir = turn * dir;
    // the blades: seven, a little straighter between their corners than a circle (an aperture near full open)
    float t = fract(a * 1.1140846 + 0.33) - 0.5;
    r *= 1.0 - 0.06 * (1.0 - 4.0 * t * t);
    vec2 o = dir * r * uMaxCoc;
    vec2 uv = vUv + o * uTexel;
    float sz = viewZ(uv), sc = coc(sz);
    // what lies behind a sharp thing does not smear over it
    if (sz > z) sc = min(sc, c0 * 2.0);
    vec3 s = texture2D(tSrc, uv).rgb;
    float k = smoothstep(r * uMaxCoc - 1.0, r * uMaxCoc + 1.0, sc) * (1.0 + 0.5 * min(luma(s), 6.0));
    acc += s * k; w += k;
  }
  gl_FragColor = vec4(acc / w, 1.0);
}`;

// Motion blur from the camera's movement: each pixel's place in the last frame, from its depth.
const BLUR_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform mat4 uInvViewProj, uPrevViewProj; uniform float uShutter;
varying vec2 vUv;
${COMMON}
void main() {
  float d = texture2D(tDepth, vUv).x;
  vec4 world = uInvViewProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 prev = uPrevViewProj * vec4(world.xyz / world.w, 1.0);
  vec2 v = (vUv - (prev.xy / prev.w * 0.5 + 0.5)) * uShutter;
  float len = length(v);
  if (len < 0.0004) { gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.0); return; }
  if (len > 0.05) v *= 0.05 / len;
  vec3 acc = vec3(0.0);
  float j = ign(gl_FragCoord.xy) - 0.5;
  for (int i = 0; i < 8; i++) acc += texture2D(tSrc, vUv - v * ((float(i) + j) / 7.0 - 0.5)).rgb;
  gl_FragColor = vec4(acc / 8.0, 1.0);
}`;

// Bloom: a soft-knee bright pass, then a pyramid of blurs.
const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uKnee;
varying vec2 vUv;
void main() {
  vec2 o = uTexel;
  vec3 m = texture2D(tSrc, vUv).rgb, a = texture2D(tSrc, vUv + o).rgb, b = texture2D(tSrc, vUv - o).rgb;
  vec3 e = texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb, f = texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb;
  vec3 c;
  if (uKnee > 0.0) {
    // the bright pass. Each sample counts less the brighter it is: one very bright texel (a window bar's edge, a
    // glint) then cannot swing the whole glow as the camera moves across it
    vec4 k = vec4(1.0) / (1.0 + vec4(max(a.r, max(a.g, a.b)), max(b.r, max(b.g, b.b)), max(e.r, max(e.g, e.b)), max(f.r, max(f.g, f.b))) / uKnee);
    float km = 4.0 / (1.0 + max(m.r, max(m.g, m.b)) / uKnee);
    c = (m * km + a * k.x + b * k.y + e * k.z + f * k.w) / (km + k.x + k.y + k.z + k.w);
    float l = max(c.r, max(c.g, c.b));
    c *= smoothstep(uKnee, uKnee * 3.0, l);
  } else c = m * 0.5 + (a + b + e + f) * 0.125;
  gl_FragColor = vec4(min(c, vec3(64.0)), 1.0);
}`;
const UP_FRAG = /* glsl */ `
uniform sampler2D tSrc, tAdd; uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec2 o = uTexel * 0.5;
  vec3 c = (texture2D(tSrc, vUv + vec2(-o.x * 2.0, 0.0)).rgb + texture2D(tSrc, vUv + vec2(o.x * 2.0, 0.0)).rgb
    + texture2D(tSrc, vUv + vec2(0.0, -o.y * 2.0)).rgb + texture2D(tSrc, vUv + vec2(0.0, o.y * 2.0)).rgb
    + (texture2D(tSrc, vUv + o).rgb + texture2D(tSrc, vUv - o).rgb + texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb
      + texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb) * 2.0) / 12.0;
  gl_FragColor = vec4(c + texture2D(tAdd, vUv).rgb, 1.0);
}`;

// ---- the lens flare of the Lego homeworld project (client/js/render/post.js), as it is there
const FLARE_THRESHOLD = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uLevel, uRange, uCap;
varying vec2 vUv;
vec3 tap(vec2 o) { return min(texture2D(tSrc, vUv + o * uTexel).rgb, vec3(256.0)); }
void main() {
  vec3 c = tap(vec2(0)) * 0.125
    + (tap(vec2(-2, 2)) + tap(vec2(2, 2)) + tap(vec2(-2, -2)) + tap(vec2(2, -2))) * 0.03125
    + (tap(vec2(0, 2)) + tap(vec2(-2, 0)) + tap(vec2(2, 0)) + tap(vec2(0, -2))) * 0.0625
    + (tap(vec2(-1, 1)) + tap(vec2(1, 1)) + tap(vec2(-1, -1)) + tap(vec2(1, -1))) * 0.125;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = vec4(c * smoothstep(uLevel, uLevel + uRange, l) * min(1.0, uCap / max(l, 1e-4)), 1.0);
}`;
const FLARE_BLUR = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uOffset;
varying vec2 vUv;
void main() {
  vec2 o = uTexel * uOffset;
  gl_FragColor = vec4((texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb + texture2D(tSrc, vUv + o).rgb
    + texture2D(tSrc, vUv - o).rgb + texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb) * 0.25, 1.0);
}`;
const FLARE_FEATURES = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uGhost, uHalo, uChroma, uSpin;
varying vec2 vUv;
float hash1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
// rays around the frame's centre: fine ones over broad ones, sliding as the camera turns
float rays(vec2 d) {
  float a = atan(d.y, d.x) * 0.15915494 + 0.5;
  float x = a * 120.0 + uSpin, y = a * 28.0 - uSpin * 0.37;
  float fx = fract(x), fy = fract(y);
  fx = fx * fx * (3.0 - 2.0 * fx); fy = fy * fy * (3.0 - 2.0 * fy);
  float fine = mix(hash1(mod(floor(x), 120.0)), hash1(mod(floor(x) + 1.0, 120.0)), fx);
  float broad = mix(hash1(mod(floor(y), 28.0) + 300.0), hash1(mod(floor(y) + 1.0, 28.0) + 300.0), fy);
  return 0.45 + 0.75 * fine * fine + 0.5 * broad;
}
vec3 ghost(vec2 dir, vec3 tint, float offset) {
  vec2 suv = clamp(1.0 - vUv + dir * offset, 0.0, 1.0);
  float d = clamp(length(0.5 - suv) / 0.70710678, 0.0, 1.0);
  // every reflection disperses a little: red lands slightly further out than blue, fringing each ghost
  vec2 cd = (suv - 0.5) * 0.012 * sign(offset);
  vec3 s = vec3(texture2D(tSrc, clamp(suv + cd, 0.0, 1.0)).r, texture2D(tSrc, suv).g, texture2D(tSrc, clamp(suv - cd, 0.0, 1.0)).b);
  return s * tint * pow(1.0 - d, 3.0);
}
float ring(float x, float radius, float thickness) {
  float v = min(abs(x - radius) / thickness, 1.0);
  return 1.0 - v * v * (3.0 - 2.0 * v);
}
void main() {
  vec2 dir = vUv - 0.5;
  vec3 c = ghost(dir, vec3(0.8, 0.8, 1.0), -5.0) + ghost(dir, vec3(1.0, 0.8, 0.4), -1.5)
    + ghost(dir, vec3(0.9, 1.0, 0.8), -0.4) + ghost(dir, vec3(1.0, 0.8, 0.4), -0.2)
    + ghost(dir, vec3(0.9, 0.7, 0.7), -0.1) + ghost(dir, vec3(0.5, 1.0, 0.4), 0.7)
    + ghost(dir, vec3(0.5, 0.5, 0.5), 1.0) + ghost(dir, vec3(1.0, 1.0, 0.6), 2.5)
    + ghost(dir, vec3(0.5, 0.8, 1.0), 10.0);
  c *= uGhost;
  // spectral halo ring: each channel refracted a little differently
  vec2 aspect = vec2(uTexel.x / uTexel.y, 1.0);
  vec2 hd = normalize(dir / aspect + 1e-6) * aspect;
  vec2 huv = fract(1.0 - vUv + hd * 0.3);
  vec3 off = vec3(uTexel.x * uChroma) * vec3(-1.0, 0.0, 1.0);
  vec3 halo = vec3(texture2D(tSrc, huv + hd * off.r).r, texture2D(tSrc, huv + hd * off.g).g, texture2D(tSrc, huv + hd * off.b).b);
  vec2 wuv = (vUv - vec2(0.5, 0.0)) / aspect + vec2(0.5, 0.0);
  c += halo * ring(clamp(distance(wuv, vec2(0.5)), 0.0, 1.0), 0.45, 0.25) * uHalo * rays(dir / aspect);
  gl_FragColor = vec4(c, 1.0);
}`;
// anamorphic streak: repeated wide horizontal blurs (steps 1, 4, 16 texels) stretch each light into a line;
// each pass decays faster than the last so the line tapers to fine ends instead of a flat bar
const FLARE_STREAK = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uStep, uDecay;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb; float w = 1.0;
  for (int i = 1; i <= 6; i++) {
    float k = exp(-float(i) * uDecay);
    vec2 o = vec2(float(i) * uStep * uTexel.x, 0.0);
    c += (texture2D(tSrc, vUv + o).rgb + texture2D(tSrc, vUv - o).rgb) * k; w += 2.0 * k;
  }
  gl_FragColor = vec4(c / w, 1.0);
}`;

// What the eye-adaptation loop reads: the frame's log luminance, the middle weighted over the corners.
const LUM_FRAG = /* glsl */ `
uniform sampler2D tSrc; varying vec2 vUv;
void main() {
  float l = dot(texture2D(tSrc, vUv).rgb, vec3(0.2126, 0.7152, 0.0722));
  float w = 1.0 - 0.6 * smoothstep(0.2, 0.75, distance(vUv, vec2(0.5)));
  gl_FragColor = vec4(log(max(l, 1e-4)) * w, w, 0.0, 1.0);
}`;

// FXAA (after Timothy Lottes' FXAA 3, the short form): along an edge found in the luma of four diagonal neighbours.
// The grain is added before it and survives: it has no edge direction.
const FXAA_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  vec3 m = texture2D(tSrc, vUv).rgb;
  float nw = lum(texture2D(tSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb), ne = lum(texture2D(tSrc, vUv + vec2(1.0, -1.0) * uTexel).rgb);
  float sw = lum(texture2D(tSrc, vUv + vec2(-1.0, 1.0) * uTexel).rgb), se = lum(texture2D(tSrc, vUv + vec2(1.0, 1.0) * uTexel).rgb);
  float lm = lum(m), lo = min(lm, min(min(nw, ne), min(sw, se))), hi = max(lm, max(max(nw, ne), max(sw, se)));
  vec2 dir = vec2(-((nw + ne) - (sw + se)), (nw + sw) - (ne + se));
  float reduce = max((nw + ne + sw + se) * 0.03125, 0.0078125);
  dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + reduce), -8.0, 8.0) * uTexel;
  vec3 a = 0.5 * (texture2D(tSrc, vUv + dir * (1.0 / 3.0 - 0.5)).rgb + texture2D(tSrc, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture2D(tSrc, vUv - dir * 0.5).rgb + texture2D(tSrc, vUv + dir * 0.5).rgb);
  float lb = lum(b);
  gl_FragColor = vec4(lb < lo || lb > hi ? a : b, 1.0);
}`;

// Sharpening for the finished frame (after AMD's contrast-adaptive sharpening, the short form): each pixel is pushed
// away from the mean of its four neighbours, less where the neighbourhood already has contrast, so edges do not ring.
const SHARP_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uAmount; varying vec2 vUv;
void main() {
  vec3 m = texture2D(tSrc, vUv).rgb;
  vec3 n = texture2D(tSrc, vUv + vec2(0.0, -uTexel.y)).rgb, s = texture2D(tSrc, vUv + vec2(0.0, uTexel.y)).rgb;
  vec3 w = texture2D(tSrc, vUv + vec2(-uTexel.x, 0.0)).rgb, e = texture2D(tSrc, vUv + vec2(uTexel.x, 0.0)).rgb;
  vec3 lo = min(m, min(min(n, s), min(w, e))), hi = max(m, max(max(n, s), max(w, e)));
  vec3 amp = sqrt(clamp(min(lo, 1.0 - hi) / max(hi, 1e-3), 0.0, 1.0));
  vec3 k = -amp * uAmount * 0.2;
  gl_FragColor = vec4(clamp((m + (n + s + w + e) * k) / (1.0 + 4.0 * k), 0.0, 1.0), 1.0);
}`;

const FINAL_FRAG = /* glsl */ `
uniform sampler2D tSrc, tBloom, tBloomWide, tDirt, tFlare, tStreak, tStreakCore;
uniform vec2 uRes; uniform float uExposure, uBloomI, uDirtI, uFlareI, uStreakI, uFlareDirt, uCA, uVignette, uGrain, uTime, uLens, uFilm;
uniform vec3 uStreakTint;
varying vec2 vUv;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 AgX(vec3 color) {
  const mat3 R709to2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
  const mat3 R2020to709 = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
  const mat3 inset = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 outset = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  color = inset * (R709to2020 * color);
  color = clamp((log2(max(color, 1e-10)) + 12.47393) / 16.5, 0.0, 1.0);
  color = agxContrast(color);
  float l = luma(color);
  color = pow(max(color, 0.0), vec3(1.12));
  color = l + (color - l) * 1.06;
  color = outset * color;
  color = pow(max(color, 0.0), vec3(2.2));
  return clamp(R2020to709 * color, 0.0, 1.0);
}
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
void main() {
  vec2 uv = vUv, c = uv - 0.5;
  float aspect = uRes.x / uRes.y;
  // a little colour fringing towards the corners, as a wide lens has
  vec2 ca = c * dot(c, c) * uCA * uFilm;
  vec3 col = vec3(texture2D(tSrc, uv + ca).r, texture2D(tSrc, uv).g, texture2D(tSrc, uv - ca).b);
  // ---- bloom with lens dirt: smudges and dust on the front element scatter the light of any bright thing
  // nearby in frame; the wide, low bloom level is the light falling on each speck
  vec2 duv = c * vec2(aspect / 1.6, 1.0) + 0.5;
  vec3 dirt = texture2D(tDirt, duv).rgb;
  // The glow comes in two parts. Close around a light it leans warm, as light scattered back through the sensor's
  // layers does (halation); the wide part is the veil a lens lays over the frame when it faces a window.
  vec3 wide = texture2D(tBloomWide, uv).rgb, tight = max(texture2D(tBloom, uv).rgb - wide, 0.0);
  col += (tight * vec3(1.08, 0.97, 0.86) * 0.9 + wide * 1.2) * uBloomI * uLens + dirt * wide * uDirtI * uLens;
  // ghosts, halo and streaks from every bright source; the dirty front element catches them.
  // Streaks: a short warm core inside a long, cool anamorphic line.
  vec3 lens = texture2D(tFlare, uv).rgb * uFlareI
    + (texture2D(tStreakCore, uv).rgb * vec3(1.0, 0.88, 0.75) * 0.35 + texture2D(tStreak, uv).rgb * uStreakTint) * uStreakI;
  col += lens * (1.0 + luma(dirt) * uFlareDirt) * uLens;
  col *= uExposure;
  // the lens passes less light to the corners
  float r2 = dot(c * vec2(aspect, 1.0), c * vec2(aspect, 1.0));
  col *= mix(1.0, 1.0 / pow(1.0 + r2 * 0.9, 2.0), uVignette * uFilm);
  col = toSRGB(AgX(col));
  // grain: more of it in the shadows, where a sensor is noisiest
  // (two throws of the dice summed: most grains are faint and a few stand out, as silver does; each colour layer
  // has a little grain of its own)
  vec2 gp = gl_FragCoord.xy + fract(uTime) * 311.7;
  float g = hash(gp) + hash(gp + 71.3) - 1.0;
  vec3 g3 = vec3(g) + (fract(hash(gp + 13.1) * vec3(1.0, 7.13, 13.71)) - 0.5) * 0.3;
  col += g3 * uGrain * 0.8 * uFilm * mix(1.6, 0.5, luma(col));
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- lens dirt texture (procedural; Lego homeworld's)
// Layered like a real front element: a faint greasy haze, dried droplets (bright rims, dim centres),
// wipe marks of fine parallel arcs, a few fibres and a dusting of sharp specks, each faintly tinted.
function makeDirtTexture() {
  const size = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  g.globalCompositeOperation = 'lighter';
  let s = 1234567;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const tint = (a) => {
    const t = rnd();
    const [r, gr, b] = t < 0.3 ? [255, 236, 210] : t < 0.55 ? [215, 232, 255] : [255, 255, 255];
    return (k) => `rgba(${r},${gr},${b},${a * k})`;
  };
  const blob = (x, y, r, stops) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    for (const [t, colour] of stops) gr.addColorStop(t, colour);
    g.fillStyle = gr;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  };
  for (let i = 0; i < 26; i++) {   // greasy haze
    const col = tint(0.035 + rnd() * 0.05);
    blob(rnd() * size, rnd() * size, 90 + rnd() * 220, [[0, col(1)], [0.6, col(0.5)], [1, col(0)]]);
  }
  for (let i = 0; i < 110; i++) {   // soft smudges
    const col = tint(0.04 + rnd() * 0.16);
    blob(rnd() * size, rnd() * size, 8 + Math.pow(rnd(), 2.2) * 120, [[0, col(1)], [0.5, col(0.45)], [1, col(0)]]);
  }
  for (let i = 0; i < 40; i++) {   // dried droplets
    const col = tint(0.05 + rnd() * 0.12);
    blob(rnd() * size, rnd() * size, 4 + Math.pow(rnd(), 1.8) * 26, [[0, col(0.35)], [0.6, col(0.5)], [0.86, col(1)], [1, col(0)]]);
  }
  g.lineCap = 'round';
  for (let i = 0; i < 7; i++) {   // wipe marks
    const cx = rnd() * size, cy = rnd() * size, radius = 120 + rnd() * 360, start = rnd() * Math.PI * 2, sweep = 0.3 + rnd() * 0.7;
    const col = tint(0.025 + rnd() * 0.04);
    for (let j = 0; j < 16; j++) {
      g.strokeStyle = col(0.4 + rnd() * 0.6);
      g.lineWidth = 0.6 + rnd() * 1.6;
      g.beginPath();
      g.arc(cx, cy, radius + j * (2 + rnd() * 3), start + rnd() * 0.08, start + sweep - rnd() * 0.1);
      g.stroke();
    }
  }
  for (let i = 0; i < 5; i++) {   // fibres
    g.strokeStyle = tint(0.12 + rnd() * 0.12)(1);
    g.lineWidth = 0.8 + rnd() * 0.8;
    g.beginPath();
    let x = rnd() * size, y = rnd() * size;
    g.moveTo(x, y);
    for (let k = 0; k < 3; k++) {
      const nx = x + (rnd() - 0.5) * 140, ny = y + (rnd() - 0.5) * 140;
      g.quadraticCurveTo(x + (rnd() - 0.5) * 90, y + (rnd() - 0.5) * 90, nx, ny);
      x = nx;
      y = ny;
    }
    g.stroke();
  }
  for (let i = 0; i < 1400; i++) {   // dust specks
    const col = tint(0.15 + Math.pow(rnd(), 3) * 0.75);
    blob(rnd() * size, rnd() * size, 0.8 + Math.pow(rnd(), 4) * 4.5, [[0, col(1)], [0.5, col(0.7)], [1, col(0)]]);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

// ---------------------------------------------------------------- the frame, pass by pass
const NEAR = 0.05, FAR = 400;
const camera = new THREE.PerspectiveCamera(58, 1, NEAR, FAR);
const scene = new THREE.Scene();
const quadScene = new THREE.Scene();
const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
quad.frustumCulled = false;
quadScene.add(quad);

const half = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
const target = (w, h, opts = {}) => new THREE.WebGLRenderTarget(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), { ...half, ...opts });
let rt = null;
function resize() {
  const w = Math.max(64, Math.floor(window.innerWidth * MAX_RATIO * scale)), h = Math.max(64, Math.floor(window.innerHeight * MAX_RATIO * scale));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (rt) for (const t of rt.all) t.dispose();
  // four samples a pixel for the edges of the geometry; the depth the later passes read is resolved with it
  const sceneRT = target(w, h, { depthBuffer: true, depthTexture: new THREE.DepthTexture(w, h, THREE.UnsignedIntType), samples: 4 });
  const mips = Array.from({ length: 6 }, (_, k) => target(w / 2 ** (k + 1), h / 2 ** (k + 1)));
  const ups = Array.from({ length: 5 }, (_, k) => target(w / 2 ** (k + 1), h / 2 ** (k + 1)));
  rt = { w, h, scene: sceneRT, dof: target(w, h), blur: target(w, h), mips, ups,
    ldr: new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false }),
    flareA: target(w / 4, h / 4), flareB: target(w / 4, h / 4), streakA: target(w / 4, h / 4), streakB: target(w / 4, h / 4),
    lum: new THREE.WebGLRenderTarget(32, 32, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false }) };
  rt.all = [sceneRT, rt.ldr, rt.dof, rt.blur, ...mips, ...ups, rt.flareA, rt.flareB, rt.streakA, rt.streakB, rt.lum];
}
const texel = (t) => new THREE.Vector2(1 / t.width, 1 / t.height);
const moved = (a, b) => a.elements.some((v, i) => Math.abs(v - b.elements[i]) > 1e-5);
function pass(material, to, values = {}) {
  for (const [k, v] of Object.entries(values)) {
    const u = material.uniforms[k];
    // vectors and matrices are copied into the uniform's own; a texture is swapped for another (copying one texture
    // into another would overwrite a render target's)
    if (v?.isVector2 || v?.isVector3 || v?.isMatrix4 || v?.isColor) u.value.copy(v); else u.value = v;
  }
  quad.material = material;
  renderer.setRenderTarget(to);
  renderer.render(quadScene, quadCam);
}

const depthU = () => ({ tDepth: { value: null }, uNear: { value: NEAR }, uFar: { value: FAR } });
const M = {
  dof: mat(DOF_FRAG, { ...depthU(), tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uFocus: { value: 4 }, uCoc: { value: 0 }, uMaxCoc: { value: 14 }, uFrame: { value: 0 } }),
  blur: mat(BLUR_FRAG, { ...depthU(), tSrc: { value: null }, uInvViewProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() }, uShutter: { value: 0.5 } }),
  down: mat(DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uKnee: { value: 0 } }),
  up: mat(UP_FRAG, { tSrc: { value: null }, tAdd: { value: null }, uTexel: { value: new THREE.Vector2() } }),
  threshold: mat(FLARE_THRESHOLD, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uLevel: { value: 3 }, uRange: { value: 4 }, uCap: { value: 1e4 } }),
  flareBlur: mat(FLARE_BLUR, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uOffset: { value: 1.5 } }),
  features: mat(FLARE_FEATURES, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uGhost: { value: 0.05 }, uHalo: { value: 0.06 }, uChroma: { value: 24 }, uSpin: { value: 0 } }),
  streak: mat(FLARE_STREAK, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uStep: { value: 1 }, uDecay: { value: 0.4 } }),
  lum: mat(LUM_FRAG, { tSrc: { value: null } }),
  fxaa: mat(FXAA_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } }),
  sharp: mat(SHARP_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uAmount: { value: 0.8 } }),
  final: mat(FINAL_FRAG, { tSrc: { value: null }, tBloom: { value: null }, tBloomWide: { value: null }, tDirt: { value: makeDirtTexture() }, tFlare: { value: null },
    tStreak: { value: null }, tStreakCore: { value: null }, uRes: { value: new THREE.Vector2() }, uExposure: { value: 1 }, uBloomI: { value: 0.018 }, uDirtI: { value: 0.06 },
    uFlareI: { value: 0.5 }, uStreakI: { value: 0.12 }, uFlareDirt: { value: 1.5 }, uStreakTint: { value: new THREE.Color(0.55, 0.75, 1.0) }, uCA: { value: 0.012 },
    uVignette: { value: 0.8 }, uGrain: { value: 0.022 }, uTime: { value: 0 }, uLens: { value: 1 }, uFilm: { value: 1 } }),
};

// ---------------------------------------------------------------- the level and the walk
// How far over the interior the daylight outside sits, and how far the painting's clipped whites are lifted: enough for
// a window to bloom and for the exposure to have something to do, not so much that a window blanks the frame.
const LIFT = 0.6, OUTSIDE = 4, SKY = 6;
const RELIEF = Number(query.get('relief') ?? 0.012), GLOSS = Number(query.get('gloss') ?? 1);
let hasMaps = false;
const levelMat = new THREE.ShaderMaterial({ vertexShader: LEVEL_VERT, fragmentShader: LEVEL_FRAG, side: THREE.DoubleSide, toneMapped: false,
  uniforms: { map: { value: null }, uBoxMin: { value: new THREE.Vector3() }, uBoxMax: { value: new THREE.Vector3() }, uLift: { value: LIFT }, uOutside: { value: OUTSIDE },
    tMaps: { value: null }, tRelief: { value: null }, tEnv: { value: null }, uProbe: { value: new THREE.Vector3() }, uRoomMin: { value: new THREE.Vector3() }, uRoomMax: { value: new THREE.Vector3() },
    // uRelief: metres of depth the height map's full range stands for; uGloss: divides the map's roughness (?gloss=)
    uMaps: { value: 0 }, uClay: { value: 0 }, uRelief: { value: RELIEF }, uEnvLod: { value: 0 }, uGloss: { value: GLOSS }, uShow: { value: 0 } } });
const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 24, 12), new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false, toneMapped: false,
  uniforms: { uSky: { value: SKY } }, fragmentShader: SKY_FRAG,
  vertexShader: `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0); }` }));
scene.add(sky);

// The Loft's windows, as samples/build_loft.py lays them out (glTF axes: x east, y up, z south): which way the wall
// faces into the room, where the pane's plane is, its span along the wall, and its grid of panes.
const LOFT_WINDOWS = [
  ...[-8, -4, 0, 4].map((c) => ({ axis: 'z', at: -5.15, from: c - 1.2, to: c + 1.2, cols: 3, rows: 4, inward: 1 })),   // north wall
  ...[-6, -2, 2, 6].map((c) => ({ axis: 'z', at: 5.15, from: c - 1.2, to: c + 1.2, cols: 3, rows: 4, inward: -1 })),   // south wall
  { axis: 'x', at: -10.15, from: -1.6, to: 1.6, cols: 4, rows: 4, inward: 1 },                                           // west wall
];
function makeGlass(windows, y0 = 1.0, y1 = 4.2, frame = 0.07) {
  const position = [], normal = [], uv = [], grid = [], index = [];
  for (const w of windows) {
    const a = w.from + frame, b = w.to - frame, lo = y0 + frame, hi = y1 - frame, base = position.length / 3;
    for (const [s, t] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const along = a + (b - a) * s, y = lo + (hi - lo) * t;
      position.push(...(w.axis === 'z' ? [along, y, w.at] : [w.at, y, along]));
      normal.push(...(w.axis === 'z' ? [0, 0, w.inward] : [w.inward, 0, 0]));
      uv.push(s, t);
      grid.push(w.cols, w.rows);
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('grid', new THREE.Float32BufferAttribute(grid, 2));
  g.setIndex(index);
  return g;
}
const glassMat = new THREE.ShaderMaterial({ vertexShader: GLASS_VERT, fragmentShader: GLASS_FRAG, side: THREE.DoubleSide, transparent: true, depthWrite: false, toneMapped: false,
  blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  uniforms: { tEnv: { value: null }, uProbe: { value: new THREE.Vector3() }, uBoxMin: { value: new THREE.Vector3() }, uBoxMax: { value: new THREE.Vector3() }, uDay: { value: 4 } } });
let glass = null, probe = null;

/**
 * The geometry with each triangle's corners marked, so the shader can draw its edges (the clay view). Where two
 * triangles make a rectangle, the diagonal between them is left out: the lines then follow the model's faces.
 */
function wired(geometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const p = g.getAttribute('position'), bary = new Float32Array(p.count * 3);
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], a = new THREE.Vector3(), b = new THREE.Vector3();
  for (let t = 0; t < p.count; t += 3) {
    for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(p, t + k);
    // the corner with a right angle sits opposite the diagonal
    let square = -1;
    for (let k = 0; k < 3; k++) {
      a.subVectors(v[(k + 1) % 3], v[k]); b.subVectors(v[(k + 2) % 3], v[k]);
      if (Math.abs(a.dot(b)) < 0.02 * a.length() * b.length()) square = k;
    }
    for (let k = 0; k < 3; k++) {
      bary[(t + k) * 3 + k] = 1;
      if (square >= 0) bary[(t + k) * 3 + square] = 1;   // never near zero: the edge opposite is not drawn
    }
  }
  g.setAttribute('bary', new THREE.Float32BufferAttribute(bary, 3));
  return g;
}

const EYE = 1.65, SPEED = 1.15, STEP = 0.74;
let level = null, path = null, pathLength = 0;
const ray = new THREE.Raycaster();

/** Whether a person can walk straight from a to b: nothing in the way at eye, hip and shin height. */
function clear(a, b) {
  const d = new THREE.Vector3().subVectors(b, a), len = d.length();
  d.divideScalar(len);
  for (const h of [0, -0.75, -1.3]) {
    ray.set(new THREE.Vector3(a.x, a.y + h, a.z), d);
    ray.far = len;
    if (ray.intersectObject(level, false).length) return false;
  }
  return true;
}

/**
 * A loop through the spots a person can stand at: a tree of walkable links between them, walked out and back along
 * each branch (so every stretch is one the walker can really take), then rounded off.
 */
function buildPath(points) {
  const n = points.length, links = points.map(() => []);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const d = points[i].distanceTo(points[j]);
    if (d < 9 && clear(points[i], points[j])) { links[i].push({ to: j, d }); links[j].push({ to: i, d }); }
  }
  const centre = points.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(n);
  let start = 0;
  for (let i = 1; i < n; i++) if (points[i].distanceTo(centre) < points[start].distanceTo(centre)) start = i;
  const seen = new Set([start]), order = [];
  const visit = (i, from) => {
    order.push(i);
    // nearest first, and rather straight on than back
    const next = links[i].filter((l) => !seen.has(l.to)).sort((a, b) => a.d - b.d);
    for (const l of next) {
      if (seen.has(l.to)) continue;
      seen.add(l.to);
      visit(l.to, i);
      order.push(i);
    }
    void from;
  };
  visit(start, -1);
  if (order.length > 1 && order[order.length - 1] === order[0]) order.pop();
  const curve = new THREE.CatmullRomCurve3(order.map((i) => points[i].clone()), true, 'centripetal');
  curve.arcLengthDivisions = 1200;
  return curve;
}

const state = { dist: 0, yaw: 0, pitch: 0, focus: 4, exposure: 1, time: 0, stride: 0, speed: 0, show: Number(query.get("show") ?? 0) };
const position = new THREE.Vector3(), velocity = new THREE.Vector3();
const keys = new Set();
const prevViewProj = new THREE.Matrix4(), viewProj = new THREE.Matrix4(), invViewProj = new THREE.Matrix4();
const lumPixels = new Float32Array(32 * 32 * 4);
let frame = 0, area = null, metering = false;

/** Whether the walker, a body 35 cm round, can move `step` along the unit direction `d` from `from`. */
function free(from, d, step) {
  for (const h of [-0.2, -0.75, -1.3]) {
    ray.set(new THREE.Vector3(from.x, from.y + h, from.z), d);
    ray.far = step + 0.35;
    if (ray.intersectObject(level, false).length) return false;
  }
  return true;
}

function updateCamera(dt) {
  let moving = 0;
  if (on.tour) {
    state.dist = (((state.dist + SPEED * dt) % pathLength) + pathLength) % pathLength;
    const u = state.dist / pathLength;
    const p = path.getPointAt(u), ahead = path.getPointAt((u + 2.2 / pathLength) % 1);
    const dir = new THREE.Vector3().subVectors(ahead, p).setY(0).normalize();
    position.copy(p);
    // the gaze: where the path leads, wandering off it a little
    const t = state.time, k = 1 - Math.exp(-dt * 2.2);
    const wantYaw = Math.atan2(-dir.x, -dir.z) + 0.38 * Math.sin(t * 0.21) + 0.2 * Math.sin(t * 0.53 + 1.3);
    state.yaw += Math.atan2(Math.sin(wantYaw - state.yaw), Math.cos(wantYaw - state.yaw)) * k;
    state.pitch += (-0.05 + 0.07 * Math.sin(t * 0.17 + 0.6) - state.pitch) * k;
    state.stride += (SPEED * dt / STEP) * Math.PI;
    moving = 1;
  } else {
    // W A S D, relative to where you look; the body takes a moment to get going and to stop
    const f = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
    const r = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
    const want = new THREE.Vector3(-Math.sin(state.yaw) * f + Math.cos(state.yaw) * r, 0, -Math.cos(state.yaw) * f - Math.sin(state.yaw) * r);
    if (want.lengthSq() > 0) want.normalize().multiplyScalar(keys.has('shift') ? 3.4 : 1.7);
    velocity.lerp(want, 1 - Math.exp(-dt * 9));
    // each axis on its own, so a wall is slid along and not stuck to
    for (const axis of ['x', 'z']) {
      const step = velocity[axis] * dt;
      if (Math.abs(step) < 1e-5) continue;
      const d = new THREE.Vector3(axis === 'x' ? Math.sign(step) : 0, 0, axis === 'z' ? Math.sign(step) : 0);
      if (free(position, d, Math.abs(step))) position[axis] += step; else velocity[axis] = 0;
    }
    position.x = THREE.MathUtils.clamp(position.x, area[0] + 0.4, area[3] - 0.4);
    position.z = THREE.MathUtils.clamp(position.z, area[2] + 0.4, area[5] - 0.4);
    const speed = Math.hypot(velocity.x, velocity.z);
    state.stride += (speed * dt / STEP) * Math.PI;
    moving = Math.min(1, speed / 1.7);
  }
  state.speed += (moving - state.speed) * (1 - Math.exp(-dt * 6));
  // a walker's head: it rises and falls twice a stride and sways once
  const bob = Math.abs(Math.sin(state.stride)) * 0.03 * state.speed, sway = Math.sin(state.stride) * 0.016 * state.speed;
  camera.position.set(position.x + Math.cos(state.yaw) * sway, position.y + bob, position.z - Math.sin(state.yaw) * sway);
  camera.rotation.set(state.pitch, state.yaw, Math.sin(state.stride) * 0.005 * state.speed, 'YXZ');
  camera.updateMatrixWorld(true);
}

function autofocus(dt) {
  // what is in the middle of the frame, a little below centre where things stand: the nearest of five rays
  let nearest = Infinity;
  for (const [x, y] of [[0, 0], [0.08, -0.06], [-0.08, -0.06], [0, -0.14], [0, 0.08]]) {
    ray.setFromCamera(new THREE.Vector2(x, y), camera);
    ray.far = 60;
    const hit = ray.intersectObject(level, false)[0];
    if (hit) nearest = Math.min(nearest, hit.distance);
  }
  if (nearest === Infinity) nearest = 30;
  // focus pulls faster towards something near than it lets go of it
  const rate = nearest < state.focus ? 5 : 2.2;
  state.focus += (nearest - state.focus) * (1 - Math.exp(-dt * rate));
}

function render(dt) {
  const { w, h } = rt;
  levelMat.uniforms.uLift.value = on.hdr ? LIFT : 0;
  levelMat.uniforms.uOutside.value = on.hdr ? OUTSIDE : 1;
  sky.material.uniforms.uSky.value = on.hdr ? SKY : 1;
  if (glass) { glass.visible = on.glass && !on.clay; glassMat.uniforms.uDay.value = on.hdr ? OUTSIDE : 1; }
  levelMat.uniforms.uMaps.value = on.maps && hasMaps && !on.clay ? 1 : 0;
  levelMat.uniforms.uClay.value = on.clay ? 1 : 0;
  levelMat.uniforms.uShow.value = state.show;
  renderer.setRenderTarget(rt.scene);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  renderer.render(scene, camera);

  viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const depth = rt.scene.depthTexture;
  // depth of field: the blur circle in pixels, for a lens of about f/2 on this frame height
  let src = rt.scene;
  if (on.dof) {
    pass(M.dof, rt.dof, { tSrc: src.texture, tDepth: depth, uTexel: texel(rt.scene), uFocus: state.focus, uCoc: 0.009 * h, uMaxCoc: Math.max(4, h / 130), uFrame: frame % 64 });
    src = rt.dof;
  }
  if (on.blur && moved(viewProj, prevViewProj)) {   // a camera at rest blurs nothing: the pass is left out
    // a shutter open for half the frame (a 180 degree shutter), whatever the frame rate
    pass(M.blur, rt.blur, { tSrc: src.texture, tDepth: depth, uInvViewProj: invViewProj.copy(viewProj).invert(), uPrevViewProj: prevViewProj, uShutter: 0.5 * Math.min(1, (1 / 60) / Math.max(dt, 1e-3)) * (dt > 0 ? 1 : 0) + 0.0 });
    src = rt.blur;
  }
  prevViewProj.copy(viewProj);

  // bloom pyramid
  let from = src;
  // what counts as bright is what is bright in the frame as exposed: the thresholds follow the exposure
  const ex = Math.max(state.exposure, 0.05);
  rt.mips.forEach((m, k) => { pass(M.down, m, { tSrc: from.texture, uTexel: texel(from), uKnee: k === 0 ? 2.2 / ex : 0 }); from = m; });
  let up = rt.mips[5];
  for (let k = 4; k >= 0; k--) { pass(M.up, rt.ups[k], { tSrc: up.texture, tAdd: rt.mips[k].texture, uTexel: texel(up) }); up = rt.ups[k]; }

  // lens flare: ghosts and halo from a blurred bright pass, streaks from a hotter one squeezed sideways
  const A = rt.flareA, B = rt.flareB, S = rt.streakA, T = rt.streakB;
  pass(M.threshold, B, { tSrc: src.texture, uTexel: texel(src).multiplyScalar(2), uLevel: 3.5 / ex, uRange: 6 / ex, uCap: 12 / ex });
  pass(M.flareBlur, A, { tSrc: B.texture, uTexel: texel(B), uOffset: 1.5 });
  pass(M.flareBlur, B, { tSrc: A.texture, uTexel: texel(B), uOffset: 2.5 });
  pass(M.flareBlur, A, { tSrc: B.texture, uTexel: texel(B), uOffset: 3.5 });
  pass(M.threshold, T, { tSrc: src.texture, uTexel: texel(src).multiply(new THREE.Vector2(2, 0.5)), uLevel: 5 / ex, uRange: 6 / ex, uCap: 7 / ex });
  pass(M.streak, S, { tSrc: T.texture, uTexel: texel(S), uStep: 1, uDecay: 0.35 });
  pass(M.streak, T, { tSrc: S.texture, uTexel: texel(S), uStep: 4, uDecay: 0.5 });
  pass(M.streak, S, { tSrc: T.texture, uTexel: texel(S), uStep: 16, uDecay: 0.75 });
  pass(M.features, B, { tSrc: A.texture, uTexel: texel(A), uGhost: 0.018, uHalo: 0.012, uChroma: 24, uSpin: state.yaw * 9 + state.pitch * 6 });

  // the eye adapts: every few frames, expose so the frame's average sits at middle gray
  // (read back without holding the frame up: the answer comes a frame or two later, which an eye does not notice)
  if (frame % 6 === 0 && !metering) {
    pass(M.lum, rt.lum, { tSrc: rt.mips[2].texture });
    metering = true;
    renderer.readRenderTargetPixelsAsync(rt.lum, 0, 0, 32, 32, lumPixels).then(() => {
      let sum = 0, weight = 0;
      for (let i = 0; i < lumPixels.length; i += 4) { sum += lumPixels[i]; weight += lumPixels[i + 1]; }
      const average = Math.exp(sum / Math.max(weight, 1e-3));
      state.wantExposure = on.hdr ? THREE.MathUtils.clamp(0.14 / average, 0.25, 2.0) : 1;
    }).catch(() => {}).finally(() => { metering = false; });
  }
  // quicker to close down for brightness than to open up for the dark, as an eye and a camera are
  const want = state.wantExposure ?? 1;
  state.exposure += (want - state.exposure) * (1 - Math.exp(-dt * (want < state.exposure ? 5 : 1.1)));

  pass(M.final, rt.ldr, { tSrc: src.texture, tBloom: rt.ups[0].texture, tBloomWide: rt.ups[3].texture, tFlare: B.texture, tStreak: S.texture, tStreakCore: T.texture,
    uRes: new THREE.Vector2(w, h), uExposure: state.exposure, uTime: state.time, uLens: on.lens ? 1 : 0, uFilm: on.film ? 1 : 0 });
  // the finished frame is sharpened a little; or, with X, smoothed instead (what multisampling leaves at very bright edges)
  if (on.aa) pass(M.fxaa, null, { tSrc: rt.ldr.texture, uTexel: texel(rt.ldr) });
  else pass(M.sharp, null, { tSrc: rt.ldr.texture, uTexel: texel(rt.ldr) });
  frame++;
}

// Holds the frame rate: the mean frame time over the last half second decides whether the frame is drawn smaller
// (frames running long) or may be drawn larger again (time to spare). Changes are a second apart at least.
const pace = { sum: 0, n: 0, fps: 60, since: 0 };
function govern(ms) {
  if (FIXED || !(ms > 0) || ms > 250) return;   // a hidden tab or a stall says nothing about the renderer
  pace.sum += ms; pace.n++; pace.since += ms;
  if (pace.n < 30) return;
  const mean = pace.sum / pace.n;
  pace.fps = 1000 / mean;
  pace.sum = pace.n = 0;
  if (pace.since < 1000) return;
  // under about 45 frames a second it gives ground; back over 60 with room to spare it takes it back
  const want = mean > 22 ? Math.max(0.75, scale * 0.9) : mean < 15 && scale < 1 ? Math.min(1, scale * 1.08) : scale;
  if (Math.abs(want - scale) > 0.01) { scale = want; pace.since = 0; resize(); }
}

function drawHud() {
  const row = (key, label, flag = true) => `<span class="${flag ? '' : 'off'}"><b>${key}</b> ${label}</span>`;
  hud.innerHTML = [row('W A S D', 'walk · shift: run'), row('click', document.pointerLockElement ? 'mouse looks · esc releases it' : 'to look with the mouse (or drag)'),
    row('H', 'fake HDR + auto exposure', on.hdr), row('L', 'lens: bloom, dirt, flare', on.lens), row('F', 'auto-focus depth of field', on.dof),
    row('B', 'motion blur', on.blur), row('G', 'fringe, vignette, grain', on.film), row('P', 'glass panes in the windows', on.glass), row('M', hasMaps ? 'materials: reflections, relief' : 'materials (this run has no maps)', on.maps && hasMaps), row('X', 'clay + wireframe', on.clay), row('K', 'extra edge smoothing (softer)', on.aa), row('T', 'tour: walks by itself', on.tour)].join('\n') +
    `\nfocus ${state.focus.toFixed(1)} m · exposure ${state.exposure >= 1 ? '+' : ''}${Math.log2(state.exposure).toFixed(1)} EV · ${Math.round(pace.fps)} fps at ${rt.w} × ${rt.h}`;
}

async function start() {
  const meta = await (await fetch(`${BASE}${RUN}/run.json`)).json();
  // The level with its texture at 8192 px wherever the run has one and the graphics card takes a texture that size
  // (twice the texels a metre of the 4096 px one), else at 4096 px; ?tex=4k asks for the smaller one outright.
  const big = renderer.capabilities.maxTextureSize >= 8192;
  const want = query.get('tex') ?? (big ? '8k' : '4k');
  const files = [...(want === '8k' ? ['level_8k.glb'] : []), 'level_4k.glb', 'level_textured.glb'];
  let gltf = null;
  const ktx2Loader = new KTX2Loader().detectSupport(renderer);
  const gltfLoader = new GLTFLoader().setKTX2Loader(ktx2Loader);
  for (const file of files) {
    const head = await fetch(`${BASE}${RUN}/${file}`, { method: 'HEAD' }).catch(() => null);
    if (!head?.ok || /text\/html/.test(head.headers.get('content-type') ?? '')) continue;
    msg.textContent = `loading the loft (${file.includes('8k') ? '8192' : '4096'} px of texture)…`;
    gltf = await gltfLoader.loadAsync(`${BASE}${RUN}/${file}`);
    break;
  }
  if (!gltf) throw new Error('no level file found');
  gltf.scene.updateMatrixWorld(true);
  const meshes = [];
  gltf.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const tuned = (map) => {
    map.colorSpace = THREE.NoColorSpace;   // the shader takes the picture's values as they are and makes light of them itself
    if (!map.isCompressedTexture) {
      // smaller copies of the texture for surfaces seen small or at a slant: without them brick and mesh shimmer
      map.generateMipmaps = true;
    }
    map.minFilter = map.isCompressedTexture && (map.mipmaps?.length ?? 0) <= 1 ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
    map.magFilter = THREE.LinearFilter;
    map.anisotropy = renderer.capabilities.getMaxAnisotropy();
    map.needsUpdate = true;
    return map;
  };
  let map;
  if (meshes.length === 1) {
    level = meshes[0];
    map = tuned(level.material.map);
    levelMat.uniforms.map.value = map;
    level.material = levelMat;
    level.geometry = wired(level.geometry);
  } else {
    // A level painted over several textures comes as a mesh for each of them. Each is drawn with its own texture, on
    // a material that shares every other setting with the rest; one mesh of all of them, never drawn, takes the rays
    // (the walk, the focus).
    for (const m of meshes) {
      const page = levelMat.clone();
      page.uniforms = { ...levelMat.uniforms, map: { value: tuned(m.material.map) }, tMaps: { value: null }, tRelief: { value: null } };
      m.material = page;
      m.geometry = wired(m.geometry);
    }
    map = meshes[0].material.uniforms.map.value;
    level = new THREE.Mesh(mergeGeometries(meshes.map((m) => m.geometry.clone().applyMatrix4(m.matrixWorld))), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  }
  const pages = meshes.length;
  level.geometry.boundsTree = new MeshBVH(level.geometry);
  scene.add(gltf.scene);
  // the room: where players can be, with its walls. Beyond it is outdoors.
  const bounds = new THREE.Box3().setFromObject(level);
  area = meta.area ?? [...bounds.min.toArray(), ...bounds.max.toArray()];
  levelMat.uniforms.uBoxMin.value.set(area[0] - 0.6, area[1] - 1, area[2] - 0.6);
  levelMat.uniforms.uBoxMax.value.set(area[3] + 0.6, area[4] + 1, area[5] + 0.6);
  // the run's material maps, where it has them: normal x, y and roughness in one picture, height in another
  const texture = async (file, format) => {
    const head = await fetch(`${BASE}${RUN}/${file}`, { method: 'HEAD' }).catch(() => null);
    if (!head?.ok || /text\/html/.test(head.headers.get('content-type') ?? '')) return null;
    const t = await new THREE.TextureLoader().loadAsync(`${BASE}${RUN}/${file}`);
    t.flipY = false;
    t.colorSpace = THREE.NoColorSpace;
    if (format) t.format = format;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = map.anisotropy;
    return t;
  };
  if (query.get('maps') !== 'off') {
    msg.textContent = 'loading the material maps…';
    // the maps come at the texture's size (8192 or 4096 px over all of it), cut to its pages where it has several
    const k = map.image.width * Math.sqrt(pages) >= 8192 && query.get('maps') !== '4k' ? '8k' : '4k';
    const pair = async (suffix) => {
      const maps = (await texture(`maps_${k}${suffix}.jpg`)) ?? (k === '8k' ? await texture(`maps_4k${suffix}.jpg`) : null);
      const relief = maps && ((await texture(`relief_${k}${suffix}.jpg`, THREE.RedFormat)) ?? (k === '8k' ? await texture(`relief_4k${suffix}.jpg`, THREE.RedFormat) : null));
      return maps && relief ? { maps, relief } : null;
    };
    const mats = pages === 1 ? [levelMat] : meshes.map((m) => m.material);
    const pairs = await Promise.all(mats.map((_, i) => pair(pages === 1 ? '' : `_p${i}`)));
    if (pairs.every(Boolean)) {
      mats.forEach((m, i) => { m.uniforms.tMaps.value = pairs[i].maps; m.uniforms.tRelief.value = pairs[i].relief; });
      hasMaps = true;
    }
  }
  // the room as seen from its middle, for whatever reflects it: the glass in the windows and the surfaces themselves
  const glazed = /loft/.test(meta.level ?? RUN);
  if (glazed || hasMaps) {
    const side = hasMaps ? 512 : 256;
    const cube = new THREE.WebGLCubeRenderTarget(side, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
    probe = new THREE.CubeCamera(0.1, 400, cube);
    probe.position.set((area[0] + area[3]) / 2, (area[1] + area[4]) / 2, (area[2] + area[5]) / 2);
    scene.add(probe);
    probe.update(renderer, scene);   // before the glass joins the scene, and before the surfaces reflect: neither shows in it
    for (const m of [glassMat, levelMat]) {
      m.uniforms.tEnv.value = cube.texture;
      m.uniforms.uProbe.value.copy(probe.position);
    }
    glassMat.uniforms.uBoxMin.value.set(area[0], area[1], area[2]);
    glassMat.uniforms.uBoxMax.value.set(area[3], area[4], area[5]);
    // the room's faces, where the reflections sit
    levelMat.uniforms.uRoomMin.value.set(area[0] - 0.15, area[1], area[2] - 0.15);
    levelMat.uniforms.uRoomMax.value.set(area[3] + 0.15, area[4], area[5] + 0.15);
    // the blur of a rough surface's reflection, as a level of the cube map's smaller copies
    levelMat.uniforms.uEnvLod.value = Math.log2(side * 1.273) - 1;
  }
  // glass in the windows (the Loft's; another level has none here)
  if (glazed) {
    glass = new THREE.Mesh(makeGlass(LOFT_WINDOWS), glassMat);
    glass.renderOrder = 2;
    scene.add(glass);
  }
  // the walk: the run's player spots on the main floor
  const floor = area[1];
  const spots = meta.plan.points.map((p) => new THREE.Vector3(p[0], p[1], p[2])).filter((p) => Math.abs(p.y - 1.6 - floor) < 0.25).map((p) => p.setY(floor + EYE));
  path = buildPath(spots);
  pathLength = path.getLength();
  // you start at the spot a person can stand at that is nearest the middle of the room, facing down its length
  const middle = new THREE.Vector3((area[0] + area[3]) / 2, floor + EYE, (area[2] + area[5]) / 2);
  position.copy(spots.reduce((best, p) => (p.distanceTo(middle) < best.distanceTo(middle) ? p : best)));
  state.yaw = area[3] - area[0] > area[5] - area[2] ? Math.PI / 2 : 0;
  resize();
  msg.remove();
  hud.hidden = false;
  const walkNotes = mountWalkNotesShell({
    sceneKind: 'loft',
    getSnapshot: () => ({ pos: position, on: { ...on }, meta, hasMaps, focus: state.focus, runId: RUN }),
  });
  window.demo = { state, on, path, camera, position, keys, pace, get length() { return pathLength; }, get scale() { return scale; }, get size() { return [rt.w, rt.h]; },
    // milliseconds a frame costs to draw, the screen's refresh aside: n frames one after the other, then wait for the graphics card
    bench(n = 120, moving = true) {
      const gl = renderer.getContext(), px = new Uint8Array(4);
      const wait = () => { renderer.setRenderTarget(null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
      render(0.016); wait();
      const t = performance.now();
      for (let i = 0; i < n; i++) {
        if (moving) { camera.rotation.y += (i % 2 ? 1 : -1) * 0.004; camera.updateMatrixWorld(true); }   // as when looking about
        render(0.016);
      }
      wait();
      return (performance.now() - t) / n;
    } };
  let last = performance.now(), last0 = last;
  renderer.setAnimationLoop((now) => {
    const dt = THREE.MathUtils.clamp((now - last) / 1000, 0, 0.1);
    last = now;
    state.time += dt;
    updateCamera(dt);
    autofocus(dt);
    render(dt);
    govern(now - last0);
    last0 = now;
    if (frame % 10 === 0) {
      drawHud();
      walkNotes.tick();
    }
  });
}

window.addEventListener('resize', resize);
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  keys.add(k);
  const toggle = { h: 'hdr', l: 'lens', f: 'dof', b: 'blur', g: 'film', p: 'glass', m: 'maps', x: 'clay', k: 'aa', t: 'tour' }[k];
  if (toggle && !e.repeat) {
    on[toggle] = !on[toggle];
    if (toggle === 'tour' && on.tour) {
      // the tour sets off from the point of its loop nearest to where you stand
      let best = 0, bestD = Infinity;
      for (let i = 0; i < 400; i++) { const d = path.getPointAt(i / 400).distanceTo(position); if (d < bestD) { bestD = d; best = i / 400; } }
      state.dist = best * pathLength;
    }
  }
  if (['w', 'a', 's', 'd', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());
const look = (dx, dy) => {
  if (on.tour) return;
  state.yaw -= dx * 0.0024;
  state.pitch = THREE.MathUtils.clamp(state.pitch - dy * 0.0024, -1.3, 1.3);
};
let drag = false;
canvas.addEventListener('click', () => {
  // where the page may not take the mouse (an embedded pane), dragging still looks
  if (!document.pointerLockElement) try { Promise.resolve(canvas.requestPointerLock?.()).catch(() => {}); } catch { /* not allowed here */ }
});
canvas.addEventListener('pointerdown', () => { drag = true; });
window.addEventListener('pointerup', () => { drag = false; });
window.addEventListener('mousemove', (e) => { if (document.pointerLockElement === canvas || drag) look(e.movementX, e.movementY); });

start().catch((e) => { msg.textContent = `could not load run "${RUN}": ${e.message}`; console.error(e); });
