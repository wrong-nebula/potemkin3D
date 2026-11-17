// Real main-renderer checks, with local test maps and an in-memory saved-run store. No model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { launchBrowser, startServer, ROOT } from './browser.mjs';
process.env.TROMPE_CHROME ??= '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const { server, url } = await startServer(), browser = await launchBrowser();
const out = path.join(ROOT, 'output/playwright/material-presets');
await fs.mkdir(out, { recursive: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [], modelRequests = [], saved = new Map();
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });
page.on('request', r => { if (r.url().includes('/api/fal/')) modelRequests.push(r.url()); });
await page.route(/\/(?:api\/)?runs\/material-presets-check\//, async route => {
  if (route.request().method() === 'POST') {
    saved.set(new URL(route.request().url()).pathname.split('/').at(-1), route.request().postDataBuffer());
    await route.fulfill({ status: 204 }); return;
  }
  const name = new URL(route.request().url()).pathname.split('/').at(-1), body = saved.get(name);
  await route.fulfill({ status: body ? 200 : 404, contentType: name.endsWith('.json') ? 'application/json' : 'image/png', body: body ?? '' });
});
try {
  await page.goto(`${url}?headless`); await page.waitForFunction(() => !!window.trompe);
  await page.evaluate(async () => {
    await trompe.loadSentoFloor();
    trompe.session.viewer.resize(1280, 720);
    window.hashBytes = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map(n => n.toString(16).padStart(2, '0')).join('');
    window.originalPaintHash = await hashBytes(trompe.session.engine.atlas.readBytes(undefined, 2048, true).data);
  });
  const performanceCheck = await page.evaluate(async () => {
    const s = trompe.session, v = s.viewer, renderer = s.gpu.renderer, gl = renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const maps = s.engine.pbr, assignments = s.engine.materialPresets;
    const median = values => values.length ? values.sort((a, b) => a - b)[Math.floor(values.length / 2)] : null;
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const measure = async enabled => {
      s.engine.materialPresets = enabled ? assignments : {};
      v.setPbr(enabled ? maps : undefined); v.syncMaterialResponses();
      for (let i = 0; i < 12; i++) { await frame(); v.render(); }
      gl.finish();
      const cpu = [], gpu = [], pending = [];
      for (let i = 0; i < 45; i++) {
        await frame();
        const query = ext ? gl.createQuery() : undefined;
        if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
        const start = performance.now(); v.render(); cpu.push(performance.now() - start);
        if (query) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(query); }
      }
      const deadline = performance.now() + 5000;
      while (pending.length && performance.now() < deadline) {
        await frame();
        if (gl.getParameter(ext.GPU_DISJOINT_EXT)) { pending.forEach(q => gl.deleteQuery(q)); pending.length = 0; gpu.length = 0; break; }
        while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
          const query = pending.shift(); gpu.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(query);
        }
      }
      pending.forEach(q => gl.deleteQuery(q));
      v.render();
      return { cpuSubmitMedianMs: median(cpu), gpuMedianMs: median(gpu), gpuSamples: gpu.length,
        drawCalls: renderer.info.render.calls, textures: renderer.info.memory.textures,
        image: s.canvas.toDataURL('image/png') };
    };
    const before = await measure(false), after = await measure(true);
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    let texels = 0; for (let side = maps.size; side >= 1; side = Math.floor(side / 2)) texels += side * side;
    return { before, after, gpu: gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
      width: s.canvas.width, height: s.canvas.height, addedMapTextureBytes: 2 * texels * 4,
      floorDetailTextureBytes: v.floorDetailState.textureBytes };
  });
  for (const name of ['before', 'after']) {
    await fs.writeFile(path.join(out, `${name}.png`), Buffer.from(performanceCheck[name].image.split(',')[1], 'base64'));
    delete performanceCheck[name].image;
  }
  assert.equal(performanceCheck.before.drawCalls, performanceCheck.after.drawCalls);
  assert.equal(performanceCheck.after.textures - performanceCheck.before.textures, 2);
  const rows = [], albedos = [];
  for (const id of ['limestone', 'glazed-tile', 'painted-metal', 'timber']) {
    const result = await page.evaluate(async id => {
      const s = trompe.session, v = s.viewer;
      const t0 = performance.now();
      trompe.materialPresets({ ...s.engine.materialPresets, 'tiled bathhouse floor': id });
      const milliseconds = performance.now() - t0;
      v.setFloorDetailDebug('off'); v.render();
      const image = s.canvas.toDataURL('image/png');
      v.setFloorDetailDebug('albedo'); v.render();
      const albedo = s.canvas.toDataURL('image/png');
      v.setFloorDetailDebug('off'); v.render();
      return { image, albedo, milliseconds, drawCalls: s.gpu.renderer.info.render.calls,
        textures: s.gpu.renderer.info.memory.textures, paintHash: await hashBytes(s.engine.atlas.readBytes(undefined, 2048, true).data),
        preserved: originalPaintHash === await hashBytes(s.engine.atlas.readBytes(undefined, 2048, true).data) };
    }, id);
    await fs.writeFile(path.join(out, `${id}.png`), Buffer.from(result.image.split(',')[1], 'base64'));
    albedos.push(result.albedo); const { image, albedo, ...row } = result; rows.push({ id, ...row });
  }
  assert.ok(rows.every(r => r.preserved)); assert.equal(new Set(albedos).size, 1);
  assert.equal(new Set(rows.map(r => r.drawCalls)).size, 1); assert.equal(new Set(rows.map(r => r.textures)).size, 1);
  const maps = await page.evaluate(async () => {
    const s = trompe.session, v = s.viewer;
    await v.setFloorDetail();
    const { layoutHash } = await import('/src/core/layout.ts');
    const { DEFAULT_PIPELINE } = await import('/src/core/pipeline.ts');
    const { pbrMetadata } = await import('/src/core/pbr.ts');
    const size = 32, hash = layoutHash(s.level.geometry.getAttribute('uv').array);
    const image = (kind, n = size) => {
      const c = document.createElement('canvas'); c.width = c.height = n;
      const ctx = c.getContext('2d'), data = ctx.createImageData(n, n);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const i = 4 * (y * n + x), value = Math.round(x / (n - 1) * 255);
        data.data.set(kind === 'normal' ? [240, 30, 80, 255] : kind === 'roughness' ? [170, 170, 170, 255] : [value, value, value, 255], i);
      }
      ctx.putImageData(data, 0, 0); return c.toDataURL('image/png');
    };
    let dimensionsRejected = false, layoutRejected = false;
    try { await trompe.materialMaps({ size, layoutHash: hash, heightUrl: image('height', 16) }); } catch { dimensionsRejected = true; }
    try { await trompe.materialMaps({ size, layoutHash: 'wrong', heightUrl: image('height') }); } catch { layoutRejected = true; }
    await trompe.materialMaps({ size, layoutHash: hash, heightUrl: image('height'), normalUrl: image('normal'), roughnessUrl: image('roughness'), roughnessBase: 170 / 255 });
    const source = s.engine.pbr.source, firstNormal = s.engine.pbr.normal.slice();
    s.setMaterialMapSource({ ...source, normal: undefined });
    const heightWins = firstNormal.every((n, i) => n === s.engine.pbr.normal[i]);
    s.setMaterialMapSource(source);
    const paintUnchanged = originalPaintHash === await hashBytes(s.engine.atlas.readBytes(undefined, 2048, true).data);
    // Empty view records isolate map/settings persistence; paint preservation is checked separately above.
    s.record = { level: s.level.name, options: DEFAULT_PIPELINE, plan: { points: [], views: [], waves: [], predicted: [] },
      views: [], cost: 0, seconds: 0, pbr: pbrMetadata(s.engine.pbr) };
    const before = { height: await hashBytes(source.height), normal: await hashBytes(source.normal), roughness: await hashBytes(source.roughness),
      assignments: JSON.stringify(s.engine.materialPresets), outputNormal: await hashBytes(s.engine.pbr.normal), outputOrm: await hashBytes(s.engine.pbr.orm) };
    await s.saveRun('material-presets-check');
    await s.loadRun('material-presets-check');
    const loaded = s.engine.pbr;
    return { dimensionsRejected, layoutRejected, heightWins, paintUnchanged,
      sourcesRestored: before.height === await hashBytes(loaded.source.height) && before.normal === await hashBytes(loaded.source.normal) && before.roughness === await hashBytes(loaded.source.roughness),
      outputsRestored: before.outputNormal === await hashBytes(loaded.normal) && before.outputOrm === await hashBytes(loaded.orm),
      assignmentsRestored: before.assignments === JSON.stringify(s.engine.materialPresets) };
  });
  for (const [name, value] of Object.entries(maps)) assert.equal(value, true, name);
  const glb = saved.get('level_textured.glb');
  const document = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString());
  const exported = document.materials.every(m => m.normalTexture && m.pbrMetallicRoughness?.metallicRoughnessTexture);
  assert.ok(exported); assert.deepEqual(errors, []); assert.deepEqual(modelRequests, []);
  const result = { rows, performance: performanceCheck, albedoIdentical: true, maps, exported, errors, modelRequests };
  await fs.writeFile(path.join(out, 'checks.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); await server.close(); }
