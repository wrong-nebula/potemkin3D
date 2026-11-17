/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import * as THREE from 'three';
import { ATLAS_GLSL } from './atlas';
import { floatTarget, passMaterial, type Gpu } from './gpu';
import type { Level } from './scene';

/** A camera the pipeline renders and paints from. Yaw 0 looks down -Z; pitch is up from the horizon. */
export interface ViewSpec {
  id: number;
  position: [number, number, number];
  yaw: number;    // radians
  pitch: number;  // radians
  fov: number;    // vertical = horizontal (square images), degrees
  /** Where the camera came from: a player's view (default), the aerial rings, a close pass over the roofs, a pass
   *  straight down over the ground players walk on, a final pass that only fills texels nothing has painted, or a
   *  clean-up pass aimed at what is unpainted or poorly captured. */
  kind?: 'ground' | 'aerial' | 'roof' | 'floor' | 'fill' | 'clean';
  /** For a floor view: the height (y) of the ground it looks down at. */
  floor?: number;
  /** A second go, from the same camera, at faces the model painted over the first time (core/fidelity.ts). */
  again?: boolean;
}

export function viewDirection(v: Pick<ViewSpec, 'yaw' | 'pitch'>): THREE.Vector3 {
  const cp = Math.cos(v.pitch);
  return new THREE.Vector3(-Math.sin(v.yaw) * cp, Math.sin(v.pitch), -Math.cos(v.yaw) * cp);
}

/** A camera at `from` looking at `at`. */
export function lookAt(from: THREE.Vector3, at: THREE.Vector3, fov: number, id = 0): ViewSpec {
  const d = at.clone().sub(from).normalize();
  return { id, position: from.toArray() as [number, number, number], yaw: Math.atan2(-d.x, -d.z), pitch: Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)), fov };
}

export function makeCamera(v: ViewSpec, aspect = 1, near = 0.05, far = 2000): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(v.fov, aspect, near, far);
  cam.position.set(...v.position);
  cam.lookAt(cam.position.clone().add(viewDirection(v)));
  cam.updateMatrixWorld(true);
  return cam;
}

/** Writes per-pixel world position + distance, normal + geometry flag, and UV + capture quality. */
const GEOMETRY_VERT = /* glsl */ `
in float label;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUv;
flat out float vLabel;
void main() {
  vLabel = label;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const GEOMETRY_FRAG = /* glsl */ `
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUv;
flat in float vLabel;
layout(location = 0) out vec4 gPos;
layout(location = 1) out vec4 gNrm;
layout(location = 2) out vec4 gUvq;
void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  float cosv = dot(n, toCam / dist);
  gPos = vec4(vWorld, dist);
  gNrm = vec4(n, vLabel + 1.0);   // a > 0.5 means geometry; a - 1 is the part label
  gUvq = vec4(vUv, cosv / max(dist, 0.5), cosv);
}`;

/** Composites what a view's image model sees: known texels in colour, the rest as lit clay. */
const STATE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D clay;
uniform sampler2D gNrm;
uniform sampler2D gUvq;
uniform highp sampler2DArray atlas;
uniform float ratio;
uniform float cap;
in vec2 vUv;
layout(location = 0) out vec4 outState;
layout(location = 1) out vec4 outMask;
${ATLAS_GLSL}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  bool geo = texelFetch(gNrm, p, 0).a > 0.5;
  vec4 uvq = texelFetch(gUvq, p, 0);
  vec4 a = geo ? atlasTexel(atlas, uvq.xy) : vec4(0.0);
  // cap: the capture quality at which the texture holds all the detail it can; a view that could do better
  // than that still finds such texels good enough
  bool known = geo && a.a > 0.0003 && a.a >= ratio * min(uvq.z, cap);   // 0.0003: the finishing fill is not paint
  outState = known ? vec4(a.rgb, 1.0) : texelFetch(clay, p, 0);
  outMask = vec4(geo ? 1.0 : 0.0, known ? 1.0 : 0.0, geo && a.a > 0.0003 ? 1.0 : 0.0, 1.0);   // b: painted at all (by a view)
}`;

