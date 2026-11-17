import * as THREE from 'three';
import { Engine } from './engine';
import { makeCamera, ViewRenderer, type ViewSpec } from './views';
import { crossViewAgreement, imageAgreement, type ValidationFrame } from './validation';
import { toCanvas, bitmapToRGBA } from './image';

export interface ValidationInput { spec: ViewSpec; raw: Uint8ClampedArray }

export function captureValidation(engine: Engine, renderer: ViewRenderer, spec: ViewSpec) {
  const camera = makeCamera(spec); renderer.renderGeometry(camera);
  const frame: ValidationFrame = { id: spec.id, width: renderer.size, height: renderer.size,
    color: new Uint8ClampedArray(0), position: engine.gpu.readF32(renderer.geometryTarget, 0),
    normal: engine.gpu.readF32(renderer.geometryTarget, 1),
    projection: new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).toArray(), eye: spec.position };
  const appearance = renderer.renderValidation(engine.atlas);
  const geometry = new Uint8Array(renderer.size ** 2), observed = geometry.slice(), filled = geometry.slice();
  for (let p = 0; p < geometry.length; p++) {
    geometry[p] = appearance.coverage[4 * p] > 127 ? 1 : 0;
    observed[p] = appearance.coverage[4 * p + 1] > 127 ? 1 : 0;
    filled[p] = appearance.coverage[4 * p + 2] > 127 ? 1 : 0;
  }
  frame.color = appearance.color;
  return { frame, geometry, observed, filled };
}

/** Evaluates in an isolated atlas: never changes the loaded painting, source fields, or viewer state.
 * LOO projects RAW targets, never saved composites that already contain other views' pixels.
 * Sequential/grid-generated targets are still coupled; this is a fusion diagnostic, not generalization.
 */
export async function validateViews(source: Engine, inputs: ValidationInput[], options: { size?: number; atlasSize?: number; heldOut?: boolean } = {}) {
  if (inputs.length < 2) throw new Error('Validation needs at least two raw generated views');
  const size = options.size ?? 256;
  if (!Number.isInteger(size) || size < 16 || size > 1024) throw new Error('Validation resolution must be an integer from 16 to 1024');
  const atlasSize = options.atlasSize ?? Math.min(source.options.atlasSize, Math.floor(2048 / Math.sqrt(source.options.atlasPages)));
  if (!Number.isInteger(atlasSize) || atlasSize < 16 || atlasSize > source.gpu.renderer.capabilities.maxTextureSize) throw new Error('Invalid validation atlas size');
  const engine = new Engine(source.gpu, source.level, { ...source.options, viewSize: size, atlasSize });
  const renderer = new ViewRenderer(source.gpu, source.level, size);
  const frames: ValidationFrame[] = [], raw: Uint8ClampedArray[] = [];
  try {
    for (const input of inputs) {
      if (input.raw.length !== source.size ** 2 * 4) throw new Error('Raw image dimensions do not match the recorded run');
      const image = await createImageBitmap(toCanvas(input.raw, source.size, source.size));
      try { raw.push(bitmapToRGBA(image, size, size)); } finally { image.close(); }
      const f = captureValidation(engine, renderer, input.spec).frame; f.color = raw.at(-1)!; frames.push(f);
    }
    const agreement = crossViewAgreement(frames);
    const heldOut = [];
    if (options.heldOut !== false) for (let k = 0; k < inputs.length; k++) {
      engine.atlas.reset();
      for (let j = 0; j < inputs.length; j++) if (j !== k) engine.paint(inputs[j].spec, raw[j]);
      const cap = captureValidation(engine, renderer, inputs[k].spec);
      heldOut.push({ view: inputs[k].spec.id, ...imageAgreement(raw[k], cap.frame.color, cap.frame.normal, cap.geometry, cap.observed, size, size) });
    }
    engine.atlas.reset(); inputs.forEach((v, i) => engine.paint(v.spec, raw[i]));
    const perPart: Record<string, { pixels: number; observed: number; inferred: number }> = {};
    for (const input of inputs) {
      const c = captureValidation(engine, renderer, input.spec);
      for (let p = 0; p < c.geometry.length; p++) if (c.geometry[p]) {
        const name = source.level.labels[Math.round(c.frame.normal[4 * p + 3]) - 1] ?? 'unknown';
        const row = perPart[name] ??= { pixels: 0, observed: 0, inferred: 0 };
        row.pixels++; row.observed += c.observed[p]; row.inferred += c.filled[p];
      }
    }
    return { version: 1, resolution: size, atlasSize: engine.options.atlasSize, agreement, heldOut, perPart,
      provenance: 'Raw-image replay; camera-pixel-weighted coverage. Sequential and grid targets may be coupled. Held-out is fusion-only, not independently held-out generation.',
      partNames: source.level.labels };
  } finally {
    renderer.dispose(); engine.dispose();
  }
}
