/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import '@pierre/words/styles.css';
import { createDomRenderer, createHtmlRenderer, escapeHtml, type CodeHighlighterPlugin } from '@pierre/words/html';
import { createMermaidPlugin } from '@pierre/words/mermaid';
import { register, render } from 'pele/core';
import flowchart from 'pele/diagrams/flowchart';
import type { CritiqueReport } from '../core/critic';

register(flowchart);

let cachedCodePlugin: CodeHighlighterPlugin | undefined;
let loadingRich: Promise<CodeHighlighterPlugin> | null = null;

export function ensureCodeHighlights(): Promise<CodeHighlighterPlugin> {
  if (cachedCodePlugin) return Promise.resolve(cachedCodePlugin);
  if (!loadingRich) {
    loadingRich = Promise.all([
      import('@pierre/words/highlights'),
      import('@pierre/highlights/themes/pierre-dark'),
      import('pele/diagrams/pie'),
      import('pele/diagrams/sequence'),
      import('pele/diagrams/state'),
      import('pele/diagrams/xychart'),
    ]).then(([hlMod, themeMod, pieMod, seqMod, stateMod, xyMod]) => {
      register(pieMod.default, seqMod.default, stateMod.default, xyMod.default);
      cachedCodePlugin = hlMod.createHighlightsPlugin({ theme: themeMod.default });
      return cachedCodePlugin;
    });
  }
  return loadingRich;
}

const mermaidPlugin = createMermaidPlugin(
  { render },
  { responsive: true, padding: 10, maxWidth: 680 },
);

const sharedComponents = {
  a: (html: string) => html.replace('<a ', '<a target="_blank" rel="noopener noreferrer" '),
};

export interface WordsMountOptions {
  controls?: boolean;
  lineNumbers?: boolean;
  idPrefix?: string;
}

export function mountWordsView(root: HTMLElement, opts: WordsMountOptions = {}) {
  root.setAttribute('data-markdown', 'root');
  const buildOpts = (code?: CodeHighlighterPlugin) => ({
    math: true,
    cjk: true,
    controls: opts.controls ?? false,
    lineNumbers: opts.lineNumbers ?? false,
    idPrefix: opts.idPrefix ?? 'pk-ui-',
    components: sharedComponents,
    plugins: {
      ...(code ? { code } : {}),
      mermaid: mermaidPlugin,
    },
  });
  const dom = createDomRenderer(root, buildOpts(cachedCodePlugin));
  dom.connect();

  let disposed = false;
  let streamRaf = 0;
  let latestMarkdown = '';

  const maybeUpgradeCodeHighlighter = (source: string) => {
    if (cachedCodePlugin || (!opts.controls && !source.includes('```'))) return;
    void ensureCodeHighlights().then((code) => {
      if (disposed) return;
      dom.configure(buildOpts(code));
      if (!streamRaf && latestMarkdown) {
        dom.update(latestMarkdown, false, false, false);
      }
    });
  };

  const cancelStream = () => {
    if (streamRaf) {
      cancelAnimationFrame(streamRaf);
      streamRaf = 0;
    }
  };

  return {
    get markdown() {
      return latestMarkdown;
    },
    update(source: string, { streaming = false, animated = false }: { streaming?: boolean; animated?: boolean } = {}) {
      cancelStream();
      latestMarkdown = source;
      maybeUpgradeCodeHighlighter(source);
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      dom.update(
        source,
        streaming,
        streaming,
        streaming && animated && !reduced ? { animation: 'fadeIn', duration: 150 } : false,
        streaming ? 'block' : undefined,
      );
    },
    stream(source: string, { charsPerFrame = 1800 }: { charsPerFrame?: number } = {}) {
      cancelStream();
      latestMarkdown = source;
      maybeUpgradeCodeHighlighter(source);
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduced || source.length <= charsPerFrame) {
        dom.update(source, false, false, false);
        return;
      }
      let cursor = 0;
      const step = () => {
        cursor = Math.min(source.length, cursor + charsPerFrame);
        const done = cursor >= source.length;
        dom.update(
          source.slice(0, cursor),
          !done,
          !done,
          !done ? { animation: 'fadeIn', duration: 140 } : false,
          !done ? 'block' : undefined,
        );
        if (!done) streamRaf = requestAnimationFrame(step);
        else streamRaf = 0;
      };
      step();
    },
    dispose() {
      disposed = true;
      cancelStream();
      dom.disconnect();
    },
  };
}

