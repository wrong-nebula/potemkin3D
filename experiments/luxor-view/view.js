// A walk through one exported level, filmed as the loft walk-through films its room.
// It loads ./level_2k.glb (or ./level_4k.glb with ?q=4k), both made by scripts/web_glb.py from a run's export.
//
// The level here is an albedo texture with normal and roughness maps, so unlike the loft's painting it is lit for
// real: a sun with shadows, and the sky as its other light (the surfaces reflect it by their roughness). That frame
// is kept in scene-referred light and then goes through the loft's camera, pass for pass (film.js, cut out of
// src/demo/loftwalk.js): depth of field that focuses on what is in the middle of the frame, motion blur from the
// camera's own movement, bloom, the lens flare with its dirt, ghosts, halo and streaks, an exposure that adapts
// to what the camera looks at, the AgX curve, fringe, vignette and grain, and a little sharpening.
// The desert is this viewer's own (sand.js): sand lying and blowing on the surfaces, dust in the air, motes in the
// sun. So are the texture levels of detail (lod.js): the level comes up on small textures and the sharp ones are
// fetched for the pages the camera needs. And one pass is this viewer's own: a colour grade from a 3D LUT (luxor-gold.cube, made by make-lut.mjs, or any .cube
// file dropped on the page), laid over the finished frame before it is sharpened.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { LUTCubeLoader } from 'three/addons/loaders/LUTCubeLoader.js';
import { acceleratedRaycast, computeBoundsTree } from 'three-mesh-bvh';
import { markEdges } from './edges.js';
import { makePomAtlas, pomLayer, pomUniforms } from './pom.js';
import { TextureLod } from './lod.js';
import { DUST_FRAG, RAYS_FRAG, makeMotes, noise, sandLayer, sandUniforms } from './sand.js';
import { BLUR_FRAG, DOF_FRAG, DOWN_FRAG, FINAL_FRAG, FLARE_BLUR, FLARE_FEATURES, FLARE_STREAK, FLARE_THRESHOLD, LUM_FRAG, UP_FRAG, makeDirtTexture, mat } from './film.js';
import { mountWalkNotesShell } from '../../src/demo/walk-notes-shell.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const query = new URLSearchParams(location.search);
const canvas = document.getElementById('view');
const hud = document.getElementById('hud');
const msg = document.getElementById('msg');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
// drawn at the screen's own pixels (up to 2 a point), times a scale the governor lowers when frames run long
// (1.5 a point at most: on a dense screen the last half pixel costs a third of the frame and shows least)
const MAX_RATIO = Math.min(window.devicePixelRatio, Number(query.get('ratio')) || 1.5);
const FIXED = Number(query.get('res')) || 0;
let scale = FIXED || 1;
renderer.setPixelRatio(1);
renderer.autoClear = false;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const on = { hdr: true, lens: true, dof: true, blur: true, film: true, maps: true, dust: true, rays: true, chips: true, age: true, pom: query.get('pom') !== '0', pomShadow: query.get('pomShadow') !== '0' };
const pomDepth = Number(query.get('depth') ?? 0.025);
pomUniforms.uPomDepth.value = Number.isFinite(pomDepth) ? THREE.MathUtils.clamp(pomDepth, 0, 0.12) : 0.025;

