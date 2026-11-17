import * as THREE from 'three';
import { layoutHash } from './layout';
import type { Level } from './scene';
import type { MaterialResponse } from './material-presets';

/** An explicitly assigned, paint-masked material layer. Images use glTF's top-row = v0 convention. */
export interface FloorDetailSpec {
  label: string;
  /** The exact atlas layout the preservation mask was authored against. */
  layoutHash: string;
  packedUrl: string; // RGBA = linear luminance, roughness, height, tile region ID / 255
  protectUrl: string; // white protects the original material; black allows detail
  statisticsUrl: string;
  regions: number;
  spanMetres: number;
  heightMetres: number;
  /** Actual source detail density, before any atlas upscaling. */
  sourceAtlasSize: number;
}

export function validateFloorDetail(spec: FloorDetailSpec, level: Pick<Level, 'labels' | 'geometry'>): number {
  const label = level.labels.indexOf(spec.label);
  if (label < 0) throw new Error(`Floor detail: material "${spec.label}" is absent`);
  if (!spec.layoutHash || layoutHash(level.geometry.getAttribute('uv').array) !== spec.layoutHash)
    throw new Error('Floor detail: preservation mask belongs to another UV layout');
  if (!Number.isInteger(spec.regions) || spec.regions < 1 || spec.regions > 255 ||
      !Number.isFinite(spec.spanMetres) || spec.spanMetres <= 0 ||
      !Number.isFinite(spec.heightMetres) || spec.heightMetres < 0 ||
      !Number.isInteger(spec.sourceAtlasSize) || spec.sourceAtlasSize < 1)
    throw new Error('Floor detail: invalid material scale, height, atlas size or region count');
  return label;
}

export function mipBytes(width: number, height: number, channels: number): number {
  let bytes = width * height * channels;
  while (width > 1 || height > 1) {
    width = Math.max(1, width >> 1); height = Math.max(1, height >> 1);
    bytes += width * height * channels;
  }
  return bytes;
}

/** Owns just the three auxiliary images. No changes to the paint atlas or exported maps. */
export class FloorDetail {
  readonly uniforms: Record<string, THREE.IUniform>;
  readonly textureBytes: number;
  enabled = true;
  constructor(readonly spec: FloorDetailSpec, label: number, readonly packed: THREE.Texture<HTMLImageElement>,
    readonly protect: THREE.DataTexture, readonly statistics: THREE.Texture<HTMLImageElement>, atlasSize: number) {
    this.uniforms = {
      floorPacked: { value: packed }, floorProtect: { value: protect }, floorStatistics: { value: statistics },
      floorEnabled: { value: 1 }, floorDebug: { value: 0 }, floorRelief: { value: 1 },
      floorLabel: { value: label }, floorRegions: { value: spec.regions },
      floorSpan: { value: spec.spanMetres }, floorHeightSpan: { value: spec.heightMetres },
      floorRoughnessBase: { value: .32 }, floorRoughnessGain: { value: 1 }, floorMaxSlope: { value: 10 },
      floorAtlasSize: { value: Math.min(atlasSize, spec.sourceAtlasSize) },
    };
    this.textureBytes = mipBytes(packed.image.width, packed.image.height, 4) +
      mipBytes(protect.image.width, protect.image.height, 1) + statistics.image.width * statistics.image.height * 4;
  }
  dispose() { this.packed.dispose(); this.protect.dispose(); this.statistics.dispose(); }
  setResponse(response?: MaterialResponse) {
    this.uniforms.floorHeightSpan.value = response?.heightMetres ?? this.spec.heightMetres;
    this.uniforms.floorRoughnessBase.value = response?.roughness ?? .32;
    this.uniforms.floorRoughnessGain.value = response?.roughnessGain ?? 1;
    this.uniforms.floorMaxSlope.value = response?.maxSlope ?? 10;
  }
}

