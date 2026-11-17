/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import * as THREE from 'three';
import { runVision } from '../providers/fal';
import type { Engine } from './engine';
import { toDataUrl } from './image';
import { cleanName } from './parts';
import { DEFAULT_PLAN, samplePlayerPoints } from './planner';
import { lookAt, makeCamera, ViewRenderer, type ViewSpec } from './views';

/**
 * Names for the shapes of a level that came without part names. Image models keep a blockout's shapes far better
 * when the prompt says what each one is ("a round stone bollard (right)"); without that a bollard becomes paving
 * and a blank wall becomes an alley. Each shape is rendered highlighted in the clay level, from where it shows
 * best, and a vision model is asked what it is. The names land in `level.labels`, which the prompts already read,
 * and can be corrected by hand.
 */
export interface NamingOptions {
  /** Name at most this many shapes, largest surface first; the rest stay unnamed. */
  maxParts: number;
  /** Questions asked at the same time. */
  parallel: number;
}

export const DEFAULT_NAMING: NamingOptions = { maxParts: 48, parallel: 6 };

export interface NamedParts {
  /** Per shape, '' where it wasn't named (never seen, over the limit, or no usable answer). */
  names: string[];
  /** The camera each shape was shown from, for looking at it again. */
  views: (ViewSpec | null)[];
  cost: number;
  seconds: number;
}

/**
 * Where to look at a shape from: player spots near it and a little further off (what a player sees of it), and
 * raised cameras around it at two distances. `raised` marks the latter.
 */
export function partCameras(center: THREE.Vector3, radius: number, points: THREE.Vector3[]): { spec: ViewSpec; raised: boolean }[] {
  const out: { spec: ViewSpec; raised: boolean }[] = [];
  const byDistance = points.filter((p) => Math.hypot(p.x - center.x, p.z - center.z) > 1)
    .sort((a, b) => a.distanceToSquared(center) - b.distanceToSquared(center));
  const spots = new Set([...byDistance.slice(0, 3), ...byDistance.filter((p) => p.distanceTo(center) > radius * 1.3).slice(0, 3)]);
  // wide enough to take in the shape and some of what stands around it
  const fit = (dist: number) => THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan((radius * 1.5) / Math.max(dist, 0.1))), 60, 95);
  for (const p of spots) out.push({ spec: lookAt(p, center, fit(p.distanceTo(center))), raised: false });
  for (const far of [1.7, 3]) {
    const dist = Math.max(4, radius * far);
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k * Math.PI) / 2;
      const from = new THREE.Vector3(center.x + Math.cos(a) * dist, center.y + dist * 0.6, center.z + Math.sin(a) * dist);
      out.push({ spec: lookAt(from, center, fit(from.distanceTo(center))), raised: true });
    }
  }
  return out;
}

/**
 * How well a camera shows a shape for naming it, from the share of the frame the shape takes: enough to see it,
 * not so much that nothing around it is left to say what it is. A player's view counts for more than a raised one,
 * which mostly shows roofs.
 */
export function showScore(share: number, raised: boolean): number {
  if (share < 0.004) return 0;
  return (share <= 0.35 ? share : Math.max(0.02, 0.35 - (share - 0.35))) * (raised ? 0.6 : 1);
}

const question = (look: string) =>
  `This is an untextured 3D blockout of a game level. It will be textured as ${look}. One shape is highlighted in bright ` +
  'pink; everything else is gray. In two to four plain words, name what the pink shape is most likely meant to be in this ' +
  'setting, for example: house wall, cobblestone ground, stone bollard, porch block, stone steps, low garden wall, stone ' +
  'well, wooden crate, concrete pillar, steel beam. If the pink shape is the ground that everything stands on, say so. ' +
  'Answer with the name only, without punctuation.';

/**
 * Name the level's shapes and write the names into `level.labels`.
 * @param look the look the level is being textured as (the run's style)
 */
export async function nameParts(engine: Engine, look: string, opts: Partial<NamingOptions> = {}, onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal): Promise<NamedParts> {
  const o = { ...DEFAULT_NAMING, ...opts };
  const { level, gpu } = engine;
  const shapes = level.shapes;
  if (!shapes) throw new Error('this level already names its parts');
  const t0 = performance.now();
  const points = samplePlayerPoints(level, DEFAULT_PLAN);
  const probe = new ViewRenderer(gpu, level, 128);
  const views: (ViewSpec | null)[] = shapes.map(() => null);
  const shots: { part: number; image: string }[] = [];
  try {
    for (let k = 0; k < Math.min(shapes.length, o.maxParts); k++) {
      // the camera that shows this shape best
      let best: ViewSpec | null = null, bestScore = 0;
      for (const { spec, raised } of partCameras(new THREE.Vector3(...shapes[k].center), shapes[k].radius, points)) {
        probe.renderGeometry(makeCamera(spec));
        const nrm = gpu.readF32(probe.geometryTarget, 1);
        let px = 0;
        for (let i = 3; i < nrm.length; i += 4) if (Math.round(nrm[i] - 1) === k) px++;
        const score = showScore(px / (128 * 128), raised);
        if (score > bestScore) { bestScore = score; best = spec; }
      }
      if (!best) continue;   // nothing sees it: it stays unnamed
      views[k] = best;
      engine.clay.setHighlight(k);
      const { clay } = engine.renderView(best);
      shots.push({ part: k, image: toDataUrl(clay, engine.size, engine.size, 'image/jpeg', 0.9) });
    }
  } finally {
    engine.clay.setHighlight(null);
    probe.geometryTarget.dispose();
    probe.stateTarget.dispose();
  }
  const names = shapes.map(() => '');
  let cost = 0, next = 0, done = 0;
  onProgress?.(0, shots.length);
  const worker = async () => {
    while (next < shots.length && !signal?.aborted) {
      const shot = shots[next++];
      try {
        const r = await runVision(question(look), [shot.image], signal);
        names[shot.part] = cleanName(r.text);
        cost += r.cost;
      } catch (e) {
        if (signal?.aborted) throw e;   // otherwise this one shape stays unnamed
      }
      onProgress?.(++done, shots.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.parallel, shots.length)) }, worker));
  for (let k = 0; k < names.length; k++) level.labels[k] = names[k];
  return { names, views, cost, seconds: (performance.now() - t0) / 1000 };
}
