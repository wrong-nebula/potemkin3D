// SPDX-License-Identifier: Apache-2.0
// Contextual scene notes, shader pass diagrams and provenance overlay for baked Potemkin 3D walkthroughs,
// streamed incrementally with @pierre/words, @pierre/highlights and Pele Mermaid.
import wordsStyles from '@pierre/words/styles.css?inline';
import { createDomRenderer } from '@pierre/words/html';
import { createHighlightsPlugin } from '@pierre/words/highlights';
import pierreDark from '@pierre/highlights/themes/pierre-dark';
import { createMermaidPlugin } from '@pierre/words/mermaid';
import { register, render } from 'pele/core';
import flowchart from 'pele/diagrams/flowchart';

register(flowchart);

const codePlugin = createHighlightsPlugin({ theme: pierreDark });
const mermaidPlugin = createMermaidPlugin({ render }, { responsive: true, padding: 8, maxWidth: 360 });

const NOTES_CSS = `
${wordsStyles}
.potemkin-notes-ui {
  --pele-bg: #161616;
  --pele-fg: #f2f2f2;
  --pele-muted: #a3a3a3;
  --pele-line: #8c8c8c;
  --pele-surface: #202020;
  --pele-surface-alt: #262626;
  --pele-border: #383838;
  --pele-accent: #e5e5e5;
  --pele-font: ui-sans-serif, system-ui, -apple-system, sans-serif;
  --pele-radius: 4px;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  color: #f2f2f2;
}
.potemkin-notes-btn {
  position: fixed;
  right: max(16px, env(safe-area-inset-right));
  bottom: max(16px, env(safe-area-inset-bottom));
  z-index: 25;
  min-height: 34px;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  background: rgba(20, 20, 20, 0.84);
  color: #f2f2f2;
  font: 500 12px/1.2 ui-sans-serif, system-ui, sans-serif;
  cursor: pointer;
}
.potemkin-notes-btn:hover {
  background: #242424;
  border-color: rgba(255, 255, 255, 0.38);
}
.potemkin-notes-btn:focus-visible {
  outline: 2px solid #e5e5e5;
  outline-offset: 2px;
}
.potemkin-notes-drawer {
  position: fixed;
  top: calc(max(56px, env(safe-area-inset-top) + 48px));
  right: max(16px, env(safe-area-inset-right));
  bottom: calc(max(60px, env(safe-area-inset-bottom) + 52px));
  width: min(380px, calc(100vw - 32px));
  z-index: 26;
  display: flex;
  flex-direction: column;
  border-radius: 6px;
  border: 1px solid #2e2e2e;
  background: rgba(20, 20, 20, 0.94);
  overflow: hidden;
}
.potemkin-notes-drawer[hidden] {
  display: none;
}
.potemkin-notes-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  background: #1b1b1b;
  border-bottom: 1px solid #2e2e2e;
}
.potemkin-notes-tabs {
  display: inline-flex;
  gap: 4px;
}
.potemkin-notes-tab,
.potemkin-notes-close {
  min-height: 26px;
  padding: 3px 9px;
  border-radius: 4px;
  border: 1px solid transparent;
  background: transparent;
  color: #a3a3a3;
  font: 500 11.5px/1.2 ui-sans-serif, system-ui, sans-serif;
  cursor: pointer;
}
.potemkin-notes-tab[aria-selected="true"] {
  background: #282828;
  border-color: #3f3f3f;
  color: #f2f2f2;
}
.potemkin-notes-close:hover,
.potemkin-notes-tab:hover {
  color: #f2f2f2;
}
.potemkin-notes-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: #3a3a3a transparent;
  padding: 12px 14px;
  font-size: 12.5px;
  line-height: 1.58;
  color: #d8d8d8;
  font-variant-numeric: tabular-nums;
}
.potemkin-notes-body h2 {
  font-size: 14px;
  color: #f2f2f2;
  margin-block: 0 6px;
}
.potemkin-notes-body h3 {
  font-size: 12.5px;
  color: #ececec;
  margin-block: 12px 4px;
}
.potemkin-notes-body strong { color: #ffffff; }
.potemkin-notes-body [data-markdown="code"] {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  background: #252525;
  color: #f2f2f2;
  padding: 1px 4px;
  border-radius: 3px;
}
.potemkin-notes-body [data-markdown="code-block"] {
  border: 1px solid #2e2e2e;
  border-radius: 4px;
  background: #131313;
  margin-block: 8px;
}
.potemkin-notes-body [data-markdown="code-block"] pre {
  padding: 8px 10px;
  font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.potemkin-notes-body [data-markdown="code-block"]:has([data-markdown="mermaid"]) > [data-markdown="code-header"] {
  display: none;
}
.potemkin-notes-body [data-markdown="mermaid"] {
  padding: 8px;
  border: 1px solid #2e2e2e;
  border-radius: 4px;
  background: #131313;
  margin-block: 8px;
}
.potemkin-notes-body [data-markdown="code-block"] [data-markdown="mermaid"] {
  border: 0;
  margin-block: 0;
}
.potemkin-notes-body [data-markdown="mermaid"] svg {
  max-height: 120px;
  width: auto;
  max-width: 100%;
}
.potemkin-notes-body [data-markdown="table"] {
  display: table;
  width: 100%;
  font-size: 11.5px;
  margin-block: 8px;
}
.potemkin-notes-body :is(th, td) {
  padding: 4px 7px;
  border-color: #2e2e2e;
  overflow-wrap: normal;
  word-break: normal;
}
.potemkin-notes-body th {
  background: #1b1b1b;
  color: #f2f2f2;
}
`;

