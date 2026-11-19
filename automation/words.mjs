// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { createHtmlSession, renderToAnsi, renderToHtml } from '@pierre/words';
import { createHtmlRenderer, escapeHtml } from '@pierre/words/html';
import { createHighlightsPlugin } from '@pierre/words/highlights';
import pierreDark from '@pierre/highlights/themes/pierre-dark';
import { createMermaidPlugin } from '@pierre/words/mermaid';
import * as pele from 'pele';
import { ROOT, AutomationError, inside, readJSON } from './files.mjs';

const decoder = new TextDecoder();

export const DOC_CATALOG = [
  { id: 'engine', title: 'Engine Architecture', path: 'ENGINE.md', summary: 'Geometry prepasses, camera planning, projection, stitching, UV refinement and PBR baking.' },
  { id: 'readme', title: 'Overview & Quickstart', path: 'README.md', summary: 'Setup, studio authoring workflow, CLI flags and sample scenes.' },
  { id: 'potemkin', title: 'Potemkin Scenes & Film Camera', path: 'POTEMKIN.md', summary: 'Scene-referred HDR walkthroughs, lens flare, DOF, POM relief and progressive 4K LOD.' },
  { id: 'material-maps', title: 'Material Maps & Presets', path: 'docs/material-maps.md', summary: 'Intrinsic and PATINA height, roughness, metallic, normal and glTF ORM channels.' },
  { id: 'automation', title: 'Automation & MCP Reference', path: 'docs/AUTOMATION.md', summary: 'Persistent jobs, CLI commands, MCP server tools/resources and spend guards.' },
  { id: 'tutorial', title: 'Free Walkthrough Tutorial', path: 'docs/TUTORIAL.md', summary: 'Zero-cost end-to-end tour of planning, clay self-test and scene screenshots.' },
  { id: 'provenance', title: 'Provenance & Licensing', path: 'PROVENANCE.md', summary: 'Attribution, upstream lineage and Apache-2.0 licensing details.' },
  { id: 'todo', title: 'Research & Roadmap', path: 'TODO.md', summary: 'Measured benchmarks across UV unwrap, local providers, Critic loop and research spikes.' },
];

const codePlugin = createHighlightsPlugin({ theme: pierreDark });
const mermaidPlugin = createMermaidPlugin(pele, {
  responsive: true,
  padding: 12,
  maxWidth: 760,
});

const htmlComponents = {
  a: (html) => html.replace('<a ', '<a target="_blank" rel="noopener noreferrer" '),
};

export function createWordsHtmlRenderer(opts = {}) {
  return createHtmlRenderer({
    math: true,
    cjk: true,
    controls: opts.controls ?? false,
    lineNumbers: opts.lineNumbers ?? false,
    idPrefix: opts.idPrefix ?? 'pk-',
    components: htmlComponents,
    plugins: {
      code: codePlugin,
      mermaid: mermaidPlugin,
    },
  });
}

export function markdownToHtmlFragment(markdown, { incomplete = false, active = false, controls = false, lineNumbers = false } = {}) {
  const renderer = createWordsHtmlRenderer({ controls, lineNumbers });
  try {
    return renderer.render(String(markdown ?? ''), incomplete, active).html;
  } finally {
    renderer.dispose();
  }
}

export function markdownToAnsi(markdown, { width = 88, math = true, cjk = true } = {}) {
  const bytes = renderToAnsi(String(markdown ?? ''), { width, math, cjk });
  return decoder.decode(bytes);
}

export function parseMarkdownFrontmatter(markdown) {
  const [meta, bytes] = renderToHtml(String(markdown ?? ''), { frontmatter: true, skipHtml: true, math: true });
  return { frontmatter: meta, html: decoder.decode(bytes) };
}

