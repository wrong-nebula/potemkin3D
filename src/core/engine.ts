/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import * as THREE from 'three';
import { Atlas } from './atlas';
import { ClayRenderer, OUTDOOR, type Lighting } from './clay';
import { Gpu } from './gpu';
import type { AoMap } from './ao';
import type { PbrMaps } from './pbr';
import type { Level } from './scene';
import type { MaterialAssignments } from './material-presets';
import { makeCamera, ViewRenderer, type ViewSpec } from './views';

export interface EngineOptions {
  viewSize: number;   // px, square views sent to the models
  atlasSize: number;  // px, the baked texture (each of them, when it is several)
  /** How many textures the level's texture is: 1, 4 or 16 (a grid of pages; needs a layout made for it, core/layout.ts pagedLayout). */
  atlasPages: number;
  lighting: Lighting;
  qualityRatio: number;
  /** Surfaces seen at a lower angle than this (cosine between the view ray and the normal) are not painted from that view. */
  minCos: number;
  /** A farther surface this close (px at a 1024 px view) to a nearer one's outline is not painted from that view; 0 = off. */
  edgeGuard: number;
  /**
   * The share of an image's side, along each border, that is not painted from. At the rim the models let things peek
   * into the frame (a sliver of a door, half a window), and a sliver painted onto a wall is a narrow door for good.
   */
  frameMargin: number;
}

export const DEFAULT_ENGINE: EngineOptions = { viewSize: 2048, atlasSize: 4096, atlasPages: 1, lighting: OUTDOOR, qualityRatio: 0.4, minCos: 0.08, edgeGuard: 0, frameMargin: 0 };

/** Owns the GPU resources for one level: clay renders, view buffers and the texture being painted. */
export class Engine {
  readonly clay: ClayRenderer;
  readonly views: ViewRenderer;
  readonly atlas: Atlas;
  readonly options: EngineOptions;
  /** Normal and roughness maps predicted for the current texture (core/pbr.ts); unset until they're made. */
  pbr?: PbrMaps;
  /** Explicit material response assignments, keyed by the level's stable part names. */
  materialPresets: MaterialAssignments = {};
  /** Ambient occlusion baked for the level (core/ao.ts); unset until it's baked. */
  ao?: AoMap;
  private readonly clayTarget: THREE.WebGLRenderTarget;
  private readonly compTexture: THREE.DataTexture;

  constructor(readonly gpu: Gpu, readonly level: Level, opts: Partial<EngineOptions> = {}) {
    this.options = { ...DEFAULT_ENGINE, ...opts };
    const s = this.options.viewSize;
    this.clay = new ClayRenderer(gpu, level, this.options.lighting, s);
    this.views = new ViewRenderer(gpu, level, s);
    this.atlas = new Atlas(gpu, level, this.options.atlasSize, Math.round(Math.sqrt(this.options.atlasPages)));
    this.clayTarget = this.clay.makeTarget(s);
    this.compTexture = new THREE.DataTexture(new Uint8Array(s * s * 4), s, s, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.compTexture.minFilter = THREE.LinearFilter;
    this.compTexture.magFilter = THREE.LinearFilter;
    this.compTexture.generateMipmaps = false;
  }

  get size() {
    return this.options.viewSize;
  }

  /** Clay render, geometry buffers and the state image for one view, against the current texture. */
  renderView(spec: ViewSpec, ratio = this.options.qualityRatio, cap = 1e9) {
    const camera = makeCamera(spec);
    const lens = camera.projectionMatrix.elements[5] || 1;
    this.views.renderGeometry(camera);
    const g = this.views.geometryTarget.textures;
    this.clay.render(camera, this.clayTarget, { pos: g[0], nrm: g[1] });
    const { state, mask } = this.views.renderState(this.clayTarget.texture, this.atlas, ratio, cap, lens);
    return { camera, state, mask, clay: this.gpu.readU8(this.clayTarget) };
  }

  /** World position and normal (a = part label + 1, 0 = sky) per pixel of the last rendered view, top-down. */
  readGeometry() {
    const t = this.views.geometryTarget;
    return { pos: this.gpu.readF32(t, 0), nrm: this.gpu.readF32(t, 1) };
  }

  /** Project a composited image (top-down RGBA, view size) into the texture from `spec`'s camera. */
  paint(spec: ViewSpec, comp: Uint8ClampedArray, detail = 1) {
    const camera = makeCamera(spec);
    const lens = camera.projectionMatrix.elements[5] || 1;
    this.views.renderGeometry(camera);
    (this.compTexture.image.data as Uint8Array).set(comp);
    this.compTexture.needsUpdate = true;
    this.atlas.project(camera, this.views.geometryTarget.textures[0], this.compTexture, this.options.qualityRatio, detail * lens, this.options.minCos, this.options.edgeGuard, this.options.frameMargin);
  }

  /** 1 where a view's pixels show level geometry (0 = sky), top-down. */
  geometryMask(spec: ViewSpec): Uint8Array {
    this.views.renderGeometry(makeCamera(spec));
    const px = this.gpu.readF32(this.views.geometryTarget, 1);
    const m = new Uint8Array(px.length / 4);
    for (let i = 0; i < m.length; i++) m[i] = px[4 * i + 3] > 0.5 ? 1 : 0;
    return m;
  }

  /** Rebuild the texture from recorded composites (no model calls). */
  replay(steps: { spec: ViewSpec; comp: Uint8ClampedArray; detail?: number }[], upTo = steps.length) {
    this.atlas.reset();
    for (let i = 0; i < upTo; i++) this.paint(steps[i].spec, steps[i].comp, steps[i].detail);
  }

  /** Releases an isolated/offscreen engine without disposing the shared input geometry or GPU. */
  dispose() {
    this.views.dispose(); this.atlas.dispose(); this.clay.dispose();
    this.clayTarget.dispose(); this.compTexture.dispose();
  }
}
