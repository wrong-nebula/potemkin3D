// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT, AutomationError, inside, readJSON, atomicJSON } from './files.mjs';
import { jobId, filename, workflow, screenshot, buildInput, paidSteps } from './schema.mjs';
import { preflight } from './preflight.mjs';

export const terminal = new Set(['succeeded','failed','cancelled','interrupted']);
export const store = (root=ROOT) => inside(root,'.potemkin/jobs',{exists:false});
export const jobDir = (id,root=ROOT) => { jobId.parse(id); return inside(root,`.potemkin/jobs/${id}`,{exists:false}); };
const lockFile = (root=ROOT) => inside(root,'.potemkin/active.json',{exists:false});
const alive = pid => { try { process.kill(pid,0); return true; } catch(e) { return e.code!=='ESRCH'; } };
export function releaseLock(id,root=ROOT) {
  const file=lockFile(root);
  try {
    if (fs.existsSync(file) && readJSON(file).id===id) fs.unlinkSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}
export function getJob(id, { cursor=0, limit=25, root=ROOT } = {}) {
  const dir=jobDir(id,root), file=path.join(dir,'state.json');
  if (!fs.existsSync(file)) throw new AutomationError('NOT_FOUND','Unknown job ID');
  let state=readJSON(file);
  if (!terminal.has(state.status)) {
    const owner=path.join(dir,'owner.json');
    const pid=state.pid??(fs.existsSync(owner)?readJSON(owner).pid:undefined);
    if ((pid && !alive(pid)) || (!pid && Date.now()-Date.parse(state.createdAt)>60000)) {
      state={...state,status:'interrupted',finishedAt:new Date().toISOString(),error:{code:'WORKER_LOST',message:'Worker stopped; inspect saved runs before resuming'}};
      atomicJSON(file,state); releaseLock(id,root);
    }
  }
  if(terminal.has(state.status))releaseLock(id,root);
  const eventsFile=path.join(dir,'events.ndjson');
  const lines=fs.existsSync(eventsFile)?fs.readFileSync(eventsFile,'utf8').trim().split('\n').filter(Boolean):[];
  const events=lines.slice(cursor,cursor+limit).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  const {pid,...publicState}=state;
  return {...publicState,cancelRequested:fs.existsSync(path.join(dir,'cancel.json')),
    stale:!terminal.has(state.status)&&Date.now()-Date.parse(state.updatedAt)>30000,
    events,nextCursor:Math.min(lines.length,cursor+limit),hasMore:cursor+limit<lines.length};
}
export function listJobs(root=ROOT) {
  if (!fs.existsSync(store(root))) return [];
  return fs.readdirSync(store(root)).filter(n=>jobId.safeParse(n).success).map(id=>getJob(id,{root,limit:0}))
    .sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,50).map(({events,results,...s})=>s);
}
export function cancelJob(id,root=ROOT) {
  const state=getJob(id,{root,limit:0});
  if (!terminal.has(state.status)) atomicJSON(path.join(jobDir(id,root),'cancel.json'),{requestedAt:new Date().toISOString()});
  return {id,status:state.status,cancelRequested:!terminal.has(state.status)};
}
export function startJob(kind, input, { root=ROOT, spawnWorker=spawn } = {}) {
  const payload=({workflow,screenshot,build:buildInput}[kind]).parse(input);
  if (kind==='workflow') {
    const paid=paidSteps(payload);
    if (paid.length && !payload.allowPaid) throw new AutomationError('PAID_OPT_IN_REQUIRED',`These operations can call paid models: ${[...new Set(paid)].join(', ')}. Set allowPaid explicitly.`);
    preflight(payload,root);
  }
  const lock=lockFile(root); fs.mkdirSync(path.dirname(lock),{recursive:true,mode:0o700});
  if (fs.existsSync(lock)) {
    const active=readJSON(lock); getJob(active.id,{root,limit:0});
  }
  const id=randomUUID();
  try { fs.writeFileSync(lock,JSON.stringify({id}),{flag:'wx',mode:0o600}); }
  catch(e) { if(e.code==='EEXIST') throw new AutomationError('BUSY',`Another GPU/build job is active: ${readJSON(lock).id}`); throw e; }
  const dir=jobDir(id,root), now=new Date().toISOString();
  const state={version:1,id,kind,status:'queued',createdAt:now,updatedAt:now,step:0,total:kind==='workflow'?payload.steps.length:1,results:[],artifacts:[]};
  try {
    atomicJSON(path.join(dir,'request.json'),{kind,payload}); atomicJSON(path.join(dir,'state.json'),state);
    const child=spawnWorker(process.execPath,[path.join(root,'automation/worker.mjs'),id],
      {cwd:root,detached:true,stdio:'ignore',env:{...process.env}});
    atomicJSON(path.join(dir,'owner.json'),{pid:child.pid});
    child.on('error',()=>{atomicJSON(path.join(dir,'state.json'),{...state,status:'failed',error:{code:'SPAWN_FAILED',message:'Could not start the worker'}});releaseLock(id,root);});
    child.unref();
    return {id,status:'queued',kind,statusCommand:`potemkin job-status --id ${id}`,resource:`potemkin://jobs/${id}`};
  } catch(e) { releaseLock(id,root); throw e; }
}
export function artifact(id,name,root=ROOT) {
  filename.parse(name);
  const state=getJob(id,{root,limit:0});
  const entry=state.artifacts.find(a=>a.name===name);
  if (!entry) throw new AutomationError('NOT_FOUND','Artifact is not in this job manifest');
  return {...entry,file:inside(root,entry.path)};
}