export function mountWalkNotes({ sceneKind, getSnapshot }) {
  const styleEl = document.createElement('style');
  styleEl.textContent = NOTES_CSS;
  document.head.append(styleEl);

  const root = document.createElement('div');
  root.className = 'potemkin-notes-ui';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'potemkin-notes-btn';
  btn.setAttribute('aria-expanded', 'false');
  btn.textContent = 'Notes · I';

  const drawer = document.createElement('aside');
  drawer.className = 'potemkin-notes-drawer';
  drawer.setAttribute('aria-label', 'Scene notes and provenance');
  drawer.hidden = true;

  const tabContext = document.createElement('button');
  tabContext.type = 'button';
  tabContext.className = 'potemkin-notes-tab';
  tabContext.setAttribute('role', 'tab');
  tabContext.setAttribute('aria-selected', 'true');
  tabContext.textContent = 'Field Notes';

  const tabProv = document.createElement('button');
  tabProv.type = 'button';
  tabProv.className = 'potemkin-notes-tab';
  tabProv.setAttribute('role', 'tab');
  tabProv.setAttribute('aria-selected', 'false');
  tabProv.textContent = 'Provenance';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'potemkin-notes-close';
  closeBtn.setAttribute('aria-label', 'Close notes');
  closeBtn.textContent = 'Close';

  const head = document.createElement('div');
  head.className = 'potemkin-notes-head';
  const tabsWrap = document.createElement('div');
  tabsWrap.className = 'potemkin-notes-tabs';
  tabsWrap.setAttribute('role', 'tablist');
  tabsWrap.append(tabContext, tabProv);
  head.append(tabsWrap, closeBtn);

  const body = document.createElement('div');
  body.className = 'potemkin-notes-body';
  body.setAttribute('data-markdown', 'root');
  drawer.append(head, body);
  root.append(btn, drawer);
  document.body.append(root);

  const dom = createDomRenderer(body, {
    math: true,
    cjk: true,
    controls: false,
    lineNumbers: false,
    idPrefix: 'pk-walk-',
    components: {
      a: (html) => html.replace('<a ', '<a target="_blank" rel="noopener noreferrer" '),
    },
    plugins: {
      code: codePlugin,
      mermaid: mermaidPlugin,
    },
  });
  dom.connect();

  let activeTab = 'context';
  let lastKey = '';
  let streamRaf = 0;

  const streamMarkdown = (md) => {
    if (streamRaf) cancelAnimationFrame(streamRaf);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || md.length <= 240) {
      dom.update(md, false, false, false);
      return;
    }
    let cursor = 0;
    const step = () => {
      cursor = Math.min(md.length, cursor + 260);
      const done = cursor >= md.length;
      dom.update(md.slice(0, cursor), !done, !done, !done ? { animation: 'fadeIn', duration: 140 } : false, !done ? 'block' : undefined);
      if (!done) streamRaf = requestAnimationFrame(step);
      else streamRaf = 0;
    };
    streamRaf = requestAnimationFrame(step);
  };

  const buildContextMd = (snap) => {
    if (sceneKind === 'loft') {
      const { pos, on, meta, hasMaps, focus } = snap;
      const nearWindows = pos ? Math.abs(pos.z) > 2.6 || pos.x > 4.5 : false;
      const nearWest = pos ? pos.x < -3.5 : false;
      const zoneTitle = nearWindows
        ? 'Perimeter Factory Windows & Exterior Lift'
        : nearWest
          ? 'Exposed Brick Wall & Box-Projected Specular'
          : 'Main Studio Floor & Saw-Cut Concrete';
      const zoneBody = nearWindows
        ? 'Daylight outside the steel-framed windows is lifted stops above interior white (`uOutside`), driving anamorphic lens streaks and procedural front-element dirt.'
        : nearWest
          ? 'Roughness and normal maps tilt reflections of the room cube-map (`tEnv`) using Karis’s split-sum fit $F(\\alpha, \\mathbf{n}\\cdot\\mathbf{v})$, suppressing reflection inside mortar joints.'
          : 'The 8-bit painted concrete atlas is lifted into scene-referred light (`uLift`) and auto-exposed from the bright-pass pyramid before AgX highlight roll-off.';

      const stages = ['S["Scene Lift"]'];
      if (on.dof) stages.push(`D["DOF (${(focus ?? 4).toFixed(1)}m)"]`);
      if (on.blur) stages.push('B["180° Blur"]');
      if (on.lens) stages.push('L["Bloom + Flare"]');
      stages.push(on.film ? 'F["AgX + Grain"]' : 'F["AgX"]');

      return [
        `## ${zoneTitle}`,
        '',
        zoneBody,
        '',
        '### Active Camera Pipeline',
        '',
        '```mermaid',
        'flowchart LR',
        ...stages.map((label, i) => `  N${i}${label.slice(1)}`),
        ...stages.slice(1).map((_, i) => `  N${i} --> N${i + 1}`),
        '```',
        '',
        '| Pass | State | Key |',
        '| :--- | :--- | :--- |',
        `| Scene-referred HDR | **${on.hdr ? 'ON' : 'OFF'}** | \`H\` |`,
        `| Material maps & relief | **${on.maps && hasMaps ? 'ON' : 'OFF'}** | \`M\` |`,
        `| Lens bloom & dirt | **${on.lens ? 'ON' : 'OFF'}** | \`L\` |`,
        `| Auto-focus DOF | **${on.dof ? 'ON' : 'OFF'}** | \`F\` |`,
        `| Clay blockout | **${on.clay ? 'ON' : 'OFF'}** | \`X\` |`,
        '',
        ...(meta ? [`_Baked from **${meta.views?.length ?? '–'} views** (${meta.atlasSize ?? 4096} px atlas)._`] : []),
      ].join('\n');
    }

    const { pos, on, pomDepthMm, lodStatus } = snap;
    const z = pos?.z ?? 20;
    const zoneTitle =
      z > 24
        ? 'Sphinx Avenue & Approach'
        : z > 4
          ? 'First Court & Sunlit Sandstone'
          : 'Papyrus Colonnade & Carved Relief';
    const zoneBody =
      z > 24
        ? 'Low-angle desert sun casts PCF shadows across eroded blocks while volumetric dust (`sand.js`) scatters warm aerial perspective.'
        : z > 4
          ? 'Progressive texture LOD (`lod.js`) boots on a compact 2K GLB and streams 4K pages on demand for the UV islands nearest the camera.'
          : `Parallax occlusion mapping (\`${pomDepthMm} mm\`) raymarches per-island height atlases with self-shadowing horizon steps inside carved hieroglyphs.`;

    const nodes = [
      'N0["PBR + Sun"]',
      ...(on.pom && on.maps ? [`N1["POM (${pomDepthMm}mm)"]`] : []),
      ...(on.dust ? ['N2["Dust + Shafts"]'] : []),
      ...(on.dof ? ['N3["Auto DOF"]'] : []),
      'N4["AgX + 3D LUT"]',
    ];
    return [
      `## ${zoneTitle}`,
      '',
      zoneBody,
      '',
      '### Active Frame Pipeline',
      '',
      '```mermaid',
      'flowchart LR',
      ...nodes.map((n) => `  ${n}`),
      ...nodes.slice(1).map((n, i) => `  ${nodes[i].slice(0, 2)} --> ${n.slice(0, 2)}`),
      '```',
      '',
      '| Pass | State | Key |',
      '| :--- | :--- | :--- |',
      `| Normal & roughness | **${on.maps ? 'ON' : 'OFF'}** | \`M\` |`,
      `| Carved POM relief | **${on.pom && on.maps ? `${pomDepthMm} mm` : 'OFF'}** | \`P\` / \`9 0\` |`,
      `| Edge wear & patina | **${on.chips || on.age ? 'ON' : 'OFF'}** | \`C\` / \`O\` |`,
      `| Sand & sun shafts | **${on.dust ? 'ON' : 'OFF'}** | \`U\` / \`R\` |`,
      '',
      ...(lodStatus?.pages ? [`_Streaming 4K LOD: **${lodStatus.sharp}/${lodStatus.pages}** sharp pages active._`] : []),
    ].join('\n');
  };

  const buildProvenanceMd = (snap) => {
    if (sceneKind === 'loft') {
      const m = snap.meta;
      return [
        '## Loft Provenance & Run Manifest',
        '',
        'Generated with **Potemkin 3D** from a coarse architectural blockout (`samples/loft.glb`), projected into a multi-view UV atlas and relit with box-projected environment reflections.',
        '',
        '| Field | Value |',
        '| :--- | :--- |',
        `| Run ID | \`${snap.runId ?? 'loft'}\` |`,
        `| Painted views | ${m?.views?.length ?? '–'} |`,
        `| Atlas size | ${m?.atlasSize ?? 4096} px (\`${m?.layout?.kind ?? 'file'}\`) |`,
        `| Material maps | ${snap.hasMaps ? 'Normal + Roughness + Height' : 'Albedo only'} |`,
        '',
        '```bash',
        '# Inspect or re-score this run via CLI',
        `node automation/cli.mjs report --run-id ${snap.runId ?? 'loft-props'} --ansi`,
        '```',
        '',
        '_Apache-2.0 · Modified from Patch Trompe by the Potemkin contributors (see `PROVENANCE.md`)._',
      ].join('\n');
    }

    return [
      '## Luxor Temple Provenance',
      '',
      'Textured from a coarse temple blockout (`samples/luxor.glb`) using sightline-weighted UV packing (`--layout near --weights --paths`), multi-view Screened-Poisson consolidation, and aligned height/roughness/normal maps.',
      '',
      '| Stage | Detail |',
      '| :--- | :--- |',
      '| Base boot mesh | `level_2k.glb` (progressive 4K tile stream in `hi/`) |',
      '| Surface relief | Per-island height atlas + horizon self-shadowing (`pom.js`) |',
      '| Color grade | 33³ 3D LUT (`luxor-gold.cube`) over AgX scene-referred HDR |',
      '| License | Apache-2.0 (`NOTICE` & `PROVENANCE.md`) |',
      '',
      '```bash',
      '# Capture or rebuild the Luxor viewer',
      'node automation/cli.mjs screenshot --scene luxor --wait --ansi',
      'npm run build:scenes',
      '```',
    ].join('\n');
  };

  const renderNow = (forceStream = false) => {
    if (drawer.hidden) return;
    const snap = getSnapshot();
    const md = activeTab === 'context' ? buildContextMd(snap) : buildProvenanceMd(snap);
    const sig = `${activeTab}:${md}`;
    if (!forceStream && sig === lastKey) return;
    lastKey = sig;
    if (forceStream) streamMarkdown(md);
    else dom.update(md, false, false, false);
  };

  const setOpen = (open) => {
    drawer.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) {
      if (document.pointerLockElement) document.exitPointerLock?.();
      renderNow(true);
    }
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(drawer.hidden);
  });
  closeBtn.addEventListener('click', () => setOpen(false));
  tabContext.addEventListener('click', () => {
    activeTab = 'context';
    tabContext.setAttribute('aria-selected', 'true');
    tabProv.setAttribute('aria-selected', 'false');
    renderNow(true);
  });
  tabProv.addEventListener('click', () => {
    activeTab = 'provenance';
    tabContext.setAttribute('aria-selected', 'false');
    tabProv.setAttribute('aria-selected', 'true');
    renderNow(true);
  });

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 'i' || e.key === '?') {
      setOpen(drawer.hidden);
    } else if (k === 'escape' && !drawer.hidden && !document.pointerLockElement) {
      setOpen(false);
    }
  });

  return {
    tick() {
      if (!drawer.hidden) renderNow(false);
    },
    setOpen,
  };
}
