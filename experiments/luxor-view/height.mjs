#!/usr/bin/env node
// Generate dedicated, aligned PATINA height maps. Requests/results are saved immediately for free resumption.
// node experiments/luxor-view/height.mjs --run luxor-02 [--quote] [--pack-only] [--parallel 2]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fal } from '@fal-ai/client';
import { falKey } from '../../scripts/browser.mjs';

const { values: a } = parseArgs({ options: {
  run: { type: 'string', default: 'luxor-02' }, out: { type: 'string' }, quote: { type: 'boolean' },
  'pack-only': { type: 'boolean' }, parallel: { type: 'string', default: '2' }, limit: { type: 'string' },
} });
const root = path.resolve(import.meta.dirname, '../..'), run = path.resolve(root, 'runs', a.run);
const out = path.resolve(root, a.out ?? path.join('runs', a.run, 'height'));
const python = (mode) => {
  const result = spawnSync(process.env.PYTHON ?? 'python3', ['-I', path.join(import.meta.dirname, 'height_maps.py'), mode, '--run', run, '--out', out], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Height ${mode} failed`);
};
python('prepare');
const manifest = JSON.parse(fs.readFileSync(path.join(out, 'inputs.json'), 'utf8'));
const pending = manifest.tiles.filter((t) => !fs.existsSync(path.join(out, t.raw)));
const estimate = pending.reduce((sum, t) => sum + 0.01 + t.sent * t.sent / 1e6 * 0.01, 0);
console.log(`${pending.length}/${manifest.tiles.length} height tiles remaining; estimated new cost $${estimate.toFixed(2)}`);
if (a.quote) process.exit(0);
if (!a['pack-only'] && pending.length) {
  const key = await falKey();
  if (!key) throw new Error('FAL_KEY is not configured');
  fal.config({ credentials: key });
  const queue = pending.slice(0, a.limit ? Number(a.limit) : undefined);
  const work = async () => {
    while (queue.length) {
      const tile = queue.shift(), file = path.join(out, `${tile.id}_request.json`);
      const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      const save = () => fs.writeFileSync(file, JSON.stringify(saved, null, 2) + '\n');
      const start = Date.now();
      if (!saved.result) {
        if (saved.requestId) {
          await fal.queue.subscribeToStatus(manifest.spec.model, { requestId: saved.requestId, logs: false });
          const result = await fal.queue.result(manifest.spec.model, { requestId: saved.requestId });
          saved.result = result.data;
        } else {
          const input = new File([fs.readFileSync(path.join(out, tile.input))], tile.input, { type: 'image/png' });
          const url = await fal.storage.upload(input);
          const result = await fal.subscribe(manifest.spec.model, {
            input: { image_url: url, maps: ['height'], seed: manifest.spec.seed, output_format: 'png' }, logs: false,
            onEnqueue: (id) => { saved.requestId = id; saved.estimatedCost = 0.01 + tile.sent ** 2 / 1e6 * 0.01; save(); },
          });
          saved.result = result.data;
        }
        saved.seconds = (Date.now() - start) / 1000;
        save();
      }
      const image = saved.result.images?.find((image) => image.map_type === 'height');
      if (!image?.url) throw new Error(`No height output for ${tile.id}`);
      const response = await fetch(image.url);
      if (!response.ok) throw new Error(`Height download failed for ${tile.id}: ${response.status}`);
      fs.writeFileSync(path.join(out, tile.raw), Buffer.from(await response.arrayBuffer()));
      console.log(`${tile.id}: saved predicted height (${saved.seconds.toFixed(1)} s)`);
    }
  };
  const workers = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(4, Number(a.parallel) || 2)) }, work));
  for (const result of workers) if (result.status === 'rejected') throw result.reason;
}
const missing = manifest.tiles.filter((t) => !fs.existsSync(path.join(out, t.raw)));
if (missing.length) {
  if (a.limit) console.log(`${missing.length} tiles left; rerun without --limit to finish.`);
  else throw new Error(`${missing.length} height predictions are missing`);
} else python('pack');