export function createStreamingReportSession(opts = {}) {
  const rawSession = createHtmlSession();
  const richRenderer = createWordsHtmlRenderer(opts);
  let buffer = '';
  return {
    get markdown() {
      return buffer;
    },
    append(chunk, { incomplete = true } = {}) {
      buffer += chunk;
      return this.snapshot({ incomplete });
    },
    replace(nextMarkdown, { incomplete = false } = {}) {
      buffer = nextMarkdown;
      return this.snapshot({ incomplete });
    },
    snapshot({ incomplete = false, width = 88 } = {}) {
      const raw = rawSession.render(buffer, { incomplete, math: true, cjk: true });
      const rich = richRenderer.render(buffer, incomplete, incomplete);
      return {
        markdown: buffer,
        html: rich.html,
        stable: rich.stable,
        pending: rich.pending,
        rawStableBytes: raw.stable.length,
        ansi: markdownToAnsi(buffer, { width }),
      };
    },
    dispose() {
      richRenderer.dispose();
    },
  };
}

const STANDALONE_CSS = `
:root {
  color-scheme: dark;
  --bg: #121212;
  --panel: #171717;
  --header: #1c1c1c;
  --muted-bg: #232323;
  --border: #2c2c2c;
  --fg: #f2f2f2;
  --muted: #a3a3a3;
  --ok: #8fd1a6;
  --warn: #e2ba78;
  --pele-bg: #171717;
  --pele-fg: #f2f2f2;
  --pele-muted: #a3a3a3;
  --pele-line: #8c8c8c;
  --pele-surface: #202020;
  --pele-surface-alt: #262626;
  --pele-border: #3a3a3a;
  --pele-accent: #d4d4d4;
  --pele-font: ui-sans-serif, system-ui, -apple-system, sans-serif;
  --pele-radius: 4px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 14px/1.65 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  padding: 32px 20px 64px;
}
main {
  max-width: 920px;
  margin: 0 auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 28px 32px;
}
header.report-meta {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  padding-bottom: 14px;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--border);
  color: var(--muted);
  font-size: 12px;
}
header.report-meta strong { color: var(--fg); font-weight: 600; }
[data-markdown='root'] { line-height: 1.65; overflow-wrap: anywhere; }
[data-markdown='root'] > :first-child { margin-top: 0; }
[data-markdown='root'] > :last-child { margin-bottom: 0; }
[data-markdown='root'] :is(p, ul, ol, blockquote, table, [data-markdown='code-block'], [data-markdown='mermaid']) { margin-block: 1em; }
[data-markdown='root'] :is(h1, h2, h3, h4) { font-weight: 600; line-height: 1.3; margin-block: 1.4em 0.5em; letter-spacing: -0.02em; }
h1 { font-size: 1.55rem; margin-top: 0; }
h2 { font-size: 1.18rem; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
h3 { font-size: 1.02rem; color: #dcdcdc; }
table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
th, td { border: 1px solid var(--border); padding: 7px 10px; text-align: left; }
th { background: var(--header); color: var(--fg); font-weight: 600; }
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.88em;
  background: var(--muted-bg);
  padding: 0.15em 0.4em;
  border-radius: 3px;
}
pre {
  margin: 0;
  padding: 12px 14px;
  overflow-x: auto;
  background: #141414;
  border: 1px solid var(--border);
  border-radius: 4px;
  font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
}
pre code { background: transparent; padding: 0; }
[data-markdown='code-block'] { border: 1px solid var(--border); border-radius: 4px; overflow: hidden; background: #141414; }
[data-markdown='code-header'] {
  display: flex; justify-content: space-between; padding: 6px 12px;
  background: var(--header); border-bottom: 1px solid var(--border);
  font: 11.5px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted);
}
[data-markdown='code-block'] pre { border: 0; border-radius: 0; }
[data-markdown='mermaid'] {
  display: flex; justify-content: center; overflow-x: auto;
  padding: 14px; background: #141414; border: 1px solid var(--border); border-radius: 4px;
}
blockquote {
  margin-inline: 0; padding-inline-start: 12px;
  border-inline-start: 3px solid #525252; color: var(--muted);
}
a { color: var(--fg); text-underline-offset: 3px; }
`;

