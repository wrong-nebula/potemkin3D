#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Build both Potemkin viewers from source while retaining the shipped baked scene assets.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'deploy/potemkin3d');
const out = path.join(root, 'dist-potemkin');
for (const file of ['index.html', 'luxor/index.html', 'luxor/level_2k.glb', 'runs/scene/level_4k.glb', 'runs/scene/level_8k.glb']) {
  await fs.access(path.join(source, file));
}
const original = await fs.readFile(path.join(source, 'index.html'), 'utf8');
const shell = original.match(/<!-- potemkin-shell:start -->[\s\S]*?<!-- potemkin-shell:end -->/)?.[0];
if (!shell) throw new Error('The shipped site is missing its shared scene menu');
await fs.rm(out, { recursive: true, force: true });
await fs.cp(source, out, { recursive: true });
await fs.rm(path.join(out, 'assets'), { recursive: true, force: true });
await build({ configFile: false, root, base: './', publicDir: false,
  build: { outDir: out, emptyOutDir: false, rollupOptions: { input: path.join(root, 'loft-walk.html') } } });
let loft = await fs.readFile(path.join(out, 'loft-walk.html'), 'utf8');
loft = loft.replace(/<html lang="en"[^>]*>/, '<html lang="en" data-run="scene" data-base="./runs/">');
loft = loft.replace('</head>', `${shell}\n</head>`);
await fs.writeFile(path.join(out, 'index.html'), loft);
await fs.unlink(path.join(out, 'loft-walk.html'));
const luxor = spawnSync(process.execPath, ['experiments/luxor-view/build.mjs', '--out', path.join(out, 'luxor')], { cwd: root, stdio: 'inherit' });
if (luxor.status !== 0) process.exit(luxor.status ?? 1);
const templePage = path.join(out, 'luxor/index.html');
let temple = await fs.readFile(templePage, 'utf8');
temple = temple.replace(/<title>[^<]*<\/title>/, '<title>Luxor temple · Potemkin 3D</title>').replace('</head>', `${shell}\n</head>`);
await fs.writeFile(templePage, temple);
console.log('Built dist-potemkin/ from editable viewer source and the included baked assets.');
