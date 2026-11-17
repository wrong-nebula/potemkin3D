#!/usr/bin/env node
/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
// Debug stills: node scripts/snap.mjs --level samples/courtyard.glb [--run id] [--plan 24] --out /tmp/x.jpg --mode clay|textured [--atlas 4096] [--layout file|seen]
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { launchBrowser, openApp, startServer } from './browser.mjs';

const { values: a } = parseArgs({ options: {
  level: { type: 'string', default: 'samples/courtyard.glb' }, run: { type: 'string' }, plan: { type: 'string' },
  out: { type: 'string', default: 'snap.jpg' }, mode: { type: 'string', default: 'clay' }, lighting: { type: 'string', default: 'outdoor' },
  view: { type: 'string', default: 'top' }, 'hide-overlay': { type: 'boolean', default: false }, width: { type: 'string', default: '1600' },
  height: { type: 'string', default: '900' }, eye: { type: 'string' }, at: { type: 'string' }, fov: { type: 'string', default: '60' },
  atlas: { type: 'string', default: '4096' }, layout: { type: 'string', default: 'file' }, 'view-size': { type: 'string' }, 'min-cos': { type: 'string' }, 'edge-guard': { type: 'string' }, 'frame-margin': { type: 'string' },
} });
// a run is shown at the view size it was painted at; a clay still needs no more than 1024 px
a['view-size'] ??= String((a.run && JSON.parse(fs.readFileSync(`runs/${a.run}/run.json`, 'utf8')).viewSize) || 1024);
const { server, url } = await startServer();
const browser = await launchBrowser();
try {
  const page = await openApp(browser, url, { onLog: (s) => console.log(s), onEvent: (e) => console.log(JSON.stringify(e)) });
  await page.evaluate(([l, lighting, atlasSize, layout, viewSize]) => window.trompe.load(`/${l}`, { lighting, atlasSize: +atlasSize, layout, viewSize: +viewSize }), [a.level, a.lighting, a.atlas, a.layout, a['view-size']]);
  if (a['min-cos'] || a['edge-guard'] || a['frame-margin']) await page.evaluate((o) => window.trompe.projection(o), { ...(a['min-cos'] ? { minCos: +a['min-cos'] } : {}), ...(a['edge-guard'] ? { edgeGuard: +a['edge-guard'] } : {}), ...(a['frame-margin'] ? { frameMargin: +a['frame-margin'] } : {}) });
  if (a.run) console.log(await page.evaluate((r) => window.trompe.loadRun(r), a.run));
  if (a.plan) console.log(await page.evaluate((n) => window.trompe.plan({ maxViews: +n }), a.plan));
  const b = await page.evaluate(() => window.trompe.bounds());
  const c = b.min.map((m, i) => (m + b.max[i]) / 2);
  const span = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]);
  let position, target;
  if (a.eye) { position = a.eye.split(',').map(Number); target = a.at.split(',').map(Number); }
  else if (a.view === 'top') { position = [c[0], b.max[1] + span * 0.9, c[2] + span * 0.35]; target = c; }
  else { position = [c[0] + span * 0.55, b.max[1] + span * 0.25, c[2] + span * 0.55]; target = c; }
  const dataUrl = await page.evaluate((o) => window.trompe.snapshot(o), { position, target, mode: a.mode, overlay: !a['hide-overlay'],
    width: +a.width, height: +a.height, fov: +a.fov });
  fs.writeFileSync(a.out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('wrote', a.out);
} finally { await browser.close(); await server.close(); }