// ---------------------------------------------------------------- the frame, pass by pass (as in loftwalk.js)
const NEAR = 0.05, FAR = 400;
const camera = new THREE.PerspectiveCamera(62, 1, NEAR, FAR);
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
  // four samples a pixel for the geometry's edges; two when the frame is large, where edges are finer anyway
  const sceneRT = target(w, h, { depthBuffer: true, depthTexture: new THREE.DepthTexture(w, h, THREE.UnsignedIntType), samples: w * h > 1.6e6 ? 2 : 4 });
  const mips = Array.from({ length: 6 }, (_, k) => target(w / 2 ** (k + 1), h / 2 ** (k + 1)));
  const ups = Array.from({ length: 5 }, (_, k) => target(w / 2 ** (k + 1), h / 2 ** (k + 1)));
  rt = { w, h, scene: sceneRT, dust: target(w, h), rays: target(w / 2, h / 2), dof: target(w, h), blur: target(w, h), mips, ups,
    ldr: new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false }),
    flareA: target(w / 4, h / 4), flareB: target(w / 4, h / 4), streakA: target(w / 4, h / 4), streakB: target(w / 4, h / 4), meter: target(w / 8, h / 8),
    lum: new THREE.WebGLRenderTarget(32, 32, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false }) };
  rt.all = [sceneRT, rt.ldr, rt.dust, rt.rays, rt.dof, rt.blur, ...mips, ...ups, rt.flareA, rt.flareB, rt.streakA, rt.streakB, rt.meter, rt.lum];
}
const texel = (t) => new THREE.Vector2(1 / t.width, 1 / t.height);
// (a camera that drifts by less than a pixel or so blurs nothing worth a pass)
const moved = (a, b) => a.elements.some((v, i) => Math.abs(v - b.elements[i]) > 1.2e-3);
function pass(material, to, values = {}) {
  for (const [k, v] of Object.entries(values)) {
    const u = material.uniforms[k];
    if (v?.isVector2 || v?.isVector3 || v?.isMatrix4 || v?.isColor) u.value.copy(v); else u.value = v;
  }
  quad.material = material;
  renderer.setRenderTarget(to);
  renderer.render(quadScene, quadCam);
}
// The last pass, two things in one draw: the finished frame is sharpened a little (the loft's SHARP_FRAG, after AMD's
// contrast-adaptive sharpening), and each colour is then looked up in a cube of colours (a .cube LUT), blended in by
// `uAmount`. As two passes they cost a full frame's worth of reading and writing more.
const GRADE_FRAG = /* glsl */ `
precision highp sampler3D;
uniform sampler2D tSrc; uniform sampler3D tLut; uniform vec2 uTexel; uniform float uSize, uAmount, uSharp;
varying vec2 vUv;
void main() {
  vec3 m = texture2D(tSrc, vUv).rgb;
  vec3 n = texture2D(tSrc, vUv + vec2(0.0, -uTexel.y)).rgb, s = texture2D(tSrc, vUv + vec2(0.0, uTexel.y)).rgb;
  vec3 w = texture2D(tSrc, vUv + vec2(-uTexel.x, 0.0)).rgb, e = texture2D(tSrc, vUv + vec2(uTexel.x, 0.0)).rgb;
  vec3 lo = min(m, min(min(n, s), min(w, e))), hi = max(m, max(max(n, s), max(w, e)));
  vec3 amp = sqrt(clamp(min(lo, 1.0 - hi) / max(hi, 1e-3), 0.0, 1.0));
  vec3 k = -amp * uSharp * 0.2;
  vec3 c = clamp((m + (n + s + w + e) * k) / (1.0 + 4.0 * k), 0.0, 1.0);
  // the cube's first and last entries sit at the centres of its outer texels
  vec3 g = uAmount > 0.0 ? texture(tLut, c * ((uSize - 1.0) / uSize) + 0.5 / uSize).rgb : c;
  gl_FragColor = vec4(mix(c, g, uAmount), 1.0);
}`;
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
  rays: mat(RAYS_FRAG, { tDepth: { value: null }, tShadow: { value: null }, uInvViewProj: { value: new THREE.Matrix4() }, uShadowMatrix: { value: new THREE.Matrix4() }, uCam: { value: new THREE.Vector3() },
    uReach: { value: 70 }, uFrame: { value: 0 } }),
  dust: mat(DUST_FRAG, { tSrc: { value: null }, tDepth: { value: null }, tRays: { value: null }, uRaysTexel: { value: new THREE.Vector2() }, uShafts: { value: 0 }, uInvViewProj: { value: new THREE.Matrix4() }, uCam: { value: new THREE.Vector3() }, uSun: { value: new THREE.Vector3(0, 1, 0) },
    uDustColor: { value: new THREE.Color(2.3, 1.85, 1.3) }, uDensity: { value: 0.006 }, uTime: { value: 0 }, uFar: { value: 220 }, tNoise: { value: noise }, uHeat: { value: 1 } }),
  grade: mat(GRADE_FRAG, { tSrc: { value: null }, tLut: { value: null }, uTexel: { value: new THREE.Vector2() }, uSize: { value: 33 }, uAmount: { value: 0 }, uSharp: { value: 0.8 } }),
  final: mat(FINAL_FRAG, { tSrc: { value: null }, tBloom: { value: null }, tBloomWide: { value: null }, tDirt: { value: makeDirtTexture() }, tFlare: { value: null },
    tStreak: { value: null }, tStreakCore: { value: null }, uRes: { value: new THREE.Vector2() }, uExposure: { value: 1 }, uBloomI: { value: 0.018 }, uDirtI: { value: 0.06 },
    uFlareI: { value: 0.5 }, uStreakI: { value: 0.12 }, uFlareDirt: { value: 1.5 }, uStreakTint: { value: new THREE.Color(0.55, 0.75, 1.0) }, uCA: { value: 0.012 },
    uVignette: { value: 0.8 }, uGrain: { value: 0.022 }, uTime: { value: 0 }, uLens: { value: 1 }, uFilm: { value: 1 } }),
};

