// Optional one-time map prediction. Key is read from stdin or FAL_KEY, never written to disk.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fal } from '@fal-ai/client';

const directory = path.join(import.meta.dirname, 'assets');
let credential = process.env.FAL_KEY;
if (!credential) {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  credential = text.trim();
}
if (!credential) throw new Error('Supply FAL_KEY or the key on stdin.');
fal.config({ credentials: credential });
const requests = [];
for (const name of ['stone', 'tile']) {
  const marker = path.join(directory, `${name}-prediction.json`);
  if (await fs.stat(marker).catch(() => null)) { console.log(`${name}: using cached maps`); continue; }
  const input = await fs.readFile(path.join(directory, `${name}-source.png`));
  const start = performance.now();
  const result = await fal.subscribe('fal-ai/patina', {
    input: { image_url: `data:image/png;base64,${input.toString('base64')}`,
      maps: ['basecolor', 'height', 'roughness'], seed: 1701, output_format: 'png' },
    logs: false,
  });
  const outputs = [];
  for (const map of result.data.images ?? []) {
    if (!['basecolor','height','roughness'].includes(map.map_type)) continue;
    const response = await fetch(map.url);
    if (!response.ok) throw new Error(`Map download returned ${response.status}`);
    const file = `${name}-${map.map_type}.png`;
    await fs.writeFile(path.join(directory, file), Buffer.from(await response.arrayBuffer()));
    outputs.push(file);
  }
  const record = { model: 'fal-ai/patina', seed: 1701, requestId: result.requestId,
    elapsedSeconds: (performance.now() - start)/1000, outputs };
  if (outputs.length !== 3) throw new Error(`Incomplete ${name} result`);
  await fs.writeFile(marker, JSON.stringify(record, null, 2)+'\n');
  requests.push(record);
  console.log(`${name}: saved ${outputs.length} maps in ${record.elapsedSeconds.toFixed(1)} s`);
}
credential = undefined;
