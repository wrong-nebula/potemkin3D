// Browser regression check of the MAIN Viewer. No API/model calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchBrowser, startServer, ROOT } from './browser.mjs';

process.env.TROMPE_CHROME ??= '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const { server, url } = await startServer();
const browser = await launchBrowser();
const out = path.join(ROOT, 'output/playwright/sento-main');
await fs.mkdir(out, { recursive: true });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });
const save = async (name, data) => fs.writeFile(path.join(out, `${name}.png`), Buffer.from(data.split(',')[1], 'base64'));
try {
  await page.goto(`${url}?headless`);
  await page.waitForFunction(() => !!window.trompe);
  const state = await page.evaluate(async () => {
    await trompe.loadSentoFloor();
    const { SENTO_FLOOR } = await import('/src/presets/sento-floor.ts');
    window.floorSpec = SENTO_FLOOR.detail;
    const s = trompe.session, v = s.viewer;
    v.resize(1280, 720); v.render();
    return { ...v.floorDetailState, mode: v.mode, triangles: s.level.triangles,
      revision: s.engine.atlas.revision, drawCalls: s.gpu.renderer.info.render.calls };
  });
  assert.equal(state.enabled, true); assert.equal(state.mode, 'lit');
  for (const debug of ['off', 'albedo', 'protected']) {
    for (const enabled of debug === 'protected' ? [true] : [false, true]) {
      const image = await page.evaluate(({ debug, enabled }) => {
        const v = trompe.session.viewer;
        v.setFloorDetailEnabled(enabled); v.setFloorDetailDebug(debug); v.render();
        return trompe.session.canvas.toDataURL('image/png');
      }, { debug, enabled });
      await save(`${debug}-${enabled ? 'after' : 'before'}`, image);
    }
  }
  const checks = await page.evaluate(async () => {
    const s = trompe.session, v = s.viewer, atlas = s.engine.atlas;
    const pixels = () => {
      const gl = s.gpu.renderer.getContext(), data = new Uint8Array(s.canvas.width * s.canvas.height * 4);
      gl.readPixels(0, 0, s.canvas.width, s.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data); return data;
    };
    v.setFloorDetailDebug('off'); v.setFloorDetailEnabled(false); v.render();
    const disabled = pixels(), drawBefore = s.gpu.renderer.info.render.calls;
    const paintBefore = atlas.readBytes(undefined, 256).data;
    await v.setFloorDetail(); v.render();
    const removed = pixels(); let disabledMaxError = 0, disabledChangedChannels = 0;
    for (let i = 0; i < disabled.length; i++) { const d = Math.abs(disabled[i] - removed[i]); disabledMaxError = Math.max(disabledMaxError, d); if (d) disabledChangedChannels++; }
    await v.setFloorDetail(window.floorSpec); v.render();
    const drawAfter = s.gpu.renderer.info.render.calls, paintAfter = atlas.readBytes(undefined, 256).data;
    const errors = [];
    try { await v.setFloorDetail({ ...window.floorSpec, layoutHash: 'invalid' }); } catch (e) { errors.push(e.message); }
    try { await v.setFloorDetail({ ...window.floorSpec, label: 'unrelated wall' }); } catch (e) { errors.push(e.message); }
    const stillEnabled = v.floorDetailState.enabled;
    const settings = v.floorDetailSettings;
    const portable = settings.spec.packedUrl.startsWith('/') && settings.paintHash.length === 64;
    await v.setFloorDetail();
    await v.setFloorDetail(settings.spec, settings.paintHash); v.render();
    const restored = v.floorDetailState.enabled;
    let wrongPaintRejected = false;
    try { await v.setFloorDetail(settings.spec, 'not-the-same-paint'); } catch { wrongPaintRejected = true; }
    v.setMode('textured'); v.render(); const plainWithDetail = s.canvas.toDataURL('image/png');
    v.setFloorDetailEnabled(false); v.render(); const plainWithoutDetail = s.canvas.toDataURL('image/png');
    v.setFloorDetailEnabled(true); v.setMode('lit');
    // Any actual paint operation invalidates the old mask, including one that only fills remaining gaps.
    atlas.fillUnpainted(new Uint8ClampedArray([128, 128, 128, 255]), 1);
    v.render(); const stale = v.floorDetailState;
    const staleNotSaved = v.floorDetailSettings === undefined;
    let staleRejected = false; try { v.setFloorDetailEnabled(true); } catch { staleRejected = true; }
    const textures = s.gpu.renderer.info.memory.textures;
    await v.setFloorDetail(); v.render();
    return { disabledMaxError, disabledChangedChannels, paintUnchanged: paintBefore.every((n, i) => n === paintAfter[i]),
      drawBefore, drawAfter, wrongBindingRejected: errors.length === 2, stillEnabled,
      portable, restored, wrongPaintRejected, staleNotSaved,
      texturedModeUnchanged: plainWithDetail === plainWithoutDetail, stale, staleRejected,
      texturesReleased: textures - s.gpu.renderer.info.memory.textures };
  });
  await fs.writeFile(path.join(out, 'checks.json'), JSON.stringify({ state, checks, errors }, null, 2));
  console.log(JSON.stringify({ state, checks, errors }));
  // Removing a shader may change compiler rounding by one byte; the same-program paint check below is exact.
  assert.ok(checks.disabledMaxError <= 1, 'Disabled layer must match the stock renderer within one output byte');
  for (const key of ['paintUnchanged', 'wrongBindingRejected', 'stillEnabled', 'texturedModeUnchanged', 'staleRejected', 'portable', 'restored', 'wrongPaintRejected', 'staleNotSaved']) assert.equal(checks[key], true, key);
  assert.equal(checks.drawBefore, checks.drawAfter); assert.equal(checks.stale.enabled, false);
  assert.equal(checks.texturesReleased, 3);
  assert.deepEqual(errors, []);
} finally { await browser.close(); await server.close(); }
