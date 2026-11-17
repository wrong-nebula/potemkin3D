#!/usr/bin/env node
// Reproducible GPU regression check against the built viewer. No model calls.
// TROMPE_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node experiments/luxor-view/check-pom.mjs http://127.0.0.1:5186/
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { launchBrowser } from '../../scripts/browser.mjs';

const base = process.argv[2] ?? 'http://127.0.0.1:5186/';
const out = path.resolve('output/playwright/pom-height');
await fs.mkdir(out, { recursive: true });
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 744 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const report = [];
  for (const hi of [0, 4]) {
    const url = new URL(base);
    url.search = `res=1&ratio=1&hi=${hi}`;
    await page.goto(url.href);
    await page.waitForFunction(() => window.luxorView?.ready(), null, { timeout: 60000 });
    await page.waitForFunction(() => !window.luxorView.lod()?.heightLoading, null, { timeout: 60000 });
    await page.keyboard.press('5');
    if (hi) await page.waitForFunction(() => window.luxorView.lod()?.sharp === 4 && !window.luxorView.lod().loading, null, { timeout: 60000 });
    const result = await page.evaluate(async () => {
      const v = window.luxorView;
      Object.assign(v.on, { dof: false, blur: false, film: false, dust: false, lens: false, hdr: false });
      v.state.exposure = 0.8;
      const snap = () => v.snapshot();
      const capture = () => { v.on.pom = false; const off = snap(); v.on.pom = true; return { off, on: snap() }; };
      const checks = [];
      const same = (name) => { const pair = capture(); checks.push({ name, passed: pair.off === pair.on }); };
      const wall = capture();
      checks.push({ name: 'visible relief', passed: wall.off !== wall.on });
      // Light the carving obliquely and exercise an increased user depth. The normal midday view
      // contains little direct-light occlusion in these deliberately shallow predicted recesses.
      v.setSun(45, 60);
      v.pom.uPomDepth.value = 0.05;
      v.on.pomShadow = false;
      const noShadows = snap();
      v.on.pomShadow = true;
      const shadows = snap();
      // Compare pixels, not just PNG encodings. The final sharpening pass can brighten neighbours of a
      // darkened groove, so check that light removed clearly dominates those small contrast halos.
      const pixels = async (url) => {
        const image = await createImageBitmap(await (await fetch(url)).blob());
        const canvas = new OffscreenCanvas(image.width, image.height), ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0); image.close();
        return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const a = await pixels(noShadows), b = await pixels(shadows);
      let darkened = 0, brightened = 0, removed = 0, added = 0;
      for (let i = 0; i < a.length; i += 4) {
        const change = b[i] + b[i + 1] + b[i + 2] - a[i] - a[i + 1] - a[i + 2];
        if (change < -6) darkened++;
        if (change > 6) brightened++;
        removed += Math.max(0, -change); added += Math.max(0, change);
      }
      checks.push({ name: 'cavity shadows', passed: darkened > 100 && removed > 2 * added });
      v.setSun(60, 30);
      v.pom.uPomDepth.value = 0;
      same('zero depth is identical');
      v.pom.uPomDepth.value = 0.025;
      v.on.maps = false;
      same('materials off is identical');
      v.on.maps = true;
      v.stand(40, 34, 55, 0, 2, 0, true);
      same('distant view is identical');
      // Run a short oblique camera path, including near-grazing views, to exercise all shader paths.
      for (let i = 0; i < 16; i++) {
        v.stand(-11.7 - i * 0.04, 1.65, 12 - i * 0.1, -13, 1.9, 8, true);
        snap();
      }
      v.stand(-11.7, 1.65, 12, -13, 1.9, 8, true);
      return { checks, lod: v.lod(), shadowSettings: { azimuth: 45, elevation: 60, depth: 0.05 },
        darkened, brightened, removed, added, wall, noShadows, shadows };
    });
    for (const [name, data] of Object.entries({ ...result.wall, noShadows: result.noShadows, shadows: result.shadows })) {
      await fs.writeFile(path.join(out, `${hi ? '4k' : '2k'}-${name}.png`), Buffer.from(data.split(',')[1], 'base64'));
    }
    delete result.wall; delete result.noShadows; delete result.shadows;
    report.push(result);
    await fs.writeFile(path.join(out, 'checks.json'), JSON.stringify(report, null, 2));
    for (const check of result.checks) assert(check.passed, `${hi ? '4K' : '2K'}: ${check.name} (${result.darkened} darkened, ${result.brightened} brightened)`);
    assert.equal(result.lod.sharp, hi);
    assert.equal(result.lod.heightPages, 4, 'all four dedicated height maps are loaded');
    assert.deepEqual(result.lod.heightSizes, Array(4).fill(hi ? 4096 : 2048));
    assert.deepEqual(result.lod.heightErrors, []);
    await page.keyboard.press('j');
    assert.equal(await page.evaluate(() => window.luxorView.on.pomShadow), false);
    await page.keyboard.press('j');
    await page.keyboard.down('0');
    await page.waitForTimeout(250);
    await page.keyboard.up('0');
    assert((await page.evaluate(() => window.luxorView.pom.uPomDepth.value)) > 0.025, 'depth control');
  }
  // A failed height fetch must leave a working normal-mapped scene and no inferred-colour substitute.
  await page.route('**/*height*.png', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.alloc(0) }));
  const missingUrl = new URL(base); missingUrl.search = 'res=1&ratio=1&hi=0';
  await page.goto(missingUrl.href);
  await page.waitForFunction(() => window.luxorView?.ready() && !window.luxorView.lod()?.heightLoading);
  const missing = await page.evaluate(() => {
    const v = window.luxorView;
    Object.assign(v.on, { dof: false, blur: false, film: false, dust: false, lens: false });
    v.stand(-11.7, 1.65, 12, -13, 1.9, 8, true);
    v.on.pom = false; const off = v.snapshot(); v.on.pom = true; const on = v.snapshot();
    return { identical: off === on, status: v.lod() };
  });
  assert(missing.identical, 'missing height maps must disable POM');
  assert.equal(missing.status.heightPages, 0);
  assert.equal(missing.status.heightErrors.length, 4);
  report.push({ missingHeightFallback: true });
  assert.deepEqual(errors, [], 'browser/shader errors');
  await fs.writeFile(path.join(out, 'checks.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
