#!/usr/bin/env node
// What a saved run's cameras delivered: per view how the frame was spent, and how sharply the texture is sampled.
// Replays the run; calls no model.
//   node scripts/measure.mjs --level samples/courtyard.glb --run courtyard [--atlas 4096] [--json]
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { launchBrowser, openApp, startServer } from './browser.mjs';

const { values: a } = parseArgs({
  options: {
    level: { type: 'string', default: 'samples/village.glb' },
    run: { type: 'string' },
    atlas: { type: 'string' },
    pages: { type: 'string' },
    'view-size': { type: 'string' },   // the run's own when not given
    layout: { type: 'string' },
    cavity: { type: 'string' },
    weights: { type: 'boolean', default: false },
    paths: { type: 'boolean', default: false },
    mode: { type: 'string' },
    unwrap: { type: 'string' },
    'min-cos': { type: 'string' },     // replay with another grazing-angle cut-off
    'edge-guard': { type: 'string' }, 'frame-margin': { type: 'string' },  // replay with another guard round nearer outlines (px at 1024 px views)   // 'file', 'seen' or 'near'; the run's own when not given
    json: { type: 'boolean', default: false },
  },
});
if (!a.run) {
  console.error('which run? --run <id> (a folder under runs/)');
  process.exit(1);
}
const saved = JSON.parse(fs.readFileSync(`runs/${a.run}/run.json`, 'utf8'));
const lighting = saved.lighting?.name ?? 'outdoor';
a.atlas ??= String(saved.pages?.size ?? saved.atlasSize ?? 4096);
const pages = +(a.pages ?? saved.pages?.count ?? 1);
a['view-size'] ??= String(saved.viewSize ?? 1024);
const layout = a.layout ?? saved.layout?.kind ?? 'file';
const cavity = layout === 'file' ? 0 : +(a.cavity ?? (a.layout ? 0 : saved.layout?.cavity ?? 0));
const weights = a.weights || (!a.layout && !!(saved.layout?.weights ?? saved.weights));
const paths = a.paths || (!a.layout && !!(saved.layout?.paths ?? saved.paths));
const mode = a.mode ?? saved.mode ?? 'auto';
const unwrap = a.unwrap ?? (saved.unwrap?.reason === 'asked' ? 'always' : 'auto');
const { server, url } = await startServer();
const browser = await launchBrowser();
try {
  const page = await openApp(browser, url, { onLog: () => {}, onEvent: () => {} });
  await page.evaluate(([lvl, l, atlas, viewSize, layout, area, pages, unwrap, cavity, weights, mode, paths]) => window.trompe.load(`/${lvl}`, { lighting: l, atlasSize: +atlas, viewSize: +viewSize, layout, area, pages, unwrap, cavity, weights, mode, paths }),
    [a.level, lighting, a.atlas, a['view-size'], layout, saved.area, pages, unwrap, cavity, weights, mode, paths]);
  if (a['min-cos'] || a['edge-guard'] || a['frame-margin']) await page.evaluate((o) => window.trompe.projection(o), { ...(a['min-cos'] ? { minCos: +a['min-cos'] } : {}), ...(a['edge-guard'] ? { edgeGuard: +a['edge-guard'] } : {}), ...(a['frame-margin'] ? { frameMargin: +a['frame-margin'] } : {}) });
  await page.evaluate((r) => window.trompe.loadRun(r), a.run);
  const m = await page.evaluate(() => window.trompe.measure());
  if (a.json) {
    console.log(JSON.stringify(m, null, 1));
  } else {
    const pc = (x, w = 4) => (x === undefined || x === null ? '-' : `${Math.round(100 * x)}%`).padStart(w);
    console.log('view  kind    model         pitch   sky  context  grazing  productive  faces  largest  held back');
    for (const v of m.views) {
      console.log(`${String(v.index).padStart(4)}  ${v.kind.padEnd(7)} ${v.model.padEnd(12)} ${String(v.pitch).padStart(5)}° ${pc(v.sky, 5)} ${pc(v.context, 8)} ${pc(v.grazing, 8)} ${pc(v.productive, 11)} ` +
        `${String(v.faces).padStart(6)} ${pc(v.maxFace, 8)} ${pc(v.held, 10)}`);
    }
    const s = m.sampling;
    console.log(`\n${m.views.length} views, $${m.cost.toFixed(2)}, ${pc(m.coverage, 0)} of the texture painted` +
      (m.seen ? `; players can see ${pc(m.seen.share, 0)} of the texture, and ${pc(m.seen.painted, 0)} of that is painted` +
        (m.seen.filled ? ` by a view, ${pc(m.seen.filled, 0)} by the finishing fill` : '') : ''));
    console.log(`productive share of each paid frame: ${pc(m.productive, 0)} over all views, ${pc(m.productivePlanned, 0)} over the planned ones; ${m.wasted} views delivered under 3% of a frame`);
    console.log(`context the planned views had (level already painted): ${pc(m.context, 0)} on average`);
    console.log(`sampling, in view pixels per texel: median ${s.p50.toFixed(2)} (10th percentile ${s.p10.toFixed(2)}, 90th ${s.p90.toFixed(2)}); ` +
      `${pc(s.under1, 0)} of painted cells under 1, ${pc(s.under05, 0)} under 0.5`);
    console.log(`detail over the whole texture, unpainted included: ${(100 * s.detail).toFixed(1)}% of what its resolution could hold; ` +
      `${(100 * s.full).toFixed(1)}% of it has a view pixel or more per texel`);
    console.log(`on the surface (layout: ${layout}, ${a.atlas} px texture): ${s.surface.toFixed(0)} px of detail per metre at the median of what's painted; ` +
      `(mean ${s.surfaceMean.toFixed(0)}, sharpest quarter from ${s.surface75.toFixed(0)}); the texture holds ${s.texels.toFixed(0)} texels per metre there`);
    if (m.highRank && m.highRank.share > 0) {
      const h = m.highRank;
      console.log(`on high-rank sightlines (${pc(h.share, 0)} of texture, ${pc(h.painted, 0)} painted): ${h.surface.toFixed(0)} px/m median ` +
        `(mean ${h.surfaceMean.toFixed(0)}, sharpest quarter from ${h.surface75.toFixed(0)}); ${h.texels.toFixed(0)} texels/m`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}
