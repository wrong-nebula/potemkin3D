#!/usr/bin/env node
/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
// Texture a level headlessly and save the run to runs/<id>/.
//   FAL_KEY=... node scripts/texture.mjs --level samples/courtyard.glb --id courtyard --views 24 \
//     [--lighting overcast|outdoor|indoor|indoor-soft] [--style "..."] [--first flux3-klein|h3] [--fill flux3-klein|h3|fibo2] [--view-size 2048|4096] [--aerial 8] [--roofs 24] [--floors 16] [--holes 12] [--plan-only]
//     [--pbr [--pbr-size 4096]]   also make normal and roughness maps for the finished texture
//     [--ao [--ao-size 1024]]     also bake ambient occlusion into the material's occlusion channel (no model call)
//     [--layout seen] lay the texture out again so the faces players can see get the texels (the exported GLB carries the new UVs)
//     [--full]       a clean-up pass, hard parts textured on their own, and the finishing fill (add --floors 12 for plain ground
//                    such as concrete: on patterned ground the floor pass still drifts in scale from view to view)
//     [--ground 3]   lay the ground from tiles painted from straight above (scripts/ground.mjs does the same for a saved run)
//     [--frame-margin 0.04]  don't paint from the outer 4% of each image, where the models let things peek into the frame
//     [--notes notes.json]  things to add at spots in the level (a poster, a rug): each is drawn as a red note on the renders of the
//                    views that see its spot, until one has painted it. Flat things only; MiniMax H3 only (--first h3 --fill h3)
//     [--look samples/luxor.look.json]  a place's own look, as a JSON file: its level, lighting and texture size, the look in words
//                    (style, floorStyle, roofStyle, wording), how prompts speak of such a place (setting: see PromptSetting in
//                    src/providers/models.ts), photos of the real place to paint from (styleImages) and eye positions on floors the
//                    planner cannot climb to, such as a mezzanine up a long flight of stairs (spots). A flag given by hand wins
//     [--no-names]   don't have a vision model name the shapes of a level that names none of its parts
//     [--style-reference]  show mostly-unpainted views a sheet of material samples from the texture so far
//     [--no-planes]  skip the plane test (one MoGe-2 call per view with a big flat face, about a cent)
//     [--no-check] [--check-retries 1] [--check-threshold 0.5]   the blockout check (on by default): faces the model
//                                        painted over are left for a later view; with retries, such a view is painted
//                                        again first; a lower threshold lets more through
// Every view is written to runs/<id>/ as it's painted. A run whose page dies resumes itself (up to three times);
// one stopped by hand can be picked up with --resume <id>.
import { parseArgs } from 'node:util';
import { falKey, launchBrowser, openApp, startServer } from './browser.mjs';

