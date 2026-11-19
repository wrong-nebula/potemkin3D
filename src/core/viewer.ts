/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OUTDOOR, sunDirection, type Lighting } from './clay';
import { aoImage, type AoMap } from './ao';
import { ATLAS_GLSL } from './atlas';
import type { Engine } from './engine';
import type { PbrMaps } from './pbr';
import { SkyDome } from './sky';
import type { ViewSpec } from './views';
import { makeCamera, viewDirection } from './views';
import { WalkControls, Walker } from './walk';
import { loadFloorDetail, installFloorDetail, type FloorDetail, type FloorDetailSpec } from './floor-detail';
import { MATERIAL_PRESETS } from './material-presets';
import { weightOverlayColors, type SurfaceWeights, type WeightOverlayKind } from './surface-weights';

export const ACCENT = new THREE.Color('#E5E5E5');
export const PINK = ACCENT;

/**
 * Display of the level: lit clay underneath, the painted texture on top (unpainted texels show the clay).
 * During a reveal, texels changed by the newest views sweep in from `revealOrigin` with a pink leading edge.
 */
const TEX_VERT = /* glsl */ `
out vec2 vUv;
out vec3 vWorld;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const TEX_FRAG = /* glsl */ `
uniform highp sampler2DArray atlas;
uniform highp sampler2DArray before;
uniform float useBefore;
uniform vec3 revealOrigin;
uniform float revealRadius;
uniform float revealBand;
uniform vec3 accent;
in vec2 vUv;
in vec3 vWorld;
layout(location = 0) out vec4 outColor;
${ATLAS_GLSL}
void main() {
  vec4 a = atlasTexel(atlas, vUv);
  if (useBefore < 0.5) {
    if (a.a <= 0.0) discard;
    outColor = vec4(a.rgb, 1.0);
    return;
  }
  vec4 b = atlasTexel(before, vUv);
  if (a.a <= 0.0 && b.a <= 0.0) discard;
  float d = length(vWorld - revealOrigin);
  float t = clamp((revealRadius - d) / revealBand, 0.0, 1.0);
  bool changed = distance(a, b) > 0.002;
  vec3 col = b.a > 0.0 ? mix(b.rgb, a.rgb, t) : a.rgb;
  float alpha = b.a > 0.0 ? 1.0 : t;
  float edge = changed ? smoothstep(0.0, 0.5, t) * (1.0 - smoothstep(0.5, 1.0, t)) : 0.0;
  col = mix(col, accent, 0.55 * edge);
  alpha = max(alpha, edge);
  if (alpha <= 0.001) discard;
  outColor = vec4(col, alpha);
}`;

export type DisplayMode = 'clay' | 'textured' | 'lit';
export type WeightOverlay = 'off' | WeightOverlayKind;

const WEIGHT_VERT = /* glsl */ `
in vec3 color;
out vec3 vColor;
out vec3 vNormal;
out vec3 vWorld;
void main() {
  vColor = color;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const WEIGHT_FRAG = /* glsl */ `
precision highp float;
in vec3 vColor;
in vec3 vNormal;
in vec3 vWorld;
layout(location = 0) out vec4 outColor;
void main() {
  vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  vec3 v = normalize(cameraPosition - vWorld);
  float shade = 0.68 + 0.22 * abs(dot(n, v)) + 0.10 * max(0.0, n.y);
  outColor = vec4(vColor * shade, 1.0);
}`;

/**
 * Lit display: the painted texture as albedo under the viewer's sun (with real shadows) and sky light, with the same
 * reveal sweep as the unlit display. Shares its uniforms with `texMaterial`.
 */
function litMaterial(uniforms: Record<string, THREE.IUniform>) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  m.defines = { USE_UV: '' };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = 'varying vec3 vRevealWorld;\n' + shader.vertexShader.replace('#include <project_vertex>',
      '#include <project_vertex>\n  vRevealWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = /* glsl */ `
uniform highp sampler2DArray atlas;
uniform highp sampler2DArray before;
uniform float useBefore;
uniform vec3 revealOrigin;
uniform float revealRadius;
uniform float revealBand;
uniform vec3 accent;
varying vec3 vRevealWorld;
${ATLAS_GLSL}
` + shader.fragmentShader.replace('#include <map_fragment>', /* glsl */ `
  vec4 tA = atlasTexel(atlas, vUv);
  vec3 tCol = tA.rgb;
  float tAlpha = tA.a > 0.0 ? 1.0 : 0.0;
  if (useBefore > 0.5) {
    vec4 tB = atlasTexel(before, vUv);
    float t = clamp((revealRadius - length(vRevealWorld - revealOrigin)) / revealBand, 0.0, 1.0);
    float edge = distance(tA, tB) > 0.002 ? smoothstep(0.0, 0.5, t) * (1.0 - smoothstep(0.5, 1.0, t)) : 0.0;
    tCol = mix(tB.a > 0.0 ? mix(tB.rgb, tA.rgb, t) : tA.rgb, accent, 0.55 * edge);
    tAlpha = max(tB.a > 0.0 ? 1.0 : (tA.a > 0.0 ? t : 0.0), edge);
  }
  if (tAlpha < 0.5) discard;
  diffuseColor.rgb = sRGBTransferEOTF(vec4(tCol, 1.0)).rgb;`);
  };
  return m;
}

export class Viewer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 2000);
  readonly controls: OrbitControls;
  readonly sky = new SkyDome();
  readonly overlay = new THREE.Group();
  private readonly clayMesh: THREE.Mesh;
  private readonly texMesh: THREE.Mesh;
  readonly texMaterial: THREE.ShaderMaterial;
  private readonly litMat: THREE.MeshStandardMaterial;
  /** Lighting for the lit display (and, when set, for every mode); unset, clay previews what the models get. */
  displayLighting?: Lighting;
  private readonly sun = new THREE.DirectionalLight(0xfff4e6, 3);
  private readonly fill = new THREE.DirectionalLight(0xdfe6f0, 1);
  private readonly hemi = new THREE.HemisphereLight(0xc4d6f2, 0xa09e9a, 1);
  points?: THREE.Points;
  frusta?: THREE.LineSegments;
  mode: DisplayMode = 'clay';
  /** False-colour debug view of the geometry prepasses (core/surface-weights.ts); 'off' for normal display. */
  weightOverlay: WeightOverlay = 'off';
  private weightMesh?: THREE.Mesh;
  private weightGeo?: THREE.BufferGeometry;
  private weightMat?: THREE.ShaderMaterial;
  /** Show the AI-matched sky behind textured views (otherwise the flat clay sky colour). */
  aiSky = true;
  dirty = true;
  /** Set while walking the level in first person (see `startWalk`). */
  walker?: Walker;
  private walkControls?: WalkControls;
  private orbitPose?: { position: THREE.Vector3; target: THREE.Vector3; fov: number };
  private pbrTextures: THREE.DataTexture[] = [];
  private aoTexture?: THREE.DataTexture;
  /** Strength of the normal map in the lit display (0 = flat). */
  relief = 1;
  private floorDetail?: FloorDetail;
  private floorDetailRevision = -1;
  private floorDetailPaintHash?: string;
  private floorDetailRequest = 0;
  private removeFloorDetail?: () => void;
  private disposed = false;

  constructor(private readonly engine: Engine, private readonly dom: HTMLElement) {
    const { level, clay } = engine;
    this.clayMesh = new THREE.Mesh(level.geometry, clay.material);
    this.clayMesh.castShadow = this.clayMesh.receiveShadow = true;
    this.texMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: TEX_VERT, fragmentShader: TEX_FRAG, side: THREE.DoubleSide,
      transparent: true, depthWrite: false, depthFunc: THREE.LessEqualDepth,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      uniforms: {
        atlas: { value: engine.atlas.texture }, atlasGrid: { value: engine.atlas.grid }, before: { value: null }, useBefore: { value: 0 },
        revealOrigin: { value: new THREE.Vector3() }, revealRadius: { value: 0 }, revealBand: { value: 5 },
        accent: { value: new THREE.Vector3(PINK.r, PINK.g, PINK.b) },
      },
    });
    this.litMat = litMaterial(this.texMaterial.uniforms);
    this.texMesh = new THREE.Mesh(level.geometry, this.texMaterial);
    this.texMesh.renderOrder = 1;
    this.texMesh.visible = false;
    this.scene.add(this.sky.mesh, this.clayMesh, this.texMesh, this.overlay, this.sun, this.sun.target, this.fill,
      this.fill.target, this.hemi);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 2;
    this.syncLighting();
    const b = level.bounds;
    const c = b.getCenter(new THREE.Vector3());
    const r = b.getSize(new THREE.Vector3()).length() * 0.5;
    this.camera.position.set(c.x + r * 0.7, c.y + r * 0.6, c.z + r * 0.7);
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.target.copy(c);
    this.controls.update();
    this.controls.addEventListener('change', () => (this.dirty = true));
  }

  /** The lighting the display uses now: what the models get in clay mode, a sunny day for the lit display. */
  get lighting(): Lighting {
    return this.displayLighting ?? (this.mode === 'lit' ? OUTDOOR : this.engine.clay.lighting);
  }

  syncLighting() {
    const l = this.lighting;
    const sphere = this.engine.level.geometry.boundingSphere!;
    const dir = sunDirection(l);
    this.sun.intensity = l.sunIntensity;
    this.sun.position.copy(sphere.center).addScaledVector(dir, -sphere.radius * 2);
    this.sun.target.position.copy(sphere.center);
    const fillDir = new THREE.Vector3(-dir.x, Math.min(-0.2, dir.y * 0.3), -dir.z).normalize();
    this.fill.intensity = l.sunIntensity * l.bounce;
    this.fill.position.copy(sphere.center).addScaledVector(fillDir, -sphere.radius * 2);
    this.fill.target.position.copy(sphere.center);
    const cam = this.sun.shadow.camera as THREE.OrthographicCamera;
    cam.left = cam.bottom = -sphere.radius;
    cam.right = cam.top = sphere.radius;
    cam.near = 0.1;
    cam.far = sphere.radius * 4;
    cam.updateProjectionMatrix();
    this.sun.shadow.needsUpdate = true;
    this.hemi.intensity = l.skyIntensity;
    const skyU = (this.sky.mesh.material as THREE.ShaderMaterial).uniforms;
    skyU.fallbackTop.value = new THREE.Color(...l.sky);
    skyU.fallbackBottom.value = new THREE.Color(...l.sky).lerp(new THREE.Color(1, 1, 1), 0.55);   // haze toward the horizon
    this.dirty = true;
  }

  setMode(mode: DisplayMode) {
    this.mode = mode;
    const normal = this.weightOverlay === 'off';
    this.clayMesh.visible = normal;
    this.texMesh.visible = normal && mode !== 'clay';
    this.texMesh.material = mode === 'lit' ? this.litMat : this.texMaterial;
    this.texMesh.receiveShadow = mode === 'lit';
    this.sky.mesh.visible = normal && ((mode === 'textured' && this.aiSky) || mode === 'lit');
    (this.sky.mesh.material as THREE.ShaderMaterial).uniforms.has.value = mode === 'lit' ? 0 : this.sky.built ? 1 : 0;
    this.syncLighting();
    this.dirty = true;
  }

  /** Show a per-face geometry weight or semantic class map as false colour on the mesh, or 'off' to restore `mode`. */
  setWeightOverlay(overlay: WeightOverlay, weights?: SurfaceWeights) {
    this.weightOverlay = overlay;
    if (overlay === 'off' || !weights) {
      this.weightOverlay = 'off';
      if (this.weightMesh) this.weightMesh.visible = false;
      this.setMode(this.mode);
      return;
    }
    const src = this.engine.level.geometry;
    if (!this.weightMesh) {
      this.weightGeo = new THREE.BufferGeometry();
      this.weightMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: WEIGHT_VERT, fragmentShader: WEIGHT_FRAG, side: THREE.DoubleSide,
      });
      this.weightMesh = new THREE.Mesh(this.weightGeo, this.weightMat);
      this.scene.add(this.weightMesh);
    }
    this.weightGeo!.setAttribute('position', src.getAttribute('position'));
    this.weightGeo!.setAttribute('normal', src.getAttribute('normal'));
    this.weightGeo!.setAttribute('color', new THREE.BufferAttribute(weightOverlayColors(overlay, weights), 3));
    this.weightMesh.visible = true;
    this.clayMesh.visible = false;
    this.texMesh.visible = false;
    this.sky.mesh.visible = false;
    this.dirty = true;
  }

  /**
   * Use (or drop) predicted normal and roughness maps in the lit display. The maps follow glTF's conventions, so
   * the normal's Y is flipped here the way GLTFLoader flips it for meshes without tangents.
   */
  setPbr(maps: PbrMaps | undefined) {
    for (const t of this.pbrTextures) t.dispose();
    this.pbrTextures = [];
    const m = this.litMat;
    if (maps) {
      const make = (data: Uint8ClampedArray) => {
        const t = new THREE.DataTexture(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), maps.size, maps.size, THREE.RGBAFormat);
        t.generateMipmaps = true;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.anisotropy = this.engine.gpu.renderer.capabilities.getMaxAnisotropy();
        t.needsUpdate = true;
        this.pbrTextures.push(t);
        return t;
      };
      m.normalMap = make(maps.normal);
      const orm = make(maps.orm);
      m.roughnessMap = orm;
      m.metalnessMap = orm;
      m.roughness = 1;
      m.metalness = 1;
    } else {
      m.normalMap = m.roughnessMap = m.metalnessMap = null;
      m.roughness = 0.92;
      m.metalness = 0;
    }
    this.setRelief(this.relief);
    m.needsUpdate = true;
    this.dirty = true;
  }

  /** Use (or drop) the baked ambient occlusion in the lit display: it dims the sky light in corners and under things. */
  setAo(ao: AoMap | undefined) {
    this.aoTexture?.dispose();
    this.aoTexture = undefined;
    if (ao) {
      const t = new THREE.DataTexture(new Uint8Array(aoImage(ao).buffer), ao.size, ao.size, THREE.RGBAFormat);
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.needsUpdate = true;
      this.aoTexture = t;
    }
    this.litMat.aoMap = this.aoTexture ?? null;
    this.litMat.needsUpdate = true;
    this.dirty = true;
  }

  setRelief(strength: number) {
    this.relief = strength;
    this.litMat.normalScale.set(strength, -strength);
    if (this.floorDetail) this.floorDetail.uniforms.floorRelief.value = strength;
    this.dirty = true;
  }

  /** Assign a reviewed material layer to this atlas. A failed or stale asynchronous load cannot replace it. */
  async setFloorDetail(spec?: FloorDetailSpec, expectedPaintHash?: string) {
    const request = ++this.floorDetailRequest;
    const revision = this.engine.atlas.revision;
    let paintHash: string | undefined;
    if (spec) {
      const pixels = this.engine.atlas.readBytes(undefined, this.engine.atlas.size, true).data;
      const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(pixels));
      paintHash = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
      if (expectedPaintHash && paintHash !== expectedPaintHash)
        throw new Error('Floor detail: preservation mask belongs to another painting or atlas resolution');
    }
    const detail = spec ? await loadFloorDetail(spec, this.engine.level, this.engine.atlas.size,
      Math.min(8, this.engine.gpu.renderer.capabilities.getMaxAnisotropy())) : undefined;
    if (request !== this.floorDetailRequest || this.disposed || revision !== this.engine.atlas.revision) {
      detail?.dispose();
      if (request === this.floorDetailRequest && !this.disposed) throw new Error('Paint changed while the floor material was loading');
      return;
    }
    this.removeFloorDetail?.(); this.removeFloorDetail = undefined;
    this.floorDetail?.dispose(); this.floorDetail = detail;
    this.floorDetailRevision = revision;
    this.floorDetailPaintHash = paintHash;
    if (detail) {
      detail.setResponse(MATERIAL_PRESETS[this.engine.materialPresets[detail.spec.label]]);
      detail.uniforms.floorRelief.value = this.relief;
      this.removeFloorDetail = installFloorDetail(this.litMat, detail);
    }
    this.dirty = true;
  }

  get floorDetailState() {
    const d = this.floorDetail, stale = !!d && this.engine.atlas.revision !== this.floorDetailRevision;
    return { available: !!d, enabled: !!d?.enabled && !stale, stale, label: d?.spec.label,
      textureBytes: d?.textureBytes ?? 0 };
  }

  /** Portable run metadata; stale masks are never saved as usable material layers. */
  get floorDetailSettings() {
    const d = this.floorDetail;
    if (!d || this.floorDetailState.stale) return undefined;
    const portable = (url: string) => {
      const absolute = new URL(url, location.href);
      return absolute.origin === location.origin ? absolute.pathname + absolute.search : absolute.href;
    };
    return { spec: { ...d.spec, packedUrl: portable(d.spec.packedUrl), protectUrl: portable(d.spec.protectUrl),
      statisticsUrl: portable(d.spec.statisticsUrl) }, enabled: d.enabled, paintHash: this.floorDetailPaintHash };
  }

  setFloorDetailEnabled(enabled: boolean) {
    if (enabled && this.floorDetailState.stale) throw new Error('Floor detail is paused because the paint changed; load a newly reviewed mask first');
    if (this.floorDetail) this.floorDetail.enabled = enabled;
    this.dirty = true;
  }

  syncMaterialResponses() {
    if (this.floorDetail) this.floorDetail.setResponse(MATERIAL_PRESETS[this.engine.materialPresets[this.floorDetail.spec.label]]);
    this.dirty = true;
  }

  /** Read-only validation views; normal display is 'off'. */
  setFloorDetailDebug(mode: 'off' | 'albedo' | 'protected') {
    if (this.floorDetail) this.floorDetail.uniforms.floorDebug.value = { off: 0, albedo: 1, protected: 2 }[mode];
    this.dirty = true;
  }

  /** Pink markers for player points and planned cameras. */
  showPlan(points: THREE.Vector3[], views: ViewSpec[], scale = 0.9, color: THREE.ColorRepresentation = PINK) {
    this.clearOverlay();
    const isObject = this.engine.level.mode === 'object';
    const markerScale = isObject ? Math.max(0.08, Math.min(0.9, this.engine.level.bounds.getSize(new THREE.Vector3()).length() * 0.14)) : scale;
    this.points = new THREE.Points(new THREE.BufferGeometry().setFromPoints(points.map((p) => (isObject ? p.clone() : p.clone().setY(p.y - 1.6)))),
      new THREE.PointsMaterial({ color, size: 7, sizeAttenuation: false, depthTest: true }));
    this.overlay.add(this.points);
    const segs: number[] = [];
    for (const v of views) frustumSegments(v, markerScale, segs);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
    this.frusta = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 }));
    this.overlay.add(this.frusta);
    this.dirty = true;
  }

  /** Show only the first `points` markers and `frusta` cameras (for staged reveals). */
  setOverlayCounts(points: number, frusta: number) {
    this.points?.geometry.setDrawRange(0, Math.max(0, Math.floor(points)));
    this.frusta?.geometry.setDrawRange(0, Math.max(0, Math.floor(frusta)) * 24);
    this.dirty = true;
  }

  clearOverlay() {
    for (const o of [...this.overlay.children]) {
      this.overlay.remove(o);
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material)?.dispose();
    }
    this.points = undefined;
    this.frusta = undefined;
    this.dirty = true;
  }

  /**
   * Walk the level in first person from `eye` (a player's eye position, e.g. one of the plan's points). WASD or the
   * arrows move, Shift runs, Space jumps, the mouse looks; `onExit` runs when the walk ends (Esc).
   */
  startWalk(eye: THREE.Vector3, yaw = 0, onExit?: () => void) {
    this.stopWalk();
    const { level } = this.engine;
    this.orbitPose = { position: this.camera.position.clone(), target: this.controls.target.clone(), fov: this.camera.fov };
    this.walker = new Walker(level.bvh, level.bounds);
    this.walker.place(new THREE.Vector3(eye.x, eye.y - this.walker.options.eyeHeight, eye.z), yaw);
    this.controls.enabled = false;
    this.walkControls = new WalkControls(this.walker, this.dom, () => { this.stopWalk(); onExit?.(); });
    this.camera.fov = 75;
    this.camera.updateProjectionMatrix();
    this.walker.applyTo(this.camera);
    this.dirty = true;
    return this.walker;
  }

  stopWalk() {
    if (!this.walker) return;
    this.walkControls?.dispose();
    this.walkControls = undefined;
    this.walker = undefined;
    this.controls.enabled = true;
    if (this.orbitPose) {
      this.camera.position.copy(this.orbitPose.position);
      this.controls.target.copy(this.orbitPose.target);
      this.camera.fov = this.orbitPose.fov;
      this.camera.updateProjectionMatrix();
      this.controls.update();
    }
    this.dirty = true;
  }

  /** Per-frame update: moves the walker (if any). `dt` in seconds. */
  tick(dt: number) {
    if (!this.walker) return;
    this.walker.step(dt);
    this.walker.applyTo(this.camera);
    this.dirty = true;
  }

  dispose() {
    this.disposed = true; this.floorDetailRequest++;
    this.removeFloorDetail?.(); this.floorDetail?.dispose(); this.floorDetail = undefined;
    this.stopWalk();
    this.clearOverlay();
    this.setPbr(undefined);
    this.setAo(undefined);
    this.sun.shadow.dispose();
    this.texMaterial.dispose();
    this.litMat.dispose();
    this.weightGeo?.dispose();
    this.weightMat?.dispose();
    this.sky.dispose();
    this.controls.dispose();
  }

  goTo(spec: ViewSpec) {
    const cam = makeCamera(spec);
    this.camera.position.copy(cam.position);
    this.controls.target.copy(cam.position).add(viewDirection(spec).multiplyScalar(3));
    this.controls.update();
    this.dirty = true;
  }

  resize(w: number, h: number) {
    this.engine.gpu.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  render(camera: THREE.Camera = this.camera) {
    if (this.floorDetail) this.floorDetail.uniforms.floorEnabled.value =
      this.floorDetailState.enabled && this.texMaterial.uniforms.useBefore.value < .5 ? 1 : 0;
    const r = this.engine.gpu.renderer;
    r.setRenderTarget(null);
    const showingWeights = this.weightOverlay !== 'off';
    r.toneMapping = showingWeights ? THREE.NoToneMapping : THREE.NeutralToneMapping;
    r.toneMappingExposure = showingWeights ? 1 : this.lighting.exposure;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.autoClear = true;
    r.setClearColor(showingWeights ? new THREE.Color(0x161822) : new THREE.Color(...this.lighting.sky), 1);
    r.render(this.scene, camera);
    r.toneMapping = THREE.NoToneMapping;
    this.dirty = false;
  }
}

/** Line segments drawing a small camera frustum for a view (24 vertices each). */
export function frustumSegments(v: ViewSpec, scale: number, out: number[]) {
  const cam = makeCamera(v);
  const o = cam.position;
  const h = Math.tan(THREE.MathUtils.degToRad(v.fov / 2)) * scale;
  const corners = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, y]) =>
    new THREE.Vector3(x, y, -scale).applyMatrix4(cam.matrixWorld));
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    out.push(o.x, o.y, o.z, a.x, a.y, a.z, a.x, a.y, a.z, b.x, b.y, b.z);
  }
}
