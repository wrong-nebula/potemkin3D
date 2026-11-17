#!/usr/bin/env node
// Reproduce the comparison with the pinned external implementation. Offline by default.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
const { values: a }=parseArgs({options:{generate:{type:'boolean',default:false},root:{type:'string',default:'output/benchmark/tatooine'},
  upstream:{type:'string',default:process.env.MVB2R_ROOT??'/private/tmp/trompe-multiview-to-real'},
  python:{type:'string',default:process.env.MVB2R_PYTHON??'/private/tmp/trompe-benchmark-venv/bin/python'},budget:{type:'string',default:'5'}}});
const PIN='4885e248aa58f425eba88309b14176524a4ec3ef',root=path.resolve(a.root),up=path.resolve(a.upstream);
const cli=path.join(up,'skills/multiview-to-real/scripts/mvb2r.py'),blender=process.env.BLENDER??'/Applications/Blender.app/Contents/MacOS/Blender';
const env={...process.env,BLENDER:blender,MVB2R_PYTHON:a.python,MVB2R_BLENDER_TIMEOUT:'1800'};
const exists=async p=>!!(await fs.stat(p).catch(()=>null)),json=async p=>JSON.parse(await fs.readFile(p,'utf8'));
async function run(cmd,args,log){console.log([path.basename(cmd),...args].join(' '));await new Promise((resolve,reject)=>{
  const child=spawn(cmd,args,{env,stdio:['ignore','pipe','pipe']});let output='';
  for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{const s=b.toString().replaceAll(process.env.FAL_KEY??'__no_key__','<redacted>');output+=s;if(!log)process.stdout.write(s);});
  child.on('error',reject);child.on('exit',async c=>{if(log)await fs.writeFile(log,output);c===0?resolve():reject(new Error(`Stage failed (${c}); ${log??'see output above'}`));});
});}
async function stage(name,caseDir,...args){await run(a.python,[cli,name,caseDir,...args]);}
if(!await exists(cli))throw new Error(`Clone https://github.com/gokayfem/multiview-to-real into ${up} and check out ${PIN}`);
const {execFileSync}=await import('node:child_process');
if(execFileSync('git',['-C',up,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==PIN)throw new Error('Upstream commit differs from the benchmark pin');
await fs.mkdir(root,{recursive:true});
const common=path.join(root,'upstream');
if(!await exists(path.join(common,'case.json')))await stage('new',common,'--input','samples/tatooine.blend','--resolution','512','--generator','fal','--max-calls','7','--edit-endpoint','blackforestlabs/flux-3/klein/edit-image');
await run(a.python,['scripts/benchmark-upstream.py','configure',common,'--upstream',up]);
if(!await exists(path.join(common,'views/cameras.json')))await stage('views',common,'--samples','8');
else if(!await exists(path.join(common,'views/view_01/position_world.exr')))await stage('views',common,'--samples','8');
if(a.generate){
  if(!process.env.FAL_KEY)throw new Error('--generate requires FAL_KEY in the environment');
  if(+a.budget<.684)throw new Error('Reserve at least $0.684 for the planned maximum of 19 one-image calls');
  await run(process.execPath,['scripts/benchmark.mjs','--stage','independent','--root',root,'--budget',a.budget]);
}
const cfg=await json(path.join(common,'case.json'));
await fs.mkdir(path.join(root,'common-targets'),{recursive:true});
await run(a.python,['-c',`from pathlib import Path\nfrom PIL import Image\nr=Path(${JSON.stringify(root)})\nfor p in (r/'common-native').glob('*.png'): Image.open(p).convert('RGB').resize((512,512),Image.Resampling.LANCZOS).save(r/'common-targets'/p.name)`]);
if(!await exists(path.join(root,'common-targets/view_01.png')))throw new Error('Shared generated targets are absent. Run with --generate, or import view_01.png…view_06.png into common-targets.');
for(const dataset of ['common','truth']){
  const c=dataset==='common'?common:path.join(root,'upstream-truth');
  if(!await exists(c))await fs.cp(common,c,{recursive:true});
  if(dataset==='truth'){
    const target=path.join(root,'truth-targets');await fs.mkdir(target,{recursive:true});
    if(!await exists(path.join(root,'truth/manifest.json')))await run(blender,['-b','--factory-startup','--disable-autoexec','--python','samples/render_tatooine_truth.py']);
    for(const v of cfg.views.cameras)await fs.copyFile(path.join(root,'truth',v.camera+'.png'),path.join(target,v.name+'.png'));
  }
  await stage('targets',c,'--images',path.join(root,dataset+'-targets'));
  await stage('consistency',c);
  await stage('project',c,'--method','auto','--no-render');
  await run(a.python,['scripts/benchmark-upstream.py','heldout',c,'--upstream',up]);
  await run(blender,['-b','--factory-startup','--disable-autoexec','--python','scripts/benchmark-export.py','--',c,'--heldout'],path.join(c,'logs/benchmark-export.log'));
  await run(process.execPath,['scripts/benchmark.mjs','--stage','trompe','--dataset',dataset,'--root',root]);
  await run(process.execPath,['scripts/benchmark.mjs','--stage','render-upstream','--dataset',dataset,'--root',root]);
}
// Existing native artifacts are retained. A native run can be launched explicitly by the documented stages;
// failures and refused views never trigger an automatic retry or a changed acceptance threshold.
await run(a.python,['scripts/benchmark-report.py','--root',root]);
console.log('Open /experiments/benchmark/ on the local Vite server. Native generation stages are documented in its README.');
