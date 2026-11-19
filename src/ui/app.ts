/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import '@ui-sdk/web/alert-dialog';
import '@ui-sdk/web/button';
import '@ui-sdk/web/checkbox';
import '@ui-sdk/web/dialog';
import '@ui-sdk/web/field';
import '@ui-sdk/web/file-input';
import '@ui-sdk/web/input';
import '@ui-sdk/web/listbox';
import '@ui-sdk/web/password-input';
import '@ui-sdk/web/resizable';
import '@ui-sdk/web/segmented-control';
import '@ui-sdk/web/select';
import '@ui-sdk/web/slider';
import '@ui-sdk/web/tabs';
import '@ui-sdk/web/textarea';
import '@ui-sdk/web/toggle';
import { createConfirm, type UiAlertDialogElement } from '@ui-sdk/web/alert-dialog';
import type { UiButtonElement } from '@ui-sdk/web/button';
import type { UiCheckboxElement } from '@ui-sdk/web/checkbox';
import type { UiDialogElement } from '@ui-sdk/web/dialog';
import type { UiFileInputElement } from '@ui-sdk/web/file-input';
import type { UiInputElement } from '@ui-sdk/web/input';
import type { UiListboxElement } from '@ui-sdk/web/listbox';
import type { UiPasswordInputElement } from '@ui-sdk/web/password-input';
import type { UiResizableElement } from '@ui-sdk/web/resizable';
import type { UiSegmentedControlElement } from '@ui-sdk/web/segmented-control';
import type { UiSelectElement } from '@ui-sdk/web/select';
import type { UiSliderElement } from '@ui-sdk/web/slider';
import type { UiTabsElement } from '@ui-sdk/web/tabs';
import type { UiTextareaElement } from '@ui-sdk/web/textarea';
import type { UiToggleElement } from '@ui-sdk/web/toggle';
import * as THREE from 'three';
import { setAgentConfirmHandler } from '../agent';
import type { makeApi } from '../api';
import type { CritiqueReport } from '../core/critic';
import type { Note } from '../core/notes';
import { MATERIAL_PRESETS, isMaterialPreset, suggestMaterialPreset, type MaterialAssignments } from '../core/material-presets';
import { pbrQuote } from '../core/pbr';
import { DEFAULT_PIPELINE, quote, type PipelineEvent, type PipelineOptions } from '../core/pipeline';
import { configureFal } from '../providers/fal';
import { MODELS } from '../providers/models';
import { configureProvider, type LocalBackend, type ProviderKind } from '../providers/router';
import { LIGHTING, type Session } from '../session';
import { buildCriticMarkdown, buildMonitorMarkdown, mountWordsView, renderStandaloneStudioReport } from './words';
import hangar from '../../samples/hangar.look.json';
import luxor from '../../samples/luxor.look.json';
import tatooine from '../../samples/tatooine.look.json';

export interface Sample {
  name: string;
  url: string;
  lighting: 'outdoor' | 'overcast' | 'indoor' | 'indoor-soft';
  style: string;
  roofStyle?: string;
  floorStyle?: string;
  preset?: 'sento-floor';
  area?: number[];
  look?: Pick<PipelineOptions, 'wording' | 'setting' | 'styleImages' | 'styleMax'>;
}

export interface StudioMounts {
  topbar: HTMLElement;
  leftDock: HTMLElement;
  rightDock: HTMLElement;
  bottomDock: HTMLElement;
  viewportHud: HTMLElement;
}

export const SAMPLES: Sample[] = [
  { name: 'Village', url: '/samples/village.glb', lighting: 'overcast', style: DEFAULT_PIPELINE.style },
  { name: 'Courtyard', url: '/samples/courtyard.glb', lighting: 'overcast', style: DEFAULT_PIPELINE.style },
  {
    name: 'Hall',
    url: '/samples/hall.glb',
    lighting: 'indoor',
    style: 'an abandoned industrial hall: cracked dusty concrete floor, peeling painted plaster walls, rusted steel beams, grimy window frames',
    roofStyle: 'weathered corrugated metal roofing with rust streaks',
    floorStyle: 'cracked dusty concrete floor with stains and fine cracks',
  },
  {
    name: 'Loft',
    url: '/samples/loft.glb',
    lighting: 'indoor',
    style: 'the inside of a modern New York industrial loft: exposed red brick walls, black steel columns and beams, black steel-framed factory windows, a white-painted ceiling, a polished concrete floor; through the windows, brick and stone buildings across the street',
    floorStyle: 'a polished concrete floor: smooth gray concrete with soft mottling, a few hairline cracks and faint straight saw-cut joints',
    area: [-10, 0, -5, 10, 6, 5],
  },
  {
    name: 'Luxor',
    url: `/${luxor.level}`,
    lighting: 'overcast',
    style: luxor.style,
    floorStyle: luxor.floorStyle,
    look: { wording: luxor.wording as PipelineOptions['wording'], setting: luxor.setting, styleImages: luxor.styleImages },
  },
  {
    name: 'Tatooine · benchmark',
    url: `/${tatooine.level}`,
    lighting: 'overcast',
    style: tatooine.style,
    floorStyle: tatooine.floorStyle,
    area: tatooine.area,
    look: { wording: tatooine.wording as PipelineOptions['wording'], setting: tatooine.setting },
  },
  {
    name: 'Hangar',
    url: `/${hangar.level}`,
    lighting: 'indoor-soft',
    style: hangar.style,
    floorStyle: hangar.floorStyle,
    area: [...hangar.area, ...hangar.spots.flat()],
    look: { wording: hangar.wording as PipelineOptions['wording'], setting: hangar.setting, styleImages: hangar.styleImages, styleMax: hangar.styleMax },
  },
  {
    name: 'Sento · painted floor',
    url: 'preset:sento-floor',
    preset: 'sento-floor',
    lighting: 'overcast',
    style: 'a traditional Japanese bathhouse with pale ceramic floor tiles, blue tiled baths and hand-painted walls',
    floorStyle: 'small pale glazed ceramic tiles with recessed grout and preserved painted wear',
  },
];

type StudioApi = ReturnType<typeof makeApi>;
type Choice = { value: string; label: string };
type ConfirmPayload = { title: string; description: string; confirmLabel: string };

const el = <T extends Element = HTMLElement>(tag: string, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...kids);
  return node as unknown as T;
};

function makeFeedback() {
  const node = el('div', { class: 'feedback', role: 'status', 'aria-live': 'polite' });
  node.hidden = true;
  const show = (msg: string, kind: 'info' | 'ok' | 'error' = 'info') => {
    if (!msg) {
      node.hidden = true;
      node.textContent = '';
      return;
    }
    node.hidden = false;
    node.className = `feedback${kind === 'info' ? '' : ` ${kind}`}`;
    node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    node.textContent = msg;
  };
  return { el: node, show };
}

function drawThumb(stage: HTMLElement, canvas: HTMLCanvasElement, data: Uint8ClampedArray, size: number) {
  const tmp = document.createElement('canvas');
  tmp.width = tmp.height = size;
  tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), size, size), 0, 0);
  canvas.width = canvas.height = 256;
  canvas.getContext('2d')!.drawImage(tmp, 0, 0, 256, 256);
  stage.classList.add('filled');
}

function makeButton(
  text: string,
  onAction: () => void | Promise<unknown>,
  opts: { variant?: 'solid' | 'destructive'; confirm?: string; className?: string } = {},
) {
  const btnAttrs: Record<string, string> = { type: 'button' };
  if (opts.variant) btnAttrs['data-variant'] = opts.variant;
  if (opts.confirm) btnAttrs['data-agent-confirm'] = opts.confirm;
  const native = el<HTMLButtonElement>('button', btnAttrs, text);
  const root = el<UiButtonElement>('ui-button', opts.className ? { class: opts.className } : {}, native);
  root.addEventListener('action', (ev) => {
    const res = onAction();
    if (res && typeof (res as Promise<unknown>).then === 'function') {
      ev.detail.waitUntil(res as Promise<unknown>);
    }
  });
  return {
    root,
    native,
    setDisabled(v: boolean) {
      root.disabled = v;
    },
    setText(t: string) {
      native.textContent = t;
    },
  };
}

function makeToggle(text: string, defaultPressed: boolean, onChange: (pressed: boolean) => void) {
  const native = el<HTMLButtonElement>('button', { type: 'button' }, text);
  const root = el<UiToggleElement>('ui-toggle', defaultPressed ? { 'default-pressed': '' } : {}, native);
  root.addEventListener('pressedchange', (ev) => onChange(ev.detail.value));
  return {
    root,
    native,
    setPressed(v: boolean) {
      root.pressed = v;
    },
  };
}

function makeSegmented(
  label: string,
  items: Choice[],
  defaultVal: string,
  onChange: (val: string) => void,
  inField = false,
) {
  let current = defaultVal;
  const seg = el<UiSegmentedControlElement>(
    'ui-segmented-control',
    {
      'default-value': defaultVal,
      ...(inField ? { class: 'full' } : { 'aria-label': label }),
    },
    el('ui-segmented-control-indicator'),
    ...items.map((it) => el('ui-segmented-control-item', { value: it.value }, it.label)),
  );
  seg.addEventListener('valuechange', (ev) => {
    if (typeof ev.detail.value === 'string') {
      current = ev.detail.value;
      onChange(current);
    }
  });
  const wrap = inField ? el('ui-field', {}, el('ui-field-label', {}, label), seg) : seg;
  return {
    wrap,
    seg,
    get value() {
      return current;
    },
    set value(v: string) {
      current = v;
      seg.value = v;
    },
  };
}

function makeSelect(
  label: string,
  initialItems: Choice[],
  defaultVal: string,
  onChange?: (val: string) => void,
  inlineAria = false,
) {
  let current = defaultVal;
  const content = el('ui-select-content');
  const triggerBtn = el<HTMLButtonElement>(
    'button',
    inlineAria ? { type: 'button', 'aria-label': label } : { type: 'button' },
    el('ui-select-value'),
  );
  const select = el<UiSelectElement>(
    'ui-select',
    {
      'aria-label': label,
      ...(defaultVal ? { 'default-value': defaultVal } : { placeholder: 'None' }),
    },
    el('ui-select-trigger', {}, triggerBtn),
    content,
  );

  const setItems = (next: Choice[], selected?: string) => {
    content.replaceChildren(
      ...next.map((it) =>
        el('ui-select-item', { value: it.value, label: it.label }, it.label, el('ui-select-item-indicator')),
      ),
    );
    select.items = next;
    if (selected !== undefined) {
      current = selected;
      select.value = selected || null;
    }
  };
  setItems(initialItems);

  select.addEventListener('valuechange', (ev) => {
    const raw = ev.detail.value as string | { value?: string } | null;
    current = typeof raw === 'object' && raw ? (raw.value ?? '') : (raw ?? '');
    onChange?.(current);
  });

  const wrap = inlineAria
    ? el('div', { class: 'tb-select' }, select)
    : el('ui-field', {}, el('ui-field-label', {}, label), select);

  return {
    wrap,
    select,
    setItems,
    setDisabled(v: boolean) {
      select.disabled = v;
    },
    get value() {
      return current;
    },
    set value(v: string) {
      current = v;
      select.value = v || null;
    },
  };
}