export function renderStandaloneReportHtml({ title, subtitle = 'Potemkin 3D · Process Report', markdown, incomplete = false }) {
  const bodyHtml = markdownToHtmlFragment(markdown, { incomplete, controls: false, lineNumbers: false });
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)} · Potemkin 3D</title>
    <style>${STANDALONE_CSS}</style>
  </head>
  <body>
    <main>
      <header class="report-meta">
        <span><strong>Potemkin 3D</strong> · ${escapeHtml(subtitle)}</span>
        <span>${escapeHtml(new Date().toISOString())}</span>
      </header>
      <div data-markdown="root">${bodyHtml}</div>
    </main>
  </body>
</html>
`;
}

export function listDocs(root = ROOT) {
  return DOC_CATALOG.filter((d) => fs.existsSync(path.join(root, d.path))).map((d) => ({
    ...d,
    bytes: fs.statSync(path.join(root, d.path)).size,
    uri: `potemkin://docs/${d.id}`,
  }));
}

export function readDoc(idOrPath, { format = 'markdown', width = 88, root = ROOT } = {}) {
  const normalized = String(idOrPath || 'engine').toLowerCase().replace(/\.md$/, '');
  const entry = DOC_CATALOG.find(
    (d) => d.id === normalized || d.path.toLowerCase() === String(idOrPath).toLowerCase() || d.path.toLowerCase().replace(/\.md$/, '') === normalized,
  );
  if (!entry) throw new AutomationError('NOT_FOUND', `Unknown documentation topic: ${idOrPath}. Available: ${DOC_CATALOG.map((d) => d.id).join(', ')}`);
  const file = inside(root, entry.path);
  const markdown = fs.readFileSync(file, 'utf8');
  const headings = markdown
    .split('\n')
    .filter((l) => /^#{1,3}\s+/.test(l))
    .map((l) => l.replace(/^#+\s+/, '').trim());
  const out = {
    id: entry.id,
    title: entry.title,
    path: entry.path,
    summary: entry.summary,
    headings,
    markdown,
  };
  if (format === 'html') out.html = markdownToHtmlFragment(markdown, { lineNumbers: false });
  if (format === 'standalone-html') out.html = renderStandaloneReportHtml({ title: entry.title, subtitle: entry.path, markdown });
  if (format === 'ansi') out.ansi = markdownToAnsi(markdown, { width });
  return out;
}

const mermaidSafe = (s) => String(s ?? '').replace(/["[\]{}()<>|#`]/g, ' ').replace(/\s+/g, ' ').trim();
const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '–');
const usd = (v) => (typeof v === 'number' && Number.isFinite(v) ? `USD ${v.toFixed(2)}` : '–');

export function formatJobMarkdown(job, requestPayload = null) {
  const steps = requestPayload?.steps ?? [];
  const total = job.total ?? (steps.length || 1);
  const completedCount = (job.results ?? []).length;
  const activeStep = job.status === 'running' ? (job.step || completedCount + 1) : 0;

  const lines = [
    `# Job Report · \`${job.id}\``,
    '',
    `| Field | Value |`,
    `| :--- | :--- |`,
    `| Kind | \`${job.kind}\` |`,
    `| Status | **${job.status}** |`,
    `| Progress | ${completedCount} / ${total} steps${job.operation ? ` (current: \`${job.operation}\`)` : ''} |`,
    `| Created | \`${job.createdAt}\` |`,
    ...(job.finishedAt ? [`| Finished | \`${job.finishedAt}\` |`] : []),
    '',
  ];

  if (steps.length > 0 || (job.results ?? []).length > 0) {
    const opList = steps.length > 0
      ? steps.map((s, idx) => ({ index: idx + 1, op: s.op }))
      : (job.results ?? []).map((r, idx) => ({ index: r.step ?? idx + 1, op: r.op }));

    lines.push('## Pipeline Flow', '', '```mermaid', 'flowchart LR');
    for (let i = 0; i < opList.length; i++) {
      const item = opList[i];
      const tag = item.index <= completedCount ? 'done' : item.index === activeStep ? 'active' : 'queued';
      lines.push(`  S${item.index}["${item.index}. ${mermaidSafe(item.op)} (${tag})"]`);
      if (i > 0) lines.push(`  S${opList[i - 1].index} --> S${item.index}`);
    }
    lines.push('```', '');
  }

  if (job.error) {
    lines.push('## Error', '', `> **${escapeHtml(job.error.code ?? 'ERROR')}**: ${escapeHtml(job.error.message ?? String(job.error))}`, '');
  }

  if ((job.results ?? []).length > 0) {
    lines.push('## Completed Steps', '', '| Step | Operation | Highlights |', '| ---: | :--- | :--- |');
    for (const r of job.results) {
      const detail = [];
      if (r.views !== undefined && typeof r.views === 'number') detail.push(`${r.views} views`);
      if (Array.isArray(r.views)) detail.push(`${r.views.length} views`);
      if (typeof r.predicted === 'number') detail.push(`predicted ${pct(r.predicted)}`);
      if (typeof r.score === 'number') detail.push(`score ${r.score}/100`);
      if (typeof r.cost === 'number') detail.push(usd(r.cost));
      if (r.path) detail.push(`\`${r.path}\``);
      lines.push(`| ${r.step ?? '–'} | \`${r.op}\` | ${detail.join(' · ') || 'ok'} |`);
    }
    lines.push('');
  }

  if ((job.artifacts ?? []).length > 0) {
    lines.push('## Artifacts', '', '| Name | MIME | Size | Path |', '| :--- | :--- | ---: | :--- |');
    for (const a of job.artifacts) {
      lines.push(`| \`${a.name}\` | \`${a.mimeType}\` | ${(a.bytes / 1024).toFixed(1)} KiB | \`${a.path}\` |`);
    }
    lines.push('');
  }

  if ((job.events ?? []).length > 0) {
    const recent = job.events.slice(-10);
    lines.push('## Recent Telemetry', '');
    for (const ev of recent) {
      const msg = ev.message ?? (ev.op ? `${ev.type}: ${ev.op} (step ${ev.step})` : ev.type);
      lines.push(`- \`${(ev.at ?? '').slice(11, 19) || 'event'}\` — ${mermaidSafe(msg)}`);
    }
    lines.push('');
  }

  if (job.status === 'running' || job.status === 'queued') {
    lines.push(`_Streaming live updates — poll \`potemkin job-status --id ${job.id} --ansi\` for incremental progress._`);
  }

  return lines.join('\n');
}

export function formatCritiqueSectionLines(critique) {
  if (!critique) return [];
  const m = critique.metrics ?? {};
  const lines = [
    '## Critic Evaluation',
    '',
    `| Metric | Measured | Target / Note |`,
    `| :--- | ---: | :--- |`,
    `| Overall score | **${critique.score} / 100** | Verdict: **${critique.verdict}** |`,
    `| Visible painted | ${pct(m.seenPainted)} | Unpainted visible residual ${pct(1 - (m.seenPainted ?? 0))} |`,
    `| High-rank sightlines | ${m.highRankPxPerM ?? '–'} px/m | Weighted by bot gaze $\\propto \\cos^{1.35}\\theta / d$ |`,
    `| Multi-view consistency | ${pct(m.multiView?.consistency)} | Overlap agreement across views |`,
    `| UV seam step ratio | ${typeof m.seam?.ratio === 'number' ? `${m.seam.ratio.toFixed(2)}×` : '–'} | Cross-seam vs interior gradient |`,
    `| Baked shading $\\lvert r \\rvert$ | ${typeof m.bakedShading?.correlation === 'number' ? m.bakedShading.correlation.toFixed(3) : '–'} | Sun/sky irradiance correlation |`,
    '',
  ];
  if ((critique.actions ?? []).length > 0) {
    lines.push('### Prescribed Repairs', '');
    for (const act of critique.actions) {
      lines.push(`- **\`${act.op}\`** (${act.estimatedCalls ?? 0} model calls) — ${act.reason}`);
    }
    lines.push('');
  }
  return lines;
}

export function formatRunMarkdown(runId, meta, { critique = null, planMeta = null } = {}) {
  const views = meta.views ?? [];
  const lastPred = views.at(-1)?.predicted ?? null;
  const totalCost = (meta.cost ?? 0) + (meta.pbr?.cost ?? 0);
  const atlasSize = meta.pages?.size ?? meta.atlasSize ?? 4096;
  const pageCount = meta.pages?.count ?? 1;

  const lines = [
    `# Run Report · \`${runId}\``,
    '',
    `| Property | Value |`,
    `| :--- | :--- |`,
    `| Level | **${meta.level ?? runId}** |`,
    `| Views painted | ${views.length}${meta.partial ? ' _(partial)_' : ''} |`,
    `| Predicted coverage | ${pct(lastPred)} |`,
    `| Atlas | ${atlasSize} px × ${pageCount} page(s) (\`${meta.layout?.kind ?? 'file'}\`) |`,
    `| Lighting | \`${meta.lighting?.name ?? 'overcast'}\` |`,
    `| Spend & elapsed | ${usd(totalCost)} · ${Math.round(meta.seconds ?? 0)}s |`,
    '',
    '## Pipeline Topology',
    '',
    '```mermaid',
    'flowchart LR',
    `  G["Geometry (${mermaidSafe(meta.level ?? runId)})"] --> P["Camera Plan (${views.length}v)"]`,
    `  P --> A["Paint & Project (${atlasSize}px)"]`,
    ...(critique
      ? [
          `  A --> C["Critic (${critique.score}/100 · ${critique.verdict})"]`,
          ...(meta.pbr ? [`  C --> M["PBR (${mermaidSafe(meta.pbr.source?.kind ?? 'maps')})"]`] : []),
        ]
      : meta.pbr
        ? [`  A --> M["PBR (${mermaidSafe(meta.pbr.source?.kind ?? 'maps')})"]`]
        : []),
    '```',
    '',
  ];

  if (views.length > 0) {
    lines.push('## Camera Wave Summary', '', '| View | Wave | Model | Unknown | Predicted | Time |', '| ---: | ---: | :--- | ---: | ---: | ---: |');
    for (const v of views.slice(0, 16)) {
      lines.push(
        `| ${v.index} | ${v.wave ?? 0} | \`${v.model ?? '–'}\` | ${pct(v.unknownFraction)} | ${pct(v.predicted)} | ${typeof v.seconds === 'number' ? `${v.seconds.toFixed(1)}s` : '–'} |`,
      );
    }
    if (views.length > 16) lines.push(`| … | … | _+${views.length - 16} more views_ | … | ${pct(lastPred)} | … |`);
    lines.push('');
  }

  lines.push(...formatCritiqueSectionLines(critique));

  const cliSnippet = [
    `# Inspect and score this run from the terminal`,
    `node automation/cli.mjs run-info --id ${runId} --ansi`,
    `node automation/cli.mjs agent-critique --run-id ${runId} --ansi`,
  ].join('\n');
  lines.push('## Reproduce & Inspect', '', '```bash', cliSnippet, '```', '');

  if (planMeta?.coverageBudget) {
    lines.push('### Planner Coverage Budget', '', '```json', JSON.stringify(planMeta.coverageBudget, null, 2), '```', '');
  }

  return lines.join('\n');
}

export function formatAgentSessionMarkdown(session) {
  const b = session.budget ?? {};
  const cb = session.coverageBudget ?? {};
  const lines = [
    `# Agent Session · \`${session.id}\``,
    '',
    `| Field | Value |`,
    `| :--- | :--- |`,
    `| Run ID | \`${session.runId}\` |`,
    `| Status | **${session.status}** |`,
    `| Geometry | \`${session.inputPath ?? session.level ?? '–'}\` (${session.mode ?? 'level'}) |`,
    `| Spend | ${usd(session.spentUsd ?? 0)} / ${usd(b.statedUsd ?? 0)} (remaining ${usd(b.remainingUsd ?? 0)}) |`,
    `| Views used | ${cb.viewsUsed ?? 0} / ${cb.maxTotalViews ?? '–'} (target seen ${pct(cb.targetSeenPainted)}) |`,
    '',
    '## Planner → Actor → Critic Loop',
    '',
    '```mermaid',
    'flowchart LR',
    `  PL["Planner (${cb.initialViews ?? 0}v)"] --> AP["Approval Gate"]`,
  ];

  const rounds = (session.episodes ?? []).filter((e) => e.round !== undefined && e.ops);
  if (rounds.length === 0) {
    lines.push('  AP --> AC["Actor (pending)"]');
  } else {
    let prev = 'AP';
    for (const r of rounds) {
      const node = `R${r.round}`;
      lines.push(`  ${prev} --> ${node}["Round ${r.round}: ${mermaidSafe(r.kind)} (${r.scoreAfter ?? '–'}/100)"]`);
      prev = node;
    }
    if (session.status === 'completed') lines.push(`  ${prev} --> EX["Export GLB + PBR"]`);
    else if (session.pendingProposal) lines.push(`  ${prev} --> NX["Pending Round ${session.pendingProposal.round}"]`);
  }
  lines.push('```', '');

  if (rounds.length > 0) {
    lines.push('## Episodic Rounds', '', '| Round | Kind | Operations | Views | Spend | Score | Verdict |', '| ---: | :--- | :--- | ---: | ---: | ---: | :--- |');
    for (const r of rounds) {
      const scoreStr = r.scoreBefore !== null && r.scoreBefore !== undefined ? `${r.scoreBefore} → **${r.scoreAfter}**` : `**${r.scoreAfter ?? '–'}**`;
      lines.push(
        `| ${r.round} | \`${r.kind}\` | \`${(r.ops ?? []).join(', ')}\` | +${r.viewsAdded ?? 0} (${r.totalViews ?? 0}) | ${usd(r.roundSpendUsd ?? 0)} | ${scoreStr} | ${r.verdict} |`,
      );
    }
    lines.push('');
  }

  if (session.pendingProposal) {
    const p = session.pendingProposal;
    lines.push(
      '## Pending Human Spend Proposal',
      '',
      `> **Proposal \`${p.id}\`** (Round ${p.round} · \`${p.kind}\` · est. ${p.estimatedViews} views · ${usd(p.estimatedCostUsd)}): ${p.summary}`,
      '',
      '```bash',
      `node automation/cli.mjs agent-approve --session-id ${session.id} --proposal-id ${p.id} --ansi`,
      '```',
      '',
    );
  }

  lines.push(...formatCritiqueSectionLines(session.latestCritique));
  return lines.join('\n');
}

export function writeRunReportFiles(runId, { root = ROOT, critique = null } = {}) {
  const runJsonPath = inside(root, `runs/${runId}/run.json`, { exists: false });
  if (!fs.existsSync(runJsonPath)) return null;
  const meta = readJSON(runJsonPath);
  const planPath = inside(root, `runs/${runId}/look.plan.json`, { exists: false });
  const planMeta = fs.existsSync(planPath) ? readJSON(planPath) : null;
  const critPath = inside(root, `runs/${runId}/critique.json`, { exists: false });
  const effectiveCrit = critique ?? (fs.existsSync(critPath) ? readJSON(critPath) : null);

  const md = formatRunMarkdown(runId, meta, { critique: effectiveCrit, planMeta });
  const html = renderStandaloneReportHtml({ title: `Run ${runId}`, subtitle: `Run ${runId} (${meta.level ?? 'scene'})`, markdown: md });
  const dir = path.dirname(runJsonPath);
  const mdFile = path.join(dir, 'report.md');
  const htmlFile = path.join(dir, 'report.html');
  fs.writeFileSync(mdFile, md);
  fs.writeFileSync(htmlFile, html);
  return {
    markdown: md,
    htmlPath: `runs/${runId}/report.html`,
    markdownPath: `runs/${runId}/report.md`,
    bytes: Buffer.byteLength(html),
  };
}

export function formatCommandMarkdown(command, data) {
  if (!data || typeof data !== 'object') return `# \`${command}\`\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;

  if (command === 'doc' && typeof data.markdown === 'string') return data.markdown;
  if (command === 'report' && typeof data.markdown === 'string') return data.markdown;

  if (command === 'doctor') {
    return [
      '# Potemkin Doctor',
      '',
      '| Check | Status | Detail |',
      '| :--- | :--- | :--- |',
      `| Node.js | **${data.nodeSupported ? 'PASS' : 'WARN'}** | \`v${data.node}\` |`,
      `| Headless Chromium | **${data.browserInstalled ? 'PASS' : 'MISSING'}** | Source: \`${data.browserSource}\` |`,
      `| Cloud \`FAL_KEY\` | ${data.falKeyConfigured ? 'Configured' : 'Not set (local $0 available)'} | Server-side env |`,
      `| Local model endpoint | ${data.localModelUrl ? `\`${data.localModelUrl}\`` : 'Auto-probe loopback'} | \`LOCAL_MODEL_URL\` |`,
      `| Baked scene viewers | **${data.scenes ? 'READY' : 'MISSING'}** | \`deploy/potemkin3d\` |`,
      '',
      `> **Next:** ${data.next}`,
      '',
    ].join('\n');
  }

  if (command === 'job-status') return formatJobMarkdown(data);

  if (command === 'dcc-sync' && Array.isArray(data.targets)) {
    const mapList = Object.entries(data.maps ?? {}).map(([k, p]) => `- **${k}**: \`${p}\``).join('\n') || '- _(embedded GLB base-color only)_';
    const targetRows = data.targets.map((t) => `| \`${t.server}\` | **${t.status.toUpperCase()}** | \`${t.tool}\` | ${t.endpoint ? `\`${t.endpoint}\`` : 'offline preview'} |`);
    return [
      `# DCC Sync${data.dryRun ? ' (Dry Run)' : ''}`,
      '',
      `- **Mesh**: \`${data.glb}\``,
      `- **Blender collection**: \`${data.collection}\``,
      `- **Unreal path**: \`${data.destinationPath}\``,
      '',
      '```mermaid',
      'flowchart LR',
      `  GLB["${data.glb}"] --> SYNC["potemkin dcc-sync"]`,
      ...data.targets.map((t, idx) => `  SYNC --> T${idx}["${t.server}: ${t.tool}"]`),
      '```',
      '',
      '## Channels',
      '',
      mapList,
      '',
      '## Target Dispatch',
      '',
      '| Server | Status | Negotiated Tool | Endpoint |',
      '| :--- | :--- | :--- | :--- |',
      ...targetRows,
      '',
    ].join('\n');
  }

  if (command === 'jobs' && Array.isArray(data.jobs)) {
    const rows = data.jobs.slice(0, 20).map((j) => `| \`${j.id}\` | \`${j.kind}\` | **${j.status}** | ${j.step ?? 0}/${j.total ?? 1} | \`${j.createdAt}\` |`);
    return ['# Recent Jobs', '', '| Job ID | Kind | Status | Steps | Created |', '| :--- | :--- | :--- | ---: | :--- |', ...rows, ''].join('\n');
  }

  if (command === 'runs' && Array.isArray(data.runs)) {
    if (!data.runs.length) return '# Saved Runs\n\nNo saved generation runs under `runs/` yet.\n';
    const rows = data.runs.map((r) => `| \`${r.id}\` | ${r.level} | ${r.views} | ${usd(r.cost)} | \`${r.layout ?? 'file'}\` |`);
    return ['# Saved Runs', '', '| Run ID | Level | Views | Cost | Layout |', '| :--- | :--- | ---: | ---: | :--- |', ...rows, ''].join('\n');
  }

  if (command === 'run-info' && data.id) {
    const arts = (data.artifacts ?? []).map((a) => `- \`${a.path}\``).join('\n') || '- _(no exported files yet)_';
    return [
      `# Run \`${data.id}\``,
      '',
      `| Field | Value |`,
      `| :--- | :--- |`,
      `| Level | **${data.level}** |`,
      `| Views | ${data.views}${data.partial ? ' _(partial)_' : ''} |`,
      `| Cost & time | ${usd(data.cost)} · ${Math.round(data.seconds ?? 0)}s |`,
      `| Atlas & view | ${data.atlasSize ?? '–'} px / ${data.viewSize ?? '–'} px (\`${data.layout ?? 'file'}\`) |`,
      '',
      '## Exported Artifacts',
      '',
      arts,
      '',
    ].join('\n');
  }

  if (command === 'catalog' && Array.isArray(data.samples)) {
    const rows = data.samples.map((s) => `| **${s.name}** | \`${s.path}\` | ${(s.bytes / 1024).toFixed(0)} KiB | ${s.look ? `\`${s.look}\`` : '–'} |`);
    return [
      '# Potemkin Catalog',
      '',
      '| Sample | Path | Size | Look preset |',
      '| :--- | :--- | ---: | :--- |',
      ...rows,
      '',
      `Walkthrough scenes: ${(data.scenes ?? []).map((s) => `\`${s}\``).join(', ')}`,
      '',
    ].join('\n');
  }

  if (command === 'inspect' && data.path) {
    const matList = (data.materials ?? []).map((m) => `\`${typeof m === 'string' ? m : m.name}\``).join(', ') || 'none';
    const uvStatus =
      data.primitivesWithUVs === data.primitives && data.primitives > 0
        ? `Present (${data.primitivesWithUVs}/${data.primitives} primitives)`
        : `${data.primitivesWithUVs ?? 0}/${data.primitives ?? 0} primitives (xatlas unwrap ready)`;
    return [
      `# GLB Inspection · \`${data.path}\``,
      '',
      '| Metric | Value |',
      '| :--- | :--- |',
      `| File size | ${((data.bytes ?? 0) / 1024).toFixed(1)} KiB (glTF \`${data.version ?? '2.0'}\`) |`,
      `| Nodes / meshes / primitives | ${data.nodes ?? 0} / ${data.meshes ?? 0} / ${data.primitives ?? 0} |`,
      `| UV attribute | **${uvStatus}** |`,
      `| Embedded images | ${data.images ?? 0} |`,
      `| Materials | ${matList} |`,
      '',
    ].join('\n');
  }

  if ((command === 'agent-critique' || command === 'agent-act') && data.critique) {
    const header = [
      `# ${command === 'agent-act' ? `Agent Round ${data.roundExecuted} (${data.status})` : `Critic Report · \`${data.runId}\``}`,
      '',
      ...(data.sessionId ? [`Session: \`${data.sessionId}\` · Run: \`${data.runId}\``] : []),
      '',
    ];
    return [...header, ...formatCritiqueSectionLines(data.critique)].join('\n');
  }

  if (command === 'agent-status' && data.id) {
    return formatAgentSessionMarkdown(data);
  }

  if (command === 'help') {
    if (data.commands) {
      const rows = Object.entries(data.commands).map(([k, desc]) => `| \`${k}\` | ${desc} |`);
      return [
        '# Potemkin CLI',
        '',
        `Usage: \`${data.usage} [--ansi] [--markdown]\``,
        '',
        '| Command | Description |',
        '| :--- | :--- |',
        ...rows,
        '',
      ].join('\n');
    }
  }

  return `# \`${command}\`\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;
}
