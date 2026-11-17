import * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';

/**
 * Notes pinned to the level: "add a poster here", "a worn rug here". A note belongs to a spot on a surface, not to
 * a picture, so every view that sees the spot is told about it the same way: the note is drawn onto the render the
 * model is sent, in red, as an art director would mark up a print (an outline of where and how big, a label with
 * the words), and the prompt says to carry the notes out and leave no trace of them.
 *
 * A note is carried out once. The first view that sees its spot well (square enough, whole, not half hidden) gets
 * it drawn; views after that find the spot painted and get nothing. A view that sees the spot badly, before any
 * view has seen it well, paints around it: the spot is kept out of what that view projects, so it is still bare
 * when a better view comes (the clean-up pass aims at bare spots players can see, so one usually does).
 *
 * What fits: flat things on a surface (a poster, a rug, a stain, lettering, a painted line). A thing with depth (a
 * duct, a lamp) is painted as a picture of itself and looks flat from the side: that belongs in the mesh.
 */
export interface Note {
  /** What to add, as one would write it on the print: "add a poster here". */
  text: string;
  /** Where: a point on (or near) a surface, in world coordinates. */
  at: [number, number, number];
  /** How big the thing is, in metres: across, for a spot; how thick, for a line. Default 1 (a line: 0.4). */
  size?: number;
  /** For something that runs along a surface (a pipe run, a painted stripe): its other end. */
  to?: [number, number, number];
}

/** A note snapped onto the level's surface, with the surface's normal there. */
export interface PinnedNote extends Note {
  size: number;
  normal: [number, number, number];
}

/** Snap each note onto the nearest surface of the level and note which way that surface faces. */
export function pinNotes(notes: Note[], geometry: THREE.BufferGeometry, bvh: MeshBVH): PinnedNote[] {
  const pos = geometry.getAttribute('position'), index = geometry.index;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), p = new THREE.Vector3();
  const snap = (q: [number, number, number]) => {
    const hit = bvh.closestPointToPoint(p.set(...q));
    if (!hit) return { point: q, normal: [0, 1, 0] as [number, number, number] };
    const v = (k: number) => (index ? index.getX(3 * hit.faceIndex + k) : 3 * hit.faceIndex + k);
    a.fromBufferAttribute(pos, v(0)); b.fromBufferAttribute(pos, v(1)); c.fromBufferAttribute(pos, v(2));
    const n = b.sub(a).cross(c.sub(a)).normalize();
    return { point: hit.point.toArray() as [number, number, number], normal: n.toArray() as [number, number, number] };
  };
  return notes.map((note) => {
    const at = snap(note.at);
    return { ...note, at: at.point, normal: at.normal, size: note.size ?? (note.to ? 0.4 : 1), ...(note.to ? { to: snap(note.to).point } : {}) };
  });
}

export interface NoteInView {
  /** Which note (its place in the list). */
  index: number;
  note: PinnedNote;
  /** 1 on the view's pixels that show the note's spot. */
  footprint: Uint8Array;
  pixels: number;
  /** The spot's outline in the view (px): the edge of a spot, or the two ends of a line. */
  outline: [number, number][];
  /** Share of the footprint no view has painted yet. */
  open: number;
  /** Seen well enough to carry the note out here: square enough, whole, in frame, big enough to draw into. */
  well: boolean;
}

/** Distance from p to the segment a-b (all 3 numbers each). */
function toSegment(px: number, py: number, pz: number, a: number[], b: number[]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = dx * dx + dy * dy + dz * dz;
  const t = len ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy + (pz - a[2]) * dz) / len)) : 0;
  return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy, pz - a[2] - t * dz);
}

/**
 * Which notes a view sees, and how. The view's own buffers say what is in sight, so a spot behind a column or
 * round a corner is simply not there.
 * @param pos per pixel (top row first): world position
 * @param nrm per pixel: world normal, a = 1 where the level is
 * @param known per pixel: 1 where the texture already holds this surface
 * @param size the view's side in pixels
 */
