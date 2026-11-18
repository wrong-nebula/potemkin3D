/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import { MATERIAL_MODEL, MODELS } from '../providers/models';
import { configureFal } from '../providers/fal';
import { pbrQuote } from '../core/pbr';
import { DEFAULT_PIPELINE, quote, type PipelineEvent, type PipelineOptions } from '../core/pipeline';
import hangar from '../../samples/hangar.look.json';
import luxor from '../../samples/luxor.look.json';
import tatooine from '../../samples/tatooine.look.json';
import { LIGHTING, type Session } from '../session';
import { MATERIAL_PRESETS, isMaterialPreset, suggestMaterialPreset, type MaterialAssignments } from '../core/material-presets';

export interface Sample { name: string; url: string; lighting: 'outdoor' | 'overcast' | 'indoor' | 'indoor-soft'; style: string; roofStyle?: string; floorStyle?: string;
  preset?: 'sento-floor';
  /** Where players can be (min x, y, z, max x, y, z), when the level has more floor than that. */
  area?: number[];
  /** What a place of its own kind brings to a run: its wording, how prompts speak of it, photos of the real place (a look file). */
  look?: Pick<PipelineOptions, 'wording' | 'setting' | 'styleImages' | 'styleMax'> }

export const SAMPLES: Sample[] = [
  { name: 'Village', url: '/samples/village.glb', lighting: 'overcast', style: DEFAULT_PIPELINE.style },
  { name: 'Courtyard', url: '/samples/courtyard.glb', lighting: 'overcast', style: DEFAULT_PIPELINE.style },
  { name: 'Hall', url: '/samples/hall.glb', lighting: 'indoor',
    style: 'an abandoned industrial hall: cracked dusty concrete floor, peeling painted plaster walls, rusted steel beams, grimy window frames',
    roofStyle: 'weathered corrugated metal roofing with rust streaks', floorStyle: 'cracked dusty concrete floor with stains and fine cracks' },
  { name: 'Loft', url: '/samples/loft.glb', lighting: 'indoor',
    style: 'the inside of a modern New York industrial loft: exposed red brick walls, black steel columns and beams, black steel-framed factory windows, a white-painted ceiling, a polished concrete floor; through the windows, brick and stone buildings across the street',
    floorStyle: 'a polished concrete floor: smooth gray concrete with soft mottling, a few hairline cracks and faint straight saw-cut joints',
    area: [-10, 0, -5, 10, 6, 5] },
  // the look lives in samples/luxor.look.json, which the headless script reads too (--look)
  { name: 'Luxor', url: `/${luxor.level}`, lighting: 'overcast', style: luxor.style, floorStyle: luxor.floorStyle,
    look: { wording: luxor.wording as PipelineOptions['wording'], setting: luxor.setting, styleImages: luxor.styleImages } },
  { name: 'Tatooine · benchmark courtyard', url: `/${tatooine.level}`, lighting: 'overcast', style: tatooine.style,
    floorStyle: tatooine.floorStyle, area: tatooine.area,
    look: { wording: tatooine.wording as PipelineOptions['wording'], setting: tatooine.setting } },
  // a painted place: samples/hangar.look.json asks for a background painting ('cel'), not a photo, and is made for MiniMax H3
  { name: 'Hangar', url: `/${hangar.level}`, lighting: 'indoor-soft', style: hangar.style, floorStyle: hangar.floorStyle, area: [...hangar.area, ...hangar.spots.flat()],
    look: { wording: hangar.wording as PipelineOptions['wording'], setting: hangar.setting, styleImages: hangar.styleImages, styleMax: hangar.styleMax } },
  { name: 'Sento · painted floor', url: 'preset:sento-floor', preset: 'sento-floor', lighting: 'overcast',
    style: 'a traditional Japanese bathhouse with pale ceramic floor tiles, blue tiled baths and hand-painted walls',
    floorStyle: 'small pale glazed ceramic tiles with recessed grout and preserved painted wear' },
];

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
};

function drawThumb(canvas: HTMLCanvasElement, data: Uint8ClampedArray, size: number) {
  const tmp = h('canvas');
  tmp.width = tmp.height = size;
  tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), size, size), 0, 0);
  canvas.width = canvas.height = 256;
  canvas.getContext('2d')!.drawImage(tmp, 0, 0, 256, 256);
}

