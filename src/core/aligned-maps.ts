import { CONSERVATIVE_MATERIAL, materialResponse, type MaterialAssignments } from './material-presets';

/** All channels have the same dimensions, UV layout, row order and source crop. Albedo stays in the paint atlas. */
export interface AlignedMapSource {
  size: number;
  layoutHash: string;
  kind: 'dedicated-height' | 'predicted-height' | 'legacy-normal' | 'flat';
  /** Normalized height, RGBA8 with the value in R. Never made from albedo brightness. */
  height?: Uint8ClampedArray;
  /** Optional existing tangent-space normals, used only when there is no height. */
  normal?: Uint8ClampedArray;
  /** RGBA8; the roughness value is in G, with variations around roughnessBase. */
  roughness?: Uint8ClampedArray;
  roughnessBase: number;
  defaultRoughness?: number;
  /** Authored absolute maps are centered per material; relative prediction fields have a known shared baseline. */
  roughnessMode?: 'absolute' | 'relative';
}

export function validateAlignedSource(source: AlignedMapSource) {
  if (!Number.isInteger(source.size) || source.size < 1 || !source.layoutHash ||
      !Number.isFinite(source.roughnessBase) || source.roughnessBase < 0 || source.roughnessBase > 1)
    throw new Error('Invalid aligned map metadata');
  if (!['dedicated-height', 'predicted-height', 'legacy-normal', 'flat'].includes(source.kind) ||
      (source.roughnessMode !== undefined && !['absolute', 'relative'].includes(source.roughnessMode)) ||
      (source.defaultRoughness !== undefined && (!Number.isFinite(source.defaultRoughness) || source.defaultRoughness < 0 || source.defaultRoughness > 1)))
    throw new Error('Invalid aligned map source or default roughness');
  for (const [name, data] of [['height', source.height], ['normal', source.normal], ['roughness', source.roughness]] as const)
    if (data && data.length !== source.size * source.size * 4) throw new Error(`${name} map does not match the aligned map dimensions`);
  if (source.kind.endsWith('height') && !source.height) throw new Error('The aligned set is missing its height source');
}

