/** Geometry-based multiview evaluation. Inspired by multiview-to-real's evaluation protocol (MIT).
 * Colors are sRGB bytes; errors are RGB code values, NOT perceptual Delta E or physical accuracy.
 * Generated images can agree and still be wrong. Always report support beside an error.
 */
export interface ValidationFrame {
  id: number;
  width: number;
  height: number;
  color: Uint8ClampedArray;
  /** Top-down world XYZ + distance to camera; zero distance means background. */
  position: Float32Array;
  /** World normal XYZ + positive part ID; zero means background. */
  normal: Float32Array;
  /** Column-major world-to-clip matrix. */
  projection: number[];
  eye: number[];
}

export interface ErrorScore {
  eligible: number;
  samples: number;
  support: number;
  mae: number | null;
  lowBandMae: number | null;
  highBandMae: number | null;
  highBandCorrelation: number | null;
}

function check(f: ValidationFrame) {
  const n = f.width * f.height * 4;
  if (!Number.isInteger(f.width) || !Number.isInteger(f.height) || f.width < 1 || f.height < 1 ||
    f.color.length !== n || f.position.length !== n || f.normal.length !== n || f.projection.length !== 16 || f.eye.length !== 3)
    throw new Error('Invalid calibrated validation frame');
}

/** A masked, separable box filter: no color crosses a semantic object boundary. */
export function surfaceLowPass(color: ArrayLike<number>, labels: ArrayLike<number>, width: number, height: number, radius = 3) {
  const out = new Float32Array(width * height * 3), tmp = new Float32Array(out.length);
  for (let axis = 0; axis < 2; axis++) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x, label = labels[4 * p + 3];
    if (!label) continue;
    let count = 0;
    for (let k = -radius; k <= radius; k++) {
      const xx = axis ? x : x + k, yy = axis ? y + k : y;
      if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
      const q = yy * width + xx;
      if (labels[4 * q + 3] !== label) continue;
      count++;
      for (let c = 0; c < 3; c++) (axis ? out : tmp)[3 * p + c] += axis ? tmp[3 * q + c] : color[4 * q + c];
    }
    for (let c = 0; c < 3; c++) (axis ? out : tmp)[3 * p + c] /= Math.max(1, count);
  }
  return out;
}

class Accumulator {
  eligible = 0; n = 0; full = 0; low = 0; high = 0; a = 0; b = 0; aa = 0; bb = 0; ab = 0;
  add(a: ArrayLike<number>, b: ArrayLike<number>, la: ArrayLike<number>, lb: ArrayLike<number>, p: number, q: number) {
    this.n++;
    let ah = 0, bh = 0;
    for (let c = 0; c < 3; c++) {
      const av = a[4 * p + c], bv = b[4 * q + c], al = la[3 * p + c], bl = lb[3 * q + c];
      this.full += Math.abs(av - bv) / 3;
      this.low += Math.abs(al - bl) / 3;
      this.high += Math.abs((av - al) - (bv - bl)) / 3;
      ah += (av - al) / 3; bh += (bv - bl) / 3;
    }
    this.a += ah; this.b += bh; this.aa += ah * ah; this.bb += bh * bh; this.ab += ah * bh;
  }
  result(): ErrorScore {
    const va = this.aa - this.a * this.a / Math.max(1, this.n), vb = this.bb - this.b * this.b / Math.max(1, this.n);
    return { eligible: this.eligible, samples: this.n, support: this.eligible ? this.n / this.eligible : 0,
      mae: this.n ? this.full / this.n : null, lowBandMae: this.n ? this.low / this.n : null,
      highBandMae: this.n ? this.high / this.n : null,
      highBandCorrelation: this.n >= 20 && va > 1e-6 && vb > 1e-6 ? Math.max(-1, Math.min(1, (this.ab - this.a * this.b / this.n) / Math.sqrt(va * vb))) : null };
  }
}

function interior(f: ValidationFrame, p: number, margin: number) {
  const x = p % f.width, y = Math.floor(p / f.width), id = f.normal[4 * p + 3], depth = f.position[4 * p + 3];
  if (!id || !(depth > 0) || x < margin || y < margin || x >= f.width - margin || y >= f.height - margin) return false;
  for (const [dx, dy] of [[margin, 0], [-margin, 0], [0, margin], [0, -margin]]) {
    const q = (y + dy) * f.width + x + dx;
    if (f.normal[4 * q + 3] !== id || Math.abs(f.position[4 * q + 3] - depth) > .06 * depth + .03) return false;
  }
  return true;
}

