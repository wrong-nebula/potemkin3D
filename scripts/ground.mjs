#!/usr/bin/env node
// Lay the ground of a saved run from tiles (core/ground.ts) and save the run again.
//   node scripts/ground.mjs --level samples/courtyard.glb --run courtyard [--tiles 3] [--span 4] [--cell 1] [--style "..."]
//     [--turn 2|1|0]   how patches may be turned: any angle (stone, earth, concrete), quarter turns (square tiles), not at all (planks, bricks)
//     [--dirt 1]       how strongly the ground darkens towards walls (0 = not at all)
//     [--only "concrete floor,mezzanine floor"]   lay it on the up-facing faces of these parts, not on the floor players walk on
//     [--reuse]        lay the run's tiles again with other settings; paints nothing and costs nothing
//     [--notes notes.json]  things to add to the laid ground at spots (a drain cover, a damp streak): [{ "text": ..., "at": [x, y, z], "size": m, "to": [x, y, z] }];
//                      with --notes-only the ground is left as it is and only the notes are carried out
//     [--shots dir]    also write stills from three player spots into this folder ([--shots-only]: just those, of the run as it is)
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { falKey, launchBrowser, openApp, startServer } from './browser.mjs';

const { values: a } = parseArgs({ options: {
  level: { type: 'string', default: 'samples/courtyard.glb' }, run: { type: 'string' }, tiles: { type: 'string' }, span: { type: 'string' },
  cell: { type: 'string' }, turn: { type: 'string' }, dirt: { type: 'string' }, style: { type: 'string' }, only: { type: 'string' },
  seed: { type: 'string' }, reuse: { type: 'boolean', default: false }, shots: { type: 'string' }, 'shots-only': { type: 'boolean', default: false }, 'no-save': { type: 'boolean', default: false }, 'frame-margin': { type: 'string' }, notes: { type: 'string' }, 'notes-only': { type: 'boolean', default: false },
} });
if (!a.run) { console.error('--run <id> is needed'); process.exit(1); }
if ((!a.reuse || a.notes) && !a['shots-only'] && !(await falKey())) { console.error('FAL_KEY is not set (export FAL_KEY=your-fal-key, or put FAL_KEY=... in .env.local)'); process.exit(1); }
const saved = JSON.parse(fs.readFileSync(`runs/${a.run}/run.json`, 'utf8'));
const { server, url } = await startServer();
const browser = await launchBrowser();
try {
  const page = await openApp(browser, url, { onLog: (s) => console.log(s), onEvent: (e) => { if (e.type === 'check') console.log(e.message); } });
  // on the texture size and the number of pages the run was painted over, or saving would bake it down to one 4096 px texture
  await page.evaluate(([l, lighting, viewSize, layout, area, atlasSize, pages]) => window.trompe.load(`/${l}`, { lighting, atlasSize, viewSize, layout, area, pages }),
    [a.level, saved.lighting?.name ?? 'overcast', saved.viewSize ?? 1024, saved.layout?.kind ?? 'file', saved.area, saved.pages?.size ?? 4096, saved.pages?.count ?? 1]);
  if (a['frame-margin']) await page.evaluate((m) => window.trompe.projection({ frameMargin: m }), +a['frame-margin']);
  await page.evaluate((r) => window.trompe.loadRun(r), a.run);
  const num = (k) => (a[k] !== undefined ? { [k]: +a[k] } : {});
  const opts = { ...num('tiles'), ...num('span'), ...num('cell'), ...num('turn'), ...num('dirt'), ...num('seed'), ...(a.style ? { style: a.style } : {}),
    ...(a.only ? { only: a.only.split(',').map((s) => s.trim()) } : {}), reuse: a.reuse };
  if (!a['shots-only'] && !a['notes-only']) console.log('ground:', JSON.stringify(await page.evaluate(([o, id]) => window.trompe.ground(o, undefined, id), [opts, a.run])));
  if (a.notes) console.log('ground notes:', JSON.stringify(await page.evaluate(([n, id]) => window.trompe.groundNotes(n, undefined, id), [JSON.parse(fs.readFileSync(a.notes, 'utf8')), a.run])));
  if (a.shots) {
    fs.mkdirSync(a.shots, { recursive: true });
    const shots = await page.evaluate(async () => {
      const t = window.trompe, pts = t.session.plan.points;
      // three spots far from one another, each looking at the next, eyes on the ground ahead
      const pick = [pts[0]];
      while (pick.length < 3) pick.push(pts.reduce((best, p) => (Math.min(...pick.map((q) => q.distanceTo(p))) > Math.min(...pick.map((q) => q.distanceTo(best))) ? p : best)));
      const out = pick.map((p, k) => { const q = pick[(k + 1) % 3]; return t.snapshot({ position: [p.x, p.y, p.z], target: [q.x, p.y - 1.45, q.z], width: 1600, height: 900, fov: 70, mode: 'textured', overlay: false }); });
      const b = t.bounds();
      out.push(t.snapshot({ position: [(b.min[0] + b.max[0]) / 2, b.max[1] + 18, (b.min[2] + b.max[2]) / 2 + 0.01], target: [(b.min[0] + b.max[0]) / 2, b.min[1], (b.min[2] + b.max[2]) / 2], width: 1400, height: 1400, fov: 60, mode: 'textured', overlay: false }));
      return out;
    });
    shots.forEach((s, k) => fs.writeFileSync(`${a.shots}/${k < 3 ? `eye_${k}` : 'top'}.jpg`, Buffer.from(s.split(',')[1], 'base64')));
    console.log('stills in', a.shots);
  }
  if (!a['no-save'] && !a['shots-only']) { await page.evaluate((r) => window.trompe.save(r), a.run); console.log(`saved to runs/${a.run}/`); }
} finally { await browser.close(); await server.close(); }