// ---------------------------------------------------------------- the light: a sky, and a sun in it
// The sky is several stops over the stone in shade and the sun's disc far over that, as outdoors: that is what the
// exposure works against and what the lens flares on.
const SKY_GLSL = /* glsl */ `
uniform vec3 uSun; uniform float uDisc; uniform sampler2D tNoise;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, 0.0, 1.0);
  vec3 c = mix(vec3(1.05, 1.0, 0.92) * 2.2, vec3(0.26, 0.48, 1.0) * 1.5, pow(h, 0.45));
  // the ground's own light, for what faces down: sunlit sand and paving
  c = mix(vec3(0.95, 0.76, 0.52) * 1.6, c, smoothstep(-0.06, 0.04, d.y));
  // a few high, thin clouds, drawn out along the wind; none near the horizon, where the dust is
  vec2 over = d.xz / (d.y + 0.18);
  float cirrus = smoothstep(0.50, 0.78, texture2D(tNoise, over * vec2(0.035, 0.012) + 0.21).r * 0.65 + texture2D(tNoise, over * vec2(0.16, 0.05)).g * 0.35);
  c = mix(c, vec3(2.9, 2.75, 2.55), cirrus * 0.42 * smoothstep(0.06, 0.35, d.y));
  float s = dot(d, normalize(uSun));
  c += vec3(1.0, 0.86, 0.62) * (0.9 * pow(max(s, 0.0), 24.0) + 5.0 * pow(max(s, 0.0), 900.0));   // the glow round the sun
  c += vec3(1.0, 0.95, 0.85) * 420.0 * smoothstep(0.99990, 0.99996, s) * uDisc;                  // its disc
  gl_FragColor = vec4(c, 1.0);
}`;
const skyUniforms = { uSun: { value: new THREE.Vector3(0, 1, 0) }, uDisc: { value: 1 }, tNoise: { value: noise } };
const skyMat = () => new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false, toneMapped: false, uniforms: skyUniforms, fragmentShader: SKY_GLSL,
  vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0); }' });
const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), skyMat());
sky.frustumCulled = false;
scene.add(sky);
const pmrem = new THREE.PMREMGenerator(renderer);
let envRT = null;
/** The sky as the level's other light: blurred by roughness, so smooth stone mirrors it and rough stone is washed by it. */
function lightFromSky() {
  const only = new THREE.Scene();
  only.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyMat()));
  skyUniforms.uDisc.value = 0;   // the disc is the sun lamp's job; in the sky's light it would only make fireflies
  const next = pmrem.fromScene(only, 0, 0.1, 100);
  skyUniforms.uDisc.value = 1;
  envRT?.dispose();
  envRT = next;
  scene.environment = envRT.texture;
}
const sun = new THREE.DirectionalLight(0xfff1dc, 26);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);

