#!/usr/bin/env node
// No paid calls. Raw-target cross-view agreement and fusion-only leave-one-view-out for saved Trompe runs.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { launchBrowser, openApp, startServer } from './browser.mjs';
const { values: a } = parseArgs({ options: { run: { type: 'string' }, level: { type: 'string' },
  size: { type: 'string', default: '256' }, limit: { type: 'string', default: '12' }, output: { type: 'string' } } });
if (!a.run || !/^[\w-]+$/.test(a.run)) throw new Error('Supply --run <saved-run-id>');
const meta = JSON.parse(fs.readFileSync(`runs/${a.run}/run.json`, 'utf8'));
const { server, url } = await startServer();
const browser = await launchBrowser();
try {
  const page = await openApp(browser, url);
  await page.evaluate(async ({ a, meta }) => {
    await window.trompe.load(`/${a.level ?? `samples/${meta.level}.glb`}`, { lighting: meta.lighting?.name ?? 'overcast',
      atlasSize: 2048, viewSize: meta.viewSize ?? 1024, layout: meta.layout?.kind ?? 'file', area: meta.area });
    await window.trompe.loadRun(a.run);
  }, { a, meta });
  const result = await page.evaluate(({ id, size, limit }) => window.trompe.validate(id, { size, limit }),
    { id: a.run, size: +a.size, limit: +a.limit });
  const json = JSON.stringify(result, null, 2);
  if (a.output) fs.writeFileSync(a.output, json); else console.log(json);
} finally { await browser.close(); await server.close(); }
