#!/usr/bin/env node
// Build the Luxor walk-around as a static site from one run's exported level:
//   node experiments/luxor-view/build.mjs --run luxor-02 [--out deploy/luxor] [--fresh]
// It takes the loft's camera shaders (take-film.mjs), writes the grade (make-lut.mjs), bundles the page, and puts the
// level beside it: a small copy to start on (level_2k.glb) and the sharp textures to stream in (hi/). The level
// files are made by scripts/web_glb.py, which needs Python with Pillow (PYTHON names another interpreter); they are
// kept from the last build unless --fresh is given.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { build } from 'vite';

const { values: a } = parseArgs({ options: { run: { type: 'string' }, out: { type: 'string', default: 'deploy/luxor' }, fresh: { type: 'boolean', default: false }, height: { type: 'string' } } });
const here = import.meta.dirname, root = path.resolve(here, '../..'), out = path.resolve(root, a.out);
const run = (cmd, args) => { const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' }); if (r.status !== 0) process.exit(r.status ?? 1); };
run(process.execPath, [path.join(here, 'take-film.mjs')]);
run(process.execPath, [path.join(here, 'make-lut.mjs')]);
// the page and its script; the level files already in the folder are left where they are
for (const f of fs.existsSync(out) ? fs.readdirSync(out) : []) if (f === 'assets' || f === 'index.html') fs.rmSync(path.join(out, f), { recursive: true });
await build({
  configFile: false,
  root: here,
  base: './',
  logLevel: 'error',
  build: {
    outDir: out,
    emptyOutDir: false,
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'three', test: /node_modules[\\/](three|three-mesh-bvh)/, priority: 20 },
          ],
        },
      },
    },
  },
});
const python = process.env.PYTHON ?? 'python3';
if (a.fresh || !fs.existsSync(path.join(out, 'level_2k.glb')) || !fs.existsSync(path.join(out, 'hi', 'textures.json'))) {
  if (!a.run) { console.error('--run <id> is needed to make the level files'); process.exit(1); }
  const level = path.join('runs', a.run, 'level_textured.glb');
  run(python, ['-I', 'scripts/web_glb.py', level, path.join(out, 'level_2k.glb'), '--size', '2048']);
  run(python, ['-I', 'scripts/web_glb.py', level, '--split', path.join(out, 'hi'), '--size', '4096', '--quality', '93']);
}
// Height generation is a separate, explicit paid step. Building only copies existing, source-matched maps.
const heightDir = a.height ? path.resolve(root, a.height) : a.run ? path.join(root, 'runs', a.run, 'height') : null;
if (heightDir && fs.existsSync(path.join(heightDir, 'height.json'))) {
  const height = JSON.parse(fs.readFileSync(path.join(heightDir, 'height.json'), 'utf8'));
  if (height.convention !== 'white-high' || height.colorSpace !== 'linear') throw new Error('Unsupported height-map convention');
  const listingFile = path.join(out, 'hi', 'textures.json');
  const listing = JSON.parse(fs.readFileSync(listingFile, 'utf8'));
  if (height.pages.length !== listing.length) throw new Error('Height maps do not match the exported page count');
  for (const page of height.pages) {
    if (a.run) {
      const source = path.join(root, 'runs', a.run, `texture_${page.page}.png`);
      const hash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
      if (hash !== page.source_sha256) throw new Error(`Height map ${page.page} was made for another texture`);
    }
    const entry = listing[page.page];
    entry.height = `p${page.page}_height.png`; entry.heightLow = `p${page.page}_height_2k.png`;
    entry.heightSize = page.size; entry.heightSource = height.model;
    fs.copyFileSync(path.join(heightDir, page.height), path.join(out, 'hi', entry.height));
    fs.copyFileSync(path.join(heightDir, page.low), path.join(out, 'hi', entry.heightLow));
  }
  fs.writeFileSync(listingFile, JSON.stringify(listing, null, 2) + '\n');
  fs.copyFileSync(path.join(heightDir, 'height.json'), path.join(out, 'hi', 'height.json'));
  console.log(`included ${height.pages.length} generated height maps at 2K and 4K`);
} else if (heightDir) {
  console.warn('No generated height maps found; POM stays disabled until height.mjs has been run.');
}
const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`built ${path.relative(root, out)}: ${(size(out) / 1e6).toFixed(1)} MB`);