let level = null;
const materials = [];
const centre = new THREE.Vector3(), size = new THREE.Vector3();
function placeSun() {
  const az = THREE.MathUtils.degToRad(sunAz), el = THREE.MathUtils.degToRad(sunEl);
  const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  const reach = Math.max(size.x, size.z, 40) * 0.75;
  sun.position.copy(centre).addScaledVector(dir, reach * 2);
  sun.target.position.copy(centre);
  const c = sun.shadow.camera;
  c.left = c.bottom = -reach; c.right = c.top = reach; c.near = 1; c.far = reach * 4;
  c.updateProjectionMatrix();
  const low = 1 - THREE.MathUtils.smoothstep(Math.sin(el), 0.15, 0.6);   // a low sun is warmer and weaker
  sun.color.setRGB(1, 0.945 - 0.2 * low, 0.86 - 0.42 * low);
  sun.intensity = 26 - 12 * low;
  skyUniforms.uSun.value.copy(dir);
  // nothing in the level moves, so its shadows are drawn once for each place the sun is put, not every frame
  sun.shadow.needsUpdate = true;
  // the sky's light is worked out again a moment after the sun stops moving (it is slow, and changes little)
  skyDue = envRT ? performance.now() + 250 : 0;
  if (!envRT) lightFromSky();
}
sun.shadow.autoUpdate = false;

// ---------------------------------------------------------------- the walk
const EYE = 1.65, STEP = 0.74, CLIMB = 0.6;
const BASE_EXPOSURE = 0.17;   // the exposure for sunlit stone, which the meter's reading is shown against
const state = { yaw: 0, pitch: 0, focus: 6, exposure: BASE_EXPOSURE, time: 0, stride: 0, speed: 0 };
const position = new THREE.Vector3(), velocity = new THREE.Vector3();
const keys = new Set();
const prevViewProj = new THREE.Matrix4(), viewProj = new THREE.Matrix4(), invViewProj = new THREE.Matrix4();
const lumPixels = new Float32Array(32 * 32 * 4);
let frame = 0, metering = false, flying = false;
const grade = { lut: null, amount: 0.5 };
const dust = { amount: 0.75 };
const RAYS = 2.4;   // how far over the dust's own light the shafts stand
let exposureEV = 0.6, lod = null, sunAz = 60, sunEl = 30, skyDue = 0;
const motes = makeMotes();
scene.add(motes);
const ray = new THREE.Raycaster();
ray.firstHitOnly = true;

function stand(x, y, z, toX, toY, toZ, fly = false) {
  position.set(x, y, z);
  velocity.set(0, 0, 0);
  const d = new THREE.Vector3(toX - x, toY - y, toZ - z).normalize();
  state.yaw = Math.atan2(-d.x, -d.z);
  state.pitch = Math.asin(d.y);
  flying = fly;
}
/** Whether the walker, a body 35 cm round, can move `step` along the unit direction `d` from `from` (loftwalk.js's test). */
function free(from, d, step) {
  for (const h of [-0.2, -0.75, -(EYE - CLIMB - 0.05)]) {
    ray.set(new THREE.Vector3(from.x, from.y + h, from.z), d);
    ray.far = step + 0.35;
    if (ray.intersectObject(level, true).length) return false;
  }
  return true;
}
function updateCamera(dt) {
  const f = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
  const r = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
  const pace = flying ? 9 : 1.7;
  const want = new THREE.Vector3(-Math.sin(state.yaw) * f + Math.cos(state.yaw) * r, 0, -Math.cos(state.yaw) * f - Math.sin(state.yaw) * r);
  if (want.lengthSq() > 0) want.normalize().multiplyScalar(keys.has('shift') ? 2 * pace : pace);
  // the body takes a moment to get going and to stop
  velocity.lerp(want, 1 - Math.exp(-dt * 9));
  for (const axis of ['x', 'z']) {
    const step = velocity[axis] * dt;
    if (Math.abs(step) < 1e-5) continue;
    const d = new THREE.Vector3(axis === 'x' ? Math.sign(step) : 0, 0, axis === 'z' ? Math.sign(step) : 0);
    if (flying || free(position, d, Math.abs(step))) position[axis] += step; else velocity[axis] = 0;
  }
  if (!flying) {
    // the feet follow the floor, up and down a step
    ray.set(new THREE.Vector3(position.x, position.y - EYE + CLIMB, position.z), new THREE.Vector3(0, -1, 0));
    ray.far = 2 * CLIMB + 0.4;
    const hit = ray.intersectObject(level, true)[0];
    if (hit) position.y += (hit.point.y + EYE - position.y) * Math.min(1, 12 * dt);
  }
  const speed = Math.hypot(velocity.x, velocity.z);
  const moving = flying ? 0 : Math.min(1, speed / 1.7);
  state.stride += (speed * dt / STEP) * Math.PI;
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
    ray.far = 80;
    const hit = ray.intersectObject(level, true)[0];
    if (hit) nearest = Math.min(nearest, hit.distance);
  }
  if (nearest === Infinity) nearest = 40;
  const rate = nearest < state.focus ? 5 : 2.2;   // focus pulls faster towards something near than it lets go of it
  state.focus += (nearest - state.focus) * (1 - Math.exp(-dt * rate));
}

