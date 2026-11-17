#!/usr/bin/env node
// Write the viewer's own colour grade as a 3D LUT in the .cube format any grading tool reads:
//   node experiments/luxor-view/make-lut.mjs            (writes experiments/luxor-view/public/luxor-gold.cube)
// The grade is for sunlit sandstone under a desert sky, after the photo the scene was built from: the stone's
// oranges are pulled together and deepened, the sky's blue is made denser and a little darker, shadows cool off
// towards teal while highlights warm, and the whole frame gets a gentle S-curve with slightly lifted blacks.
// It works on the finished frame (display values, after the tone curve), which is where a .cube LUT sits.
import fs from 'node:fs';
import path from 'node:path';

const N = 33;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

function toHsl(r, g, b) {
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b), l = (hi + lo) / 2, d = hi - lo;
  if (d < 1e-6) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1) + 1e-6);
  const h = hi === r ? ((g - b) / d + 6) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, clamp(s), l];
}
function fromHsl(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}
/** How much a hue belongs to a band centred on `at` degrees, `width` wide to either side (1 at the centre). */
const band = (h, at, width) => { const d = Math.abs(((h - at + 540) % 360) - 180); return 1 - smooth(0, width, d); };

function grade(r, g, b) {
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // split tone: shadows a little teal, highlights a little warm
  const lo = 1 - smooth(0.0, 0.45, luma), hi = smooth(0.5, 1.0, luma);
  r += -0.018 * lo + 0.030 * hi;
  g += 0.006 * lo + 0.012 * hi;
  b += 0.026 * lo - 0.034 * hi;
  let [h, s, l] = toHsl(clamp(r), clamp(g), clamp(b));
  // the stone: yellows and red-oranges are drawn to one orange, and that orange is deepened
  const stone = band(h, 34, 34);
  h = (h + (30 - h) * 0.35 * stone * (h < 90 ? 1 : 0) + 360) % 360;
  s = clamp(s * (1 + 0.38 * stone) + 0.04 * stone * s);
  // the sky: a denser, slightly darker blue, kept off cyan
  const skyBand = band(h, 215, 40);
  h = (h + (220 - h) * 0.3 * skyBand + 360) % 360;
  s = clamp(s * (1 + 0.22 * skyBand));
  l = l * (1 - 0.07 * skyBand * s);
  [r, g, b] = fromHsl(h, s, l);
  // an S-curve around the middle, with the blacks a touch off the floor
  const curve = (x) => { const k = x * x * (3 - 2 * x); return 0.014 + (1 - 0.014) * mix(x, k, 0.38); };
  return [curve(clamp(r)), curve(clamp(g)), curve(clamp(b))];
}

const lines = ['TITLE "Luxor gold"', '# sunlit sandstone under a desert sky; made by experiments/luxor-view/make-lut.mjs', `LUT_3D_SIZE ${N}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0', ''];
for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
  lines.push(grade(r / (N - 1), g / (N - 1), b / (N - 1)).map((v) => clamp(v).toFixed(5)).join(' '));
}
const out = path.join(import.meta.dirname, 'public', 'luxor-gold.cube');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`${path.relative(process.cwd(), out)}: ${N}³ entries, ${(fs.statSync(out).size / 1e6).toFixed(2)} MB`);