/** Directed geometric correspondences; checks the destination's real 3D point, not ray-distance vs camera-Z. */
export function crossViewAgreement(frames: ValidationFrame[], options: { stride?: number; margin?: number; minCos?: number } = {}) {
  frames.forEach(check);
  const { stride = 2, margin = 2, minCos = .15 } = options;
  if (!Number.isInteger(stride) || stride < 1 || !Number.isInteger(margin) || margin < 0) throw new Error('Invalid sampling options');
  const bands = frames.map(f => surfaceLowPass(f.color, f.normal, f.width, f.height));
  const total = new Accumulator(), parts = new Map<number, Accumulator>();
  const pairs: { from: number; to: number; score: ErrorScore }[] = [];
  frames.forEach((a, ai) => frames.forEach((b, bi) => {
    if (ai === bi) return;
    const acc = new Accumulator(), m = b.projection;
    for (let y = margin; y < a.height - margin; y += stride) for (let x = margin; x < a.width - margin; x += stride) {
      const p = y * a.width + x;
      if (!interior(a, p, margin)) continue;
      const part = a.normal[4 * p + 3];
      if (!parts.has(part)) parts.set(part, new Accumulator());
      const pa = parts.get(part)!;
      acc.eligible++; total.eligible++; pa.eligible++;
      const wx = a.position[4 * p], wy = a.position[4 * p + 1], wz = a.position[4 * p + 2];
      const w = m[3] * wx + m[7] * wy + m[11] * wz + m[15];
      if (!(w > 0)) continue;
      const nx = (m[0] * wx + m[4] * wy + m[8] * wz + m[12]) / w;
      const ny = (m[1] * wx + m[5] * wy + m[9] * wz + m[13]) / w;
      const nz = (m[2] * wx + m[6] * wy + m[10] * wz + m[14]) / w;
      if (Math.abs(nx) >= 1 || Math.abs(ny) >= 1 || Math.abs(nz) > 1) continue;
      const bx = Math.floor((nx * .5 + .5) * b.width), by = Math.floor((.5 - ny * .5) * b.height), q = by * b.width + bx;
      if (!interior(b, q, margin) || b.normal[4 * q + 3] !== part) continue;
      const distance = Math.hypot(b.eye[0] - wx, b.eye[1] - wy, b.eye[2] - wz);
      const cos = (a.normal[4 * p] * (b.eye[0] - wx) + a.normal[4 * p + 1] * (b.eye[1] - wy) + a.normal[4 * p + 2] * (b.eye[2] - wz)) / distance;
      if (cos < minCos || Math.hypot(wx - b.position[4 * q], wy - b.position[4 * q + 1], wz - b.position[4 * q + 2]) > .015 + .008 * distance) continue;
      for (const dst of [acc, total, pa]) dst.add(a.color, b.color, bands[ai], bands[bi], p, q);
    }
    pairs.push({ from: a.id, to: b.id, score: acc.result() });
  }));
  return { score: total.result(), parts: Object.fromEntries([...parts].map(([id, a]) => [id, a.result()])), pairs,
    note: 'Geometry-reprojected sRGB agreement, not ground-truth accuracy. Low support is not a good score; null means no evidence.' };
}

/** Held-out image error with an explicit fixed eligible mask and separate reconstruction support. */
export function imageAgreement(target: Uint8ClampedArray, prediction: Uint8ClampedArray, labels: Float32Array,
  eligible: Uint8Array, observed: Uint8Array, width: number, height: number): ErrorScore {
  const n = width * height;
  if (target.length !== n * 4 || prediction.length !== n * 4 || labels.length !== n * 4 || eligible.length !== n || observed.length !== n)
    throw new Error('Image/mask dimensions differ');
  const a = surfaceLowPass(target, labels, width, height), b = surfaceLowPass(prediction, labels, width, height), acc = new Accumulator();
  for (let p = 0; p < n; p++) if (eligible[p]) { acc.eligible++; if (observed[p]) acc.add(target, prediction, a, b, p, p); }
  return acc.result();
}

/** Green = projected observation; amber = inferred fill; magenta = missing; background unchanged. */
export function coverageOverlay(color: Uint8ClampedArray, geometry: Uint8Array, observed: Uint8Array, filled?: Uint8Array) {
  if (color.length !== geometry.length * 4 || observed.length !== geometry.length || (filled && filled.length !== geometry.length))
    throw new Error('Coverage image/mask dimensions differ');
  const out = color.slice();
  for (let p = 0; p < geometry.length; p++) if (geometry[p]) {
    const tint = observed[p] ? [56, 195, 141] : filled?.[p] ? [239, 170, 63] : [222, 74, 153];
    for (let c = 0; c < 3; c++) out[4 * p + c] = .35 * color[4 * p + c] + .65 * tint[c];
    out[4 * p + 3] = 255;
  }
  return out;
}
