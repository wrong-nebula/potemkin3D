// SPDX-License-Identifier: Apache-2.0
// Real local transport/GPU smoke test. All jobs keep allowPaid=false.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ROOT } from '../automation/files.mjs';

let client,transport,active,agentSessionId;
const resumeId=`automation-smoke-${randomUUID()}`;
const resumeDir=path.join(ROOT,'runs',resumeId);
const agentRunId=`agent-smoke-${randomUUID().slice(0,8)}`;
const agentRunDir=path.join(ROOT,'runs',agentRunId);
const memPath=path.join(ROOT,'.potemkin/agent-memory.json');
const hadMem=fs.existsSync(memPath);
const prevMem=hadMem?fs.readFileSync(memPath,'utf8'):null;
async function connect() {
  transport=new StdioClientTransport({command:process.execPath,args:[path.join(ROOT,'automation/mcp.mjs')],cwd:ROOT,
    env:Object.fromEntries(Object.entries(process.env).filter(([,v])=>v!==undefined)),stderr:'pipe'});
  transport.stderr?.on('data',b=>process.stderr.write(b));
  client=new Client({name:'potemkin-smoke-test',version:'1.0.0'});
  await client.connect(transport);
}
async function call(name,args={}) {
  const response=await client.callTool({name:`potemkin_${name}`,arguments:args});
  const result=response.structuredContent??JSON.parse(response.content[0].text);
  assert.equal(result.ok,true,JSON.stringify(result));return result.data;
}
async function poll(id) {
  const deadline=Date.now()+300000;let cursor=0;
  while(Date.now()<deadline) {
    const state=await call('job_status',{id,cursor,limit:100});cursor=state.nextCursor;
    if(['succeeded','failed','cancelled','interrupted'].includes(state.status))return state;
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw new Error('Smoke test job did not finish within five minutes');
}
try {
  await connect();
  const listed=await client.listTools();assert(listed.tools.some(t=>t.name==='potemkin_job_start'));
  assert(listed.tools.some(t=>t.name==='potemkin_agent_plan'));
  assert(listed.tools.some(t=>t.name==='potemkin_report'));
  assert(listed.tools.some(t=>t.name==='potemkin_doc'));
  assert.equal(listed.tools.length,23);
  assert((await call('catalog')).samples.some(s=>s.name==='luxor'));
  assert((await call('docs')).docs.some(d=>d.id==='engine'));
  assert((await client.readResource({uri:'potemkin://docs/engine'})).contents[0].text.includes('Potemkin'));
  assert((await call('inspect',{path:'samples/luxor.glb'})).primitivesWithUVs>0);
  assert((await call('schema')).schema.properties.steps);
  assert((await client.readResource({uri:'potemkin://tutorial'})).contents[0].text.includes('Luxor'));
  assert((await client.getPrompt({name:'free-luxor-tour'})).messages.length>0);
  assert((await client.getPrompt({name:'budgeted-agent-loop'})).messages.length>0);
  const rejected=await client.callTool({name:'potemkin_job_start',arguments:{steps:[{op:'run',saveAs:'smoke-never-paid'}]}});
  assert.equal(rejected.isError,true);assert.equal(rejected.structuredContent.error.code,'PAID_OPT_IN_REQUIRED');
  console.log('MCP discovery, schema, resources, prompt and paid guard passed');
  const workflow=JSON.parse((await client.readResource({uri:'potemkin://examples/free-luxor'})).contents[0].text);
  active=(await call('job_start',workflow)).id;
  await client.close();await connect(); // Detached worker must survive transport exit.
  const done=await poll(active);assert.equal(done.status,'succeeded',JSON.stringify(done.error));active=undefined;
  assert.equal(done.results.length,workflow.steps.length);
  assert(done.results.find(r=>r.op==='quote').result.estimateOnly);
  assert(done.artifacts.some(a=>a.name==='luxor-clay-test.glb'));
  assert(done.artifacts.some(a=>a.name==='report.html'));
  const repArtifact=done.artifacts.find(a=>a.name==='report.html');
  assert((await client.readResource({uri:repArtifact.uri})).contents[0].text.includes('<svg'));
  const image=done.artifacts.find(a=>a.mimeType==='image/jpeg');assert(image);
  assert((await client.readResource({uri:image.uri})).contents[0].blob.length>100);
  const exported=done.artifacts.find(a=>a.name==='luxor-clay-test.glb');
  assert.equal(fs.readFileSync(path.join(ROOT,exported.path)).toString('ascii',0,4),'glTF');
  console.log('Free Luxor workflow, reconnection, quote, image resource and GLB passed');
  active=(await call('screenshot',{scene:'luxor',width:960,height:540})).id;
  const shot=await poll(active);assert.equal(shot.status,'succeeded',JSON.stringify(shot.error));active=undefined;
  assert(shot.artifacts[0].bytes>1000);console.log(`Luxor screenshot passed: ${shot.artifacts[0].path}`);
  active=(await call('job_start',workflow)).id;
  const busy=await client.callTool({name:'potemkin_screenshot',arguments:{scene:'luxor'}});
  assert.equal(busy.structuredContent.error.code,'BUSY');
  assert((await call('job_cancel',{id:active})).cancelRequested);
  const cancelled=await poll(active);assert.equal(cancelled.status,'cancelled',JSON.stringify(cancelled.error));active=undefined;
  console.log('Concurrent-job guard and cancellation passed');
  active=(await call('job_start',{steps:[{op:'load',path:'samples/courtyard.glb',options:{atlasSize:512,viewSize:256}},{op:'measure'}]})).id;
  const failed=await poll(active);assert.equal(failed.status,'failed');assert.match(failed.error.message,/load a run first/);active=undefined;
  console.log('Engine errors propagate into terminal job state');
  // A synthetic empty record exercises restoration/saving without generating paid textures.
  fs.mkdirSync(resumeDir,{recursive:true});
  fs.writeFileSync(path.join(resumeDir,'run.json'),JSON.stringify({level:'courtyard',atlasSize:512,viewSize:256,
    lighting:{name:'overcast'},options:{},cost:0,seconds:0,views:[],plan:{points:[],views:[],waves:[],predicted:[]}}));
  active=(await call('job_start',{steps:[{op:'loadRun',id:resumeId},{op:'save',id:resumeId},{op:'export',output:'restored.glb'}]})).id;
  const resumed=await poll(active);assert.equal(resumed.status,'succeeded',JSON.stringify(resumed.error));active=undefined;
  const run=await call('run_info',{id:resumeId});assert.equal(run.atlasSize,512);assert.equal(run.viewSize,256);
  assert(run.artifacts.some(a=>a.name==='level_textured.glb'));
  console.log('Saved-run restoration and atlas/view resolution round-trip passed');

  // End-to-end Planner → Actor → Critic loop over MCP under a stated $0.25 budget (allowPaid=false via local procedural backend)
  const planned=await call('agent_plan',{
    path:'samples/courtyard.glb',
    runId:agentRunId,
    atlasSize:512,
    viewSize:256,
    initialViews:2,
    maxRepairRounds:1,
    budgetUsd:0.25,
    unitCallCostUsd:0.02,
    targetSeenPainted:0.9,
    provider:'local',
    localBackend:'procedural',
  });
  agentSessionId=planned.sessionId;
  assert.equal(planned.status,'awaiting-approval');
  assert.equal(planned.budget.statedUsd,0.25);

  // Actor must block until human approves Round 1 spend
  const unapproved=await client.callTool({name:'potemkin_agent_act',arguments:{sessionId:agentSessionId}});
  assert.equal(unapproved.isError,true);
  assert.equal(unapproved.structuredContent.error.code,'APPROVAL_REQUIRED');

  await call('agent_approve',{sessionId:agentSessionId,proposalId:planned.pendingProposal.id,approvedBy:'mcp-smoke'});
  const round1=await call('agent_act',{sessionId:agentSessionId});
  assert.equal(round1.critique.verdict,'needs-repair');
  assert(round1.pendingProposal&&round1.pendingProposal.kind==='repair','Critic should gate a targeted repair round');
  assert.equal(round1.status,'awaiting-approval');

  // Human approves the Critic-gated repair proposal; Round 2 repairs, refines, generates PBR and exports GLB within budget
  await call('agent_approve',{sessionId:agentSessionId,proposalId:round1.pendingProposal.id,approvedBy:'mcp-smoke'});
  const round2=await call('agent_act',{sessionId:agentSessionId});
  assert.equal(round2.status,'completed',`status=${round2.status}`);
  assert(round2.budget.spentUsd>0&&round2.budget.spentUsd<=0.25,`spentUsd=${round2.budget.spentUsd}`);
  assert(round2.critique.metrics.seenPainted>round1.critique.metrics.seenPainted,'Repair round must increase player-visible paint coverage');
  assert(round2.critique.score>round1.critique.score,'Repair round must raise Critic score');
  assert((round2.exportArtifacts??[]).some(a=>a.name===`${agentRunId}.glb`),`exportArtifacts=${JSON.stringify(round2.exportArtifacts)}`);
  assert.equal(round2.externalHooks.blenderMcp.server,'blender-mcp');
  assert.equal(round2.externalHooks.unrealMcp.server,'unreal-mcp');
  assert(fs.existsSync(path.join(agentRunDir,'episodes.ndjson')),'missing episodes.ndjson');
  assert(fs.existsSync(path.join(agentRunDir,'look.plan.json')),'missing look.plan.json');
  assert(fs.existsSync(path.join(agentRunDir,'report.html')),'missing runs/<id>/report.html');
  assert((await client.readResource({uri:`potemkin://agent/sessions/${agentSessionId}/report`})).contents[0].text.includes('mermaid'));
  const mem=JSON.parse((await client.readResource({uri:'potemkin://agent/memory'})).contents[0].text);
  assert(mem.successfulConfigs.some(c=>c.runId===agentRunId),`missing ${agentRunId} in memory`);
  console.log(`Budgeted Planner → Actor → Critic MCP E2E passed: score ${round1.critique.score} → ${round2.critique.score}, seen ${(100*round1.critique.metrics.seenPainted).toFixed(1)}% → ${(100*round2.critique.metrics.seenPainted).toFixed(1)}%, spent $${round2.budget.spentUsd.toFixed(2)}/$0.25`);
} finally {
  if(active&&client)await call('job_cancel',{id:active}).catch(()=>{});
  await client?.close();
  if(!active)fs.rmSync(resumeDir,{recursive:true,force:true});
  fs.rmSync(agentRunDir,{recursive:true,force:true});
  if(agentSessionId)fs.rmSync(path.join(ROOT,'.potemkin/sessions',agentSessionId),{recursive:true,force:true});
  if(hadMem)fs.writeFileSync(memPath,prevMem);else fs.rmSync(memPath,{force:true});
}