export function notesInView(notes: PinnedNote[], camera: THREE.PerspectiveCamera, pos: ArrayLike<number>, nrm: ArrayLike<number>,
  known: ArrayLike<number>, size: number): NoteInView[] {
  const out: NoteInView[] = [];
  const eye = camera.getWorldPosition(new THREE.Vector3());
  const v = new THREE.Vector3();
  const project = (q: number[]): [number, number] | null => {
    v.set(q[0], q[1], q[2]).project(camera);
    return v.z > 1 || v.z < -1 ? null : [(v.x * 0.5 + 0.5) * size, (1 - (v.y * 0.5 + 0.5)) * size];
  };
  notes.forEach((note, index) => {
    const r = note.size / 2, n = note.normal, end = note.to ?? note.at;
    const footprint = new Uint8Array(size * size);
    let pixels = 0, unpainted = 0;
    for (let i = 0; i < size * size; i++) {
      if (!(nrm[4 * i + 3] > 0.5)) continue;   // sky
      // on the note's own surface (not the floor under a note on a wall), within its reach
      if (nrm[4 * i] * n[0] + nrm[4 * i + 1] * n[1] + nrm[4 * i + 2] * n[2] < 0.5) continue;
      if (toSegment(pos[4 * i], pos[4 * i + 1], pos[4 * i + 2], note.at, end) > r) continue;
      footprint[i] = 1;
      pixels++;
      if (!known[i]) unpainted++;
    }
    if (!pixels) return;
    // the outline as it would be with nothing in the way: a circle on the surface, or the line's two ends
    const outline: [number, number][] = [];
    let whole = true;
    const add = (q: number[]) => { const p = project(q); if (p) outline.push(p); else whole = false; };
    if (note.to) { add(note.at); add(note.to); } else {
      const up = Math.abs(n[1]) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      const t1 = new THREE.Vector3(...n).cross(up).normalize(), t2 = new THREE.Vector3(...n).cross(t1).normalize();
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * 2 * Math.PI;
        add([note.at[0] + r * (Math.cos(a) * t1.x + Math.sin(a) * t2.x), note.at[1] + r * (Math.cos(a) * t1.y + Math.sin(a) * t2.y),
          note.at[2] + r * (Math.cos(a) * t1.z + Math.sin(a) * t2.z)]);
      }
    }
    const margin = 0.03 * size;
    const inFrame = whole && outline.every(([x, y]) => x > margin && y > margin && x < size - margin && y < size - margin);
    // how squarely the surface faces the camera, at the middle of the note
    const mid = [(note.at[0] + end[0]) / 2, (note.at[1] + end[1]) / 2, (note.at[2] + end[2]) / 2];
    const toEye = v.set(eye.x - mid[0], eye.y - mid[1], eye.z - mid[2]).normalize();
    const cos = Math.abs(toEye.x * n[0] + toEye.y * n[1] + toEye.z * n[2]);
    // how much of it is hidden: the pixels it shows against the pixels its outline holds
    let area = 0;
    if (note.to && outline.length === 2) {
      const d = eye.distanceTo(v.set(mid[0], mid[1], mid[2]));
      const pxPerMetre = size / (2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
      area = Math.hypot(outline[1][0] - outline[0][0], outline[1][1] - outline[0][1]) * note.size * pxPerMetre * cos;
    } else {
      for (let k = 0; k < outline.length; k++) {
        const [x0, y0] = outline[k], [x1, y1] = outline[(k + 1) % outline.length];
        area += (x0 * y1 - x1 * y0) / 2;
      }
      area = Math.abs(area);
    }
    const shown = area > 0 ? pixels / area : 0;
    const well = inFrame && cos >= 0.45 && pixels >= 0.0012 * size * size && shown >= 0.6;
    out.push({ index, note, footprint, pixels, outline, open: unpainted / pixels, well });
  });
  return out;
}

/** The share of a note's footprint that must still be unpainted for the note to count as not yet carried out. */
export const NOTE_OPEN = 0.3;

/**
 * Where a note's label goes: centred under its outline, or over it when there is no room below, kept inside the
 * frame. Returns the label's box and the point on the outline its arrow points at.
 */
export function labelPlace(outline: [number, number][], width: number, height: number, size: number): { x: number; y: number; tip: [number, number] } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of outline) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const gap = 0.03 * size, pad = 0.01 * size;
  const below = y1 + gap + height < size - pad;
  const y = below ? y1 + gap : Math.max(pad, y0 - gap - height);
  const x = Math.max(pad, Math.min(size - pad - width, (x0 + x1) / 2 - width / 2));
  return { x, y, tip: [(x0 + x1) / 2, below ? y1 : y0] };
}

/**
 * Draw notes onto a render, as the model is to see them: each spot's outline in red, and its words in red on a
 * white label with an arrow to the spot. Browser only (it draws on a canvas). The render itself is not changed.
 */
