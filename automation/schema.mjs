// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

export const object = shape => z.strictObject(shape);
const number = z.number().finite();
const positive = number.positive();
const count = z.number().int().min(0).max(10000);
const fraction = number.min(0).max(1);
const text = z.string().min(1).max(16000);
export const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
export const jobId = z.uuid();
export const relativePath = z.string().min(1).max(500).refine(p =>
  !p.startsWith('/') && !p.includes('\\') && !p.includes(':') && !p.includes('\0') &&
  p.split('/').every(v => v && v !== '.' && v !== '..'), 'Use a project-relative path without traversal');
export const filename = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/);
const vector = z.tuple([number, number, number]);
const size = z.number().int().min(64).max(8192);
const optional = shape => Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, value.optional()]));
export const planOptions = object(optional({
  eyeHeight: positive, spacing: positive, fov: number.min(10).max(140), yaws: count,
  pitchDeg: number.min(-90).max(90), downYaws: count, downPitchDeg: number.min(-90).max(90),
  maxViews: count, targetCoverage: fraction, probeSize: size, grid: size, goodRatio: fraction,
  goodAbs: positive, maxParallel: z.number().int().min(1).max(16), aerial: count, roofs: count,
  roofDistance: positive, floors: count, floorHeight: positive, holes: count, cleanup: count,
  seed: z.number().int(), objective: z.enum(['coverage', 'sharpness', 'fisher']), lookAt: count,
  adaptive: z.boolean(), geodesic: z.boolean(),
  mode: z.enum(['auto', 'level', 'object']), focusParts: z.array(text),
}));
const note = object({ text, at: vector, size: positive.optional(), to: vector.optional() });
const setting = object(optional({ place: text, carriers: text, details: text, additions: z.array(text), materials: text, fill: text, ground: text, light: text }));
export const pipelineOptions = object(optional({
  style: text, roofStyle: text, floorStyle: text, references: count, holeModel: text, gapNotes: z.boolean(),
  notes: z.array(note), plainFills: z.boolean(), diffuse: z.boolean(),
  wording: z.enum(['photo','aaa','scout','retro','remaster','survey','cel','transfer','production']),
  setting, styleImages: z.array(z.string().max(500)), styleMax: count, firstModel: text, fillModel: text,
  mostlyNew: fraction, feather: number.min(0).max(256), seed: z.number().int(), plan: planOptions,
  check: z.boolean(), checkThreshold: fraction, checkRetries: count, retryAbove: fraction, minFresh: fraction,
  checkPlanes: z.boolean(), checkCells: z.boolean(), styleReference: z.boolean(), nameParts: z.boolean(),
}));
const weightOverlay = z.enum(['off','openness','curvature','light','class','importance']);
const loadOptions = object(optional({ lighting: z.enum(['overcast','outdoor','indoor','indoor-soft']),
  atlasSize: size, viewSize: size, name: id, layout: z.enum(['file','seen','near']),
  area: z.array(number).min(6), pages: z.union([z.literal(1),z.literal(4),z.literal(16)]),
  unwrap: z.enum(['auto','always','off']), cavity: z.number().min(0).max(0.99), weights: z.boolean(),
  mode: z.enum(['auto','level','object']) }));
const camera = object({ position: vector, target: vector, ...optional({ fov: number.min(10).max(140),
  width: size, height: size, mode: z.enum(['clay','textured','lit']), overlay: z.boolean(), weights: weightOverlay }) });