export async function loadFloorDetail(spec: FloorDetailSpec, level: Level, atlasSize: number, anisotropy: number): Promise<FloorDetail> {
  const label = validateFloorDetail(spec, level);
  const loader = new THREE.TextureLoader();
  // allSettled lets us dispose successful loads even when another image fails.
  const results = await Promise.allSettled([spec.packedUrl, spec.protectUrl, spec.statisticsUrl].map(url => loader.loadAsync(url)));
  const owned = results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
  try {
    const failed = results.find(r => r.status === 'rejected');
    if (failed?.status === 'rejected') throw new Error(`Floor detail image failed: ${String(failed.reason)}`);
    const [packed, mask, statistics] = owned;
    if (packed.image.width !== packed.image.height || statistics.image.height !== 1 || statistics.image.width <= spec.regions)
      throw new Error('Floor detail: invalid packed field or region statistics dimensions');
    for (const t of owned) { t.flipY = false; t.colorSpace = THREE.NoColorSpace; }
    packed.minFilter = THREE.LinearMipmapLinearFilter; packed.anisotropy = anisotropy;
    statistics.generateMipmaps = false;
    statistics.minFilter = statistics.magFilter = THREE.NearestFilter;
    const canvas = document.createElement('canvas');
    canvas.width = mask.image.width; canvas.height = mask.image.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(mask.image, 0, 0);
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const data = new Uint8Array(canvas.width * canvas.height);
    for (let i = 0; i < data.length; i++) data[i] = rgba[4 * i];
    const protect = new THREE.DataTexture(data, canvas.width, canvas.height, THREE.RedFormat);
    protect.generateMipmaps = true;
    protect.minFilter = THREE.LinearMipmapLinearFilter; protect.magFilter = THREE.LinearFilter;
    protect.needsUpdate = true;
    mask.dispose();
    return new FloorDetail({ ...spec }, label, packed, protect, statistics, atlasSize);
  } catch (error) { for (const t of owned) t.dispose(); throw error; }
}

const COMMON = /* glsl */ `
uniform sampler2D floorPacked, floorProtect, floorStatistics;
uniform float floorEnabled, floorDebug, floorRelief, floorLabel, floorRegions;
uniform float floorSpan, floorHeightSpan, floorAtlasSize;
uniform float floorRoughnessBase, floorRoughnessGain, floorMaxSlope;
varying vec3 vFloorWorld, vFloorNormal;
flat varying float vFloorLabel;
float floorWeight = 0.0, floorHeight = 0.0, floorRoughness = 0.92;
float floorSelected = 0.0, floorProtection = 1.0;
vec2 floorMirror(vec2 p) { return 1.0 - abs(mod(p, 2.0) - 1.0); }
float floorHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec3 floorBump(vec3 at, vec3 n, vec2 dh, float facing) {
  vec3 dx = dFdx(at), dy = dFdy(at), r1 = cross(dy, n), r2 = cross(n, dx);
  float det = dot(dx, r1) * facing;
  vec3 gradient = sign(det) * (dh.x * r1 + dh.y * r2) / max(abs(det), 1e-12);
  gradient *= min(1.0, floorMaxSlope / max(length(gradient), 1e-6));
  return normalize(n - gradient);
}
`;

