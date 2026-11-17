#!/usr/bin/env node
// Shared-scene benchmark. Real API calls only in explicit `independent` / `sequential` stages.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { fal } from '@fal-ai/client';
import { launchBrowser, startServer, ROOT } from './browser.mjs';

const { values: a } = parseArgs({ options: { stage: { type: 'string', default: 'trompe' },
  root: { type: 'string', default: 'output/benchmark/tatooine' }, budget: { type: 'string', default: '5' },
  dataset: { type: 'string', default: 'common' } } });
const root = path.resolve(a.root), json = async p => JSON.parse(await fs.readFile(p, 'utf8'));
await fs.mkdir(root, { recursive: true });
const scene = await json('samples/tatooine-cameras.json'), look = await json('samples/tatooine.look.json');
const cfg = await json(path.join(root, 'upstream/case.json'));
const views = cfg.views.cameras.map((v, i) => ({ ...scene.cameras.find(c => c.name === v.camera), id: i, key: v.name }));
if (views.some(v => !v.name)) throw new Error('Shared camera names do not match');
const novel = scene.novelCameras ?? scene.novel ?? [];
const endpoint = 'blackforestlabs/flux-3/klein/edit-image';
const logPath = path.join(root, 'budget.json');
let budget = await json(logPath).catch(() => ({ cap: +a.budget, reserved: 0, calls: [] }));
async function reserve(label) {
  const existing = budget.calls.find(c => c.label === label);
  if (existing) return existing;
  if (budget.reserved + .036 > Math.min(+a.budget, budget.cap)) throw new Error('Generation budget reached');
  const row = { label, reserved: .036, status: 'reserved', at: new Date().toISOString() };
  budget.reserved += .036; budget.calls.push(row); await saveBudget(); return row;
}
async function saveBudget() { await fs.writeFile(logPath, JSON.stringify(budget, null, 2)); }
const writeData = async (file, data) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, Buffer.from(data.split(',').at(-1), 'base64')); };
const exists = async file => !!(await fs.stat(file).catch(() => null));
const urlFor = file => '/' + path.relative(ROOT, file).split(path.sep).join('/');

if (a.stage === 'independent') {
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY must be passed in the environment');
  fal.config({ credentials: process.env.FAL_KEY });
  for (const v of views) {
    const dest = path.join(root, 'common-native', v.key + '.png');
    if (await exists(dest)) { console.log('Cached', v.key); continue; }
    const call = await reserve('independent:' + v.key), start = Date.now();
    if (call.status === 'reserved' && call.attempted) throw new Error('Uncertain prior submission; reconcile it before retrying');
    if (!call.requestId) {
      call.attempted = true; await saveBudget();
      const clay = await fs.readFile(path.join(root, 'upstream/views', v.key, 'clay.png'));
      const prompt = `Texture this exact grey 3D blockout view. Keep the camera, geometry, silhouettes and object positions exactly. ${look.style}. ${look.setting.light}. Do not add people, objects, openings, buildings or lettering. All visible parts are existing modeled surfaces. Output only this one view.`;
      let r;
      try { r = await fal.queue.submit(endpoint, { input: { image_urls: ['data:image/png;base64,' + clay.toString('base64')], prompt,
        image_size: { width: 1024, height: 1024 }, num_images: 1, seed: 7, output_format: 'png', enable_prompt_expansion: false } }); }
      catch (error) { if (error.cause?.code === 'ENOTFOUND') { call.attempted = false; call.note = 'DNS failure before submission'; await saveBudget(); } throw error; }
      call.requestId = r.request_id; call.prompt = prompt; call.inputSha256 = crypto.createHash('sha256').update(clay).digest('hex'); call.status = 'submitted'; await saveBudget();
    }
    console.log('Waiting on', v.key, call.requestId);
    await fal.queue.subscribeToStatus(endpoint, { requestId: call.requestId, logs: false, pollInterval: 1500 });
    const r = await fal.queue.result(endpoint, { requestId: call.requestId });
    const response = await fetch(r.data.images[0].url); if (!response.ok) throw new Error('Generated image download failed');
    const png = Buffer.from(await response.arrayBuffer());
    if (png.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('Expected a native PNG');
    call.native = [png.readUInt32BE(16), png.readUInt32BE(20)]; call.status = 'complete'; call.seconds = (Date.now() - start) / 1000;
    await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, png); await saveBudget();
    console.log('Generated', v.key, call.native, call.seconds.toFixed(1) + 's');
  }
  process.exit(0);
}