function render(dt) {
  const { w, h } = rt;
  sandUniforms.uSandTime.value = state.time;
  sandUniforms.uSand.value = on.dust ? dust.amount : 0;
  sandUniforms.uChips.value = on.chips ? 1 : 0;
  sandUniforms.uAge.value = on.age ? 1 : 0;
  pomUniforms.uPomEnabled.value = on.pom && on.maps ? 1 : 0;
  pomUniforms.uPomShadow.value = on.pomShadow ? 0.8 : 0;
  motes.visible = on.dust && dust.amount > 0;
  const mu = motes.material.uniforms;
  mu.uTime.value = state.time; mu.uHeight.value = h; mu.uAmount.value = Math.min(1, dust.amount * 1.6);
  mu.uLight.value.copy(sun.color).multiplyScalar(0.12 * sun.intensity);
  renderer.setRenderTarget(rt.scene);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  renderer.render(scene, camera);

  viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const depth = rt.scene.depthTexture;
  let src = rt.scene;
  invViewProj.copy(viewProj).invert();
  if (on.dust && dust.amount > 0) {
    // the air's dust lies between the scene and the lens: it is in the frame before focus and bloom see it
    const shafts = on.rays && sun.shadow.map?.depthTexture ? 1 : 0;
    if (shafts) pass(M.rays, rt.rays, { tDepth: depth, tShadow: sun.shadow.map.depthTexture, uInvViewProj: invViewProj, uShadowMatrix: sun.shadow.matrix, uCam: camera.position, uFrame: frame % 64 });
    pass(M.dust, rt.dust, { tSrc: src.texture, tDepth: depth, tRays: rt.rays.texture, uRaysTexel: texel(rt.rays), uShafts: shafts * RAYS, uInvViewProj: invViewProj, uCam: camera.position,
      uSun: skyUniforms.uSun.value, uDensity: 0.012 * dust.amount, uTime: state.time });
    src = rt.dust;
  }
  // (Skipped when nothing in the frame would be blurred by a pixel: with the focus far off and nothing near, as it
  // mostly is out of doors, the pass would read twenty samples a pixel to change nothing.)
  const circle = 0.0045 * h;
  const blurred = (z) => circle * Math.abs(1 / state.focus - 1 / Math.max(z, 0.05));
  if (on.dof && Math.max(blurred(lod?.nearest ?? 1), blurred(lod?.farthest ?? 1e4)) > 0.8) {
    // the blur circle in pixels: a lens stopped down further than the loft's, as one is in sunlight
    pass(M.dof, rt.dof, { tSrc: src.texture, tDepth: depth, uTexel: texel(rt.scene), uFocus: state.focus, uCoc: circle, uMaxCoc: Math.max(4, h / 150), uFrame: frame % 64 });
    src = rt.dof;
  }
  if (on.blur && moved(viewProj, prevViewProj)) {
    pass(M.blur, rt.blur, { tSrc: src.texture, tDepth: depth, uInvViewProj: invViewProj, uPrevViewProj: prevViewProj, uShutter: 0.5 * Math.min(1, (1 / 60) / Math.max(dt, 1e-3)) * (dt > 0 ? 1 : 0) });
    src = rt.blur;
  }
  prevViewProj.copy(viewProj);

  // bloom pyramid; what counts as bright follows the exposure
  let from = src;
  const ex = Math.max(state.exposure, 0.02);
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
  // (The loft meters its bloom pyramid, which holds only what is over the bright pass's knee: right for a room whose
  // windows are the bright thing in it. Out of doors the whole frame is bright, so the frame itself is metered.)
  if (frame % 6 === 0 && !metering) {
    pass(M.down, rt.meter, { tSrc: src.texture, uTexel: texel(src).multiplyScalar(4), uKnee: 0 });
    pass(M.lum, rt.lum, { tSrc: rt.meter.texture });
    metering = true;
    renderer.readRenderTargetPixelsAsync(rt.lum, 0, 0, 32, 32, lumPixels).then(() => {
      let sum = 0, weight = 0;
      for (let i = 0; i < lumPixels.length; i += 4) { sum += lumPixels[i]; weight += lumPixels[i + 1]; }
      const average = Math.exp(sum / Math.max(weight, 1e-3));
      state.wantExposure = on.hdr ? THREE.MathUtils.clamp(0.24 * 2 ** exposureEV / average, 0.02, 4.0) : BASE_EXPOSURE;
    }).catch(() => {}).finally(() => { metering = false; });
  }
  // quicker to close down for brightness than to open up for the dark, as an eye and a camera are
  const want = state.wantExposure ?? state.exposure;
  state.exposure += (want - state.exposure) * (1 - Math.exp(-dt * (want < state.exposure ? 5 : 1.1)));

  pass(M.final, rt.ldr, { tSrc: src.texture, tBloom: rt.ups[0].texture, tBloomWide: rt.ups[3].texture, tFlare: B.texture, tStreak: S.texture, tStreakCore: T.texture,
    uRes: new THREE.Vector2(w, h), uExposure: state.exposure, uTime: state.time, uLens: on.lens ? 1 : 0, uFilm: on.film ? 1 : 0 });
  pass(M.grade, null, { tSrc: rt.ldr.texture, uTexel: texel(rt.ldr), tLut: grade.lut?.texture3D ?? null, uSize: grade.lut?.size ?? 33, uAmount: grade.lut ? grade.amount : 0 });
  frame++;
}