const VALIDATION_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D gNrm;
uniform sampler2D gUvq;
uniform highp sampler2DArray atlas;
layout(location = 0) out vec4 appearance;
layout(location = 1) out vec4 coverage;
${ATLAS_GLSL}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  bool geo = texelFetch(gNrm, p, 0).a > 0.5;
  vec4 a = geo ? atlasTexel(atlas, texelFetch(gUvq, p, 0).xy) : vec4(0.0);
  appearance = vec4(geo ? (a.a > 0.0 ? a.rgb : vec3(0.5)) : vec3(0.075), 1.0);
  coverage = vec4(geo ? 1.0 : 0.0, a.a > 0.0003 ? 1.0 : 0.0, a.a > 0.0 && a.a <= 0.0003 ? 1.0 : 0.0, 1.0);
}`;

export class ViewRenderer {
  readonly geometryScene = new THREE.Scene();
  readonly geometryTarget: THREE.WebGLRenderTarget;
  readonly stateTarget: THREE.WebGLRenderTarget;
  private readonly stateMaterial: THREE.ShaderMaterial;
  private readonly validationMaterial: THREE.ShaderMaterial;

  constructor(private readonly gpu: Gpu, level: Level, readonly size = 1024) {
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: GEOMETRY_VERT, fragmentShader: GEOMETRY_FRAG, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(level.geometry, mat);
    mesh.frustumCulled = false;
    this.geometryScene.add(mesh);
    this.geometryTarget = floatTarget(size, size, { count: 3, depth: true });
    this.stateTarget = new THREE.WebGLRenderTarget(size, size, {
      count: 2, type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, generateMipmaps: false,
    });
    this.stateMaterial = passMaterial(STATE_FRAG, {
      clay: { value: null }, gNrm: { value: null }, gUvq: { value: null }, atlas: { value: null }, atlasGrid: { value: 1 }, ratio: { value: 0.4 }, cap: { value: 1e9 },
    });
    this.validationMaterial = passMaterial(VALIDATION_FRAG, {
      gNrm: { value: this.geometryTarget.textures[1] }, gUvq: { value: this.geometryTarget.textures[2] },
      atlas: { value: null }, atlasGrid: { value: 1 },
    });
  }

  /** Geometry buffers for a camera, into `target` (defaults to the view-sized MRT target). */
  renderGeometry(camera: THREE.Camera, target = this.geometryTarget) {
    this.gpu.draw(this.geometryScene, camera, target, 0x000000, 0);
  }

  /**
   * State image + mask for the current geometry buffers. Returns top-down RGBA8 arrays.
   * @param clay the view as lit clay; null where only the mask is wanted (the state then shows clay as black)
   * @param atlas the level's texture (core/atlas.ts): its pages and how many a side
   */
  renderState(clay: THREE.Texture | null, atlas: { texture: THREE.Texture; grid: number }, ratio: number, cap = 1e9) {
    const u = this.stateMaterial.uniforms;
    u.clay.value = clay ?? this.geometryTarget.textures[1];
    u.gNrm.value = this.geometryTarget.textures[1];
    u.gUvq.value = this.geometryTarget.textures[2];
    u.atlas.value = atlas.texture;
    u.atlasGrid.value = atlas.grid;
    u.ratio.value = ratio;
    u.cap.value = cap;
    this.gpu.pass(this.stateMaterial, this.stateTarget);
    return {
      state: this.gpu.readU8(this.stateTarget, 0),
      mask: this.gpu.readU8(this.stateTarget, 1),
    };
  }

  /** Unlit appearance and separate geometry / observed / inferred flags, for repeatable evaluation. */
  renderValidation(atlas: { texture: THREE.Texture; grid: number }) {
    this.validationMaterial.uniforms.atlas.value = atlas.texture;
    this.validationMaterial.uniforms.atlasGrid.value = atlas.grid;
    this.gpu.pass(this.validationMaterial, this.stateTarget);
    return { color: this.gpu.readU8(this.stateTarget, 0), coverage: this.gpu.readU8(this.stateTarget, 1) };
  }

  dispose() {
    this.geometryTarget.dispose(); this.stateTarget.dispose();
    this.stateMaterial.dispose(); this.validationMaterial.dispose();
    for (const mesh of this.geometryScene.children) (mesh as THREE.Mesh<THREE.BufferGeometry, THREE.Material>).material.dispose();
  }
}