/** Derive lighting channels together, in the SAME atlas coordinates. Dedicated height always wins over normals. */
export function buildAlignedMaps(source: AlignedMapSource, geometry: { pos: Float32Array; nrm: Float32Array },
  labels: string[], assignments: MaterialAssignments, strength = 1) {
  validateAlignedSource(source);
  if (!Number.isFinite(strength) || strength < 0) throw new Error('Relief strength must be non-negative and finite');
  const { size } = source, count = size * size;
  if (geometry.pos.length !== count * 4 || geometry.nrm.length !== count * 4) throw new Error('Map geometry has a different resolution');
  const normal = source.normal && !source.height ? new Uint8ClampedArray(source.normal) : new Uint8ClampedArray(count * 4);
  const orm = new Uint8ClampedArray(count * 4);
  const responses = labels.map(label => materialResponse(label, assignments));
  const heights = source.height ? new Float32Array(count) : undefined;
  const part = (p: number) => Math.round(geometry.pos[4 * p + 3]) - 1;
  const roughnessBases = new Float32Array(labels.length).fill(source.roughnessBase);
  if (source.roughness && source.roughnessMode === 'absolute') {
    const histograms = labels.map(() => new Uint32Array(256)), counts = new Uint32Array(labels.length);
    for (let p = 0; p < count; p++) { const label = part(p); if (histograms[label] && geometry.nrm[p * 4 + 3] > .5) { histograms[label][source.roughness[p * 4 + 1]]++; counts[label]++; } }
    for (let label = 0; label < labels.length; label++) if (counts[label]) {
      let total = 0;
      for (let value = 0; value < 256; value++) { total += histograms[label][value]; if (total > (counts[label] - 1) / 2) { roughnessBases[label] = value / 255; break; } }
    }
  }
  if (heights) for (let p = 0; p < count; p++) {
    const response = responses[part(p)] ?? CONSERVATIVE_MATERIAL;
    heights[p] = (source.height![4 * p] / 255 - .5) * response.heightMetres;
  }
  const slope = (p: number, lo: number, hi: number, label: number) => {
    if (lo < 0 || hi >= count || part(lo) !== label || part(hi) !== label || geometry.nrm[lo * 4 + 3] < .5 || geometry.nrm[hi * 4 + 3] < .5) return 0;
    if (source.height && (!source.height[lo * 4 + 3] || !source.height[hi * 4 + 3] || !source.height[p * 4 + 3])) return 0;
    // Reject a neighbouring UV island with a different surface orientation.
    const dot = (q: number) => geometry.nrm[p * 4] * geometry.nrm[q * 4] + geometry.nrm[p * 4 + 1] * geometry.nrm[q * 4 + 1] + geometry.nrm[p * 4 + 2] * geometry.nrm[q * 4 + 2];
    if (dot(lo) < .9 || dot(hi) < .9) return 0;
    const distance = Math.hypot(geometry.pos[hi * 4] - geometry.pos[lo * 4], geometry.pos[hi * 4 + 1] - geometry.pos[lo * 4 + 1], geometry.pos[hi * 4 + 2] - geometry.pos[lo * 4 + 2]);
    return distance > 1e-7 ? (heights![hi] - heights![lo]) / distance : 0;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const p = y * size + x, i = p * 4, label = part(p), response = responses[label] ?? CONSERVATIVE_MATERIAL;
    if (!source.normal || heights) { normal[i] = normal[i + 1] = 128; normal[i + 2] = normal[i + 3] = 255; }
    const assigned = !!assignments[labels[label]];
    const sourceBase = roughnessBases[label] ?? source.roughnessBase;
    const base = assigned ? response.roughness : source.roughnessMode === 'absolute' ? sourceBase : source.defaultRoughness ?? source.roughnessBase;
    const rough = source.roughness ? source.roughness[i + 1] / 255 - sourceBase : 0;
    orm[i] = source.roughness?.[i] ?? 255;
    orm[i + 1] = 255 * Math.min(1, Math.max(.08, base + rough * (assigned ? response.roughnessGain : 1)));
    // Paint, ceramic, stone and timber are dielectrics. An exposed-metal mask is needed to make chipped paint metallic.
    orm[i + 2] = 0; orm[i + 3] = 255;
    if (label < 0 || geometry.nrm[i + 3] < .5) continue;
    if (!assigned && !heights && source.normal) continue;
    let nx = 0, ny = 0, nz = 1;
    if (heights) {
      nx = x > 0 && x + 1 < size ? -slope(p, p - 1, p + 1, label) * strength : 0;
      ny = y > 0 && y + 1 < size ? slope(p, p - size, p + size, label) * strength : 0;
      const limit = response.maxSlope, magnitude = Math.hypot(nx, ny);
      if (magnitude > limit) { nx *= limit / magnitude; ny *= limit / magnitude; }
    } else if (source.normal) {
      const gain = (assigned ? response.fallbackRelief : CONSERVATIVE_MATERIAL.fallbackRelief) * strength;
      nx = (source.normal[i] / 127.5 - 1) * gain;
      ny = (source.normal[i + 1] / 127.5 - 1) * gain;
      nz = Math.max(.1, source.normal[i + 2] / 127.5 - 1);
      const magnitude = Math.hypot(nx, ny), limit = nz * response.maxSlope;
      if (magnitude > limit) { nx *= limit / magnitude; ny *= limit / magnitude; }
    }
    const length = Math.hypot(nx, ny, nz);
    normal[i] = (nx / length * .5 + .5) * 255;
    normal[i + 1] = (ny / length * .5 + .5) * 255;
    normal[i + 2] = (nz / length * .5 + .5) * 255;
  }
  return { normal, orm };
}