const { server, url } = await startServer();
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', e => console.error('Browser:', e.message));
  await page.goto(url + 'experiments/benchmark/runner.html');
  await page.waitForFunction(() => !!window.benchmark);
  const info = await page.evaluate(() => window.benchmark.init());
  const capture = async (folder, spec, upstream) => {
    const data = upstream ? await page.evaluate(({ upstream, spec }) => window.benchmark.renderModel(upstream.image, upstream.coverage, spec), { upstream, spec })
      : await page.evaluate(v => window.benchmark.capture(v), spec);
    for (const [key, value] of Object.entries(data)) if (typeof value === 'string' && value.startsWith('data:')) await writeData(path.join(folder, spec.name + '-' + key + '.png'), value);
  };
  if (a.stage === 'sequential') {
    for (const v of views) {
      const call = await reserve('sequential:' + v.key);
      if (call.status === 'complete') throw new Error('Sequential replay requires its saved composites; use a fresh run or explicit replay');
      if (call.attempted) throw new Error('Uncertain prior sequential request; reconcile before retrying');
      call.attempted = true; await saveBudget();
      const result = await page.evaluate(({ v, look }) => window.benchmark.generate(v, look), { v, look });
      for (const key of ['image', 'input']) await writeData(path.join(root, 'sequential', v.key + '-' + key + '.png'), result[key]);
      Object.assign(call, { status: 'complete', requestId: result.requestId, native: result.native, seconds: result.seconds, prompt: result.prompt }); await saveBudget();
      console.log('Sequential', v.key, result.seconds.toFixed(1) + 's');
    }
    await page.evaluate(() => window.benchmark.finish());
    for (const v of [...views, ...novel]) await capture(path.join(root, 'sequential/renders'), v);
    await fs.writeFile(path.join(root, 'sequential/appearance.glb'), Buffer.from(await page.evaluate(() => window.benchmark.glb()), 'base64'));
  } else if (a.stage === 'trompe') {
    const targets = views.map(v => ({ spec: v, url: urlFor(path.join(root, a.dataset === 'truth' ? 'truth' : a.dataset + '-targets', (a.dataset === 'truth' ? v.name : v.key) + '.png')) }));
    await page.evaluate(t => window.benchmark.project(t), targets);
    const validation = await page.evaluate(() => window.benchmark.validate());
    const out = path.join(root, a.dataset, 'trompe'); await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, 'validation.json'), JSON.stringify(validation, null, 2));
    await page.evaluate(() => window.benchmark.finish());
    for (const v of [...views, ...novel]) await capture(path.join(out, 'renders'), v);
    await fs.writeFile(path.join(out, 'appearance.glb'), Buffer.from(await page.evaluate(() => window.benchmark.glb()), 'base64'));
    for (let k = 0; k < views.length; k++) {
      await page.evaluate(({ targets, k }) => window.benchmark.project(targets, k), { targets, k });
      await capture(path.join(out, 'heldout'), views[k]);
    }
    await fs.writeFile(path.join(out, 'config.json'), JSON.stringify({ ...info, inputTargets: targets, projection: 'production GPU projector; raw targets, default minCos=.08, no SAM/plane rejection in controlled fusion ablation', totalAtlasTexels: 2048 ** 2 }, null, 2));
    console.log('Trompe evaluation complete:', out);
  } else if (a.stage === 'render-upstream') {
    const upstream = path.join(root, a.dataset === 'common' ? 'upstream' : 'upstream-' + a.dataset);
    const out = path.join(root, a.dataset, 'multiview');
    for (const v of [...views, ...novel]) await capture(path.join(out, 'renders'), v, { image: urlFor(path.join(upstream, 'exports/appearance.glb')), coverage: urlFor(path.join(upstream, 'exports/coverage.glb')) });
    for (const v of views) if (await exists(path.join(upstream, 'exports', v.key + '-heldout.glb'))) await capture(path.join(out, 'heldout'), v,
      { image: urlFor(path.join(upstream, 'exports', v.key + '-heldout.glb')), coverage: urlFor(path.join(upstream, 'exports', v.key + '-coverage.glb')) });
    console.log('Upstream captures complete:', out);
  } else throw new Error('Unknown benchmark stage');
} finally { await browser.close(); await server.close(); }