// Holds the frame rate (after loftwalk.js's governor): frames running long are drawn smaller, never under 0.6 of the
// screen. Two things differ from the loft's. Frames are not counted while the level is still arriving (textures going
// to the GPU stall a frame or two each, which says nothing about the renderer). And the way back up does not wait
// for time to spare, which a screen that caps at 60 never shows: when the frame rate has held at the screen's own
// for a while the size is tried one step larger, and if that does not hold it comes down again and waits longer.
const pace = { sum: 0, n: 0, fps: 60, since: 0, lastDrop: -1e9, patience: 6000 };
function govern(ms, now) {
  if (FIXED || !(ms > 0) || ms > 250 || lod?.status.loading || state.time < 4) { pace.sum = pace.n = 0; return; }
  pace.sum += ms; pace.n++; pace.since += ms;
  if (pace.n < 30) return;
  const mean = pace.sum / pace.n;
  pace.fps = 1000 / mean;
  pace.sum = pace.n = 0;
  if (pace.since < 1000) return;
  let want = scale;
  if (mean > 20) {
    want = Math.max(0.6, scale * 0.88);
    // a step up that had to be taken back: wait twice as long before the next try (up to a minute)
    if (now - pace.lastRaise < 4000) pace.patience = Math.min(60000, pace.patience * 2);
    pace.lastDrop = now;
  } else if (mean < 17.5 && scale < 1 && now - pace.lastDrop > pace.patience) {
    want = Math.min(1, scale * 1.07);
    pace.lastRaise = now;
  }
  if (Math.abs(want - scale) > 0.01) { scale = want; pace.since = 0; resize(); }
}