const step = (op, fields = {}) => object({ op: z.literal(op), ...fields });
export const steps = [
  step('load', { path: relativePath.optional(), look: relativePath.optional(), options: loadOptions.optional() }),
  step('loadRun', { id }), step('loadSentoFloor'), step('bounds'), step('weights', { overlay: weightOverlay.optional() }),
  step('plan', { options: planOptions.optional() }),
  step('quote', { options: object(optional({firstModel:text,fillModel:text,holes:count,secondGoes:count,planes:z.boolean(),viewSize:size})).optional() }),
  step('projection', { options: object(optional({ minCos: fraction, edgeGuard: count, frameMargin: number.min(0).max(.49) })) }),
  step('run', { saveAs: id, options: pipelineOptions.optional() }),
  step('topUp', { saveAs: id, options: pipelineOptions.optional() }),
  step('parts', { saveAs: id, options: object(optional({ max: count, minShare: fraction, only: z.array(text) })).optional() }),
  step('ground', { saveAs: id, options: object(optional({ tiles: count, span: positive, cell: positive, turn: count, dirt: number.min(0), style: text, only: z.array(text), seed: z.number().int(), reuse: z.boolean() })).optional() }),
  step('repair', { saveAs: id, dry: z.boolean().optional(), regions: z.array(object({ min: vector, max: vector,
    text: text.optional(), from: vector.optional(), again: count.optional() })).min(1) }),
  step('groundNotes', { saveAs: id, notes: z.array(note).min(1) }),
  step('props', { saveAs: id, options: object(optional({ max: count, only: z.array(text), angles: count, runId: id,
    mode: z.enum(['sheet','sequence']), model: text, split: z.boolean(), cels: z.array(text), dry: z.boolean(),
    cameras: z.record(z.string(), z.array(object({ position: vector, target: vector, fov: number.optional() }))) })).optional() }),
  step('finish'), step('save', { id }),
  step('ao', { options: object(optional({ size, rays: z.number().int().min(1).max(256), radius: positive })).optional() }),
  step('pbr', { options: object(optional({ size, seed: z.number().int(), strength: number.min(0), baseRoughness: fraction,
    roughnessGain: number.min(0), parallel: z.number().int().min(1).max(16) })).optional() }),
  step('nameParts', { style: text.optional() }),
  step('materialPresets', { assignments: z.record(z.string(), z.enum(['limestone','glazed-tile','painted-metal','timber','hard-surface','metal','fabric','organic'])) }),
  step('materialMaps', { options: object({ size, layoutHash: text, ...optional({ heightUrl: text, normalUrl: text,
    roughnessUrl: text, roughnessBase: fraction }) }) }),
  step('floorDetail', { options: object({label:text,layoutHash:text,packedUrl:text,protectUrl:text,statisticsUrl:text,
    regions:z.number().int().min(1).max(255),spanMetres:positive,heightMetres:number.min(0),sourceAtlasSize:size}).nullable() }),
  step('floorDetailEnabled', { enabled: z.boolean() }),
  step('walk', { options: object(optional({ near: vector, yaw: number })).nullable().optional() }),
  step('pick', { options: object({ position: vector, target: vector, x: fraction, y: fraction,
    fov: number.optional(), aspect: positive.optional() }) }),
  step('snapshot', { output: filename.optional(), camera }),
  step('export', { output: filename.optional() }),
  step('selfTest', { views: z.number().int().min(1).max(16).optional() }),
  step('measure'),
  step('validate', { id, options: object(optional({ size, atlasSize: size, heldOut: z.boolean(), limit: count })).optional() }),
  step('checkRun', { id, threshold: fraction.optional(), planes: z.boolean().optional(), cells: z.boolean().optional() }),
  step('promptTest', { options: object({ run: id, views: z.array(count),
    variants: z.array(object({ name: id, opts: pipelineOptions, seeds: z.array(z.number().int()).optional() })).min(1),
    roofs: count.optional(), roofOpts: pipelineOptions.optional(), dry: z.boolean().optional(), fresh: z.boolean().optional() }) }),
];
export const workflow = object({ version: z.literal(1).default(1), steps: z.array(z.discriminatedUnion('op',steps)).min(1).max(100),
  allowPaid: z.boolean().default(false), timeoutSeconds: z.number().int().min(10).max(86400).default(1800) });
export const screenshot = object({ scene: z.enum(['luxor','loft']).default('luxor'),
  preset: z.number().int().min(1).max(5).default(1), width: size.default(1280), height: size.default(720),
  hud: z.boolean().default(false), timeoutSeconds: z.number().int().min(10).max(600).default(120) });
export const planInput = object({ sample: id.default('luxor'), views: z.number().int().min(1).max(10000).default(8),
  atlas: size.default(1024), viewSize: size.default(512), layout: z.enum(['file','seen','near']).default('file') });
export const buildInput = object({ target: z.enum(['author','scenes']).default('scenes'), timeoutSeconds: z.number().int().min(10).max(3600).default(600) });
export function paidSteps(input) {
  return input.steps.filter(s => ['run','topUp','parts','groundNotes','pbr','nameParts','promptTest'].includes(s.op) ||
    (s.op === 'ground' && !s.options?.reuse) || (s.op === 'props' && !s.options?.dry) ||
    (s.op === 'repair' && !s.dry) || (s.op === 'checkRun' && s.planes)).map(s => s.op);
}
export const jsonSchema = schema => z.toJSONSchema(schema, { target:'draft-7', io:'input' });