function makeSlider(
  label: string,
  min: number,
  max: number,
  step: number,
  defaultVal: number,
  format: (v: number) => string,
  onChange?: (v: number) => void,
) {
  let current = defaultVal;
  const valOut = el('ui-slider-value', {}, format(defaultVal));
  const slider = el<UiSliderElement>(
    'ui-slider',
    { 'aria-label': label, 'default-value': String(defaultVal), min: String(min), max: String(max), step: String(step) },
    el('div', { class: 'slider-head' }, el('ui-field-label', {}, label), valOut),
    el(
      'ui-slider-control',
      {},
      el('ui-slider-track', {}, el('ui-slider-indicator'), el('ui-slider-thumb')),
    ),
  );
  slider.format = format;
  slider.addEventListener('valuechange', (ev) => {
    const num = Array.isArray(ev.detail.value) ? Number(ev.detail.value[0]) : Number(ev.detail.value);
    current = num;
    valOut.textContent = format(num);
    onChange?.(num);
  });
  const wrap = el('ui-field', {}, slider);
  return {
    wrap,
    slider,
    setDisabled(v: boolean) {
      slider.disabled = v;
    },
    get value() {
      return current;
    },
    set value(v: number) {
      current = v;
      slider.value = v;
      valOut.textContent = format(v);
    },
  };
}

function makeCheckbox(label: string, defaultChecked: boolean, onChange?: (checked: boolean) => void) {
  let current = defaultChecked;
  const box = el<UiCheckboxElement>('ui-checkbox', defaultChecked ? { 'default-checked': '' } : {}, el('ui-checkbox-indicator'));
  box.addEventListener('checkedchange', (ev) => {
    current = ev.detail.value === true;
    onChange?.(current);
  });
  const wrap = el('label', {}, box, label);
  return {
    wrap,
    box,
    setDisabled(v: boolean) {
      box.disabled = v;
    },
    get checked() {
      return current;
    },
    set checked(v: boolean) {
      current = v;
      box.checked = v;
    },
  };
}

function makeInput(label: string, placeholder: string, defaultVal = '', onChange?: (v: string) => void) {
  let current = defaultVal;
  const native = el<HTMLInputElement>('input', { type: 'text', placeholder, value: defaultVal });
  const input = el<UiInputElement>('ui-input', defaultVal ? { 'default-value': defaultVal } : {}, native);
  input.addEventListener('valuechange', (ev) => {
    current = ev.detail.value;
    onChange?.(current);
  });
  const wrap = el('ui-field', {}, el('ui-field-label', {}, label), input);
  return {
    wrap,
    input,
    get value() {
      return current;
    },
    set value(v: string) {
      current = v;
      native.value = v;
      input.value = v;
    },
  };
}

function makeTextarea(label: string, placeholder: string, defaultVal = '') {
  let current = defaultVal;
  const native = el<HTMLTextAreaElement>('textarea', { placeholder, rows: '3' }, defaultVal);
  const area = el<UiTextareaElement>('ui-textarea', defaultVal ? { 'default-value': defaultVal } : {}, native);
  area.addEventListener('valuechange', (ev) => {
    current = ev.detail.value;
  });
  const wrap = el('ui-field', {}, el('ui-field-label', {}, label), area);
  return {
    wrap,
    area,
    get value() {
      return current;
    },
    set value(v: string) {
      current = v;
      native.value = v;
      area.value = v;
    },
  };
}

function makePassword(label: string, placeholder: string, defaultVal = '') {
  let current = defaultVal;
  const native = el<HTMLInputElement>('input', { placeholder, value: defaultVal });
  const toggleBtn = el<HTMLButtonElement>('button', { type: 'button', 'aria-label': 'Show API key' });
  const pw = el<UiPasswordInputElement>(
    'ui-password-input',
    defaultVal ? { 'default-value': defaultVal } : {},
    native,
    el('ui-password-input-toggle', {}, toggleBtn),
  );
  pw.addEventListener('valuechange', (ev) => {
    current = ev.detail.value;
  });
  const wrap = el('ui-field', {}, el('ui-field-label', {}, label), pw);
  return {
    wrap,
    pw,
    get value() {
      return current;
    },
  };
}

