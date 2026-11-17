// temporary: stills of a run from its player spots (no model call)
import fs from 'node:fs';
import { launchBrowser, openApp, startServer } from './browser.mjs';
const [run, out, mode = 'textured', atlas = '4096'] = process.argv.slice(2);
const saved = JSON.parse(fs.readFileSync(`runs/${run}/run.json`, 'utf8'));
const { server, url } = await startServer();
const browser = await launchBrowser();
try {
  const page = await openApp(browser, url, { onLog: () => {}, onEvent: () => {} });
  await page.evaluate(([l, lighting, atlasSize, viewSize, area]) => window.trompe.load(`/${l}`, { lighting, atlasSize: +atlasSize, viewSize: +viewSize, area }), [`samples/${saved.level}.glb`, saved.lighting.name, atlas, saved.viewSize, saved.area]);
  console.log(JSON.stringify(await page.evaluate((r) => window.trompe.loadRun(r), run)));
  console.log(JSON.stringify(await page.evaluate(() => window.trompe.bounds())));
  if (fs.existsSync(`${out}/probe.js`)) console.log(JSON.stringify(await page.evaluate(fs.readFileSync(`${out}/probe.js`, 'utf8')), null, 0));
  const shots = JSON.parse(fs.readFileSync(`${out}/shots.json`, 'utf8'));
  for (const s of shots) {
    const dataUrl = await page.evaluate((o) => window.trompe.snapshot(o), { position: s.eye, target: s.at, mode, overlay: false, width: s.w ?? 1280, height: s.h ?? 720, fov: s.fov ?? 75 });
    fs.writeFileSync(`${out}/${s.name}.jpg`, Buffer.from(dataUrl.split(',')[1], 'base64'));
  }
  console.log('wrote', shots.length);
} finally { await browser.close(); await server.close(); }