const COLOUR = /* glsl */ `
floorSelected = (1.0 - step(0.5, abs(vFloorLabel - floorLabel))) * smoothstep(.92, .99, vFloorNormal.y);
floorProtection = texture2D(floorProtect, vUv).r;
floorWeight = floorSelected * (1.0 - smoothstep(.35, .82, floorProtection)) * floorEnabled;
floorWeight *= 1.0 - smoothstep(4.0, 10.0, length(vViewPosition));
// Derivatives are evaluated outside divergent branches, including material boundaries.
vec2 floorUV = vec2(vFloorWorld.x, -vFloorWorld.z) / floorSpan;
vec2 floorDx = dFdx(floorUV), floorDy = dFdy(floorUV);
vec2 floorAtlasDx = dFdx(vUv), floorAtlasDy = dFdy(vUv);
if (floorWeight > 0.0) {
  vec2 uv = floorMirror(floorUV), direction = sign(1.0 - mod(floorUV, 2.0));
  vec4 field = textureGrad(floorPacked, uv, floorDx * direction, floorDy * direction);
  float atlasFoot = max(length(floorAtlasDx), length(floorAtlasDy)) * floorAtlasSize;
  float sampleFoot = max(length(floorDx), length(floorDy));
  float density = atlasFoot / max(sampleFoot, 1e-7);
  float side = float(textureSize(floorPacked, 0).x);
  float lowMip = clamp(log2(side / max(density, 1.0)), 0.0, log2(side));
  float low = textureLod(floorPacked, uv, lowMip).r;
  float restore = clamp((field.r + .015) / (low + .015), .65, 1.35);
  ivec2 cell = clamp(ivec2(uv * side), ivec2(0), ivec2(int(side) - 1));
  int region = int(texelFetch(floorPacked, cell, 0).a * 255.0 + .5);
  region = clamp(region, 0, int(floorRegions));
  int other = 1 + int(floorHash(floor(floorUV) + vec2(float(region) * .71, float(region) * 1.17)) * floorRegions);
  float fromMean = texelFetch(floorStatistics, ivec2(region, 0), 0).r;
  float toMean = texelFetch(floorStatistics, ivec2(other, 0), 0).r;
  float variation = region > 0 ? clamp(toMean - fromMean, -.08, .08) * .18 : 0.0;
  diffuseColor.rgb *= mix(1.0, restore + variation, floorWeight);
  floorHeight = (field.b - .5) * floorHeightSpan * floorWeight * floorRelief;
  floorRoughness = clamp(floorRoughnessBase + (field.g - .32) * floorRoughnessGain, .08, 1.0);
}
`;

/** Compose with the viewer's atlas/reveal shader. Undo removes only this layer and forces a clean program. */
export function installFloorDetail(material: THREE.MeshStandardMaterial, detail: FloorDetail): () => void {
  const previous = material.onBeforeCompile, previousKey = material.customProgramCacheKey;
  const baseKey = previousKey.call(material);
  // Three caches custom uniforms per material/program. Clear old bindings when replacing the images,
  // otherwise the same shader key can keep sampling the previous, already-disposed textures.
  material.dispose();
  material.onBeforeCompile = function(shader, renderer) {
    previous.call(this, shader, renderer);
    Object.assign(shader.uniforms, detail.uniforms);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
attribute float label;
varying vec3 vFloorWorld, vFloorNormal;
flat varying float vFloorLabel;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vFloorWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
vFloorNormal = normalize(mat3(modelMatrix) * objectNormal);
vFloorLabel = label;`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${COMMON}`)
      .replace('#include <alphamap_fragment>', `${COLOUR}\n#include <alphamap_fragment>`)
      .replace('#include <lights_physical_fragment>', `
vec2 floorGradient = vec2(dFdx(floorHeight), dFdy(floorHeight));
vec3 floorBaseNormal = normalize(mix(normal, nonPerturbedNormal, floorWeight * clamp(floorRelief, 0.0, 1.0)));
vec3 floorDetailNormal = floorBump(-vViewPosition, floorBaseNormal, floorGradient, faceDirection);
// Fully protected pixels keep ALL original material channels, including at a mask edge.
if (floorWeight > 0.0) normal = normalize(mix(normal, floorDetailNormal, floorWeight));
roughnessFactor = mix(roughnessFactor, floorRoughness, floorWeight);
#include <lights_physical_fragment>`)
      .replace('#include <opaque_fragment>', `
if (floorDebug > .5 && floorDebug < 1.5) outgoingLight = diffuseColor.rgb;
if (floorDebug > 1.5) outgoingLight = vec3(floorSelected * step(.82, floorProtection));
#include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => `${baseKey}|floor-detail-v1`;
  material.needsUpdate = true;
  return () => {
    material.dispose();
    material.onBeforeCompile = previous; material.customProgramCacheKey = previousKey; material.needsUpdate = true;
  };
}
