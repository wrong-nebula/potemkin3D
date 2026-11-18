// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ROOT, AutomationError, inside, readJSON, inspectGlb } from './files.mjs';
import { object, id, jobId, relativePath, workflow, planInput, screenshot, buildInput, paidSteps, jsonSchema } from './schema.mjs';
import { startJob, getJob, listJobs, cancelJob } from './jobs.mjs';
import { preflight } from './preflight.mjs';
import {
  agentPlan, agentPlanInput,
  agentApprove, agentApproveInput,
  agentAct, agentActInput,
  agentCritique, agentCritiqueInput,
  agentStatus, readAgentMemory,
} from './agent.mjs';

const empty=object({});
export const examples=['free-luxor','texture-luxor','resume-luxor'];
export function catalog(root=ROOT) {
  return fs.readdirSync(path.join(root,'samples')).filter(n=>n.endsWith('.glb')).map(n=>{
    const name=n.slice(0,-4), look=`samples/${name}.look.json`;
    return {name,path:`samples/${n}`,...(fs.existsSync(path.join(root,look))?{look}:{}),bytes:fs.statSync(path.join(root,'samples',n)).size};
  });
}
export function runInfo(run,root=ROOT) {
  id.parse(run); const file=inside(root,`runs/${run}/run.json`), m=readJSON(file);
  return {id:run,level:m.level,views:m.views?.length??0,cost:m.cost??0,seconds:m.seconds??0,
    partial:!!m.partial,lighting:m.lighting?.name,layout:m.layout?.kind,pages:m.pages,
    atlasSize:m.pages?.size??m.atlasSize??null,viewSize:m.viewSize,
    artifacts:fs.readdirSync(path.dirname(file)).filter(n=>/\.(glb|png|jpg)$/.test(n)).map(name=>({name,path:`runs/${run}/${name}`}))};
}
const command=(description,input,handler,readOnly=true)=>({description,input,handler,readOnly});
export const commands={
  doctor:command('Check Node, installed browser, local configuration and scene availability without model calls.',empty,async()=>{
    const {chromium}=await import('playwright');
    const executable=process.env.TROMPE_CHROME??chromium.executablePath();
    const {loadEnv}=await import('vite'); const configured=!!(process.env.FAL_KEY||loadEnv('development',ROOT,'FAL_').FAL_KEY);
    const localModelUrl=process.env.LOCAL_MODEL_URL||loadEnv('development',ROOT,'LOCAL_').LOCAL_MODEL_URL||null;
    const browserInstalled=fs.existsSync(executable);
    return {node:process.versions.node,nodeSupported:(Number(process.versions.node.split('.')[0])>22 || (Number(process.versions.node.split('.')[0])===22 && Number(process.versions.node.split('.')[1])>=12)),
      browserInstalled,browserSource:process.env.TROMPE_CHROME?'TROMPE_CHROME':'Playwright',falKeyConfigured:configured,localModelUrl,
      scenes:['luxor/index.html','index.html'].every(p=>fs.existsSync(path.join(ROOT,'deploy/potemkin3d',p))),
      next:browserInstalled?'Use plan, screenshot, or job-start.':'Run npx playwright install chromium or set TROMPE_CHROME to an installed Chrome.'};
  }),
  catalog:command('List bundled geometry, look files, baked walkthroughs and example workflows.',empty,()=>({samples:catalog(),scenes:['luxor','loft'],
    examples:examples.map(name=>({name,path:`examples/automation/${name}.json`,uri:`potemkin://examples/${name}`}))})),
  schema:command('Get machine-readable input schemas for workflow steps or any command.',object({name:z.string().default('workflow')}),({name})=>{
    const schema=name==='workflow'?workflow:commands[name]?.input;
    if(!schema)throw new AutomationError('NOT_FOUND','Unknown schema name');
    return {name,schema:jsonSchema(schema)};
  }),
  inspect:command('Inspect a project GLB, including UV availability and materials; no browser or API key.',object({path:relativePath}),({path:p})=>{
    if(!p.endsWith('.glb')) throw new AutomationError('INVALID_INPUT','inspect accepts .glb files');
    return {path:p,...inspectGlb(inside(ROOT,p))};
  }),
  runs:command('List saved generation runs. Baked scene bundles are not resumable generation runs.',empty,()=>{
    const dir=path.join(ROOT,'runs'); if(!fs.existsSync(dir))return {runs:[]};
    const runs=fs.readdirSync(dir).filter(n=>id.safeParse(n).success&&fs.existsSync(path.join(dir,n,'run.json')))
      .map(n=>{const {artifacts,...info}=runInfo(n);return info;}); return {runs};
  }),
  'run-info':command('Inspect saved run metadata and available exported files.',object({id}),({id})=>runInfo(id)),
  'workflow-check':command('Validate workflow inputs and project files; report paid operations without executing them.',workflow,input=>{preflight(input);return {valid:true,steps:input.steps.length,paidOperations:paidSteps(input),allowPaid:input.allowPaid};}),
  'job-start':command('Start a persistent workflow job. Poll job-status; paid operations require allowPaid=true.',workflow,input=>startJob('workflow',input),false),
  plan:command('Start a free camera-planning job for a bundled sample. Returns a job ID.',planInput,input=>{
    const sample=catalog().find(s=>s.name===input.sample);if(!sample)throw new AutomationError('NOT_FOUND','Unknown sample; use catalog');
    return startJob('workflow',{steps:[{op:'load',path:sample.path,...(sample.look?{look:sample.look}:{}),
      options:{atlasSize:input.atlas,viewSize:input.viewSize,layout:input.layout}},
      {op:'plan',options:{maxViews:input.views}}]});
  },false),
  screenshot:command('Capture the baked Luxor or loft viewer without paid calls. Returns a job ID and an image artifact on completion.',screenshot,input=>startJob('screenshot',input),false),
  build:command('Build the authoring app or both scene viewers in a background job; no model calls.',buildInput,input=>startJob('build',input),false),
  jobs:command('List the most recent 50 jobs, including terminal and interrupted work.',empty,()=>({jobs:listJobs()})),
  'job-status':command('Read job status, step results, artifact manifest and a page of progress events.',object({id:jobId,
    cursor:z.number().int().min(0).default(0),limit:z.number().int().min(0).max(100).default(25)}),({id,...opts})=>getJob(id,opts)),
  'job-cancel':command('Request cooperative cancellation. Completed files remain; an already accepted remote model call may still be billed.',object({id:jobId}),({id})=>cancelJob(id),false),
  'agent-plan':command('Planner stage of the budgeted Planner → Actor → Critic loop: emit a look file (and object brief in object mode), set coverage/seam targets under a stated budgetUsd, and stage Round 1 awaiting human approval.',agentPlanInput,input=>agentPlan(input),false),
  'agent-approve':command('Human spend-approval gate: authorize a staged Planner or Critic repair SpendProposal within the remaining session budget before agent-act executes.',agentApproveInput,input=>agentApprove(input),false),
  'agent-act':command('Actor + Critic stage: execute the approved proposal, record episodic traces in runs/<id>/episodes.ndjson, score multi-view consistency/coverage/seams/residuals, and either gate a targeted repair round or finalize export + Blender/Unreal MCP hooks.',agentActInput,input=>agentAct(input),false),
  'agent-critique':command('Run the standalone Critic on a saved run (no model calls): coverage, high-rank px/m, cross-view seam ratio, SAM/MoGe residuals, diagnostic screenshots and repair prescriptions.',agentCritiqueInput,input=>agentCritique(input),false),
  'agent-status':command('Inspect a budgeted Planner → Actor → Critic session, pending spend proposal, episodic trace and Blender/Unreal MCP hooks.',object({sessionId:jobId}),input=>agentStatus(input)),
  'agent-memory':command('Read cross-session memory of successful material presets, layouts and repair pattern score gains.',empty,()=>readAgentMemory()),
};
export async function invoke(name,input={}) {
  const spec=commands[name]; if(!spec)throw new AutomationError('UNKNOWN_COMMAND',`Unknown command: ${name}`);
  return spec.handler(spec.input.parse(input));
}
