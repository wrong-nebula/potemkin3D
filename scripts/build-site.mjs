#!/usr/bin/env node
// Build the walk-through of one painted run as a static site for any static file host:
//   node scripts/build-site.mjs --run loft-props [--out deploy/potemkin3d] [--title "Potemkin 3D"]
// The site holds the page, its script (three.js bundled in), and the run's level files with the texture at 8192 px
// and 4096 px (made with the bake step: level_8k.glb, level_4k.glb), plus the little of run.json the page reads.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { build } from 'vite';

const { values: a } = parseArgs({ options: { run: { type: 'string' }, out: { type: 'string', default: 'deploy/potemkin3d' }, title: { type: 'string', default: 'Potemkin 3D' } } });
if (!a.run) { console.error('--run <id> is needed'); process.exit(1); }
const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(root, a.out);
await build({ configFile: false, root, base: './', publicDir: false, logLevel: 'warn',
  build: { outDir: out, emptyOutDir: true, sourcemap: false, rollupOptions: { input: path.join(root, 'loft-walk.html') } } });
// the page, as the site's front page, told where its scene is
let html = fs.readFileSync(path.join(out, 'loft-walk.html'), 'utf8');
html = html.replace(/<html lang="en"[^>]*>/, '<html lang="en" data-run="scene" data-base="./runs/">').replace(/<title>[^<]*<\/title>/, `<title>${a.title}</title>`);
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.rmSync(path.join(out, 'loft-walk.html'));
// the scene: the level files and what the page needs of the run (where players stand, and the room's box)
const from = path.join(root, 'runs', a.run), to = path.join(out, 'runs', 'scene');
fs.mkdirSync(to, { recursive: true });
const meta = JSON.parse(fs.readFileSync(path.join(from, 'run.json'), 'utf8'));
fs.writeFileSync(path.join(to, 'run.json'), JSON.stringify({ level: meta.level, area: meta.area, plan: { points: meta.plan.points } }));
for (const f of ['level_8k.glb', 'level_4k.glb']) {
  if (!fs.existsSync(path.join(from, f))) { console.error(`runs/${a.run}/${f} is missing: bake the run's 8192 px texture first`); process.exit(1); }
  fs.copyFileSync(path.join(from, f), path.join(to, f));
}
// the run's material maps, where it has them (normal + roughness, and relief): the page does without them otherwise
// (a run painted over several textures has them cut to its pages: maps_8k_p0.jpg and so on)
for (const f of fs.readdirSync(from).filter((f) => /^(maps|relief)_(8k|4k)(_p\d+)?\.jpg$/.test(f))) fs.copyFileSync(path.join(from, f), path.join(to, f));
// nothing of this machine goes out with it: the home folder's name must not be in any file
const user = os.userInfo().username;
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const files = walk(out);
const leaks = files.filter((f) => fs.readFileSync(f).includes(user));
if (leaks.length) { console.error(`these files hold this machine's user name: ${leaks.map((f) => path.relative(out, f)).join(', ')}`); process.exit(1); }
const size = files.reduce((s, f) => s + fs.statSync(f).size, 0);
console.log(`built ${path.relative(root, out)}: ${files.length} files, ${(size / 1e6).toFixed(1)} MB; no user name in any of them`);
for (const f of files) console.log(`  ${(fs.statSync(f).size / 1e6).toFixed(2).padStart(6)} MB  ${path.relative(out, f)}`);
