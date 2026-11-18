// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ROOT, inside, inspectGlb, atomicJSON, redact } from '../automation/files.mjs';
import { workflow, paidSteps, jsonSchema, relativePath, localUrl } from '../automation/schema.mjs';
import { startJob, getJob, cancelJob, artifact } from '../automation/jobs.mjs';
import { preflight } from '../automation/preflight.mjs';
import { parseCLI } from '../automation/cli.mjs';
const dirs=[];
const temp=()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'potemkin-test-'));dirs.push(d);return d;};
afterEach(()=>{for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});});
const fakeSpawn=()=>Object.assign(new EventEmitter(),{pid:process.pid,unref(){}});

describe('automation boundaries',()=>{
  it('rejects unknown fields, arbitrary operations and traversal',()=>{
    expect(()=>workflow.parse({steps:[{op:'eval',code:'x'}]})).toThrow();
    expect(()=>workflow.parse({steps:[{op:'bounds'}],falKey:'secret'})).toThrow();
    for(const p of ['../file','/tmp/file','foo/../file','C:\\file','a//b'])expect(relativePath.safeParse(p).success).toBe(false);
    expect(()=>workflow.parse({steps:[{op:'load',path:'samples/luxor.glb',options:{layout:'near',cavity:1}}]})).toThrow();
    expect(workflow.parse({steps:[{op:'load',path:'samples/luxor.glb',options:{layout:'near',cavity:0.7,weights:true,paths:true,mode:'object'}},{op:'paths'},{op:'weights',overlay:'paths'},{op:'plan',options:{maxViews:24,adaptive:true,objective:'fisher',geodesic:true,mode:'object',focusParts:['barrel','face']}},{op:'consolidate',options:{size:1024,flow:true,lambda:0.02}},{op:'uvRefine',options:{size:1024,delight:0.85,sharpen:0.45}},{op:'materialPresets',assignments:{hull:'hard-surface',barrel:'metal',tarp:'fabric',head:'organic'}},{op:'snapshot',camera:{position:[0,2,5],target:[0,1,0],weights:'paths'}}]}).steps.length).toBe(8);
    expect(jsonSchema(workflow).properties.steps.items.oneOf.length).toBeGreaterThan(30);
  });
  it('requires explicit paid opt-in before any worker starts, while allowing strict $0 local runs',()=>{
    const input={steps:[{op:'run',saveAs:'test'}]};
    expect(paidSteps(workflow.parse(input))).toEqual(['run']);
    expect(()=>startJob('workflow',input,{root:temp(),spawnWorker:()=>{throw Error('spawned');}})).toThrow(/allowPaid/);
    expect(paidSteps(workflow.parse({steps:[{op:'props',saveAs:'test',options:{dry:true}},{op:'ground',saveAs:'test',options:{reuse:true}},{op:'selfTest'}]}))).toEqual([]);
    expect(paidSteps(workflow.parse({steps:[{op:'checkRun',id:'test',planes:true},{op:'pbr'}]}))).toEqual(['checkRun','pbr']);
    // Strict local provider ($0 paint, no cloud fallback) requires no paid opt-in; cloud fallback still requires allowPaid
    expect(paidSteps(workflow.parse({steps:[{op:'provider',options:{provider:'local',localBackend:'comfyui',localUrl:'http://127.0.0.1:8188'}},{op:'run',saveAs:'local-run'},{op:'parts',saveAs:'local-run'},{op:'pbr',options:{mode:'intrinsic'}},{op:'exportPbr',options:{format:'both'}}]}))).toEqual([]);
    expect(paidSteps(workflow.parse({steps:[{op:'run',saveAs:'hybrid-run',options:{provider:'local',providerFallback:'fal'}}]}))).toEqual(['run']);
    for(const bad of ['http://169.254.169.254:8000','https://evil.example:8188','ftp://127.0.0.1:8188'])expect(localUrl.safeParse(bad).success).toBe(false);
    for(const ok of ['http://127.0.0.1:8188','http://localhost:8000','http://[::1]:8081'])expect(localUrl.safeParse(ok).success).toBe(true);
  });
  it('rejects existing and dangling symlink escapes',()=>{
    const root=temp(),outside=temp();
    fs.symlinkSync(outside,path.join(root,'escape'));
    fs.symlinkSync(path.join(outside,'missing'),path.join(root,'dangling'));
    expect(()=>inside(root,'escape/new',{exists:false})).toThrow(/symlink/);
    expect(()=>inside(root,'dangling',{exists:false})).toThrow(/symlink/);
    expect(inside(root,'safe/new',{exists:false})).toBe(path.join(fs.realpathSync(root),'safe/new'));
  });
  it('checks files and ordering before browser startup',()=>{
    expect(()=>preflight({steps:[{op:'bounds'}]},temp())).toThrow(/needs load/);
    expect(()=>preflight({steps:[{op:'load',path:'missing.glb'}]},temp())).toThrow(/Missing/);
    expect(()=>preflight({steps:[{op:'load',path:'samples/luxor.glb'},{op:'quote'}]})).toThrow(/plan first/);
    expect(preflight(JSON.parse(fs.readFileSync(path.join(ROOT,'examples/automation/free-luxor.json')))).steps.length).toBe(6);
  });
  it('inspects GLB geometry without loading a browser',()=>{
    const info=inspectGlb(path.join(ROOT,'samples/luxor.glb'));
    expect(info.primitives).toBeGreaterThan(0);expect(info.primitivesWithUVs).toBe(info.primitives);
    const bad=path.join(temp(),'bad.glb');fs.writeFileSync(bad,'glTF');expect(()=>inspectGlb(bad)).toThrow(/glTF/);
  });
  it('redacts home paths and configured credentials',()=>{
    expect(redact(path.join(os.homedir(),'project'))).not.toContain(os.homedir());
    const previous=process.env.FAL_KEY;process.env.FAL_KEY='test-secret-value';
    try{expect(redact({message:'test-secret-value'})).not.toContain('test-secret-value');}
    finally{if(previous===undefined)delete process.env.FAL_KEY;else process.env.FAL_KEY=previous;}
  });
});
describe('persistent jobs',()=>{
  it('serializes writers, requests cancellation and reclaims a completed lock',()=>{
    const root=temp();const job=startJob('build',{}, {root,spawnWorker:fakeSpawn});
    expect(getJob(job.id,{root}).status).toBe('queued');
    expect(()=>startJob('build',{}, {root,spawnWorker:fakeSpawn})).toThrow(/active/);
    expect(cancelJob(job.id,root).cancelRequested).toBe(true);
    const file=path.join(root,'.potemkin/jobs',job.id,'state.json');
    atomicJSON(file,{...getJob(job.id,{root}),status:'succeeded'});
    expect(startJob('build',{}, {root,spawnWorker:fakeSpawn}).id).not.toBe(job.id);
  });
  it('recovers abandoned jobs and paginates progress without exposing PIDs',()=>{
    const root=temp(),id=randomUUID(),dir=path.join(root,'.potemkin/jobs',id);
    atomicJSON(path.join(dir,'state.json'),{id,status:'queued',createdAt:'2000-01-01T00:00:00Z',updatedAt:'2000-01-01T00:00:00Z',artifacts:[]});
    fs.writeFileSync(path.join(dir,'events.ndjson'),' {"step":1}\n{"step":2}\n');
    const state=getJob(id,{root,limit:1});expect(state.status).toBe('interrupted');expect(state.events).toEqual([{step:1}]);expect(state.hasMore).toBe(true);expect(state).not.toHaveProperty('pid');
    expect(getJob(id,{root,cursor:state.nextCursor}).events).toEqual([{step:2}]);
    expect(()=>artifact(id,'unlisted.png',root)).toThrow(/manifest/);
  });
});
describe('CLI contract',()=>{
  it('parses nested JSON and rejects missing values',()=>{
    expect(parseCLI(['plan','--views','4','--wait','--json']).input).toEqual({views:4});
    expect(parseCLI(['job-start','--input','{"steps":[{"op":"bounds"}]}','--allow-paid','true']).input.allowPaid).toBe(true);
    expect(()=>parseCLI(['plan','--views','--json'])).toThrow(/Missing value/);
  });
  it('works outside the repository with one JSON envelope and useful exit codes',()=>{
    const cli=path.join(ROOT,'automation/cli.mjs');
    const good=spawnSync(process.execPath,[cli,'catalog','--json'],{cwd:temp(),encoding:'utf8'});
    expect(good.status).toBe(0);expect(good.stderr).toBe('');expect(JSON.parse(good.stdout).data.samples.some(s=>s.name==='luxor')).toBe(true);
    const bad=spawnSync(process.execPath,[cli,'plan','--typo','1','--json'],{encoding:'utf8'});
    expect(bad.status).toBe(2);expect(JSON.parse(bad.stdout).error.code).toBe('INVALID_INPUT');
  });
});
