#!/usr/bin/env node
/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
// Make normal and roughness maps for a saved run's texture and add them to the run (normal.png, orm.png, and the
// .glb re-exported with them). No view is repainted.
//   node scripts/pbr.mjs --level samples/village.glb --run village [--size 4096] [--atlas 8192] [--strength 1] [--quote]
//     a run painted over several pages is loaded on them; --size is then the size of the maps over all the pages together
//     (8192 for four pages of 4096 px gives each page maps as sharp as its texture)
//     [--ao]       also bake ambient occlusion into the ORM map's occlusion channel (rays against the geometry, free)
//     [--ao-only]  bake only that: no model call, no fal key needed
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { falKey, launchBrowser, openApp, startServer } from './browser.mjs';

const { values: a } = parseArgs({
  options: {
    level: { type: 'string', default: 'samples/village.glb' },
    run: { type: 'string' },
    size: { type: 'string', default: '4096' },
    atlas: { type: 'string', default: '4096' },
    'view-size': { type: 'string' },   // the run's own when not given
    strength: { type: 'string', default: '1' },
    quote: { type: 'boolean', default: false },
    ao: { type: 'boolean', default: false },
    'ao-only': { type: 'boolean', default: false },
  },
});
if (!a.run) {
  console.error('which run? --run <id> (a folder under runs/)');
  process.exit(1);
}
// a run painted over several textures (--pages) is loaded on its pages, at their size; its maps cover all of them
const pagesOf = JSON.parse(fs.readFileSync(`runs/${a.run}/run.json`, 'utf8')).pages;
if (pagesOf) a.atlas = String(pagesOf.size);
const grid = Math.round(Math.sqrt(pagesOf?.count ?? 1));
if (a.quote) {
  // what the call would send at most: tiles of 2048 px, fal lists PATINA at $0.01 per megapixel
  const size = Math.min(+a.size, +a.atlas * grid);
  const n = Math.max(1, Math.round(size / 2048)) ** 2;
  console.log(`${size} px maps: up to ${n} tile${n > 1 ? 's' : ''}, about $${(n * 2.048 * 2.048 * 0.01).toFixed(2)}`);
  process.exit(0);
}
if (!a['ao-only'] && !(await falKey())) {
  console.error('FAL_KEY is not set (export FAL_KEY=your-fal-key, or put FAL_KEY=... in .env.local)');
  process.exit(1);
}
const saved = JSON.parse(fs.readFileSync(`runs/${a.run}/run.json`, 'utf8'));
const lighting = saved.lighting?.name ?? 'outdoor';
a['view-size'] ??= String(saved.viewSize ?? 1024);
const layout = saved.layout?.kind ?? 'file';   // the layout the run was painted on
const { server, url } = await startServer();
const browser = await launchBrowser();
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
try {
  const page = await openApp(browser, url, {
    onLog: log,
    onEvent: (e) => log(e.type === 'pbr' ? `tile ${e.done}/${e.total}` : e.type === 'save' ? `saving ${e.msg}` : JSON.stringify(e)),
  });
  await page.evaluate(([lvl, l, atlas, viewSize, layout, pages]) => window.trompe.load(`/${lvl}`, { lighting: l, atlasSize: +atlas, viewSize: +viewSize, layout, pages }),
    [a.level, lighting, a.atlas, a['view-size'], layout, grid * grid]);
  log(`run: ${JSON.stringify(await page.evaluate((r) => window.trompe.loadRun(r), a.run))}`);
  if (a.ao || a['ao-only']) log(`ambient occlusion: ${JSON.stringify(await page.evaluate(() => window.trompe.ao()))}`);
  if (!a['ao-only']) log(`maps: ${JSON.stringify(await page.evaluate((o) => window.trompe.pbr(o), { size: +a.size, strength: +a.strength }))}`);
  await page.evaluate((r) => window.trompe.save(r), a.run);
  log(`saved the maps and level_textured.glb to runs/${a.run}/`);
} finally {
  await browser.close();
  await server.close();
}