export function drawNotes(image: Uint8ClampedArray, size: number, notes: NoteInView[]): Uint8ClampedArray {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(image), size, size), 0, 0);
  const red = 'rgb(225, 25, 25)', line = Math.max(3, size / 290), font = Math.round(size / 44);
  ctx.lineWidth = line;
  ctx.strokeStyle = red;
  ctx.lineJoin = ctx.lineCap = 'round';
  ctx.font = `bold ${font}px Arial, Helvetica, sans-serif`;
  ctx.textBaseline = 'top';
  for (const n of notes) {
    ctx.beginPath();
    n.outline.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (n.note.to) {
      ctx.stroke();
      for (const [x, y] of n.outline) { ctx.beginPath(); ctx.arc(x, y, 3.5 * line, 0, 2 * Math.PI); ctx.stroke(); }
    } else { ctx.closePath(); ctx.stroke(); }
    const text = n.note.text.trim();
    const w = ctx.measureText(text).width + 0.8 * font, h = 1.5 * font;
    const at = labelPlace(n.outline, w, h, size);
    ctx.fillStyle = '#fff';
    ctx.fillRect(at.x, at.y, w, h);
    ctx.fillStyle = red;
    ctx.fillText(text, at.x + 0.4 * font, at.y + 0.22 * font);
    // the arrow, from the label's near edge to the outline
    const from: [number, number] = [at.x + w / 2, at.y > at.tip[1] ? at.y : at.y + h];
    const ang = Math.atan2(at.tip[1] - from[1], at.tip[0] - from[0]);
    ctx.beginPath();
    ctx.moveTo(from[0], from[1]);
    ctx.lineTo(at.tip[0], at.tip[1]);
    for (const s of [-0.5, 0.5]) { ctx.moveTo(at.tip[0], at.tip[1]); ctx.lineTo(at.tip[0] - 5 * line * Math.cos(ang + s), at.tip[1] - 5 * line * Math.sin(ang + s)); }
    ctx.stroke();
  }
  return ctx.getImageData(0, 0, size, size).data;
}

/**
 * What a view that carried out one note puts onto the level when the surface around it is already painted (a note
 * on ground laid from tiles): the model's picture inside the note's footprint, fading into the picture as it was
 * over a band around it, and nothing beyond. So a note changes its own spot and no more, whatever else the model
 * touched, and a thing painted larger than its outline is cut back to it.
 * @param before the view as the model was sent it, without the note drawn (RGBA); `after`: what came back
 * @param allow 1 on the pixels the note may reach (the ground, not the foot of a wall beside it)
 * @param grow the band's width as a share of the footprint's radius
 * @returns RGBA, alpha 255 where the view is to be projected and 0 elsewhere
 */
export function noteComposite(before: Uint8ClampedArray, after: Uint8ClampedArray, footprint: Uint8Array, size: number,
  allow?: ArrayLike<number>, grow = 0.35): Uint8ClampedArray {
  let pixels = 0;
  for (let i = 0; i < footprint.length; i++) pixels += footprint[i];
  const band = Math.max(4, Math.round(grow * Math.sqrt(pixels / Math.PI)));
  // the share of footprint in a square of side 2 * band + 1 around each pixel, from a summed-area table
  const W = size + 1, sum = new Float64Array(W * W);
  for (let y = 0; y < size; y++) {
    let row = 0;
    for (let x = 0; x < size; x++) { row += footprint[y * size + x]; sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + row; }
  }
  const out = new Uint8ClampedArray(before.length);
  for (let y = 0; y < size; y++) {
    const y0 = Math.max(0, y - band), y1 = Math.min(size, y + band + 1);
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (allow && !allow[i]) continue;
      const x0 = Math.max(0, x - band), x1 = Math.min(size, x + band + 1);
      const share = (sum[y1 * W + x1] - sum[y0 * W + x1] - sum[y1 * W + x0] + sum[y0 * W + x0]) / ((2 * band + 1) ** 2);
      // inside the footprint the square is at least half footprint: the note's own picture; it fades out by the band's edge
      const t = footprint[i] ? Math.max(share * 2, 0.75) : share * 2;
      const w = Math.min(1, t);
      if (w < 0.03) continue;
      for (let k = 0; k < 3; k++) out[4 * i + k] = before[4 * i + k] * (1 - w) + after[4 * i + k] * w;
      out[4 * i + 3] = 255;
    }
  }
  return out;
}