// ---------------------------------------------------------------- the keys and the read-out (as the loft has them)
const SPOTS = {
  1: ['the avenue', () => stand(0, EYE, 39, 0, 3.4, 24)],
  2: ['the court', () => stand(2.5, EYE, 13, -7, 2.6, 2)],
  3: ['the colonnade', () => stand(1.2, EYE, -3.5, -2.5, 6.5, -14)],
  4: ['from above', () => stand(centre.x + 30, 34, centre.z + 46, centre.x, 2, centre.z, true)],
  5: ['stone relief', () => stand(-11.7, EYE, 12, -13, 1.9, 8)],
};
function applyMaps() {
  for (const m of materials) {
    m.normalScale.setScalar(on.maps ? RELIEF : 0);
    m.roughnessMap = on.maps ? m.userData.rough : null;
    m.needsUpdate = true;
  }
}
const RELIEF = 1.35;   // how deep the normal map's carving is drawn (1: as the map has it)
const TOGGLE = { h: 'hdr', l: 'lens', f: 'dof', b: 'blur', g: 'film', m: 'maps', u: 'dust', r: 'rays', c: 'chips', o: 'age', p: 'pom', j: 'pomShadow' };
// held keys that turn a dial: [what, by how much a second, least, most]
const DIALS = { '[': ['ev', -1.2, -3, 3], ']': ['ev', 1.2, -3, 3], '-': ['dust', -0.45, 0, 1], '=': ['dust', 0.45, 0, 1],
  '9': ['depth', -0.02, 0, 0.12], '0': ['depth', 0.02, 0, 0.12],
  ',': ['az', -60, -1e9, 1e9], '.': ['az', 60, -1e9, 1e9], ';': ['el', -30, 6, 86], "'": ['el', 30, 6, 86] };
function turnDials(dt) {
  let sunMoved = false;
  for (const k of keys) {
    const d = DIALS[k];
    if (!d) continue;
    const by = d[1] * dt, clamp = (v) => Math.min(d[3], Math.max(d[2], v + by));
    if (d[0] === 'ev') exposureEV = clamp(exposureEV);
    else if (d[0] === 'dust') dust.amount = clamp(dust.amount);
    else if (d[0] === 'depth') pomUniforms.uPomDepth.value = clamp(pomUniforms.uPomDepth.value);
    else if (d[0] === 'az') { sunAz = (clamp(sunAz) + 360) % 360; sunMoved = true; }
    else { sunEl = clamp(sunEl); sunMoved = true; }
  }
  if (sunMoved) placeSun();
  if (skyDue && performance.now() > skyDue) { skyDue = 0; lightFromSky(); }
}
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  keys.add(k);
  const toggle = TOGGLE[k];
  if (toggle && !e.repeat) { on[toggle] = !on[toggle]; if (toggle === 'maps') applyMaps(); }
  if (SPOTS[k] && !e.repeat && level) SPOTS[k][1]();
  if (['w', 'a', 's', 'd', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', "'"].includes(k)) e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());
const look = (dx, dy) => {
  state.yaw -= dx * 0.0026;
  state.pitch = THREE.MathUtils.clamp(state.pitch - dy * 0.0026, -1.45, 1.45);
};
let drag = false;
canvas.addEventListener('click', () => { if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.(); });
canvas.addEventListener('pointerdown', () => { drag = true; });
window.addEventListener('pointerup', () => { drag = false; });
window.addEventListener('mousemove', (e) => { if (document.pointerLockElement === canvas || drag) look(e.movementX, e.movementY); });
window.addEventListener('resize', resize);

function drawHud() {
  const row = (key, label, flag = true) => `<span class="${flag ? '' : 'off'}"><b>${key}</b> ${label}</span>`;
  const tex = lod?.status;
  hud.innerHTML = [row('W A S D', 'walk · shift: run'), row('click', document.pointerLockElement ? 'mouse looks · esc releases it' : 'to look with the mouse (or drag)'),
    row('1 2 3 4 5', Object.values(SPOTS).map((s) => s[0]).join(' · ')),
    row('H', 'auto exposure', on.hdr), row('L', 'lens: bloom, dirt, flare', on.lens), row('F', 'auto-focus depth of field', on.dof),
    row('B', 'motion blur', on.blur), row('G', 'fringe, vignette, grain', on.film), row('M', 'materials: relief, roughness', on.maps),
    row('P', `carved depth (POM): ${Math.round(pomUniforms.uPomDepth.value * 1000)} mm`, on.pom && on.maps),
    row('9 0', 'shallower · deeper carving', on.pom && on.maps), row('J', 'shadows inside the carving', on.pomShadow && on.pom && on.maps),
    row('O', 'old stone: tone, streaks, dirt, dust film', on.age), row('C', 'worn and chipped edges', on.chips), row('U', 'sand and dust', on.dust), row('R', 'light shafts in the dust', on.rays && on.dust),
    row('[ ]', `exposure ${exposureEV >= 0 ? '+' : ''}${exposureEV.toFixed(1)} EV`), row('- =', `sand and dust ${Math.round(100 * dust.amount)}%`, on.dust),
    row(', .', `sun round ${Math.round(sunAz)}°`) + '   ' + row("; '", `sun up ${Math.round(sunEl)}°`)].join('\n') +
    `\nfocus ${state.focus.toFixed(1)} m · exposed ${Math.log2(state.exposure / BASE_EXPOSURE) >= 0 ? '+' : ''}${Math.log2(state.exposure / BASE_EXPOSURE).toFixed(1)} EV · ${Math.round(pace.fps)} fps at ${rt.w} × ${rt.h}` +
    (tex?.size ? ` · textures ${tex.size} px on ${tex.sharp}/${tex.pages} pages${tex.loading ? ' …' : ''}` : '') +
    (tex ? ` · height maps ${tex.heightPages}/${tex.pages}${tex.heightLoading ? ' loading' : tex.heightErrors.length ? ' unavailable' : ''}` : '');
}

// the grade: the viewer's own LUT (luxor-gold.cube, made by make-lut.mjs), at half strength
fetch('./luxor-gold.cube').then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status))))).then((text) => { grade.lut = new LUTCubeLoader().parse(text); }).catch(() => {});