const { values: a } = parseArgs({
  options: {
    level: { type: 'string', default: 'samples/courtyard.glb' },
    look: { type: 'string' },
    id: { type: 'string' },
    lighting: { type: 'string' },
    style: { type: 'string' },
    'roof-style': { type: 'string' },
    'min-cos': { type: 'string' },      // don't paint a surface seen at a lower angle than this cosine (default 0.08; 0.2 leaves stretched ground to better views)
    'edge-guard': { type: 'string' }, 'frame-margin': { type: 'string' },   // leave a farther surface unpainted this close (px at 1024) to a nearer one's outline (default 0 = off)
    'check-cells': { type: 'boolean', default: false },   // with the plane test: hold back patches painted as another surface, cell by cell
    floors: { type: 'string', default: '0' },      // max views straight down at the ground, painted first (0 = none)
    'floor-style': { type: 'string' },           // what the ground is made of
    first: { type: 'string', default: 'flux3-klein' },
    fill: { type: 'string', default: 'flux3-klein' },
    views: { type: 'string', default: '36' },
    spacing: { type: 'string', default: '4' },
    aerial: { type: 'string', default: '0' },
    roofs: { type: 'string', default: '0' },
    holes: { type: 'string', default: '0' },
    ground: { type: 'string', default: '0' },      // lay the ground from this many tiles painted from straight above (1 to 3; about $0.014 each), after the views
    'ground-span': { type: 'string' },             // metres of ground a tile shows across (default 3): sets the size of the stones
    cleanup: { type: 'string', default: '0' },
    parts: { type: 'string', default: '0' },       // max parts to texture on their own where the painting left them unfinished ($0.30 each)
    finish: { type: 'boolean', default: false },
    diffuse: { type: 'boolean', default: false },
    notes: { type: 'string' },     // a JSON file of things to add at spots in the level: [{ text: 'add a poster here', at: [x, y, z], size: 1.2 }] in JSON (models that read notes only: h3)
    'hole-model': { type: 'string' },   // the model for hole and clean-up views when not the fill model (h3-fast: quicker, twice the price)
    'gap-notes': { type: 'boolean', default: false },   // hole and clean-up views carry notes naming their biggest gaps (H3)
    props: { type: 'string', default: '0' },   // max props painted on their own by H3 from cameras round them, with a note and references (about $0.15 a prop)
    references: { type: 'string' },   // how many earlier views of the same place a gap-filling view is sent as references (H3; default 2, 0 = none, about $0.008 each)
    wording: { type: 'string' },   // 'retro' (a screenshot from a mid-2000s shooter with photo-sourced textures), 'photo' (a documentary photograph, lens and aperture), 'aaa' (a next gen AAA game texture pass), 'scout' (an unedited scouting photo: the calmest) or 'cel' (a background painting from a hand-drawn animated film of the late 1980s); default: a photorealistic photo   // paint surface colour only, no shading: a base for other maps (tried on MiniMax H3 first views only)
    full: { type: 'boolean', default: false },     // the passes that have earned their place: --cleanup 10 --parts 5 --finish, each unless given   // give what no view painted its part's colours, so no clay is left (no model call)     // max views aimed at what players see that is unpainted or poorly captured
    objective: { type: 'string', default: 'coverage' },    // or 'sharpness': pick views for the detail they add (experimental)
    'look-at': { type: 'string', default: '0' },           // extra candidate cameras aimed at each patch of surface, per patch
    parallel: { type: 'string', default: '1' },
    atlas: { type: 'string', default: '4096' },
    pages: { type: 'string' },   // 4 or 16: paint over that many textures of --atlas px each (the islands are packed again over them, all at one scale)
    area: { type: 'string' },     // 'x0,y0,z0,x1,y1,z1': where players can be, when the level has more floor than that
    layout: { type: 'string' },   // 'seen': lay the texture out by what players can see; 'near': join faces into strips and size each island by how near players get; 'file' (default): the level's own UVs
    'view-size': { type: 'string' },   // 2048 (default), or 1024: a quarter of the pixels, quicker, FLUX 3 Klein charges $0.009 instead of $0.014
    'plan-only': { type: 'boolean', default: false },
    resume: { type: 'string' },
    pbr: { type: 'boolean', default: false },
    ao: { type: 'boolean', default: false },
    'ao-size': { type: 'string', default: '1024' },
    'no-check': { type: 'boolean', default: false },
    'no-names': { type: 'boolean', default: false },
    'no-planes': { type: 'boolean', default: false },
    'style-reference': { type: 'boolean', default: false },
    'check-retries': { type: 'string', default: '1' },
    'check-threshold': { type: 'string', default: '0.5' },
    'pbr-size': { type: 'string', default: '4096' },
  },
});
if (!a['plan-only'] && !(await falKey())) {
  console.error('FAL_KEY is not set (export FAL_KEY=your-fal-key, or put FAL_KEY=... in .env.local)');
  process.exit(1);
}
// A look file stands in for the flags it names; whatever was typed on the command line wins.
const given = (flag) => process.argv.some((x) => x === `--${flag}` || x.startsWith(`--${flag}=`));
let look = {};
if (a.look) {
  look = JSON.parse((await import('node:fs')).readFileSync(a.look, 'utf8'));
  for (const [flag, key] of [['level', 'level'], ['lighting', 'lighting'], ['atlas', 'atlas'], ['style', 'style'], ['floor-style', 'floorStyle'],
    ['roof-style', 'roofStyle'], ['wording', 'wording'], ['area', 'area'], ['first', 'first'], ['fill', 'fill']]) {
    if (look[key] !== undefined && !given(flag)) a[flag] = String(look[key]);
  }
}
// spots given by hand (floors the planner cannot climb to) ride along after the play area's six numbers
if (look.spots?.length && a.area && !given('area')) a.area += `,${look.spots.flat().join(',')}`;
if (a.full) {
  // every pass that has earned its place, at the settings they were measured with; a flag given by hand wins
  if (!given('cleanup')) a.cleanup = '10';
  if (!given('parts')) a.parts = '5';
  a.finish = true;
}
const id = a.resume ?? a.id ?? `${a.level.split('/').pop().replace(/\.\w+$/, '')}-${Date.now().toString(36)}`;
// a top-up paints in the light the run was painted in (runs from before overcast painting were sunny)
if (!a.lighting && a.resume) {
  const fs = await import('node:fs');
  const saved = JSON.parse(fs.readFileSync(`runs/${a.resume}/run.json`, 'utf8'));
  a.lighting = saved.lighting?.name ?? 'outdoor';
}
if (!a.pages && a.resume) {
  // and over as many textures as it was painted over
  const fs = await import('node:fs');
  const saved = JSON.parse(fs.readFileSync(`runs/${a.resume}/run.json`, 'utf8')).pages;
  if (saved) { a.pages = String(saved.count); a.atlas = String(saved.size); }
}
if (!a.layout && a.resume) {
  // and on the layout it was painted on, so its maps still fit
  const fs = await import('node:fs');
  a.layout = JSON.parse(fs.readFileSync(`runs/${a.resume}/run.json`, 'utf8')).layout?.kind;
}
a.layout ??= 'file';
if (!a.area && a.resume) {
  const fs = await import('node:fs');
  const saved = JSON.parse(fs.readFileSync(`runs/${a.resume}/run.json`, 'utf8')).area;
  if (saved) a.area = saved.join(',');
}
const area = a.area ? a.area.split(',').map(Number) : undefined;
if (!a['view-size'] && a.resume) {
  const fs = await import('node:fs');
  a['view-size'] = String(JSON.parse(fs.readFileSync(`runs/${a.resume}/run.json`, 'utf8')).viewSize ?? 1024);
}
a['view-size'] ??= '2048';
a.lighting ??= 'overcast';
const { server, url } = await startServer();
const browser = await launchBrowser();
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
let again = false;
try {
  const page = await openApp(browser, url, {
    onLog: log,
    onEvent: (e) => {
      if (e.type === 'view-done') log(`view ${String(e.index).padStart(2)} ${e.model.padEnd(12)} ${e.seconds}s unknown ${(100 * e.unknown).toFixed(0)}% → painted ${(100 * e.coverage).toFixed(1)}% · $${e.cost.toFixed(2)}` +
        (e.again ? ' · second go' : '') + (e.swatches ? ' · with material samples' : '') + (e.ignored ? ` · ${(100 * e.ignored).toFixed(0)}% painted over the blockout, held back` : ''));
      else if (e.type === 'check' || e.type === 'parts') log(e.message);
      else if (e.type === 'save') log(`saving ${e.msg}`);
      else if (e.type === 'pbr') log(`maps: tile ${e.done}/${e.total}`);
      else log(JSON.stringify(e));
    },
  });
  const info = await page.evaluate(([lvl, lighting, atlas, viewSize, layout, area, pages]) => window.trompe.load(`/${lvl}`, { lighting, atlasSize: +atlas, viewSize: +viewSize, layout, area, pages }),
    [a.level, a.lighting, a.atlas, a['view-size'], a.layout, area, +(a.pages ?? 1)]);
  log(`level: ${JSON.stringify(info)}`);
  if (a['min-cos'] || a['edge-guard'] || a['frame-margin']) {
    log(`projection: ${JSON.stringify(await page.evaluate((o) => window.trompe.projection(o),
      { ...(a['min-cos'] ? { minCos: +a['min-cos'] } : {}), ...(a['edge-guard'] ? { edgeGuard: +a['edge-guard'] } : {}), ...(a['frame-margin'] ? { frameMargin: +a['frame-margin'] } : {}) }))}`);
  }
  const planOpts = { maxViews: +a.views, spacing: +a.spacing, aerial: +a.aerial, roofs: +a.roofs, floors: +a.floors, holes: +a.holes, cleanup: +a.cleanup, maxParallel: +a.parallel, objective: a.objective, lookAt: +a['look-at'] };
  const opts = { firstModel: a.first, fillModel: a.fill, diffuse: a.diffuse, gapNotes: a['gap-notes'], ...(a['hole-model'] ? { holeModel: a['hole-model'] } : {}), ...(a.references !== undefined ? { references: +a.references } : {}), ...(a.wording ? { wording: a.wording } : {}), ...(a.notes ? { notes: JSON.parse((await import('node:fs')).readFileSync(a.notes, 'utf8')) } : {}), plan: planOpts, nameParts: !a['no-names'], check: !a['no-check'], checkPlanes: !a['no-planes'], checkCells: a['check-cells'], ...(look.setting ? { setting: look.setting } : {}), ...(look.styleImages ? { styleImages: look.styleImages } : {}), ...(look.styleMax ? { styleMax: look.styleMax } : {}), styleReference: a['style-reference'], checkRetries: +a['check-retries'], checkThreshold: +a['check-threshold'], ...(a.style ? { style: a.style } : {}),
  ...(a['roof-style'] ? { roofStyle: a['roof-style'] } : {}), ...(a['floor-style'] ? { floorStyle: a['floor-style'] } : {}) };
  if (a.resume) {
    log(`resuming ${JSON.stringify(await page.evaluate((r) => window.trompe.loadRun(r), a.resume))}`);
    // keep the run's look unless told otherwise
    const fs = await import('node:fs');
    const saved = JSON.parse(fs.readFileSync(`runs/${a.resume}/run.json`, 'utf8')).options;
    opts.style ??= saved.style;
    if (saved.roofStyle) opts.roofStyle ??= saved.roofStyle;
    if (saved.floorStyle) opts.floorStyle ??= saved.floorStyle;
    if (saved.notes) opts.notes ??= saved.notes;   // notes not yet carried out still stand
    if (saved.setting) opts.setting ??= saved.setting;
    if (saved.styleImages) opts.styleImages ??= saved.styleImages;
    if (saved.styleMax) opts.styleMax ??= saved.styleMax;
    if (saved.wording) opts.wording ??= saved.wording;
  } else {
    const plan = await page.evaluate((o) => window.trompe.plan(o), planOpts);
    log(`plan: ${JSON.stringify(plan)}`);
  }
  if (!a['plan-only']) {
    const res = await page.evaluate((o) => (o.resume ? window.trompe.topUp(o.opts, undefined, o.id) : window.trompe.run(o.opts, undefined, o.id)),
      { resume: !!a.resume, opts, id });
    log(`run: ${JSON.stringify(res)}`);
    if (a.ao) log(`ambient occlusion: ${JSON.stringify(await page.evaluate((size) => window.trompe.ao({ size }), +a['ao-size']))}`);
    if (a.pbr) log(`maps: ${JSON.stringify(await page.evaluate((size) => window.trompe.pbr({ size }), +a['pbr-size']))}`);
    if (+a.ground > 0) log(`ground: ${JSON.stringify(await page.evaluate(([o, runId]) => window.trompe.ground(o, undefined, runId), [{ tiles: +a.ground, ...(a['ground-span'] ? { span: +a['ground-span'] } : {}) }, id]))}`);
    if (+a.props > 0) log(`prop pass: ${JSON.stringify(await page.evaluate(([max, runId]) => window.trompe.props({ max }, undefined, runId), [+a.props, id]))}`);
    if (+a.parts > 0) log(`part pass: ${JSON.stringify(await page.evaluate(([max, runId]) => window.trompe.parts({ max }, undefined, runId), [+a.parts, id]))}`);
    if (a.finish) log(`finishing fill: ${JSON.stringify(await page.evaluate(() => window.trompe.finish()))}`);
    if (a.ao || a.pbr || a.finish || +a.parts > 0 || +a.ground > 0 || +a.props > 0) await page.evaluate((runId) => window.trompe.save(runId), id);
    log(`saved to runs/${id}/`);
  }
} catch (e) {
  // The page sometimes dies under a long run (it closes, or reloads). Every view is on disk by then, so pick the
  // run up where it stopped, a few times at most.
  const died = /Target page|has been closed|context was destroyed|crashed/i.test(String(e?.message ?? e));
  const fs = await import('node:fs');
  if (!died || a['plan-only'] || +(process.env.TROMPE_ATTEMPT ?? 0) >= 3 || !fs.existsSync(`runs/${id}/run.json`)) throw e;
  log(`the page died (${String(e?.message ?? e).split('\n')[0]}); resuming ${id}`);
  again = true;
} finally {
  await browser.close().catch(() => {});
  await server.close();
}
if (again) {
  const fs = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const done = JSON.parse(fs.readFileSync(`runs/${id}/run.json`, 'utf8')).views;
  const count = (kind) => done.filter((v) => !v.spec.again && (v.spec.kind ?? 'ground') === kind).length;
  // what was asked for, less what is painted: a resumed run plans only where the texture is still missing
  const left = { views: Math.max(0, +a.views - count('ground')), floors: Math.max(0, +a.floors - count('floor')) };
  const drop = new Set(['--id', '--resume', '--views', '--floors']);
  const args = [];
  for (let i = 2; i < process.argv.length; i++) {
    const [flag] = process.argv[i].split('=');
    if (drop.has(flag)) { if (!process.argv[i].includes('=')) i++; continue; }
    args.push(process.argv[i]);
  }
  const r = spawnSync(process.execPath, [process.argv[1], ...args, '--resume', id, '--views', String(left.views), '--floors', String(left.floors)],
    { stdio: 'inherit', env: { ...process.env, TROMPE_ATTEMPT: String(+(process.env.TROMPE_ATTEMPT ?? 0) + 1) } });
  process.exit(r.status ?? 1);
}