export async function renderStandaloneStudioReport({
  title,
  subtitle,
  markdown,
}: {
  title: string;
  subtitle: string;
  markdown: string;
}): Promise<string> {
  const codePlugin = await ensureCodeHighlights();
  const formatter = createHtmlRenderer({
    math: true,
    cjk: true,
    controls: false,
    lineNumbers: false,
    idPrefix: 'pk-rep-',
    components: sharedComponents,
    plugins: {
      code: codePlugin,
      mermaid: mermaidPlugin,
    },
  });
  try {
    const { html } = formatter.render(markdown, false, false);
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)} · Potemkin 3D</title>
    <style>
      :root {
        color-scheme: dark;
        --pele-bg: #171717; --pele-fg: #f2f2f2; --pele-muted: #a3a3a3;
        --pele-line: #8c8c8c; --pele-surface: #202020; --pele-surface-alt: #262626;
        --pele-border: #3a3a3a; --pele-accent: #d4d4d4;
        --pele-font: ui-sans-serif, system-ui, -apple-system, sans-serif; --pele-radius: 4px;
      }
      * { box-sizing: border-box; }
      body { margin: 0; padding: 28px 18px 56px; background: #121212; color: #f2f2f2; font: 14px/1.65 ui-sans-serif, system-ui, sans-serif; }
      main { max-width: 900px; margin: 0 auto; background: #171717; border: 1px solid #2b2b2b; border-radius: 6px; padding: 26px 30px; }
      header { display: flex; justify-content: space-between; gap: 12px; padding-bottom: 12px; margin-bottom: 18px; border-bottom: 1px solid #2b2b2b; color: #a3a3a3; font-size: 12px; }
      header strong { color: #f2f2f2; }
      h1, h2, h3 { line-height: 1.3; letter-spacing: -0.02em; }
      h1 { font-size: 1.45rem; margin-top: 0; }
      h2 { font-size: 1.12rem; border-bottom: 1px solid #2b2b2b; padding-bottom: 5px; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; margin-block: 1em; font-variant-numeric: tabular-nums; }
      th, td { border: 1px solid #2b2b2b; padding: 6px 10px; text-align: left; }
      th { background: #1c1c1c; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.88em; background: #232323; padding: 0.15em 0.38em; border-radius: 3px; }
      pre { margin: 0; padding: 12px; overflow-x: auto; background: #141414; border: 1px solid #2b2b2b; border-radius: 4px; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
      pre code { background: transparent; padding: 0; }
      [data-markdown='code-block'] { margin-block: 1em; border: 1px solid #2b2b2b; border-radius: 4px; overflow: hidden; }
      [data-markdown='code-block'] pre { border: 0; }
      [data-markdown='mermaid'] { display: flex; justify-content: center; overflow-x: auto; padding: 12px; background: #141414; border: 1px solid #2b2b2b; border-radius: 4px; margin-block: 1em; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <span><strong>Potemkin 3D</strong> · ${escapeHtml(subtitle)}</span>
        <span>${escapeHtml(new Date().toISOString())}</span>
      </header>
      <div data-markdown="root">${html}</div>
    </main>
  </body>
</html>
`;
  } finally {
    formatter.dispose();
  }
}

const safeLabel = (s: string) => s.replace(/["[\]{}()<>|#`]/g, ' ').replace(/\s+/g, ' ').trim();

export interface MonitorFeedState {
  sceneName: string;
  mode: string;
  triangles?: number;
  area?: number;
  plannedViews?: number;
  waves?: number;
  completedViews?: number;
  predictedCoverage?: string;
  cost?: string;
  provider?: string;
  hasPbr?: boolean;
  hasAo?: boolean;
  critiqueScore?: number;
  critiqueVerdict?: string;
  streaming?: boolean;
  events: string[];
}

export function buildMonitorMarkdown(s: MonitorFeedState): string {
  const stagePlan = s.plannedViews ? `${s.plannedViews}v/${s.waves ?? 1}w` : 'idle';
  const stagePaint =
    s.completedViews !== undefined && s.plannedViews
      ? `${s.completedViews}/${s.plannedViews}v`
      : s.completedViews
        ? `${s.completedViews}v`
        : 'pending';
  const lines = [
    '```mermaid',
    'flowchart LR',
    `  G["${safeLabel(s.sceneName)} (${s.mode})"] --> P["Plan (${stagePlan})"]`,
    `  P --> R["Paint (${stagePaint})"]`,
    ...(s.critiqueScore !== undefined
      ? [`  R --> C["Critic (${s.critiqueScore}/100)"]`]
      : s.hasPbr || s.hasAo
        ? [`  R --> M["${s.hasPbr ? 'PBR' : 'AO'}"]`]
        : []),
    '```',
    '',
  ];

  if (s.events.length > 0) {
    for (const item of s.events.slice(0, 6)) {
      lines.push(`- ${item}`);
    }
  } else {
    lines.push(`- Ready on **${s.sceneName}** — plan cameras or run \`potemkin doctor --ansi\`.`);
  }
  return lines.join('\n');
}

export function buildCriticMarkdown(rep: CritiqueReport, levelName: string, runId?: string): string {
  const m = rep.metrics;
  const pct = (v: number) => `${(100 * v).toFixed(1)}%`;
  const lines = [
    `### Critic Verdict · **${rep.score} / 100** (\`${rep.verdict}\`)`,
    '',
    '```mermaid',
    'flowchart LR',
    `  A["Atlas (${safeLabel(levelName)})"] --> S["Critic (${rep.score}/100)"]`,
  ];

  if (rep.actions.length === 0) {
    lines.push('  S --> E["Export Ready (GLB + ORM)"]');
  } else {
    let prev = 'S';
    rep.actions.forEach((act, idx) => {
      const id = `A${idx + 1}`;
      lines.push(`  ${prev} --> ${id}["${safeLabel(act.op)} (${act.estimatedCalls}v)"]`);
      prev = id;
    });
  }
  lines.push(
    '```',
    '',
    '| Signal | Value | Target |',
    '| :--- | ---: | :--- |',
    `| Visible painted | **${pct(m.seenPainted)}** | $\\ge 92\\%$ sightline fill |`,
    `| Gaze density | **${m.highRankPxPerM} px/m** | $w \\propto \\cos^{1.35}\\theta / d$ |`,
    `| View agreement | **${pct(m.multiView.consistency)}** | Multi-view overlap |`,
    `| Seam step | **${m.seam.ratio.toFixed(2)}×** | $\\le 1.35\\times$ interior |`,
    `| Baked light $\\lvert r \\rvert$ | **${m.bakedShading.correlation.toFixed(3)}** | Sun/sky decorrelation |`,
    '',
  );

  if (rep.actions.length > 0) {
    lines.push('**Prescribed pass sequence:**');
    for (const act of rep.actions) {
      lines.push(`- \`${act.op}\` (${act.estimatedCalls} calls) — ${act.reason}`);
    }
    lines.push('');
  }

  if (runId) {
    lines.push(
      '```bash',
      `node automation/cli.mjs report --run-id ${runId} --export-html true --ansi`,
      '```',
    );
  }
  return lines.join('\n');
}