export function mountUi(session: Session, mounts: StudioMounts, api?: StudioApi) {
  const getApi = (): StudioApi | undefined => api ?? (window as unknown as { trompe?: StudioApi }).trompe;
  const stageEl = document.getElementById('stage')!;
  const centerSplit = document.getElementById('center-split') as UiResizableElement | null;

  const confirmApi = createConfirm<ConfirmPayload>();
  const dialogTitle = el('ui-alert-dialog-title', {}, 'Confirm action');
  const dialogDesc = el('ui-alert-dialog-description', {}, '');
  const dialogConfirmBtn = el<HTMLButtonElement>('button', { type: 'button', 'data-variant': 'destructive' }, 'Confirm');
  const alertDialog = el<UiAlertDialogElement<ConfirmPayload>>(
    'ui-alert-dialog',
    {},
    el('ui-alert-dialog-backdrop', { hidden: '' }),
    el(
      'ui-alert-dialog-content',
      { hidden: '', 'keep-mounted': '' },
      dialogTitle,
      dialogDesc,
      el(
        'div',
        { class: 'row' },
        el('ui-alert-dialog-close', {}, el('button', { type: 'button' }, 'Cancel')),
        el('ui-alert-dialog-close', { value: 'confirm' }, dialogConfirmBtn),
      ),
    ),
  );
  alertDialog.controller = confirmApi.controller;
  alertDialog.addEventListener('payloadchange', (ev) => {
    const p = ev.detail.value;
    if (!p) return;
    dialogTitle.textContent = p.title;
    dialogDesc.textContent = p.description;
    dialogConfirmBtn.textContent = p.confirmLabel;
  });
  document.body.append(alertDialog);

  setAgentConfirmHandler(async (message, signal) => {
    const hook = (window as unknown as { __potemkinAgentConfirm?: (m: string) => boolean }).__potemkinAgentConfirm;
    if (hook) return hook(message);
    const onAbort = () => alertDialog.api.close();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await confirmApi({
        title: 'Allow agent action?',
        description: message,
        confirmLabel: 'Allow',
      });
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  });

  const sampleSel = makeSelect(
    'Scene',
    SAMPLES.map((s) => ({ value: s.url, label: s.name })),
    SAMPLES[0].url,
    () => onSampleChanged(),
    true,
  );

  const importPicker = el<UiFileInputElement>(
    'ui-file-input',
    { accept: '.glb,.gltf', 'aria-label': 'Toolbar blockout import' },
    el('ui-file-input-trigger', {}, el('button', { type: 'button' }, 'Import .glb')),
  );

  const shadingSeg = makeSegmented(
    'Shading',
    [
      { value: 'clay', label: 'Clay' },
      { value: 'textured', label: 'Textured' },
      { value: 'lit', label: 'Lit' },
    ],
    'clay',
    (m) => applyShading(m as 'clay' | 'textured' | 'lit'),
  );

  const overlaySel = makeSelect(
    'Viewport overlay',
    [
      { value: 'off', label: 'Overlay · Off' },
      { value: 'openness', label: 'Overlay · Openness' },
      { value: 'curvature', label: 'Overlay · Curvature' },
      { value: 'light', label: 'Overlay · Light' },
      { value: 'class', label: 'Overlay · Class' },
      { value: 'importance', label: 'Overlay · Importance' },
      { value: 'paths', label: 'Overlay · Gaze' },
    ],
    'off',
    (val) => onOverlayChanged(val),
    true,
  );

  const frustumsToggle = makeToggle('Frustums', true, (pressed) => {
    if (session.viewer) {
      session.viewer.overlay.visible = pressed;
      session.viewer.dirty = true;
    }
  });

  const hint = el('div', { id: 'hint', role: 'status', 'aria-live': 'polite' }, 'W A S D move · Shift run · Space jump · Click look · Esc exit');
  stageEl.append(hint);

  const walkToggle = makeToggle('Walkthrough', false, (wantWalk) => {
    const v = session.viewer;
    if (!v) return;
    if (!wantWalk) {
      if (v.walker) v.stopWalk();
      hint.classList.remove('show');
      return;
    }
    try {
      const eye = session.walkStart();
      const to = v.controls.target;
      const yaw = Math.hypot(to.x - eye.x, to.z - eye.z) > 0.5 ? Math.atan2(eye.x - to.x, eye.z - to.z) : 0;
      v.startWalk(eye, yaw, () => {
        walkToggle.setPressed(false);
        hint.classList.remove('show');
      });
      hint.classList.add('show');
      walkToggle.native.blur();
    } catch (e) {
      walkToggle.setPressed(false);
      statusBanner.show(String((e as Error)?.message ?? e), 'error');
    }
  });

  const planBtn = makeButton('Plan cameras', () => runPlan());
  const runBtn = makeButton('Paint textures', () => runPaint(), {
    variant: 'solid',
    confirm: 'Generates textures across planned cameras',
  });
  const stopBtn = makeButton(
    'Stop',
    async () => {
      if (!isRunning) return;
      const yes = await confirmApi({
        title: 'Abort current run?',
        description: 'Completed views stay saved on disk; any view currently in flight may still be billed.',
        confirmLabel: 'Abort now',
      });
      if (yes) session.stop();
    },
    { variant: 'destructive' },
  );
  stopBtn.setDisabled(true);

  const glbBtn = makeButton('Export GLB', () => runExportGlb());

  const docCache = new Map<string, string>();
  const docsViewport = el('div', { class: 'words-stream docs-words' });
  const docsWords = mountWordsView(docsViewport, { controls: true, idPrefix: 'pk-doc-' });
  const docsTopicSeg = makeSegmented(
    'Documentation topic',
    [
      { value: 'report', label: 'Live Report' },
      { value: 'engine', label: 'Engine' },
      { value: 'potemkin', label: 'Scenes' },
      { value: 'material-maps', label: 'Materials' },
      { value: 'automation', label: 'Automation' },
      { value: 'todo', label: 'Roadmap' },
    ],
    'report',
    (topic) => void loadDocTopic(topic),
  );
  const docsDialog = el<UiDialogElement>(
    'ui-dialog',
    { 'aria-label': 'Documentation and reports' },
    el('ui-dialog-trigger', {}, el('button', { type: 'button' }, 'Docs')),
    el('ui-dialog-backdrop', { hidden: '' }),
    el(
      'ui-dialog-content',
      { hidden: '', class: 'docs-dialog-content' },
      el(
        'div',
        { class: 'docs-dialog-head' },
        el(
          'div',
          {},
          el('ui-dialog-title', {}, 'Potemkin Documentation & Live Report'),
          el('ui-dialog-description', {}, 'Streamed with @pierre/words, Pele Mermaid diagrams, and @pierre/highlights.'),
        ),
        el('div', { class: 'row fit' }, makeButton('Export HTML', () => runExportReport()).root, el('ui-dialog-close', {}, el('button', { type: 'button' }, 'Close'))),
      ),
      docsTopicSeg.wrap,
      docsViewport,
    ),
  );
  docsDialog.addEventListener('openchange', (ev) => {
    if (ev.detail.value) void loadDocTopic(docsTopicSeg.value);
  });

  const leftDockToggle = makeToggle('Left dock', false, (on) => {
    document.body.classList.remove('show-right');
    rightDockToggle.setPressed(false);
    document.body.classList.toggle('show-left', on);
  });
  const rightDockToggle = makeToggle('Right dock', false, (on) => {
    document.body.classList.remove('show-left');
    leftDockToggle.setPressed(false);
    document.body.classList.toggle('show-right', on);
  });
  const mobileBtns = el('div', { class: 'mobile-dock-btns' }, leftDockToggle.root, rightDockToggle.root);

  const syncMobileMode = () => {
    const narrow = window.matchMedia('(max-width: 720px)').matches;
    mobileBtns.hidden = !narrow;
    if (narrow) {
      mobileBtns.removeAttribute('data-agent-hidden');
      document.documentElement.style.setProperty('--mobile-top', `${mounts.topbar.offsetHeight || 76}px`);
    } else {
      mobileBtns.setAttribute('data-agent-hidden', '');
      document.body.classList.remove('show-left', 'show-right');
    }
  };

  mounts.topbar.append(
    el('div', { class: 'tb-group' }, el('h1', { class: 'brand-mark' }, 'Potemkin ', el('span', {}, '3D')), el('span', { class: 'tb-sep' }), sampleSel.wrap, importPicker),
    el('div', { class: 'tb-group tb-viewport-strip' }, shadingSeg.wrap, overlaySel.wrap, frustumsToggle.root, walkToggle.root),
    el(
      'div',
      { class: 'tb-group' },
      planBtn.root,
      runBtn.root,
      stopBtn.root,
      el('span', { class: 'tb-sep' }),
      glbBtn.root,
      docsDialog,
      el('a', { class: 'tb-link', href: '/loft-walk.html' }, 'Viewer ↗'),
      mobileBtns,
    ),
  );
  window.addEventListener('resize', syncMobileMode);
  queueMicrotask(syncMobileMode);

  const vpLeft = el('div', { class: 'vp-pill' }, el('strong', {}, 'Village'), ' · Clay · 45°/65°');
  const vpRight = el('div', { class: 'vp-pill' }, 'Idle');
  mounts.viewportHud.append(vpLeft, vpRight);

  const geoMeta = el('span', { class: 'pane-meta' }, '–');
  const outlinerListbox = el<UiListboxElement>('ui-listbox', { 'aria-label': 'Outliner surfaces', activation: 'manual' });
  const outlinerEmpty = el('div', { class: 'pane-body' }, el('div', { class: 'note' }, 'Single unlabelled mesh — run Auto-name shapes below to segment parts.'));
  outlinerListbox.addEventListener('valuechange', (ev) => {
    const val = ev.detail.value as string | null;
    if (val) {
      activePartSel.value = val;
      inspectorTabs.value = 'material';
      syncPbr();
    }
  });

  const namesBtn = makeButton('Auto-name shapes', () => runAutoName(), {
    className: 'full-btn',
    confirm: 'Calls vision model to name unlabelled shapes',
  });
  const namesList = el('div', { class: 'parts' });
  const unlabelledWrap = el('div', { class: 'pane-body' }, namesBtn.root, namesList);
  unlabelledWrap.hidden = true;

  const runCountMeta = el('span', { class: 'pane-meta' }, '0');
  const savedRunSel = makeSelect('Saved take', [], '');
  const loadRunBtn = makeButton('Load take', () => runLoadSaved(), { className: 'fit' });
  const runsRow = el('div', { class: 'row' }, savedRunSel.wrap, loadRunBtn.root);
  runsRow.hidden = true;
  const runsEmptyNote = el('div', { class: 'note' }, 'No saved takes yet.');

  const dropPicker = el<UiFileInputElement>(
    'ui-file-input',
    { accept: '.glb,.gltf', 'aria-label': 'Takes blockout dropzone' },
    el(
      'ui-file-input-dropzone',
      {},
      el('span', { class: 'note' }, 'Drop .glb blockout'),
      el('ui-file-input-trigger', {}, el('button', { type: 'button' }, 'Browse file')),
    ),
  );

  const leftSplit = el<UiResizableElement>(
    'ui-resizable',
    { orientation: 'vertical', 'aria-label': 'Outliner and takes', 'auto-save-id': 'potemkin-left' },
    el(
      'ui-resizable-panel',
      { id: 'panel-outliner', 'default-size': '62', 'min-size': '25' },
      el('div', { class: 'pane-head' }, el('h2', { class: 'pane-title' }, 'Outliner'), geoMeta),
      outlinerListbox,
      outlinerEmpty,
      unlabelledWrap,
    ),
    el('ui-resizable-handle', { 'aria-label': 'Resize outliner and takes' }),
    el(
      'ui-resizable-panel',
      { id: 'panel-takes', 'default-size': '38', 'min-size': '24' },
      el('div', { class: 'pane-head' }, el('h2', { class: 'pane-title' }, 'Takes'), runCountMeta),
      el('div', { class: 'pane-body' }, runsRow, runsEmptyNote, dropPicker),
    ),
  );
  mounts.leftDock.append(leftSplit);

  const styleArea = makeTextarea('Surface prompt', 'Describe surface materials (stone, plaster, timber, metal)…', SAMPLES[0].style);
  const roofInput = makeInput('Roof material', 'Roof material', SAMPLES[0].roofStyle ?? DEFAULT_PIPELINE.roofStyle);
  const floorInput = makeInput('Ground material', 'Ground material', SAMPLES[0].floorStyle ?? DEFAULT_PIPELINE.floorStyle);

  const pinnedNotes: Note[] = [];
  let pinMode = false;
  let pinMarkersGroup: THREE.Group | null = null;
  const noteTextInput = makeInput('Note instruction', 'Click mesh to pin: arched door, ivy, plaque…');
  const pinNoteToggle = makeToggle('Pin note', false, (on) => {
    pinMode = on;
    session.canvas.style.cursor = on ? 'crosshair' : '';
    if (on) statusBanner.show('Pin note active: click any 3D surface in the viewport to place note.', 'info');
  });
  const clearNotesBtn = makeButton('Clear notes', () => {
    pinnedNotes.length = 0;
    syncPinMarkers();
  });
  clearNotesBtn.setDisabled(true);
  const pinnedNotesChips = el('div', { class: 'chips' });

  function syncPinMarkers() {
    clearNotesBtn.setDisabled(pinnedNotes.length === 0);
    pinnedNotesChips.replaceChildren(
      ...pinnedNotes.map((n, idx) =>
        el(
          'span',
          { class: 'chip' },
          `#${idx + 1} ${n.text} (${n.at.map((v) => v.toFixed(1)).join(', ')})`,
        ),
      ),
    );
    const viewer = session.viewer;
    if (!viewer) return;
    if (pinMarkersGroup) {
      viewer.scene.remove(pinMarkersGroup);
      pinMarkersGroup.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          (o as THREE.Mesh).geometry.dispose();
          ((o as THREE.Mesh).material as THREE.Material).dispose();
        }
      });
      pinMarkersGroup = null;
    }
    if (pinnedNotes.length) {
      pinMarkersGroup = new THREE.Group();
      for (const n of pinnedNotes) {
        const marker = new THREE.Mesh(
          new THREE.SphereGeometry(0.12, 12, 12),
          new THREE.MeshBasicMaterial({ color: 0xf2f2f2 }),
        );
        marker.position.set(n.at[0], n.at[1], n.at[2]);
        pinMarkersGroup.add(marker);
      }
      viewer.scene.add(pinMarkersGroup);
    }
    viewer.dirty = true;
  }

  let pointerDownPos: [number, number] | null = null;
  session.canvas.addEventListener('pointerdown', (e) => {
    pointerDownPos = [e.clientX, e.clientY];
  });
  session.canvas.addEventListener('pointerup', (e) => {
    if (!pinMode || !pointerDownPos || !session.level || !session.viewer) return;
    if (Math.hypot(e.clientX - pointerDownPos[0], e.clientY - pointerDownPos[1]) > 5) return;
    const rect = session.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -(((e.clientY - rect.top) / rect.height) * 2 - 1),
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, session.viewer.camera);
    const hit = session.level.bvh.raycastFirst(raycaster.ray, THREE.DoubleSide);
    if (!hit) return;
    const text = noteTextInput.value.trim() || 'surface detail';
    const at: [number, number, number] = [+hit.point.x.toFixed(2), +hit.point.y.toFixed(2), +hit.point.z.toFixed(2)];
    pinnedNotes.push({ text, at });
    syncPinMarkers();
    say(`pinned note "${text}" at (${at.join(', ')})`);
    statusBanner.show(`Pinned "${text}" at (${at.join(', ')}).`, 'ok');
  });

  const skySeg = makeSegmented(
    'Sky preset',
    [
      { value: 'outdoor', label: 'Outdoor' },
      { value: 'overcast', label: 'Overcast' },
      { value: 'indoor', label: 'Indoor' },
      { value: 'indoor-soft', label: 'Soft' },
    ],
    SAMPLES[0].lighting,
    (k) => setLighting(k),
    true,
  );
  const azSlider = makeSlider('Sun azimuth', 0, 360, 1, 140, (v) => `${Math.round(v)}°`, () => applySun());
  const elSlider = makeSlider('Sun elevation', 5, 85, 1, 48, (v) => `${Math.round(v)}°`, () => applySun());

  const budgetSlider = makeSlider('Camera budget', 6, 80, 1, 36, (v) => `${Math.round(v)}`);
  const targetModeSel = makeSelect(
    'Target geometry',
    [
      { value: 'auto', label: 'Auto (level vs object)' },
      { value: 'level', label: 'Level (walkable floor)' },
      { value: 'object', label: 'Object (sphere + probes)' },
    ],
    'auto',
    () => {
      syncModeUi();
      onSampleChanged();
    },
  );
  const focusPartsInput = makeInput('Focus parts', 'barrel, visor, wheel');
  focusPartsInput.wrap.hidden = true;

  const atlasSel = makeSelect(
    'Atlas resolution',
    [
      { value: '2048', label: '2K' },
      { value: '4096', label: '4K' },
      { value: '8192', label: '8K' },
    ],
    '8192',
    () => onSampleChanged(),
  );
  const viewResSel = makeSelect(
    'View resolution',
    [
      { value: '2048', label: '2K' },
      { value: '1024', label: '1K' },
    ],
    '2048',
    () => onSampleChanged(),
  );
  const uvLayoutSel = makeSelect(
    'UV packing',
    [
      { value: 'file', label: 'File UVs' },
      { value: 'seen', label: 'Visible faces' },
      { value: 'near', label: 'Sightline & strips' },
    ],
    'file',
    () => onSampleChanged(),
  );

  const adaptiveChk = makeCheckbox('Adaptive Fisher probes', false);
  const weightsChk = makeCheckbox('Weight UVs by gaze & AO', true, () => onSampleChanged());
  const aerialChk = makeCheckbox('Aerial roof cameras', true);
  const floorChk = makeCheckbox('Overhead floor pass', true);
  const samChk = makeCheckbox('SAM blockout check', true);
  const mogeChk = makeCheckbox('MoGe normal check', true);
  const swatchChk = makeCheckbox('Material swatches', false);

  const providerSel = makeSelect(
    'Inference provider',
    [
      { value: 'fal', label: 'Cloud · fal.ai' },
      { value: 'local', label: 'Local · $0' },
      { value: 'auto', label: 'Auto · Local + fallback' },
    ],
    'fal',
    () => {
      syncProvider();
      syncPbr();
    },
  );
  const localBackendSel = makeSelect(
    'Local backend',
    [
      { value: 'auto', label: 'Auto-probe GPU' },
      { value: 'comfyui', label: 'ComfyUI (:8188)' },
      { value: 'diffusers', label: 'Diffusers (:8000)' },
      { value: 'hunyuan3d', label: 'Hunyuan3D (:8081)' },
      { value: 'procedural', label: 'Procedural (CPU)' },
    ],
    'auto',
    () => syncProvider(),
  );
  const localUrlInput = makeInput('Loopback endpoint', 'http://127.0.0.1:8188', localStorage.getItem('trompe.localUrl') ?? '', () => syncProvider());
  const modelChoices = Object.values(MODELS).map((m) => ({ value: m.key, label: `${m.label} · $${m.price}` }));
  const firstModelSel = makeSelect('First-view model', modelChoices, DEFAULT_PIPELINE.firstModel);
  const fillModelSel = makeSelect('Fill-view model', modelChoices, DEFAULT_PIPELINE.fillModel);
  const apiKeyInput = makePassword('Cloud API key', 'Uses server FAL_KEY when blank', localStorage.getItem('trompe.falKey') ?? '');

  const syncProvider = () => {
    const prov = providerSel.value as ProviderKind;
    const isFal = prov === 'fal';
    const isLocal = prov === 'local';
    localBackendSel.wrap.hidden = isFal;
    localUrlInput.wrap.hidden = isFal || localBackendSel.value === 'procedural';
    firstModelSel.wrap.hidden = isLocal;
    fillModelSel.wrap.hidden = isLocal;
    apiKeyInput.wrap.hidden = isLocal;
    for (const w of [localBackendSel.wrap, localUrlInput.wrap, firstModelSel.wrap, fillModelSel.wrap, apiKeyInput.wrap]) {
      if (w.hidden) w.setAttribute('data-agent-hidden', '');
      else w.removeAttribute('data-agent-hidden');
    }
    const urlVal = localUrlInput.value.trim();
    if (urlVal) localStorage.setItem('trompe.localUrl', urlVal);
    else localStorage.removeItem('trompe.localUrl');
    return configureProvider({
      provider: prov,
      providerFallback: prov === 'auto' ? 'fal' : 'none',
      localBackend: localBackendSel.value as LocalBackend,
      localUrl: urlVal || undefined,
    });
  };
  syncProvider();

  const criticPill = el('span', { class: 'pill' }, 'Not scored');
  const makeStat = (lbl: string) => {
    const b = el('b', {}, '–');
    return [el('div', { class: 'stat' }, b, el('i', {}, lbl)), b] as const;
  };
  const [cScoreEl, vCScore] = makeStat('Score');
  const [cSeenEl, vCSeen] = makeStat('Seen');
  const [cPxEl, vCPx] = makeStat('px/m');
  const [cSeamEl, vCSeam] = makeStat('Seam');
  const criticStats = el('div', { class: 'stats' }, cScoreEl, cSeenEl, cPxEl, cSeamEl);
  criticStats.hidden = true;
  const criticEmpty = el('div', { class: 'note' }, 'Paint a scene or load a take, then evaluate coverage, consistency, seams and baked shading.');
  const criticChips = el('div', { class: 'chips' });
  const critiqueBtn = makeButton('Evaluate quality', () => runCritique());
  const repairRunBtn = makeButton('Apply repairs', () => runPrescribedRepairs(), {
    variant: 'solid',
    confirm: 'Runs Critic-prescribed repair passes',
  });
  repairRunBtn.root.hidden = true;
  const consolidateBtn = makeButton('Stitch seams', () => runConsolidate());
  const uvRefineBtn = makeButton('Refine UVs', () => runUvRefine());
  const reportExportBtn = makeButton('Export report', () => runExportReport(), { className: 'full-btn' });
  const criticStreamEl = el('div', { class: 'words-stream critic-words' });
  criticStreamEl.hidden = true;
  const criticWords = mountWordsView(criticStreamEl, { idPrefix: 'pk-crit-' });
  const criticFeedback = makeFeedback();
  let latestCritique: CritiqueReport | null = null;

  const activePartSel = makeSelect('Active part', [], '', () => syncPbr());
  const presetChoices: Choice[] = [
    { value: '', label: 'Original response' },
    ...Object.entries(MATERIAL_PRESETS).map(([id, p]) => ({ value: id, label: p.name })),
  ];
  const presetSel = makeSelect('Response preset', presetChoices, '', (val) => {
    const assignments = { ...session.engine?.materialPresets };
    if (isMaterialPreset(val)) assignments[activePartSel.value] = val;
    else delete assignments[activePartSel.value];
    void applyMaterials(assignments);
  });
  const suggestBtn = makeButton('Suggest presets', () => {
    const assignments = { ...session.engine?.materialPresets };
    const suggested = session.level ? session.suggestMaterialPresets() : {};
    for (const label of session.level?.labels ?? []) {
      const preset = suggestMaterialPreset(label) ?? suggested[label];
      if (preset && !assignments[label]) assignments[label] = preset;
    }
    return applyMaterials(assignments);
  }, { className: 'full-btn' });
  const materialNote = el('div', { class: 'note' });

  const pbrModeSel = makeSelect(
    'PBR pipeline',
    [
      { value: 'auto', label: 'Auto (intrinsic / PATINA)' },
      { value: 'intrinsic', label: 'Intrinsic · $0' },
      { value: 'patina', label: 'PATINA tiles + metallic' },
    ],
    'auto',
    () => syncPbr(),
  );
  const pbrBtn = makeButton('Build PBR', () => runPbr());
  const aoBtn = makeButton('Bake occlusion', () => runBakeAo());
  const reliefSlider = makeSlider('Relief depth', 0, 2, 0.05, 1, (v) => `${v.toFixed(2)}×`, (v) => {
    session.viewer?.setRelief(v);
  });

  const floorDetailChk = makeCheckbox('Fine tile detail', false, (checked) => {
    try {
      session.viewer?.setFloorDetailEnabled(checked);
      if (checked) applyShading('lit');
    } catch (e) {
      matFeedback.show(String((e as Error)?.message ?? e), 'error');
    }
    syncPbr();
  });
  const floorDetailWrap = el('div', { class: 'check-list' }, floorDetailChk.wrap);
  floorDetailWrap.hidden = true;

  const albedoExportBtn = makeButton('Save albedo PNG', () => exportAlbedoPng(), { className: 'full-btn' });
  const exportFormatSel = makeSelect(
    'GLB texture format',
    [
      { value: 'png', label: 'PNG (lossless)' },
      { value: 'ktx2', label: 'KTX2 · UASTC (4× VRAM)' },
    ],
    'png',
  );
  const dccTargetSel = makeSelect(
    'DCC target',
    [
      { value: 'blender', label: 'Blender (blender-mcp)' },
      { value: 'unreal', label: 'Unreal (unreal-mcp)' },
      { value: 'both', label: 'Blender + Unreal' },
    ],
    'blender',
  );
  const dccSyncBtn = makeButton('Sync to DCC', () => runDccSync(), { className: 'full-btn' });
  const channelFmtSel = makeSelect(
    'Channel packing',
    [
      { value: 'both', label: 'ORM + separate linear PNGs' },
      { value: 'orm', label: 'glTF ORM + Normal only' },
      { value: 'separate', label: 'Separate linear channels' },
    ],
    'both',
  );
  const pbrExportBtn = makeButton('Save PBR PNGs', () => exportPbrPngs(), { className: 'full-btn' });
  const pbrExportWrap = el('div', { class: 'check-list' }, channelFmtSel.wrap, pbrExportBtn.root);
  pbrExportWrap.hidden = true;
  const matFeedback = makeFeedback();

  const inspectorTabs = el<UiTabsElement>(
    'ui-tabs',
    { 'default-value': 'look', 'aria-label': 'Inspector sections' },
    el(
      'ui-tabs-list',
      { 'aria-label': 'Inspector sections' },
      el('ui-tabs-tab', { value: 'look' }, el('button', { type: 'button' }, 'Look')),
      el('ui-tabs-tab', { value: 'plan' }, el('button', { type: 'button' }, 'Plan')),
      el('ui-tabs-tab', { value: 'critic' }, el('button', { type: 'button' }, 'Critic')),
      el('ui-tabs-tab', { value: 'material' }, el('button', { type: 'button' }, 'Material')),
      el('ui-tabs-indicator'),
    ),
    el(
      'ui-tabs-panel',
      { value: 'look', 'keep-mounted': '' },
      styleArea.wrap,
      roofInput.wrap,
      floorInput.wrap,
      el('div', { class: 'divider' }),
      noteTextInput.wrap,
      el('div', { class: 'row' }, pinNoteToggle.root, clearNotesBtn.root),
      pinnedNotesChips,
      el('div', { class: 'divider' }),
      skySeg.wrap,
      azSlider.wrap,
      elSlider.wrap,
    ),
    el(
      'ui-tabs-panel',
      { value: 'plan', 'keep-mounted': '', hidden: '' },
      budgetSlider.wrap,
      targetModeSel.wrap,
      focusPartsInput.wrap,
      el('div', { class: 'row' }, atlasSel.wrap, viewResSel.wrap),
      uvLayoutSel.wrap,
      el(
        'div',
        { class: 'check-list' },
        adaptiveChk.wrap,
        weightsChk.wrap,
        aerialChk.wrap,
        floorChk.wrap,
        samChk.wrap,
        mogeChk.wrap,
        swatchChk.wrap,
      ),
      el('div', { class: 'divider' }),
      providerSel.wrap,
      localBackendSel.wrap,
      localUrlInput.wrap,
      firstModelSel.wrap,
      fillModelSel.wrap,
      apiKeyInput.wrap,
    ),
    el(
      'ui-tabs-panel',
      { value: 'critic', 'keep-mounted': '', hidden: '' },
      el('div', { class: 'slider-head' }, el('span', { class: 'pane-title' }, 'Quality verdict'), criticPill),
      criticEmpty,
      criticStats,
      criticChips,
      criticStreamEl,
      el('div', { class: 'row' }, critiqueBtn.root, repairRunBtn.root),
      el('div', { class: 'divider' }),
      el('div', { class: 'row' }, consolidateBtn.root, uvRefineBtn.root),
      reportExportBtn.root,
      criticFeedback.el,
    ),
    el(
      'ui-tabs-panel',
      { value: 'material', 'keep-mounted': '', hidden: '' },
      activePartSel.wrap,
      presetSel.wrap,
      materialNote,
      suggestBtn.root,
      el('div', { class: 'divider' }),
      pbrModeSel.wrap,
      el('div', { class: 'row' }, pbrBtn.root, aoBtn.root),
      reliefSlider.wrap,
      floorDetailWrap,
      el('div', { class: 'divider' }),
      exportFormatSel.wrap,
      albedoExportBtn.root,
      pbrExportWrap,
      el('div', { class: 'divider' }),
      dccTargetSel.wrap,
      dccSyncBtn.root,
      matFeedback.el,
    ),
  );
  mounts.rightDock.append(inspectorTabs);

  const thumbSees = document.createElement('canvas');
  const thumbPaints = document.createElement('canvas');
  const stageSees = el('div', { class: 'thumb-stage' }, thumbSees, el('div', { class: 'thumb-empty' }, 'Sees'));
  const stagePaints = el('div', { class: 'thumb-stage' }, thumbPaints, el('div', { class: 'thumb-empty' }, 'Paints'));

  const [sViews, vViews] = makeStat('Views');
  const [sCov, vCov] = makeStat('Surface');
  const [sCost, vCost] = makeStat('Cost');
  const [sTime, vTime] = makeStat('Time');
  const statusBanner = makeFeedback();
  statusBanner.show('Ready — select a scene, plan cameras, or load a saved take.', 'info');

  const monitorStreamEl = el('div', { class: 'words-stream monitor-words', 'aria-live': 'off' });
  const monitorWords = mountWordsView(monitorStreamEl, { idPrefix: 'pk-mon-' });
  const eventFeed: string[] = [];
  let completedViewsCount = 0;

  const toggleMonitorBtn = makeButton('Toggle monitor', () => {
    if (!centerSplit) return;
    if (centerSplit.api.isCollapsed('panel-bottom')) centerSplit.api.expand('panel-bottom');
    else centerSplit.api.collapse('panel-bottom');
  }, { className: 'ghost-mini' });

  mounts.bottomDock.append(
    el('div', { class: 'pane-head' }, el('h2', { class: 'pane-title' }, 'Monitor'), toggleMonitorBtn.root),
    el(
      'div',
      { class: 'bottom-grid' },
      el('div', { class: 'bottom-cell bottom-frames' }, el('div', { class: 'thumbs' }, stageSees, stagePaints)),
      el('div', { class: 'bottom-cell' }, el('div', { class: 'stats' }, sViews, sCov, sCost, sTime), statusBanner.el),
      el('div', { class: 'bottom-cell bottom-log' }, monitorStreamEl),
    ),
  );

  let isRunning = false;
  let savedAs: string | undefined;
  let currentShading: 'clay' | 'textured' | 'lit' = 'clay';
  const canSave = import.meta.env.DEV && !new URLSearchParams(location.search).has('nosave');
  const money = (n: number) => `$${n.toFixed(2)}`;

  const refreshMonitorWords = (streaming = false) => {
    const md = buildMonitorMarkdown({
      sceneName: session.level?.name ?? 'Scene',
      mode: session.level?.mode ?? 'level',
      plannedViews: session.plan?.views.length ?? session.record?.views.length,
      waves: session.plan?.waves.length,
      completedViews: completedViewsCount || session.record?.views.length,
      predictedCoverage: vCov.textContent ?? undefined,
      cost: vCost.textContent ?? undefined,
      provider: providerSel.value,
      hasPbr: !!session.engine?.pbr,
      hasAo: !!session.engine?.ao,
      critiqueScore: latestCritique?.score,
      critiqueVerdict: latestCritique?.verdict,
      streaming,
      events: eventFeed,
    });
    monitorWords.update(md, { streaming, animated: streaming });
  };

  const say = (msg: string) => {
    eventFeed.unshift(msg);
    if (eventFeed.length > 16) eventFeed.length = 16;
    refreshMonitorWords(isRunning);
  };

  const syncHiddenAgentState = (node: HTMLElement, hide: boolean) => {
    node.hidden = hide;
    if (hide) node.setAttribute('data-agent-hidden', '');
    else node.removeAttribute('data-agent-hidden');
  };

  const syncViewportHud = () => {
    const sceneTitle = session.level?.name ?? 'Scene';
    const modeTitle = currentShading[0].toUpperCase() + currentShading.slice(1);
    vpLeft.replaceChildren(
      el('strong', {}, sceneTitle),
      ` · ${modeTitle} · ${Math.round(azSlider.value)}°/${Math.round(elSlider.value)}°`,
    );
    vpRight.textContent = vViews.textContent === '–' ? 'Idle' : `${vViews.textContent}v · ${vCov.textContent} · ${vCost.textContent}`;
  };

  const syncRunAvailability = () => {
    const hasRun = !!session.record;
    critiqueBtn.setDisabled(!hasRun || isRunning);
    consolidateBtn.setDisabled(!hasRun || isRunning);
    uvRefineBtn.setDisabled(!hasRun || isRunning);
    criticEmpty.hidden = hasRun;
  };

  const syncOutliner = () => {
    const labels = session.level?.labels.filter(Boolean) ?? [];
    const presets = session.engine?.materialPresets ?? {};
    syncHiddenAgentState(outlinerListbox, labels.length === 0);
    outlinerEmpty.hidden = labels.length > 0;
    if (!labels.length) {
      outlinerListbox.replaceChildren();
      return;
    }
    const selected = activePartSel.value || labels[0];
    outlinerListbox.replaceChildren(
      ...labels.map((lbl) =>
        el(
          'ui-listbox-item',
          { value: lbl, label: lbl },
          lbl,
          el('span', { class: 'part-tag' }, presets[lbl] ?? 'default'),
        ),
      ),
    );
    outlinerListbox.items = labels.map((lbl) => ({ value: lbl, label: lbl }));
    outlinerListbox.value = selected;
  };

  function setLighting(k: string) {
    skySeg.value = k;
    const base = LIGHTING[k] ?? LIGHTING.outdoor;
    azSlider.value = base.sunAzimuth;
    elSlider.value = base.sunElevation;
    session.setLighting(base);
    syncViewportHud();
  }

  function applySun() {
    const az = azSlider.value;
    const elDeg = elSlider.value;
    const v = session.viewer;
    if (v?.mode === 'lit') {
      v.displayLighting = { ...LIGHTING.outdoor, sunAzimuth: az, sunElevation: elDeg };
      v.syncLighting();
    } else {
      session.setLighting({ ...(LIGHTING[skySeg.value] ?? LIGHTING.outdoor), sunAzimuth: az, sunElevation: elDeg });
    }
    syncViewportHud();
  }

  function applyShading(m: 'clay' | 'textured' | 'lit') {
    currentShading = m;
    shadingSeg.value = m;
    overlaySel.value = 'off';
    session.viewer?.setWeightOverlay('off');
    session.viewer?.setMode(m);
    syncViewportHud();
  }

  function onOverlayChanged(val: string) {
    try {
      const r = session.setWeightOverlay(val as 'off' | 'openness' | 'curvature' | 'light' | 'class' | 'importance' | 'paths');
      if (r.overlay !== 'off') {
        const cls = Object.entries(r.classes)
          .filter(([, s]) => s >= 0.01)
          .map(([k, s]) => `${k} ${Math.round(100 * s)}%`)
          .join(', ');
        const pInfo = 'paths' in r && r.paths ? ` · ${r.paths.nodes} nodes` : '';
        statusBanner.show(`Overlay ${r.overlay} (${r.seconds}s): openness ${r.mean.openness}, curvature ${r.mean.curvature}${pInfo}`, 'info');
        say(`overlay ${r.overlay}: ${cls}${pInfo}`);
      }
    } catch (e) {
      statusBanner.show(String((e as Error)?.message ?? e), 'error');
    }
  }

  const syncParts = () => {
    const level = session.level;
    syncHiddenAgentState(unlabelledWrap, !level?.shapes);
    if (!level?.shapes) return;
    const named = level.labels.some(Boolean);
    namesList.replaceChildren(
      ...(named
        ? level.labels.map((name, k) => {
            const fieldCtrl = makeInput(`Shape ${k + 1}`, `shape ${k + 1}, ${Math.round(level.shapes![k].area)} m²`, name, (v) => {
              session.setPartName(k, v);
              syncOutliner();
            });
            return fieldCtrl.wrap;
          })
        : []),
    );
  };

  async function runAutoName() {
    if (!session.level?.shapes) return;
    apiKeyInput.value ? localStorage.setItem('trompe.falKey', apiKeyInput.value) : localStorage.removeItem('trompe.falKey');
    configureFal(apiKeyInput.value || undefined);
    namesBtn.setDisabled(true);
    runBtn.setDisabled(true);
    try {
      const r = await session.nameParts(styleArea.value, (done, total) => {
        namesBtn.setText(`Naming ${done}/${total}…`);
      });
      statusBanner.show(`Named ${r.names.filter(Boolean).length}/${r.names.length} shapes (${money(r.cost)}).`, 'ok');
      say(`named ${r.names.filter(Boolean).length}/${r.names.length} shapes`);
    } catch (e) {
      statusBanner.show(String((e as Error)?.message ?? e), 'error');
    } finally {
      namesBtn.setDisabled(false);
      runBtn.setDisabled(false);
      syncParts();
      syncPbr();
    }
  }

  const syncPbr = () => {
    const e = session.engine;
    const have = !!e?.pbr;
    const intrinsicFree = pbrModeSel.value === 'intrinsic' || (pbrModeSel.value === 'auto' && providerSel.value === 'local');
    const pbrCostNote = !e ? '' : intrinsicFree ? ' PBR: $0 local.' : ` PBR: ≤${money(pbrQuote(e.atlas.size).cost)}.`;

    const labels = session.level?.labels.filter(Boolean) ?? [];
    const currentPart = labels.includes(activePartSel.value) ? activePartSel.value : (labels[0] ?? '');
    activePartSel.setItems(
      labels.map((l) => ({ value: l, label: l })),
      currentPart,
    );
    activePartSel.setDisabled(!labels.length);
    presetSel.setDisabled(!labels.length);
    suggestBtn.setDisabled(!labels.length);

    const assignedPreset = e?.materialPresets[currentPart] ?? '';
    presetSel.value = assignedPreset;
    const preset = isMaterialPreset(assignedPreset) ? MATERIAL_PRESETS[assignedPreset] : undefined;
    materialNote.textContent =
      (preset
        ? `Roughness ${preset.roughness.toFixed(2)}${preset.metalness ? ` · metal ${preset.metalness.toFixed(2)}` : ''} · relief ${(preset.heightMetres * 1000).toFixed(2)} mm.`
        : 'Assign a physical preset without changing painted albedo.') + pbrCostNote;

    const detail = session.viewer?.floorDetailState;
    syncHiddenAgentState(floorDetailWrap, !detail?.available);
    floorDetailChk.checked = !!detail?.enabled;
    floorDetailChk.setDisabled(!!detail?.stale);

    reliefSlider.setDisabled(!have && !detail?.enabled);
    syncHiddenAgentState(pbrExportWrap, !have);
    syncOutliner();
    syncRunAvailability();
    syncViewportHud();
  };

  const applyMaterials = async (assignments: MaterialAssignments) => {
    const engine = session.engine;
    presetSel.setDisabled(true);
    suggestBtn.setDisabled(true);
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (engine !== session.engine) return;
      session.setMaterialPresets(assignments);
      applyShading('lit');
      if (savedAs) await session.saveRun(savedAs);
      matFeedback.show(`Assigned ${Object.keys(assignments).length} surface presets.`, 'ok');
    } catch (e) {
      matFeedback.show(String((e as Error).message), 'error');
    } finally {
      syncPbr();
    }
  };

  async function runBakeAo() {
    if (!session.engine) return;
    aoBtn.setDisabled(true);
    matFeedback.show('Baking ambient occlusion…', 'info');
    try {
      const ao = await session.bakeAo({}, (done, total) => {
        aoBtn.setText(`AO ${Math.round((100 * done) / Math.max(1, total))}%`);
      });
      applyShading('lit');
      matFeedback.show(`Baked ${ao.size} px AO in ${ao.seconds.toFixed(1)}s.`, 'ok');
      say(`ao: ${ao.size} px, ${ao.seconds.toFixed(1)}s`);
      if (savedAs) await session.saveRun(savedAs);
    } catch (e) {
      matFeedback.show(String((e as Error)?.message ?? e), 'error');
    } finally {
      aoBtn.setDisabled(false);
      syncPbr();
    }
  }

  async function runPbr() {
    if (!session.engine) return;
    apiKeyInput.value ? localStorage.setItem('trompe.falKey', apiKeyInput.value) : localStorage.removeItem('trompe.falKey');
    configureFal(apiKeyInput.value || undefined);
    const provCfg = syncProvider();
    const chosenMode = pbrModeSel.value as 'auto' | 'intrinsic' | 'patina';
    const effectiveMode = chosenMode === 'auto' && provCfg.provider === 'local' ? 'intrinsic' : chosenMode;
    pbrBtn.setDisabled(true);
    runBtn.setDisabled(true);
    matFeedback.show('Building height, roughness, metallic and normal maps…', 'info');
    try {
      const m = await session.makePbr({ mode: effectiveMode }, (done, total) => {
        pbrBtn.setText(`PBR ${done}/${total}…`);
      });
      session.viewer?.setRelief(reliefSlider.value);
      if (session.record) vCost.textContent = money(session.record.cost + m.cost);
      applyShading('lit');
      const msg = `Built ${m.size} px PBR (${m.source?.kind ?? effectiveMode}, ${money(m.cost)}, ${m.seconds.toFixed(1)}s).`;
      matFeedback.show(msg, 'ok');
      statusBanner.show(msg, 'ok');
      say(`pbr: ${m.size} px (${m.source?.kind ?? effectiveMode})`);
      if (savedAs) await session.saveRun(savedAs);
    } catch (e) {
      matFeedback.show(String((e as Error)?.message ?? e), 'error');
    } finally {
      pbrBtn.setDisabled(false);
      runBtn.setDisabled(false);
      syncPbr();
    }
  }

  const renderCritique = (rep: CritiqueReport) => {
    latestCritique = rep;
    criticEmpty.hidden = true;
    criticStats.hidden = false;
    criticPill.textContent = rep.verdict === 'pass' ? `Pass · ${rep.score}` : `Repair · ${rep.score}`;
    criticPill.className = `pill ${rep.verdict === 'pass' ? 'pass' : 'warn'}`;
    vCScore.textContent = `${rep.score}`;
    vCSeen.textContent = `${Math.round(100 * rep.metrics.seenPainted)}%`;
    vCPx.textContent = `${rep.metrics.highRankPxPerM}`;
    vCSeam.textContent = `${rep.metrics.seam.ratio.toFixed(2)}×`;

    criticChips.replaceChildren(
      ...rep.defectRegions
        .filter((d) => d.diagnosticCamera)
        .map((d, idx) => {
          const chip = makeButton(`Defect ${idx + 1} · ${d.part}`, () => {
            const v = session.viewer;
            const cam = d.diagnosticCamera;
            if (!v || !cam) return;
            if (v.walker) {
              v.stopWalk();
              walkToggle.setPressed(false);
              hint.classList.remove('show');
            }
            v.camera.position.set(...cam.position);
            v.controls.target.set(...cam.target);
            v.controls.update();
            v.dirty = true;
            applyShading('textured');
          });
          return chip.root;
        }),
    );

    syncHiddenAgentState(repairRunBtn.root, rep.actions.length === 0);
    criticStreamEl.hidden = false;
    criticWords.stream(buildCriticMarkdown(rep, session.level?.name ?? 'Scene', savedAs), { charsPerFrame: 220 });
    refreshMonitorWords(false);
    if (rep.actions.length > 0) {
      const summary = rep.actions.map((act) => `${act.op}: ${act.reason}`).join(' · ');
      criticFeedback.show(summary, rep.verdict === 'pass' ? 'ok' : 'info');
      statusBanner.show(`Critic ${rep.score}/100 — ${summary}`, rep.verdict === 'pass' ? 'ok' : 'info');
    } else {
      const okMsg = `Critic ${rep.score}/100 (pass): seen ${(100 * rep.metrics.seenPainted).toFixed(1)}%, consistency ${(100 * rep.metrics.multiView.consistency).toFixed(0)}%.`;
      criticFeedback.show(okMsg, 'ok');
      statusBanner.show(okMsg, 'ok');
    }
  };

  const resetCriticUi = () => {
    latestCritique = null;
    criticStats.hidden = true;
    criticStreamEl.hidden = true;
    criticWords.update('', { streaming: false });
    criticChips.replaceChildren();
    syncHiddenAgentState(repairRunBtn.root, true);
    criticPill.textContent = 'Not scored';
    criticPill.className = 'pill';
    criticFeedback.show('');
    syncRunAvailability();
  };

  async function runCritique() {
    const a = getApi();
    if (!session.record || !a) {
      criticFeedback.show('Paint a scene or load a saved take first.', 'error');
      return;
    }
    inspectorTabs.value = 'critic';
    critiqueBtn.setDisabled(true);
    criticFeedback.show('Scoring coverage, sightline px/m, seams and shading…', 'info');
    try {
      const rep = await a.critique({ screenshots: 1 });
      renderCritique(rep);
      say(`critique: ${rep.score}/100 (${rep.verdict})`);
    } catch (e) {
      criticFeedback.show(String((e as Error)?.message ?? e), 'error');
    } finally {
      syncRunAvailability();
    }
  }

  async function runPrescribedRepairs() {
    const a = getApi();
    if (!latestCritique || !session.record || !a) return;
    apiKeyInput.value ? localStorage.setItem('trompe.falKey', apiKeyInput.value) : localStorage.removeItem('trompe.falKey');
    configureFal(apiKeyInput.value || undefined);
    const provCfg = syncProvider();
    repairRunBtn.setDisabled(true);
    critiqueBtn.setDisabled(true);
    runBtn.setDisabled(true);
    isRunning = true;
    stopBtn.setDisabled(false);
    criticFeedback.show('Running Critic-prescribed repairs…', 'info');
    try {
      for (const act of latestCritique.actions) {
        if (act.op === 'consolidate') {
          await a.consolidate(act.params);
        } else if (act.op === 'topUp') {
          await a.topUp(
            {
              style: styleArea.value,
              roofStyle: roofInput.value,
              floorStyle: floorInput.value,
              firstModel: firstModelSel.value,
              fillModel: fillModelSel.value,
              check: samChk.checked,
              checkPlanes: mogeChk.checked,
              provider: provCfg.provider,
              providerFallback: provCfg.providerFallback,
              localBackend: provCfg.localBackend,
              localUrl: provCfg.localUrl,
              plan: act.params.plan as PipelineOptions['plan'],
            },
            undefined,
            savedAs,
          );
        } else if (act.op === 'repair') {
          await a.repair(
            act.params.regions as { min: [number, number, number]; max: [number, number, number]; text?: string }[],
            undefined,
            savedAs,
          );
        } else if (act.op === 'parts') {
          await a.parts(act.params as { only?: string[]; max?: number }, undefined, savedAs);
        } else if (act.op === 'uvRefine') {
          await a.uvRefine(act.params);
        }
      }
      if (savedAs) await session.saveRun(savedAs);
      const rep = await a.critique({ screenshots: 1 });
      renderCritique(rep);
      applyShading('textured');
    } catch (e) {
      criticFeedback.show(String((e as Error)?.message ?? e), 'error');
    } finally {
      isRunning = false;
      stopBtn.setDisabled(true);
      repairRunBtn.setDisabled(false);
      runBtn.setDisabled(false);
      syncPbr();
    }
  }

  async function runConsolidate() {
    if (!session.record) return;
    consolidateBtn.setDisabled(true);
    criticFeedback.show('Solving tangent flow & Screened-Poisson stitching…', 'info');
    try {
      const r = await session.consolidate();
      const msg = `Stitched ${r.views} views (${r.seconds.toFixed(2)}s): seam ${r.before.ratio.toFixed(2)} → ${r.after.ratio.toFixed(2)}.`;
      criticFeedback.show(msg, 'ok');
      statusBanner.show(msg, 'ok');
      say(`consolidated ${r.views}v: ${r.before.ratio.toFixed(2)} → ${r.after.ratio.toFixed(2)}`);
      if (savedAs) await session.saveRun(savedAs);
    } catch (e) {
      criticFeedback.show(String((e as Error)?.message ?? e), 'error');
    } finally {
      syncRunAvailability();
      syncPbr();
    }
  }

  async function runUvRefine() {
    if (!session.record) return;
    uvRefineBtn.setDisabled(true);
    criticFeedback.show('Inpainting UV seams & removing baked shading…', 'info');
    try {
      const r = await session.uvRefine();
      const msg = `Refined UVs (${r.seconds.toFixed(2)}s): unpainted ${(100 * r.unpaintedBefore).toFixed(1)}% → ${(100 * r.unpaintedAfter).toFixed(1)}%.`;
      criticFeedback.show(msg, 'ok');
      statusBanner.show(msg, 'ok');
      say(`uvRefine: ${(100 * r.unpaintedBefore).toFixed(1)}% → ${(100 * r.unpaintedAfter).toFixed(1)}%`);
      if (savedAs) await session.saveRun(savedAs);
    } catch (e) {
      criticFeedback.show(String((e as Error)?.message ?? e), 'error');
    } finally {
      syncRunAvailability();
      syncPbr();
    }
  }

  const listRuns = async () => {
    if (!canSave) return;
    try {
      const runs = (await (await fetch('/api/runs')).json()) as { id: string; level: string; views: number; cost: number; partial: boolean }[];
      const mine = runs.filter((r) => r.level.toLowerCase() === session.level?.name.toLowerCase());
      savedRunSel.setItems(
        mine.map((r) => ({ value: r.id, label: `${r.id} · ${r.views}v · ${money(r.cost)}` })),
        mine[0]?.id ?? '',
      );
      runCountMeta.textContent = String(mine.length);
      syncHiddenAgentState(runsRow, mine.length === 0);
      runsEmptyNote.hidden = mine.length > 0;
    } catch {
      runCountMeta.textContent = '0';
      syncHiddenAgentState(runsRow, true);
      runsEmptyNote.hidden = false;
    }
  };

  async function runLoadSaved() {
    if (!savedRunSel.value || !session.engine) return;
    loadRunBtn.setDisabled(true);
    runBtn.setDisabled(true);
    try {
      const meta = await session.loadRun(savedRunSel.value);
      savedAs = savedRunSel.value;
      styleArea.value = meta.options.style;
      if (meta.options.roofStyle) roofInput.value = meta.options.roofStyle;
      if (meta.options.floorStyle) floorInput.value = meta.options.floorStyle;
      vViews.textContent = String(meta.views.length);
      vCov.textContent = `${Math.round(100 * (meta.views.at(-1)?.predicted ?? 0))}%`;
      vCost.textContent = money(meta.cost + (meta.pbr?.cost ?? 0));
      vTime.textContent = `${Math.round(meta.seconds)}s`;
      syncParts();
      resetCriticUi();
      applyShading(session.engine.pbr || session.viewer?.floorDetailState.enabled ? 'lit' : 'textured');
      statusBanner.show(`Loaded ${savedRunSel.value} (${meta.views.length} views).`, 'ok');
      say(`loaded ${savedRunSel.value}`);
    } catch (e) {
      statusBanner.show(String((e as Error)?.message ?? e), 'error');
    } finally {
      loadRunBtn.setDisabled(false);
      runBtn.setDisabled(false);
      syncPbr();
    }
  }

  const syncModeUi = () => {
    const isObj = targetModeSel.value === 'object' || (targetModeSel.value === 'auto' && session.level?.mode === 'object');
    syncHiddenAgentState(focusPartsInput.wrap, !isObj);
  };

  async function loadScene(src: string | ArrayBuffer, name: string, lighting: string, area?: number[]) {
    statusBanner.show(`Loading ${name}…`, 'info');
    const prepared = SAMPLES.find((s) => s.url === src)?.preset === 'sento-floor';
    atlasSel.setDisabled(prepared);
    uvLayoutSel.setDisabled(prepared);
    if (prepared) {
      atlasSel.value = '2048';
      uvLayoutSel.value = 'file';
    }
    const chosenLayout = uvLayoutSel.value as 'file' | 'seen' | 'near';
    const useWeights = !prepared && weightsChk.checked;
    const cavity = useWeights && chosenLayout !== 'file' ? 0.5 : 0;
    const info = prepared
      ? await session.loadSentoFloor(+viewResSel.value)
      : await session.load(
          src,
          name,
          LIGHTING[lighting] ?? LIGHTING.outdoor,
          +atlasSel.value,
          +viewResSel.value,
          chosenLayout,
          area,
          1,
          'auto',
          cavity,
          useWeights,
          targetModeSel.value as 'auto' | 'level' | 'object',
          useWeights,
        );
    setLighting(lighting);
    applyShading(prepared ? 'lit' : 'clay');
    walkToggle.setPressed(false);
    hint.classList.remove('show');
    savedAs = undefined;
    completedViewsCount = 0;
    eventFeed.length = 0;
    pinnedNotes.length = 0;
    pinMarkersGroup = null;
    pinNoteToggle.setPressed(false);
    pinMode = false;
    session.canvas.style.cursor = '';
    syncPinMarkers();
    stageSees.classList.remove('filled');
    stagePaints.classList.remove('filled');
    for (const b of [vViews, vCov, vCost, vTime]) b.textContent = '–';
    matFeedback.show('');
    resetCriticUi();
    syncModeUi();
    syncPbr();
    syncParts();
    void listRuns();
    const l = info.layout;
    const u = 'unwrap' in info ? info.unwrap : undefined;
    geoMeta.textContent = `${info.triangles.toLocaleString()}t · ${Math.round(info.area).toLocaleString()}m²`;
    const summary =
      `${name}${info.mode === 'object' ? ' (object)' : ''}: ${info.triangles.toLocaleString()} tris, ${info.area.toLocaleString()} m²` +
      (u ? ` · xatlas ${u.charts} charts` : '') +
      (l?.applied ? ` · ${l.gain.toFixed(2)}× density` : '');
    statusBanner.show(summary, 'info');
    say(summary);
  }

  let loadingSeq = 0;
  let currentLoad: Promise<void> = Promise.resolve();
  function onSampleChanged() {
    const s = SAMPLES.find((x) => x.url === sampleSel.value) ?? SAMPLES[0];
    styleArea.value = s.style;
    roofInput.value = s.roofStyle ?? DEFAULT_PIPELINE.roofStyle;
    floorInput.value = s.floorStyle ?? DEFAULT_PIPELINE.floorStyle;
    const seq = ++loadingSeq;
    currentLoad = loadScene(s.url, s.name, s.lighting, s.area).catch((e) => {
      if (seq === loadingSeq) statusBanner.show(String((e as Error)?.message ?? e), 'error');
    });
  }

  const handleFiles = async (files: File[]) => {
    const f = files[0];
    if (!f) return;
    currentLoad = loadScene(await f.arrayBuffer(), f.name.replace(/\.\w+$/, ''), skySeg.value);
    await currentLoad;
  };
  importPicker.addEventListener('valuechange', (ev) => {
    void handleFiles(ev.detail.value).catch((e) => statusBanner.show(String((e as Error)?.message ?? e), 'error'));
  });
  dropPicker.addEventListener('valuechange', (ev) => {
    void handleFiles(ev.detail.value).catch((e) => statusBanner.show(String((e as Error)?.message ?? e), 'error'));
  });

  const planOpts = () => {
    const obj = targetModeSel.value === 'object' || (targetModeSel.value === 'auto' && session.level?.mode === 'object');
    const focusParts = focusPartsInput.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      maxViews: Math.round(budgetSlider.value),
      adaptive: adaptiveChk.checked,
      mode: targetModeSel.value as 'auto' | 'level' | 'object',
      aerial: !obj && aerialChk.checked ? 8 : 0,
      roofs: !obj && aerialChk.checked ? 24 : 0,
      floors: !obj && floorChk.checked ? 24 : 0,
      holes: obj ? 0 : 12,
      ...(obj && focusParts.length ? { focusParts } : {}),
    };
  };

  async function runPlan() {
    try {
      await currentLoad;
      const opts = planOpts();
      const p = session.makePlan(opts);
      const provCfg = syncProvider();
      const q = quote(p, {
        firstModel: firstModelSel.value,
        fillModel: fillModelSel.value,
        holes: opts.holes,
        secondGoes: samChk.checked ? DEFAULT_PIPELINE.checkRetries : 0,
        planes: samChk.checked && mogeChk.checked,
        viewSize: session.engine?.size,
        provider: provCfg.provider,
        providerFallback: provCfg.providerFallback,
      });
      vViews.textContent = String(p.views.length);
      vCov.textContent = `${Math.round(100 * (p.predicted[p.predicted.length - 1] ?? 0))}%`;
      vCost.textContent = `≤${money(q.cost)}`;
      vTime.textContent = `~${Math.max(1, Math.round(q.seconds / 60))}m`;
      const knee = p.budget ? ` · knee ${p.budget.recommendedViews}v` : '';
      statusBanner.show(`Planned ${p.views.length} cameras (${vCov.textContent}, ≤${money(q.cost)}${knee}).`, 'ok');
      syncViewportHud();
      say(`planned ${p.views.length} cameras, ≤${money(q.cost)}${knee}`);
    } catch (e) {
      statusBanner.show(String((e as Error)?.message ?? e), 'error');
    }
  }

  async function runPaint() {
    await currentLoad;
    apiKeyInput.value ? localStorage.setItem('trompe.falKey', apiKeyInput.value) : localStorage.removeItem('trompe.falKey');
    configureFal(apiKeyInput.value || undefined);
    isRunning = true;
    runBtn.setDisabled(true);
    planBtn.setDisabled(true);
    stopBtn.setDisabled(false);
    syncRunAvailability();
    const S = session.engine?.size ?? 1024;
    let n = 0;
    const onEvent = (e: PipelineEvent) => {
      if (e.type === 'planned') {
        vViews.textContent = `0/${e.plan.views.length}`;
        statusBanner.show(`Painting ${e.plan.views.length} views across ${e.plan.waves.length} waves…`, 'info');
        syncViewportHud();
      }
      if (e.type === 'check') say(e.message);
      if (e.type === 'parts') {
        say(e.message);
        if (e.names) syncParts();
      }
      if (e.type === 'view-start') drawThumb(stageSees, thumbSees, e.state, S);
      if (e.type === 'view-done') {
        drawThumb(stagePaints, thumbPaints, e.view.gen, S);
        completedViewsCount = ++n;
        vViews.textContent = `${n}/${session.plan?.views.length ?? '?'}`;
        vCov.textContent = `${Math.round(100 * e.view.predicted)}%`;
        vCost.textContent = `$${e.cost.toFixed(2)}`;
        vTime.textContent = `${Math.round(e.elapsed)}s`;
        syncViewportHud();
        say(`view \`#${e.view.index}\` · \`${e.view.model}\` · ${e.view.seconds.toFixed(1)}s`);
      }
      if (e.type === 'error') {
        const msg = /abort/i.test(e.message) ? `Stopped at view ${e.index}.` : `View ${e.index} failed: ${e.message}`;
        statusBanner.show(msg, /abort/i.test(e.message) ? 'info' : 'error');
        say(msg);
      }
      if (e.type === 'done') {
        statusBanner.show(`Painted ${e.record.views.length} views (${money(e.record.cost)}, ${Math.round(e.record.seconds)}s).`, 'ok');
        say(`done: ${e.record.views.length}v, ${money(e.record.cost)}`);
      }
    };
    savedAs = canSave ? `${session.level!.name.replace(/[^\w.-]+/g, '-')}-${Date.now().toString(36)}` : undefined;
    const provCfg = syncProvider();
    try {
      await session.run(
        {
          style: styleArea.value,
          roofStyle: roofInput.value,
          floorStyle: floorInput.value,
          firstModel: firstModelSel.value,
          fillModel: fillModelSel.value,
          ...(SAMPLES.find((x) => x.url === sampleSel.value && x.name === session.level?.name)?.look ?? {}),
          nameParts: provCfg.provider !== 'local',
          check: samChk.checked && provCfg.provider !== 'local',
          checkPlanes: mogeChk.checked && provCfg.provider !== 'local',
          styleReference: swatchChk.checked,
          ...(pinnedNotes.length ? { notes: [...pinnedNotes] } : {}),
          plan: planOpts(),
          provider: provCfg.provider,
          providerFallback: provCfg.providerFallback,
          localBackend: provCfg.localBackend,
          localUrl: provCfg.localUrl,
        },
        onEvent,
        savedAs,
      );
      applyShading('textured');
    } catch (e) {
      statusBanner.show(String((e as Error)?.message ?? e), 'error');
    } finally {
      isRunning = false;
      runBtn.setDisabled(false);
      planBtn.setDisabled(false);
      stopBtn.setDisabled(true);
      refreshMonitorWords(false);
      syncPbr();
      void listRuns();
    }
  }

  const download = (blob: Blob, name: string) => {
    const link = el<HTMLAnchorElement>('a', { href: URL.createObjectURL(blob), download: name });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  };

  async function runExportGlb() {
    if (!session.engine) return;
    glbBtn.setDisabled(true);
    try {
      const fmt = exportFormatSel.value as 'png' | 'ktx2';
      const glb = await session.exportGlb({ format: fmt });
      const suffix = fmt === 'ktx2' ? '_ktx2.glb' : '_textured.glb';
      download(new Blob([glb], { type: 'model/gltf-binary' }), `${session.level!.name}${suffix}`);
      statusBanner.show(`Exported ${session.level!.name}${suffix} (${(glb.byteLength / (1024 * 1024)).toFixed(2)} MiB, ${fmt.toUpperCase()}).`, 'ok');
      say(`exported \`${session.level!.name}${suffix}\` (${(glb.byteLength / (1024 * 1024)).toFixed(2)} MiB)`);
    } catch (e) {
      statusBanner.show(String((e as Error)?.message ?? e), 'error');
    } finally {
      glbBtn.setDisabled(false);
    }
  }

  async function runDccSync() {
    if (!session.level) return;
    dccSyncBtn.setDisabled(true);
    try {
      const target = dccTargetSel.value as 'blender' | 'unreal' | 'both';
      const samplePath = sampleSel.value.startsWith('/') ? sampleSel.value.slice(1) : sampleSel.value;
      const body = savedAs
        ? { target, runId: savedAs }
        : { target, glb: samplePath.endsWith('.glb') ? samplePath : 'samples/village.glb' };
      const res = await fetch('/api/dcc-sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        ok: boolean;
        fallbackDryRun?: boolean;
        data?: { targets?: { server: string; status: string; tool: string }[]; receiptPath?: string };
        error?: string;
      };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const targetsSummary = (json.data?.targets ?? []).map((t) => `${t.server} (${t.tool})`).join(', ');
      const msg = json.fallbackDryRun
        ? `Staged DCC sync scripts for ${targetsSummary} (server offline; start blender-mcp/unreal-mcp for live push).`
        : `Synced PBR bundle to ${targetsSummary}.`;
      matFeedback.show(msg, 'ok');
      say(`dcc-sync: ${msg}`);
    } catch (e) {
      matFeedback.show(String((e as Error)?.message ?? e), 'error');
    } finally {
      dccSyncBtn.setDisabled(false);
    }
  }

  function exportAlbedoPng() {
    if (!session.engine) return;
    const atlas = session.engine.atlas;
    const { data, size } = atlas.readBytes([0.5, 0.5, 0.5], Math.min(atlas.size, 8192));
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d')!.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, size, size), 0, 0);
    c.toBlob((b) => {
      if (b) {
        download(b, `${session.level!.name}_albedo.png`);
        matFeedback.show(`Saved ${size} px albedo PNG.`, 'ok');
      }
    }, 'image/png');
  }

  function exportPbrPngs() {
    if (!session.engine?.pbr) return;
    const ch = session.exportPbrChannels();
    const fmt = channelFmtSel.value as 'both' | 'orm' | 'separate';
    const maps: [Uint8ClampedArray, string][] = [];
    if (fmt === 'orm' || fmt === 'both') maps.push([ch.normal, 'normal'], [ch.orm, 'orm']);
    if (fmt === 'separate' || fmt === 'both') {
      if (fmt === 'separate') maps.push([ch.normal, 'normal']);
      maps.push([ch.roughness, 'roughness'], [ch.metalness, 'metalness'], [ch.occlusion, 'occlusion'], [ch.height, 'height']);
    }
    for (const [data, name] of maps) {
      const c = document.createElement('canvas');
      c.width = c.height = ch.size;
      c.getContext('2d')!.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, ch.size, ch.size), 0, 0);
      c.toBlob((b) => b && download(b, `${session.level!.name}_${name}.png`), 'image/png');
    }
    matFeedback.show(`Saved ${maps.length} PBR PNGs (${ch.size} px).`, 'ok');
  }

  function buildLiveReportMarkdown(): string {
    const lvl = session.level;
    const plan = session.plan;
    const rec = session.record;
    const lookCfg = {
      level: sampleSel.value,
      mode: lvl?.mode ?? targetModeSel.value,
      atlas: +atlasSel.value,
      viewSize: +viewResSel.value,
      layout: uvLayoutSel.value,
      lighting: skySeg.value,
      provider: providerSel.value,
      style: styleArea.value,
      roofStyle: roofInput.value,
      floorStyle: floorInput.value,
    };
    const parts = [
      `# Studio Process Report · ${lvl?.name ?? 'Scene'}`,
      '',
      '| Property | Value |',
      '| :--- | :--- |',
      `| Geometry | \`${lvl?.name ?? '–'}\` · ${geoMeta.textContent ?? '–'} (\`${lvl?.mode ?? 'level'}\`) |`,
      `| Atlas & view | ${atlasSel.value} px / ${viewResSel.value} px (\`${uvLayoutSel.value}\`) |`,
      `| Camera plan | ${plan ? `${plan.views.length} views across ${plan.waves.length} waves` : 'Not planned yet'} |`,
      `| Views painted | ${rec ? `${rec.views.length} views (${vCov.textContent} predicted)` : '0'} |`,
      `| Spend & time | ${vCost.textContent ?? '–'} · ${vTime.textContent ?? '–'} |`,
      `| Material maps | PBR: **${session.engine?.pbr ? 'Ready' : 'None'}** · AO: **${session.engine?.ao ? 'Baked' : 'None'}** |`,
      '',
      buildMonitorMarkdown({
        sceneName: lvl?.name ?? 'Scene',
        mode: lvl?.mode ?? 'level',
        plannedViews: plan?.views.length ?? rec?.views.length,
        waves: plan?.waves.length,
        completedViews: completedViewsCount || rec?.views.length,
        predictedCoverage: vCov.textContent ?? undefined,
        cost: vCost.textContent ?? undefined,
        provider: providerSel.value,
        hasPbr: !!session.engine?.pbr,
        hasAo: !!session.engine?.ao,
        critiqueScore: latestCritique?.score,
        critiqueVerdict: latestCritique?.verdict,
        events: eventFeed,
      }),
      '',
      ...(latestCritique ? [buildCriticMarkdown(latestCritique, lvl?.name ?? 'Scene', savedAs), ''] : []),
      '## Active Look Configuration',
      '',
      '```json',
      JSON.stringify(lookCfg, null, 2),
      '```',
      '',
      '## CLI & MCP Reproduction',
      '',
      '```bash',
      `node scripts/texture.mjs --level samples/${(lvl?.name ?? 'courtyard').toLowerCase()}.glb --views ${Math.round(budgetSlider.value)} --layout ${uvLayoutSel.value} --provider ${providerSel.value} --ansi`,
      '```',
    ];
    return parts.join('\n');
  }

  async function loadDocTopic(topic: string) {
    if (topic === 'report') {
      docsWords.stream(buildLiveReportMarkdown(), { charsPerFrame: 420 });
      return;
    }
    const cached = docCache.get(topic);
    if (cached) {
      docsWords.stream(cached, { charsPerFrame: 600 });
      return;
    }
    docsWords.update(`_Loading \`${topic}\` documentation…_`, { streaming: true });
    try {
      const res = await fetch(`/api/docs?topic=${encodeURIComponent(topic)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as { markdown: string };
      docCache.set(topic, payload.markdown);
      docsWords.stream(payload.markdown, { charsPerFrame: 600 });
    } catch (e) {
      docsWords.update(`> Could not load \`${topic}\`: ${String((e as Error)?.message ?? e)}`, { streaming: false });
    }
  }

  async function runExportReport() {
    const lvlName = session.level?.name ?? 'scene';
    const md = buildLiveReportMarkdown();
    const html = await renderStandaloneStudioReport({
      title: `${lvlName} Report`,
      subtitle: savedAs ? `Run ${savedAs}` : `${lvlName} Studio Session`,
      markdown: md,
    });
    if (canSave && savedAs) {
      await Promise.allSettled([
        fetch(`/api/runs/${encodeURIComponent(savedAs)}/report.md`, { method: 'POST', body: md }),
        fetch(`/api/runs/${encodeURIComponent(savedAs)}/report.html`, { method: 'POST', body: html }),
      ]);
    }
    download(new Blob([html], { type: 'text/html' }), `${lvlName.toLowerCase()}_report.html`);
    statusBanner.show(`Exported ${lvlName.toLowerCase()}_report.html${savedAs ? ` (and runs/${savedAs}/report.html)` : ''}.`, 'ok');
  }

  setLighting(SAMPLES[0].lighting);
  const initialSample = new URLSearchParams(location.search).get('sample') === 'sento' ? 'preset:sento-floor' : '/samples/village.glb';
  sampleSel.value = initialSample;
  onSampleChanged();
}