resize();
SPOTS[1][1]();
new GLTFLoader().setKTX2Loader(new KTX2Loader().detectSupport(renderer)).load('./level_2k.glb', (gltf) => {
  level = gltf.scene;
  const aniso = renderer.capabilities.getMaxAnisotropy();
  // which edges can chip is worked out before anything else reads the geometry (it re-lays the triangles)
  const parts = [];
  level.traverse((o) => { if (o.isMesh) parts.push(o); });
  markEdges(parts);
  level.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = true;
    const islands = makePomAtlas(o.geometry);
    o.geometry.computeBoundsTree();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      for (const t of [m.map, m.normalMap, m.roughnessMap]) if (t) t.anisotropy = Math.min(8, aniso);
      m.userData.rough = m.roughnessMap;
      m.shadowSide = THREE.DoubleSide;
      m.envMapIntensity = 1;
      m.normalScale.setScalar(RELIEF);
      m.aoMapIntensity = 1.3;   // corners and wall feet a little darker than the baked occlusion alone
      sandLayer(m);
      pomLayer(m, islands);
      materials.push(m);
    }
  });
  scene.add(level);
  // the sharp textures come in page by page (?hi=2 lets fewer pages be sharp at once; ?hi=0 keeps the small ones)
  const meshes = [];
  level.traverse((o) => { if (o.isMesh) meshes.push(o); });
  lod = new TextureLod(renderer, camera, meshes, { budget: query.has('hi') ? Number(query.get('hi')) : 4 });
  new THREE.Box3().setFromObject(level).getCenter(centre);
  new THREE.Box3().setFromObject(level).getSize(size);
  placeSun();
  msg.remove();
  hud.hidden = false;
  walkNotes = mountWalkNotesShell({
    sceneKind: 'luxor',
    getSnapshot: () => ({
      pos: camera.position,
      on: { ...on },
      pomDepthMm: Math.round(pomUniforms.uPomDepth.value * 1000),
      lodStatus: lod?.status,
    }),
  });
}, (e) => {
  if (e.total) msg.textContent = `loading the temple… ${Math.round((100 * e.loaded) / e.total)}%`;
}, (e) => { msg.textContent = `the level did not load: ${e?.message ?? e}`; });

let walkNotes = null;
let last = performance.now();
renderer.setAnimationLoop((now) => {
  const ms = now - last, dt = Math.min(0.05, ms / 1000);
  last = now;
  state.time += dt;
  if (!level) return;
  turnDials(dt);
  updateCamera(dt);
  autofocus(dt);
  lod?.update(dt, rt.h);
  render(dt);
  govern(ms, now);
  if (frame % 15 === 0) {
    drawHud();
    walkNotes?.tick();
  }
});
window.luxorView = { camera, stand, state, on, grade, dust, pom: pomUniforms, lod: () => lod?.status, ready: () => !!level?.parent,
  snapshot: () => { updateCamera(0); render(0); return canvas.toDataURL('image/png'); },
  setSun: (az, el) => { sunAz = az; sunEl = el; placeSun(); } };   // for looking at it from scripts