export function mountUi(session: Session, panel: HTMLElement) {
  const sample = h('select', { 'aria-label': 'Level' });
  for (const s of SAMPLES) sample.append(h('option', { value: s.url }, s.name));
  const drop = h('div', { class: 'drop' }, 'Drop a .glb blockout here (needs UVs)');
  const file = h('input', { type: 'file', accept: '.glb,.gltf' });
  file.style.display = 'none';
  const style = h('textarea', { placeholder: 'Materials, not objects: anything named here gets painted onto walls' });
  style.value = SAMPLES[0].style;
  const roofStyle = h('input', { type: 'text', placeholder: 'Roof material' });
  roofStyle.value = SAMPLES[0].roofStyle ?? DEFAULT_PIPELINE.roofStyle;
  const floorStyle = h('input', { type: 'text', placeholder: 'Ground material' });
  floorStyle.value = SAMPLES[0].floorStyle ?? DEFAULT_PIPELINE.floorStyle;
  const floorBox = h('input', { type: 'checkbox' });
  const segLight = h('div', { class: 'seg' });
  const lightBtns = Object.keys(LIGHTING).map((k) => {
    const b = h('button', {}, k[0].toUpperCase() + k.slice(1));
    b.onclick = () => setLighting(k);
    segLight.append(b);
    return [k, b] as const;
  });
  const az = h('input', { type: 'range', min: '0', max: '360', value: '140' });
  const el = h('input', { type: 'range', min: '5', max: '85', value: '48' });
  const firstSel = h('select');
  const fillSel = h('select');
  for (const m of Object.values(MODELS)) {
    firstSel.append(h('option', { value: m.key }, `${m.label} · $${m.price}`));
    fillSel.append(h('option', { value: m.key }, `${m.label} · $${m.price}`));
  }
  firstSel.value = DEFAULT_PIPELINE.firstModel;
  fillSel.value = DEFAULT_PIPELINE.fillModel;
  const budget = h('input', { type: 'range', min: '6', max: '80', value: '36' });
  const budgetLab = h('span', { class: 'lab' }, 'Max views · 36');
  budget.oninput = () => (budgetLab.textContent = `Max views · ${budget.value}`);
  const aerialBox = h('input', { type: 'checkbox', checked: '' });
  const adaptiveBox = h('input', { type: 'checkbox' });
  const checkBox = h('input', { type: 'checkbox', checked: '' });
  const planesBox = h('input', { type: 'checkbox', checked: '' });
  const swatchBox = h('input', { type: 'checkbox' });
  const aoBtn = h('button', {}, 'Bake ambient occlusion · free');
  // Part names, for a level whose file names none: the prompts say what each gray shape is.
  const namesBtn = h('button', {}, 'Name the parts');
  const namesList = h('div', { class: 'parts' });
  const partsSection = h('section', {}, h('label', {}, 'Parts'), namesBtn, namesList,
    h('div', { class: 'note' }, 'This level names none of its parts, so a vision model names its shapes before painting. The image models keep a shape far better when the prompt says what it is. Correct any name here.'));
  partsSection.style.display = 'none';
  const atlasSel = h('select');
  for (const [v, l] of [['2048', '2K texture'], ['4096', '4K texture'], ['8192', '8K texture']]) atlasSel.append(h('option', { value: v }, l));
  atlasSel.value = '8192';
  const viewSel = h('select');
  for (const [v, l] of [['2048', '2K views'], ['1024', '1K views (quicker, a little cheaper, about half the detail)']]) viewSel.append(h('option', { value: v }, l));
  const layoutSel = h('select');
  for (const [v, l] of [['file', "The level's own UVs"], ['seen', 'Texture laid out by what players see'], ['near', 'Faces joined, sized by how near players get']]) layoutSel.append(h('option', { value: v }, l));
  const modeSel = h('select', { 'aria-label': 'Planner mode' });
  for (const [v, l] of [['auto', 'Mode · Auto (level or standalone prop)'], ['level', 'Mode · Level (walkable floor)'], ['object', 'Mode · Object (Fibonacci sphere + close-ups)']]) modeSel.append(h('option', { value: v }, l));
  const planBtn = h('button', {}, 'Plan cameras');
  const runBtn = h('button', { class: 'primary' }, 'Texture level');
  const stopBtn = h('button', {}, 'Stop');
  const stat = (label: string) => { const b = h('b', {}, '–'); return [h('div', { class: 'stat' }, b, h('i', {}, label)), b] as const; };
  const [sViews, vViews] = stat('views');
  const [sCov, vCov] = stat('surface');
  const [sCost, vCost] = stat('cost');
  const [sTime, vTime] = stat('time');
  const thumbSees = h('canvas');
  const thumbPaints = h('canvas');
  const segMode = h('div', { class: 'seg' });
  const clayBtn = h('button', { class: 'on' }, 'Clay');
  const texBtn = h('button', {}, 'Textured');
  const litBtn = h('button', {}, 'Lit');
  segMode.append(clayBtn, texBtn, litBtn);
  const weightsSel = h('select', { 'aria-label': 'Surface weights overlay' });
  for (const [v, l] of [
    ['off', 'Weights overlay · Off'],
    ['openness', 'Weights · Openness (AO / cavity)'],
    ['curvature', 'Weights · Convex curvature'],
    ['light', 'Weights · Static light'],
    ['class', 'Weights · Semantic class'],
    ['importance', 'Weights · Combined importance'],
  ]) weightsSel.append(h('option', { value: v }, l));
  const camsBox = h('input', { type: 'checkbox', checked: '' });
  const walkBtn = h('button', {}, 'Walk the level');
  const hint = h('div', { id: 'hint' }, 'W A S D to move · Shift to run · Space to jump · click to look around · Esc to leave');
  document.body.append(hint);
  const pbrBtn = h('button', {}, 'Make normal + roughness maps');
  const materialSurface = h('select', { 'aria-label': 'Material surface' });
  const materialPreset = h('select', { 'aria-label': 'Material response' });
  materialPreset.append(h('option', { value: '' }, 'Original material'));
  for (const [id, preset] of Object.entries(MATERIAL_PRESETS)) materialPreset.append(h('option', { value: id }, preset.name));
  const suggestMaterials = h('button', {}, 'Use presets from surface names · free');
  const materialNote = h('div', { class: 'note' });
  const relief = h('input', { type: 'range', min: '0', max: '2', step: '0.05', value: '1' });
  const floorDetailBox = h('input', { type: 'checkbox' });
  const floorDetailNote = h('div', { class: 'note' });
  const floorDetailControls = h('div', {}, h('label', { class: 'row note' }, floorDetailBox, 'Fine floor detail · Lit view'), floorDetailNote);
  floorDetailControls.hidden = true;
  const floorExportNote = h('div', { class: 'note' }, 'Fine floor detail is a live viewer effect. Downloads retain the original painted texture and baked maps.');
  floorExportNote.hidden = true;
  const runSel = h('select');
  const runBtnLoad = h('button', {}, 'Load');
  const runsSection = h('section', {}, h('label', {}, 'Saved runs'), h('div', { class: 'row' }, runSel, runBtnLoad),
    h('div', { class: 'note' }, 'Runs are written to runs/ view by view as they paint, so a closed tab loses nothing paid for.'));
  runsSection.style.display = 'none';
  const glbBtn = h('button', {}, 'Download .glb');
  const texDl = h('button', {}, 'Download texture');
  const mapsDl = h('button', {}, 'Download material maps');
  mapsDl.style.display = 'none';
  const key = h('input', { type: 'password', placeholder: 'fal key (optional)' });
  key.value = localStorage.getItem('trompe.falKey') ?? '';
  const log = h('div', { class: 'log' });
  const say = (msg: string) => { log.textContent = `${msg}\n${log.textContent}`.slice(0, 6000); };

  panel.append(
    h('div', {}, h('h1', {}, 'trompe', h('span', {}, '.')), h('div', { class: 'sub' }, 'Texture a whole level from a blockout.')),
    h('section', {}, h('label', {}, 'Level'), sample, drop, file),
    runsSection,
    h('section', {}, h('label', {}, 'Look'), style, h('div', { class: 'lab' }, 'Roofs'), roofStyle, h('div', { class: 'lab' }, 'Ground'), floorStyle),
    partsSection,
    h('section', {}, h('label', {}, 'Light'), segLight, h('div', { class: 'row' }, h('span', { class: 'lab' }, 'Sun'), az, el)),
    h('section', {}, h('label', {}, 'Models'), h('div', { class: 'lab' }, 'First view'), firstSel, h('div', { class: 'lab' }, 'Fills'), fillSel),
    h('section', {}, budgetLab, budget,
      h('label', { class: 'row note' }, adaptiveBox, 'Adaptive importance-driven cameras (focus views on lit, open, curved and player-near surfaces)'),
      h('label', { class: 'row note' }, aerialBox, 'Also paint roofs and outer walls (roof and aerial cameras)'),
      h('label', { class: 'row note' }, floorBox, 'Paint the ground from straight above first, so it is not stretched (floor cameras)'),
      h('label', { class: 'row note' }, checkBox, 'Check each view against the blockout and repaint what the model painted over (SAM 2.1, runs in this tab)'),
      h('label', { class: 'row note' }, planesBox, 'Also check that flat walls and floors come out flat and facing the right way (MoGe-2 on fal, about 1¢ a view)'),
      h('label', { class: 'row note' }, swatchBox, 'Show mostly-unpainted views material samples from the texture so far (experimental)'),
      atlasSel, viewSel, layoutSel, modeSel, h('div', { class: 'row' }, planBtn, stopBtn), runBtn),
    h('section', {}, h('div', { class: 'stats' }, sViews, sCov, sCost, sTime),
      h('div', { class: 'thumbs' }, thumbSees, thumbPaints), h('div', { class: 'row note' }, h('span', {}, 'Model sees'), h('span', {}, 'Model paints'))),
    h('section', {}, h('label', {}, 'Materials'), materialSurface, materialPreset, materialNote, suggestMaterials, pbrBtn,
      h('div', { class: 'row' }, h('span', { class: 'lab' }, 'Relief'), relief), floorDetailControls, aoBtn,
      h('div', { class: 'note' }, `${MATERIAL_MODEL.label} predicts height and roughness together. Normals come from that height; presets set each surface's response. Original paint stays intact. Baked normal and roughness maps are exported with the .glb.`)),
    h('section', {}, h('label', {}, 'Display'), segMode, weightsSel, h('label', { class: 'row note' }, camsBox, 'Show cameras'), walkBtn),
    h('section', {}, h('label', {}, 'Export'), h('div', { class: 'row' }, glbBtn, texDl), mapsDl, floorExportNote),
    h('section', {}, h('label', {}, 'fal'), key, h('div', { class: 'note' }, 'Empty: uses FAL_KEY from the dev server. A key here is stored in this browser and sent straight to fal.')),
    log,
  );

  const lightingKey = () => lightBtns.find(([, b]) => b.classList.contains('on'))?.[0] ?? 'outdoor';
  function setLighting(k: string) {
    for (const [name, b] of lightBtns) b.classList.toggle('on', name === k);
    const base = LIGHTING[k];
    az.value = String(base.sunAzimuth);
    el.value = String(base.sunElevation);
    session.setLighting(base);
  }
  // In the lit display the sliders move the display sun (shadows follow live); otherwise the light the models paint in.
  const applySun = () => {
    const v = session.viewer;
    if (v?.mode === 'lit') {
      v.displayLighting = { ...LIGHTING.outdoor, sunAzimuth: +az.value, sunElevation: +el.value };
      v.syncLighting();
    } else session.setLighting({ ...LIGHTING[lightingKey()], sunAzimuth: +az.value, sunElevation: +el.value });
  };
  az.oninput = applySun;
  el.oninput = applySun;

  const setMode = (m: 'clay' | 'textured' | 'lit') => {
    weightsSel.value = 'off';
    session.viewer?.setWeightOverlay('off');
    session.viewer?.setMode(m);
    clayBtn.classList.toggle('on', m === 'clay');
    texBtn.classList.toggle('on', m === 'textured');
    litBtn.classList.toggle('on', m === 'lit');
  };
  clayBtn.onclick = () => setMode('clay');
  texBtn.onclick = () => setMode('textured');
  litBtn.onclick = () => setMode('lit');
  weightsSel.onchange = () => {
    try {
      const r = session.setWeightOverlay(weightsSel.value as 'off' | 'openness' | 'curvature' | 'light' | 'class' | 'importance');
      if (r.overlay !== 'off') {
        const cls = Object.entries(r.classes).filter(([, s]) => s >= 0.01).map(([k, s]) => `${k} ${Math.round(100 * s)}%`).join(', ');
        say(`weights (${r.overlay}, ${r.seconds}s): mean openness ${r.mean.openness}, curvature ${r.mean.curvature}, light ${r.mean.light}, importance ${r.mean.importance} · ${cls}`);
      }
    } catch (e) { say(String((e as Error)?.message ?? e)); }
  };
  camsBox.onchange = () => { if (session.viewer) { session.viewer.overlay.visible = camsBox.checked; session.viewer.dirty = true; } };

  // Walk the level from the player spot nearest what the camera looks at, facing that way.
  const walking = (on: boolean) => {
    walkBtn.textContent = on ? 'Stop walking (Esc)' : 'Walk the level';
    walkBtn.classList.toggle('on', on);
    hint.classList.toggle('show', on);
  };
  walkBtn.onclick = () => {
    const v = session.viewer;
    if (!v) return;
    if (v.walker) { v.stopWalk(); walking(false); return; }
    try {
      const eye = session.walkStart();
      const to = v.controls.target;
      const yaw = Math.hypot(to.x - eye.x, to.z - eye.z) > 0.5 ? Math.atan2(eye.x - to.x, eye.z - to.z) : 0;
      v.startWalk(eye, yaw, () => walking(false));
      walking(true);
      walkBtn.blur();   // so Space jumps instead of pressing the button again
    } catch (e) { say(String(e)); }
  };

  const money = (n: number) => `$${n.toFixed(2)}`;
  // one editable name per shape, largest first; unnamed shapes show as empty fields
  const syncParts = () => {
    const level = session.level;
    partsSection.style.display = level?.shapes ? '' : 'none';
    if (!level?.shapes) return;
    const named = level.labels.some(Boolean);
    namesBtn.textContent = named ? 'Name the parts again' : `Name the ${level.shapes.length} parts · about ${money(0.006 * Math.min(48, level.shapes.length))}`;
    namesList.replaceChildren(...(named ? level.labels.map((name, k) => {
      const input = h('input', { type: 'text', placeholder: `shape ${k + 1}, ${Math.round(level.shapes![k].area)} m²` });
      input.value = name;
      input.onchange = () => session.setPartName(k, input.value);
      return input;
    }) : []));
  };
  namesBtn.onclick = async () => {
    if (!session.level?.shapes) return;
    key.value ? localStorage.setItem('trompe.falKey', key.value) : localStorage.removeItem('trompe.falKey');
    configureFal(key.value || undefined);
    namesBtn.disabled = runBtn.disabled = true;
    try {
      const r = await session.nameParts(style.value, (done, total) => { namesBtn.textContent = `Naming shape ${done}/${total}…`; });
      say(`named ${r.names.filter(Boolean).length} of ${r.names.length} shapes, ${money(r.cost)}, ${Math.round(r.seconds)}s`);
    } catch (e) {
      say(String((e as Error)?.message ?? e));
    } finally {
      namesBtn.disabled = runBtn.disabled = false;
      syncParts();
    }
  };
  const syncPbr = () => {
    const e = session.engine;
    const have = !!e?.pbr;
    pbrBtn.textContent = e ? `Predict aligned material maps · up to ${money(pbrQuote(e.atlas.size).cost)}` : 'Predict aligned material maps';
    const labels = session.level?.labels.filter(Boolean) ?? [];
    if (Array.from(materialSurface.options, option => option.value).join('\n') !== labels.join('\n')) {
      const selected = materialSurface.value;
      materialSurface.replaceChildren(...labels.map(label => h('option', { value: label }, label)));
      if (labels.includes(selected)) materialSurface.value = selected;
    }
    materialSurface.disabled = materialPreset.disabled = !labels.length;
    suggestMaterials.disabled = !labels.length;
    materialPreset.value = e?.materialPresets[materialSurface.value] ?? '';
    const preset = isMaterialPreset(materialPreset.value) ? MATERIAL_PRESETS[materialPreset.value] : undefined;
    const source = e?.pbr?.source?.kind;
    const floorHeight = session.viewer?.floorDetailState.enabled && session.viewer.floorDetailState.label === materialSurface.value;
    materialNote.textContent = preset ? `Roughness ${preset.roughness.toFixed(2)} · height span up to ${(preset.heightMetres * 1000).toFixed(2)} mm. ` +
      (floorHeight ? 'Normals follow the aligned floor height.' : source?.endsWith('height') ? 'Normals follow the aligned height map.' : source === 'legacy-normal' ? 'Existing normals use restrained relief.' : 'Flat until a height or normal source is available.')
      : 'Choose a response for this surface. Presets keep the painted colors and can be changed without a model call.';
    const detail = session.viewer?.floorDetailState;
    floorDetailControls.hidden = !detail?.available;
    floorDetailBox.checked = !!detail?.enabled;
    floorDetailBox.disabled = !!detail?.stale;
    floorDetailNote.textContent = detail?.stale ? 'Paused after repainting. Reload the prepared Sento floor to use its reviewed paint mask.'
      : 'Sharper tiles and grout, with the painted marks preserved. Toggle to compare.';
    floorExportNote.hidden = !detail?.available;
    relief.disabled = !have && !detail?.enabled;
    mapsDl.style.display = have ? '' : 'none';
    aoBtn.textContent = e?.ao ? 'Bake ambient occlusion again · free' : 'Bake ambient occlusion · free';
  };
  relief.oninput = () => session.viewer?.setRelief(+relief.value);
  materialSurface.onchange = syncPbr;
  const applyMaterials = async (assignments: MaterialAssignments) => {
    const engine = session.engine;
    materialPreset.disabled = suggestMaterials.disabled = true;
    materialNote.textContent = 'Updating material responses…';
    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (engine !== session.engine) return;
      session.setMaterialPresets(assignments);
      setMode('lit');
      if (savedAs) await session.saveRun(savedAs);
    } catch (e) { say(String((e as Error).message)); }
    finally { syncPbr(); }
  };
  materialPreset.onchange = () => {
    const assignments = { ...session.engine?.materialPresets };
    if (isMaterialPreset(materialPreset.value)) assignments[materialSurface.value] = materialPreset.value;
    else delete assignments[materialSurface.value];
    void applyMaterials(assignments);
  };
  suggestMaterials.onclick = () => {
    const assignments = { ...session.engine?.materialPresets };
    const suggested = session.level ? session.suggestMaterialPresets() : {};
    for (const label of session.level?.labels ?? []) {
      const preset = suggestMaterialPreset(label) ?? suggested[label];
      if (preset && !assignments[label]) assignments[label] = preset;
    }
    void applyMaterials(assignments);
  };
  floorDetailBox.onchange = () => {
    try {
      session.viewer?.setFloorDetailEnabled(floorDetailBox.checked);
      if (floorDetailBox.checked) setMode('lit');
    } catch (e) { say(String(e)); }
    syncPbr();
  };
  // Ambient occlusion: rays against the level's own geometry, so no model and no cost; about 15 to 30 s.
  aoBtn.onclick = async () => {
    if (!session.engine) return;
    aoBtn.disabled = true;
    try {
      const ao = await session.bakeAo({}, (done, total) => { aoBtn.textContent = `Baking occlusion: ${Math.round((100 * done) / Math.max(1, total))}%`; });
      setMode('lit');
      say(`ambient occlusion: ${ao.size} px, ${ao.rays} rays a texel, ${Math.round(ao.seconds)}s. Shown in the Lit display and exported in the .glb's occlusion channel.`);
      if (savedAs) { await session.saveRun(savedAs); say(`saved with runs/${savedAs}/`); }
    } catch (e) {
      say(String((e as Error)?.message ?? e));
    } finally {
      aoBtn.disabled = false;
      syncPbr();
    }
  };
  pbrBtn.onclick = async () => {
    if (!session.engine) return;
    key.value ? localStorage.setItem('trompe.falKey', key.value) : localStorage.removeItem('trompe.falKey');
    configureFal(key.value || undefined);
    pbrBtn.disabled = runBtn.disabled = true;
    try {
      say('reading the texture for relief and roughness…');
      const m = await session.makePbr({}, (done, total) => { pbrBtn.textContent = `Maps: tile ${done}/${total}…`; });
      session.viewer?.setRelief(+relief.value);
      if (session.record) vCost.textContent = money(session.record.cost + m.cost);
      setMode('lit');
      say(`maps: ${m.size} px from ${m.tiles} tile${m.tiles > 1 ? 's' : ''}, ${money(m.cost)}, ${Math.round(m.seconds)}s. Shown in the Lit display; move the sun to see them.`);
      if (savedAs) { await session.saveRun(savedAs); say(`saved with runs/${savedAs}/`); }
    } catch (e) {
      say(String((e as Error)?.message ?? e));
    } finally {
      pbrBtn.disabled = runBtn.disabled = false;
      syncPbr();
    }
  };

  // Saved runs (dev server only): everything painted is on disk, and can be opened again without calling a model.
  let savedAs: string | undefined;
  const canSave = import.meta.env.DEV;
  const listRuns = async () => {
    if (!canSave) return;
    try {
      const runs = (await (await fetch('/api/runs')).json()) as { id: string; level: string; views: number; cost: number; partial: boolean }[];
      // the scripts name a level after its file, the samples here are capitalised: same level either way
      const mine = runs.filter((r) => r.level.toLowerCase() === session.level?.name.toLowerCase());
      runSel.replaceChildren(...mine.map((r) => h('option', { value: r.id }, `${r.id} · ${r.views} views · ${money(r.cost)}${r.partial ? ' · unfinished' : ''}`)));
      runsSection.style.display = mine.length ? '' : 'none';
    } catch { runsSection.style.display = 'none'; }
  };
  runBtnLoad.onclick = async () => {
    if (!runSel.value || !session.engine) return;
    runBtnLoad.disabled = runBtn.disabled = true;
    try {
      say(`loading run ${runSel.value}…`);
      const meta = await session.loadRun(runSel.value);
      savedAs = runSel.value;
      style.value = meta.options.style;
      if (meta.options.roofStyle) roofStyle.value = meta.options.roofStyle;
      if (meta.options.floorStyle) floorStyle.value = meta.options.floorStyle;
      vViews.textContent = String(meta.views.length);
      vCov.textContent = `${Math.round(100 * (meta.views.at(-1)?.predicted ?? 0))}%`;
      vCost.textContent = money(meta.cost + (meta.pbr?.cost ?? 0));
      vTime.textContent = `${Math.round(meta.seconds)}s`;
      syncParts();
      setMode(session.engine.pbr || session.viewer?.floorDetailState.enabled ? 'lit' : 'textured');
      say(`run ${runSel.value}: ${meta.views.length} views, ${money(meta.cost)}${meta.partial ? ' (unfinished: continue it with scripts/texture.mjs --resume)' : ''}` +
        (meta.viewSize && session.engine && meta.viewSize > session.engine.size ? `. It was painted with ${meta.viewSize} px views; pick 2K views above to see it at full detail` : '') +
        (meta.mapsSkipped ? '. Its maps were made on another texture layout and were left out; switch the layout above to see them, or make them again.' : '') +
        (meta.floorDetailSkipped ? `. Floor detail was left off: ${meta.floorDetailSkipped}` : ''));
    } catch (e) {
      say(String((e as Error)?.message ?? e));
    } finally {
      runBtnLoad.disabled = runBtn.disabled = false;
      syncPbr();
    }
  };

  async function load(src: string | ArrayBuffer, name: string, lighting: string, area?: number[]) {
    say(`loading ${name}…`);
    const prepared = SAMPLES.find(s => s.url === src)?.preset === 'sento-floor';
    atlasSel.disabled = layoutSel.disabled = prepared;
    atlasSel.title = layoutSel.title = prepared ? 'The prepared Sento floor keeps its reviewed texture and UV layout.' : '';
    if (prepared) { atlasSel.value = '2048'; layoutSel.value = 'file'; }
    const info = prepared ? await session.loadSentoFloor(+viewSel.value) :
      await session.load(src, name, LIGHTING[lighting], +atlasSel.value, +viewSel.value, layoutSel.value as 'file' | 'seen' | 'near', area, 1, 'auto', 0, false, modeSel.value as 'auto' | 'level' | 'object');
    setLighting(lighting);
    setMode(prepared ? 'lit' : 'clay');
    walking(false);
    savedAs = undefined;
    for (const b of [vViews, vCov, vCost, vTime]) b.textContent = '–';
    syncPbr();
    syncParts();
    void listRuns();
    const l = info.layout;
    const u = 'unwrap' in info ? info.unwrap : undefined;
    say(`${name}${info.mode === 'object' ? ' (object mode)' : ''}: ${info.triangles.toLocaleString()} triangles, ${info.area.toLocaleString()} m² of surface` +
      (u ? `. Its UVs were made from scratch (${u.reason}): ${u.charts.toLocaleString()} charts filling ${Math.round(100 * u.fill)}% of the texture` : '') +
      (!l ? '' : l.applied ? `. Players can see ${Math.round(100 * l.seenSurface)}% of it; laid out again, those faces get ${l.gain.toFixed(2)}× the texels along each side.`
        : `. Laying the texture out by what players see would gain only ${l.gain.toFixed(2)}×, so the level's own UVs are kept.`));
  }
  atlasSel.onchange = viewSel.onchange = layoutSel.onchange = modeSel.onchange = () => sample.onchange?.(new Event('change'));
  sample.onchange = () => {
    const s = SAMPLES.find((x) => x.url === sample.value)!;
    style.value = s.style;
    roofStyle.value = s.roofStyle ?? DEFAULT_PIPELINE.roofStyle;
    floorStyle.value = s.floorStyle ?? DEFAULT_PIPELINE.floorStyle;
    void load(s.url, s.name, s.lighting, s.area).catch((e) => say(String(e)));
  };
  drop.onclick = () => file.click();
  const loadFile = async (f: File) => load(await f.arrayBuffer(), f.name.replace(/\.\w+$/, ''), lightingKey());
  file.onchange = () => { if (file.files?.[0]) void loadFile(file.files[0]).catch((e) => say(String(e))); };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f) void loadFile(f).catch((err) => say(String(err)));
  };

  const planOpts = () => {
    const obj = modeSel.value === 'object' || (modeSel.value === 'auto' && session.level?.mode === 'object');
    return {
      maxViews: +budget.value,
      adaptive: adaptiveBox.checked,
      mode: modeSel.value as 'auto' | 'level' | 'object',
      aerial: !obj && aerialBox.checked ? 8 : 0,
      roofs: !obj && aerialBox.checked ? 24 : 0,
      floors: !obj && floorBox.checked ? 24 : 0,
      holes: obj ? 0 : 12,
    };
  };
  planBtn.onclick = () => {
    try {
      const p = session.makePlan(planOpts());
      // the quote, before anything is spent: the most these views can cost and about how long they take
      const q = quote(p, { firstModel: firstSel.value, fillModel: fillSel.value, holes: planOpts().holes,
        secondGoes: checkBox.checked ? DEFAULT_PIPELINE.checkRetries : 0, planes: checkBox.checked && planesBox.checked,
        viewSize: session.engine?.size });
      vViews.textContent = String(p.views.length);
      vCov.textContent = `${Math.round(100 * p.predicted[p.predicted.length - 1])}%`;
      vCost.textContent = `≤${money(q.cost)}`;
      vTime.textContent = `~${Math.max(1, Math.round(q.seconds / 60))}m`;
      say(`planned ${p.views.length} views from ${p.points.length} spots, ${p.waves.length} waves, ` +
        `${Math.round(100 * (p.predicted[p.predicted.length - 1] ?? 0))}% of reachable surface. ` +
        (p.texture ? `Players' cameras can see ${Math.round(100 * p.texture.seen)}% of the texture` +
          (p.texture.seen < 0.5 ? '; the rest of its resolution goes to faces nobody sees. ' : '. ') : '') +
        (p.budget ? `Adaptive (${p.budget.rounds} rounds, ${p.budget.probedCandidates} probes): knee at ${p.budget.recommendedViews} views, limit is ${p.budget.bottleneck}, ${p.budget.sparseHeightTiles.active}/${p.budget.sparseHeightTiles.total} PBR tiles hold important surface. ` : '') +
        `At most ${money(q.cost)} and about ${Math.max(1, Math.round(q.seconds / 60))} min, counting up to ${planOpts().holes} views for holes` +
        (q.again ? ` and ${money(q.again)} for second goes at whatever the blockout check holds back (only the views that need one)` : '') +
        (q.planes ? `, and ${money(q.planes)} for the plane check.` : '.'));
    } catch (e) { say(String(e)); }
  };
  runBtn.onclick = async () => {
    key.value ? localStorage.setItem('trompe.falKey', key.value) : localStorage.removeItem('trompe.falKey');
    configureFal(key.value || undefined);
    runBtn.disabled = planBtn.disabled = true;
    const S = session.engine?.size ?? 1024;
    let n = 0;
    const onEvent = (e: PipelineEvent) => {
      if (e.type === 'planned') { vViews.textContent = `0/${e.plan.views.length}`; say(`painting ${e.plan.views.length} views in ${e.plan.waves.length} waves`); }
      if (e.type === 'check') say(e.message);
      if (e.type === 'parts') { say(e.message); if (e.names) syncParts(); }
      if (e.type === 'view-start') drawThumb(thumbSees, e.state, S);
      if (e.type === 'view-done') {
        drawThumb(thumbPaints, e.view.gen, S);
        vViews.textContent = `${++n}/${session.plan?.views.length ?? '?'}`;
        vCov.textContent = `${Math.round(100 * e.view.predicted)}%`;
        vCost.textContent = `$${e.cost.toFixed(2)}`;
        vTime.textContent = `${Math.round(e.elapsed)}s`;
        say(`view ${e.view.index} · ${e.view.model} · ${e.view.seconds.toFixed(1)}s` +
          (e.view.spec.again ? ' · second go' : '') + (e.view.swatches ? ' · with material samples' : '') + (e.view.ignored ? ` · ${Math.round(100 * e.view.ignored)}% painted over the blockout, held back` : ''));
      }
      if (e.type === 'error') say(/abort/i.test(e.message) ? `view ${e.index} stopped` : `view ${e.index} failed: ${e.message}`);
      if (e.type === 'done') say(`done: ${e.record.views.length} views, $${e.record.cost.toFixed(2)}, ${Math.round(e.record.seconds)}s`);
    };
    savedAs = canSave ? `${session.level!.name.replace(/[^\w.-]+/g, '-')}-${Date.now().toString(36)}` : undefined;
    if (savedAs) say(`saving to runs/${savedAs}/ as it paints`);
    try {
      await session.run({ style: style.value, roofStyle: roofStyle.value, floorStyle: floorStyle.value, firstModel: firstSel.value, fillModel: fillSel.value,
        ...(SAMPLES.find((x) => x.url === sample.value && x.name === session.level?.name)?.look ?? {}),
        check: checkBox.checked, checkPlanes: planesBox.checked, styleReference: swatchBox.checked, plan: planOpts() }, onEvent, savedAs);
      setMode('textured');
    } catch (e) {
      say(String(e));
    } finally {
      runBtn.disabled = planBtn.disabled = false;
      syncPbr();
      void listRuns();
    }
  };
  stopBtn.onclick = () => session.stop();
  const download = (blob: Blob, name: string) => {
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  glbBtn.onclick = async () => {
    if (!session.engine) return;
    download(new Blob([await session.exportGlb()], { type: 'model/gltf-binary' }), `${session.level!.name}_textured.glb`);
  };
  texDl.onclick = async () => {
    if (!session.engine) return;
    const atlas = session.engine.atlas;
    const { data, size } = atlas.readBytes([0.5, 0.5, 0.5], Math.min(atlas.size, 8192));   // several textures: side by side, as one picture
    const c = h('canvas');
    c.width = c.height = size;
    c.getContext('2d')!.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, size, size), 0, 0);
    c.toBlob((b) => b && download(b, `${session.level!.name}_texture.png`), 'image/png');
  };
  mapsDl.onclick = () => {
    const pbr = session.engine?.pbr;
    if (!pbr) return;
    const maps: [Uint8ClampedArray, string][] = [[pbr.normal, 'normal'], [pbr.orm, 'orm']];
    if (pbr.source?.height) maps.push([pbr.source.height, 'height_source']);
    for (const [data, name] of maps) {
      const c = h('canvas');
      c.width = c.height = pbr.size;
      c.getContext('2d')!.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, pbr.size, pbr.size), 0, 0);
      c.toBlob((b) => b && download(b, `${session.level!.name}_${name}.png`), 'image/png');
    }
  };

  setLighting(SAMPLES[0].lighting);
  sample.value = new URLSearchParams(location.search).get('sample') === 'sento' ? 'preset:sento-floor' : '/samples/village.glb';
  sample.onchange?.(new Event('change'));
}
