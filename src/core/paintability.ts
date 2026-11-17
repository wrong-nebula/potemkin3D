/**
 * How likely an image model is to paint a view as the surfaces it shows, from what the planner knows about the
 * view before paying for it. A view that scores low tends to come back as a scene of the model's own (a street
 * across a blank wall, sky on the level) and gets held back by the blockout check: money for nothing.
 *
 * These are rules of thumb from logged runs on the Courtyard, to be refitted as runs accumulate (every checked
 * view records how much of it was held back):
 * - cameras pitched 55 degrees down were held back almost entirely, six times out of six;
 * - one blank face filling the frame with nothing painted around it comes back as a scene;
 * - frames that are mostly sky deliver little and get villages painted into the sky.
 */
export interface ViewFeatures {
  /** Radians; negative looks down. */
  pitch: number;
  /** Share of the frame with no level in it. */
  sky: number;
  /** Faces of the level in view (regions bounded by silhouettes and creases, at least 0.4% of the frame each). */
  faces: number;
  /** The largest of them, as a share of the frame. */
  maxFace: number;
  /** Share of the level in view that is already painted. */
  context: number;
}

export function paintability(f: ViewFeatures): number {
  const tilt = Math.abs(f.pitch) * (180 / Math.PI);
  // level views paint well; by 55 degrees almost nothing survives
  let p = tilt <= 20 ? 1 : Math.max(0.1, 1 - (0.9 * (tilt - 20)) / 35);
  if (f.maxFace > 0.5 && f.context < 0.3) p *= 0.3;   // one blank face and nothing to go on
  if (f.faces < 2) p *= 0.3;
  if (f.sky > 0.45) p *= 0.6;
  return Math.max(0, Math.min(1, p));
}