/**
 * Notes that say what a view's gaps are: for a view that fills holes, the parts with the most unpainted pixels in
 * it, each outlined and named. A hole view sees a part in pieces (the side of a sofa between two painted walls) and
 * its prompt can only say "sofa (left, small)"; a note on the render points at it.
 * @param label per pixel, the part's index (-1: none); `unknown`: 1 where the view shows unpainted surface
 * @param names the parts' names (unnamed parts get no note)
 * @param max how many notes at most; `minShare`: the least share of the frame a part's gap must take;
 *   `maxBox`: the most of the frame the box round a part's gap may take; `skip`: parts that get no note (the
 *   scenery: walls, floor, ceiling, which the prompt names already and a box says nothing about)
 */
export function gapNotes(label: ArrayLike<number>, unknown: ArrayLike<number>, names: string[], size: number, max = 3, minShare = 0.004,
  words: (name: string) => string = (name) => `this gray part: ${name}`, maxBox = 0.3, skip?: (label: number) => boolean): NoteInView[] {
  const count = new Map<number, number>();
  for (let i = 0; i < size * size; i++) if (unknown[i] && label[i] >= 0) count.set(label[i], (count.get(label[i]) ?? 0) + 1);
  const ranked = [...count].filter(([l, n]) => names[l] && !skip?.(l) && n >= minShare * size * size).sort((a, b) => b[1] - a[1]);
  const out: NoteInView[] = [];
  for (const [l] of ranked) {
    if (out.length >= max) break;
    // The part's biggest gap in one piece (a part may be several things: three crates; or lie in pieces behind others),
    // found on a coarse grid.
    const f = Math.max(1, Math.floor(size / 256)), g = Math.ceil(size / f);
    const cell = new Uint8Array(g * g);
    for (let y = 0; y < size; y += Math.max(1, f >> 1)) for (let x = 0; x < size; x += Math.max(1, f >> 1)) {
      const i = y * size + x;
      if (unknown[i] && label[i] === l) cell[Math.floor(y / f) * g + Math.floor(x / f)] = 1;
    }
    let best = { n: 0, x0: 0, y0: 0, x1: 0, y1: 0 };
    const stack: number[] = [];
    for (let start = 0; start < g * g; start++) {
      if (cell[start] !== 1) continue;
      const blob = { n: 0, x0: g, y0: g, x1: 0, y1: 0 };
      stack.push(start);
      cell[start] = 2;
      while (stack.length) {
        const c = stack.pop()!, cx = c % g, cy = (c - cx) / g;
        blob.n++;
        blob.x0 = Math.min(blob.x0, cx); blob.x1 = Math.max(blob.x1, cx); blob.y0 = Math.min(blob.y0, cy); blob.y1 = Math.max(blob.y1, cy);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= g || ny >= g || cell[ny * g + nx] !== 1) continue;
          cell[ny * g + nx] = 2;
          stack.push(ny * g + nx);
        }
      }
      if (blob.n > best.n) best = blob;
    }
    // A note is for a gap one can point at: a thing, or a piece of one. A wall's or a floor's gap sprawls over half
    // the frame; a box round it says nothing, and the prompt names such parts already.
    const cells = (best.x1 - best.x0 + 1) * (best.y1 - best.y0 + 1);
    if (best.n * f * f < minShare * size * size || cells * f * f > maxBox * size * size || best.n < 0.25 * cells) continue;
    const x0 = best.x0 * f, y0 = best.y0 * f, x1 = Math.min(size - 1, (best.x1 + 1) * f - 1), y1 = Math.min(size - 1, (best.y1 + 1) * f - 1);
    const footprint = new Uint8Array(size * size);
    let inBox = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * size + x;
      if (unknown[i] && label[i] === l) { footprint[i] = 1; inBox++; }
    }
    const pad = 0.006 * size;
    const a = Math.max(2, x0 - pad), b = Math.max(2, y0 - pad), c = Math.min(size - 2, x1 + pad), d = Math.min(size - 2, y1 + pad);
    out.push({ index: l, note: { text: words(names[l]), at: [0, 0, 0], normal: [0, 1, 0], size: 0 }, footprint, pixels: inBox,
      outline: [[a, b], [c, b], [c, d], [a, d]], open: 1, well: true });
  }
  return out;
}
