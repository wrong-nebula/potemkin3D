import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { invoke } from '../automation/commands.mjs';
import { parseCLI } from '../automation/cli.mjs';
import {
  createStreamingReportSession,
  formatAgentSessionMarkdown,
  formatCommandMarkdown,
  formatJobMarkdown,
  listDocs,
  markdownToAnsi,
  markdownToHtmlFragment,
  readDoc,
  renderStandaloneReportHtml,
  writeRunReportFiles,
} from '../automation/words.mjs';

describe('@pierre/words streaming Markdown, Mermaid, highlights & ANSI surfaces', () => {
  it('repairs incomplete Markdown, grows Pele Mermaid diagrams mid-stream, highlights code and renders TeX math', () => {
    const stream = createStreamingReportSession();

    const step1 = stream.append('# Run **Courtyard');
    expect(step1.html).toContain('<strong data-markdown="strong">Courtyard</strong>');

    const step2 = stream.append('**\n\n```mermaid\nflowchart LR\n  A["Plan 12v"] --> B["Paint"]\n');
    expect(step2.html).toContain('data-markdown="mermaid"');
    expect(step2.html).toContain('<svg');

    const step3 = stream.append('  B --> C["Critic 84/100"]\n```\n\nWeight $w \\propto \\cos\\theta / d$.\n\n```json\n{"atlas": 4096}\n```\n', {
      incomplete: false,
    });
    expect(step3.html).toContain('<svg');
    expect(step3.html).toContain('data-markdown="math"');
    expect(step3.html).toContain('4096');
    expect(step3.ansi).toContain('Run Courtyard');
    stream.dispose();
  });

  it('renders standalone dark-gray HTML reports and writes runs/<id>/report.html + report.md', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'potemkin-words-'));
    try {
      const runDir = path.join(tmp, 'runs', 'demo-run');
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, 'run.json'),
        JSON.stringify({
          level: 'Courtyard',
          atlasSize: 4096,
          viewSize: 2048,
          cost: 0.08,
          seconds: 12.4,
          lighting: { name: 'overcast' },
          layout: { kind: 'near' },
          views: [
            { index: 0, wave: 0, model: 'flux3-klein', unknownFraction: 1, predicted: 0.42, seconds: 4.1 },
            { index: 1, wave: 1, model: 'flux3-klein', unknownFraction: 0.55, predicted: 0.89, seconds: 4.3 },
          ],
        }),
      );
      fs.writeFileSync(
        path.join(runDir, 'critique.json'),
        JSON.stringify({
          score: 86.4,
          verdict: 'pass',
          metrics: {
            seenPainted: 0.96,
            highRankPxPerM: 94.2,
            multiView: { consistency: 0.93 },
            seam: { ratio: 1.08 },
            bakedShading: { correlation: 0.041 },
          },
          actions: [],
        }),
      );

      const written = writeRunReportFiles('demo-run', { root: tmp });
      expect(written).toBeTruthy();
      expect(fs.existsSync(path.join(tmp, written.htmlPath))).toBe(true);
      expect(fs.existsSync(path.join(tmp, written.markdownPath))).toBe(true);
      const html = fs.readFileSync(path.join(tmp, written.htmlPath), 'utf8');
      expect(html).toContain('<!doctype html>');
      expect(html).toContain('data-markdown="mermaid"');
      expect(html).toContain('86.4 / 100');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('serves repository documentation topics via docs/doc commands and renders ANSI + HTML', async () => {
    const all = listDocs();
    expect(all.map((d) => d.id)).toEqual(expect.arrayContaining(['engine', 'readme', 'potemkin', 'material-maps', 'automation', 'todo']));

    const engineDoc = await invoke('doc', { topic: 'engine', format: 'html' });
    expect(engineDoc.title).toBe('Engine Architecture');
    expect(engineDoc.html).toContain('<h1');
    expect(engineDoc.headings.length).toBeGreaterThan(3);

    const ansiDoc = readDoc('material-maps', { format: 'ansi', width: 80 });
    expect(ansiDoc.ansi.length).toBeGreaterThan(200);
    expect(ansiDoc.ansi).toContain('\x1b[');
  });

  it('formats live running jobs, agent sessions, and CLI --ansi / --markdown flags without breaking JSON default', () => {
    const parsedAnsi = parseCLI(['doctor', '--ansi']);
    expect(parsedAnsi.ansi).toBe(true);
    expect(parsedAnsi.json).toBe(false);

    const runningJobMd = formatJobMarkdown(
      {
        id: '11111111-2222-3333-4444-555555555555',
        kind: 'workflow',
        status: 'running',
        step: 2,
        total: 3,
        operation: 'paint',
        createdAt: '2026-11-19T12:00:00.000Z',
        results: [{ step: 1, op: 'load', path: 'samples/courtyard.glb' }],
        artifacts: [],
        events: [{ at: '2026-11-19T12:00:03.000Z', type: 'step-start', step: 2, op: 'paint' }],
      },
      { steps: [{ op: 'load' }, { op: 'paint' }, { op: 'critique' }] },
    );
    const runningHtml = markdownToHtmlFragment(runningJobMd, { incomplete: true, active: true });
    expect(runningHtml).toContain('<svg');
    expect(runningHtml).toContain('paint (active)');

    const sessionMd = formatAgentSessionMarkdown({
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      runId: 'courtyard-agent',
      status: 'awaiting-approval',
      inputPath: 'samples/courtyard.glb',
      mode: 'level',
      spentUsd: 0.04,
      budget: { statedUsd: 0.25, remainingUsd: 0.21 },
      coverageBudget: { initialViews: 4, viewsUsed: 4, maxTotalViews: 16, targetSeenPainted: 0.92 },
      episodes: [{ round: 1, kind: 'initial', ops: ['plan', 'paint'], viewsAdded: 4, totalViews: 4, roundSpendUsd: 0.04, scoreAfter: 61.2, verdict: 'needs-repair' }],
      pendingProposal: { id: 'prop_1', round: 2, kind: 'repair', summary: 'Top up 4 views and stitch seams', estimatedViews: 4, estimatedCostUsd: 0.04 },
    });
    const standalone = renderStandaloneReportHtml({ title: 'Agent Session', markdown: sessionMd, incomplete: true });
    expect(standalone).toContain('prop_1');
    expect(standalone).toContain('<svg');

    const ansiOut = execFileSync(process.execPath, ['automation/cli.mjs', 'inspect', '--path', 'samples/courtyard.glb', '--ansi'], {
      encoding: 'utf8',
    });
    expect(ansiOut).toContain('samples/courtyard.glb');
    expect(ansiOut).toContain('\x1b[');

    const jsonOut = JSON.parse(
      execFileSync(process.execPath, ['automation/cli.mjs', 'inspect', '--path', 'samples/courtyard.glb', '--json'], {
        encoding: 'utf8',
      }),
    );
    expect(jsonOut.ok).toBe(true);
    expect(jsonOut.data.meshes).toBeGreaterThan(0);

    const doctorMd = formatCommandMarkdown('doctor', {
      node: '22.22.1',
      nodeSupported: true,
      browserInstalled: true,
      browserSource: 'Playwright',
      falKeyConfigured: false,
      localModelUrl: null,
      scenes: true,
      next: 'Use plan, screenshot, or job-start.',
    });
    expect(markdownToAnsi(doctorMd, { width: 80 })).toContain('Potemkin Doctor');
  });
});
