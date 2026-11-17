/** Artist-selected starting points, not measured properties of the photographed surfaces. */
export const MATERIAL_PRESETS = {
  limestone: { name: 'Limestone', roughness: .82, roughnessGain: .55, fallbackRelief: .3, heightMetres: .0012, maxSlope: .45 },
  'glazed-tile': { name: 'Glazed tile', roughness: .32, roughnessGain: 1, fallbackRelief: .18, heightMetres: .002, maxSlope: .85 },
  'painted-metal': { name: 'Painted metal', roughness: .42, roughnessGain: .4, fallbackRelief: .15, heightMetres: .00025, maxSlope: .2 },
  timber: { name: 'Timber', roughness: .62, roughnessGain: .7, fallbackRelief: .25, heightMetres: .0007, maxSlope: .35 },
} as const;

export type MaterialPresetId = keyof typeof MATERIAL_PRESETS;
export type MaterialAssignments = Record<string, MaterialPresetId>;
export interface MaterialResponse {
  name: string; roughness: number; roughnessGain: number; fallbackRelief: number; heightMetres: number; maxSlope: number;
}
export const CONSERVATIVE_MATERIAL: MaterialResponse = {
  name: 'Unclassified', roughness: .88, roughnessGain: .6, fallbackRelief: .25, heightMetres: .0004, maxSlope: .25,
};

export function isMaterialPreset(value: unknown): value is MaterialPresetId {
  return typeof value === 'string' && Object.hasOwn(MATERIAL_PRESETS, value);
}

export function validateMaterialAssignments(assignments: MaterialAssignments, labels: string[]): MaterialAssignments {
  const result: MaterialAssignments = {};
  for (const [label, preset] of Object.entries(assignments)) {
    if (!labels.includes(label)) throw new Error(`Unknown material surface: ${label}`);
    if (!isMaterialPreset(preset)) throw new Error(`Unknown material preset: ${String(preset)}`);
    result[label] = preset;
  }
  return result;
}

/** Suggestions are editable assignments, not an image classifier. Ambiguous names stay unassigned. */
export function suggestMaterialPreset(label: string): MaterialPresetId | undefined {
  if (/\blimestone\b/i.test(label)) return 'limestone';
  if (/\b(glazed|ceramic|tiled|tile)\b/i.test(label)) return 'glazed-tile';
  if (/\b(painted|coated)\b.*\b(metal|steel|iron|aluminium|aluminum)\b/i.test(label)) return 'painted-metal';
  if (/\b(wood|wooden|timber|cypress)\b/i.test(label) && !/\b(painted|plastic)\b/i.test(label)) return 'timber';
  return undefined;
}

export function materialResponse(label: string, assignments: MaterialAssignments): MaterialResponse {
  const id = assignments[label];
  return isMaterialPreset(id) ? MATERIAL_PRESETS[id] : CONSERVATIVE_MATERIAL;
}
