// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, AutomationError, readJSON, atomicJSON, errorInfo, redact, inside } from './files.mjs';
import { jobDir, releaseLock } from './jobs.mjs';
import { filename } from './schema.mjs';
import { executeJob } from './runtime.mjs';

const id=process.argv[2], dir=jobDir(id);
const {kind,payload}=readJSON(path.join(dir,'request.json'));
let state=readJSON(path.join(dir,'state.json'));
const controller=new AbortController();
let events=0;
const persist=()=>{state.updatedAt=new Date().toISOString();atomicJSON(path.join(dir,'state.json'),state);};
const event=value=>{
  if(events++>=10000)return;
  fs.appendFileSync(path.join(dir,'events.ndjson'),JSON.stringify({at:new Date().toISOString(),...JSON.parse(redact(value))})+'\n',{mode:0o600});
};
for(const name of ['log','warn','error'])console[name]=(...values)=>event({type:'log',message:values.map(String).join(' ').slice(0,2000)});
const artifact=(name,data,mimeType)=>{
  filename.parse(name);const relative=`output/automation/${id}/${name}`;
  const file=inside(ROOT,relative,{exists:false});fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,data,{flag:'wx'});
  const entry={name,path:relative,mimeType,bytes:data.length,uri:`potemkin://jobs/${id}/artifacts/${name}`};
  state.artifacts.push(entry);persist();return entry;
};
state={...state,pid:process.pid,status:'running',startedAt:new Date().toISOString()};persist();
const heartbeat=setInterval(()=>{
  if(fs.existsSync(path.join(dir,'cancel.json')))controller.abort(new AutomationError('CANCELLED','Cancellation requested'));
  persist();
},500);
const timeout=setTimeout(()=>controller.abort(new AutomationError('TIMEOUT','Job exceeded timeoutSeconds')),payload.timeoutSeconds*1000);
const terminate=()=>controller.abort(new AutomationError('CANCELLED','Worker received a termination signal'));
process.on('SIGTERM',terminate);process.on('SIGINT',terminate);
try {
  if(fs.existsSync(path.join(dir,'cancel.json')))terminate();
  const result=await executeJob(kind,payload,{signal:controller.signal,event,artifact,
    progress:(step,op)=>{state.step=step+1;state.operation=op;persist();event({type:'step-start',step:step+1,op});},
    result:value=>{state.results.push(value);persist();event({type:'step-done',step:value.step,op:value.op});}});
  controller.signal.throwIfAborted();
  state.results=result;state.status='succeeded';
} catch(e) {
  const error=controller.signal.aborted?controller.signal.reason:e;
  state.error=errorInfo(error);state.status=state.error.code==='CANCELLED'?'cancelled':'failed';
} finally {
  clearInterval(heartbeat);clearTimeout(timeout);state.finishedAt=new Date().toISOString();persist();releaseLock(id);
}
