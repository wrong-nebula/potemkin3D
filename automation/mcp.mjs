#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { commands, invoke, examples } from './commands.mjs';
import { ROOT, errorInfo, redact, AutomationError } from './files.mjs';
import { workflow, jsonSchema } from './schema.mjs';
import { getJob, listJobs, artifact } from './jobs.mjs';

const resultSchema=z.object({version:z.literal(1),ok:z.boolean(),data:z.unknown().optional(),error:z.unknown().optional()});
export function createServer() {
  const server=new McpServer({name:'potemkin3d',version:'0.2.0'},
    {instructions:'Start with potemkin_doctor and potemkin_catalog. Long commands return a job ID; poll potemkin_job_status with its cursor. Read potemkin://tutorial for a free walkthrough. Paid model calls require explicit allowPaid=true. Never pass API keys in tool arguments.'});
  for(const [name,spec]of Object.entries(commands))server.registerTool(`potemkin_${name.replaceAll('-','_')}`,{
    description:spec.description,inputSchema:spec.input,outputSchema:resultSchema,
    annotations:{readOnlyHint:spec.readOnly,destructiveHint:false,idempotentHint:spec.readOnly,openWorldHint:name==='job-start'},
  },async args=>{
    let result;
    try{result={version:1,ok:true,data:await invoke(name,args)};}
    catch(e){result={version:1,ok:false,error:errorInfo(e)};}
    result=JSON.parse(redact(result));
    return {isError:!result.ok,structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]};
  });
  for(const [name,file]of [['tutorial','docs/TUTORIAL.md'],['automation-reference','docs/AUTOMATION.md']]) {
    server.registerResource(name,`potemkin://${name}`,{mimeType:'text/markdown',description:`Potemkin ${name}`},uri=>({contents:[{uri:uri.href,mimeType:'text/markdown',text:fs.readFileSync(path.join(ROOT,file),'utf8')}]}));
  }
  server.registerResource('workflow-schema','potemkin://schema/workflow',{mimeType:'application/json'},uri=>({contents:[{uri:uri.href,mimeType:'application/json',text:JSON.stringify(jsonSchema(workflow))}]}));
  server.registerResource('example',new ResourceTemplate('potemkin://examples/{name}',{
    list:async()=>({resources:examples.map(name=>({uri:`potemkin://examples/${name}`,name,mimeType:'application/json'}))})}),
    {mimeType:'application/json'},(uri,{name})=>{
      if(!examples.includes(name))throw new AutomationError('NOT_FOUND','Unknown example workflow');
      return {contents:[{uri:uri.href,mimeType:'application/json',text:fs.readFileSync(path.join(ROOT,`examples/automation/${name}.json`),'utf8')}]};
    });
  server.registerResource('job',new ResourceTemplate('potemkin://jobs/{id}',{list:async()=>({resources:listJobs().map(j=>({uri:`potemkin://jobs/${j.id}`,name:`${j.kind}: ${j.status}`,mimeType:'application/json'}))})}),
    {mimeType:'application/json'},(uri,{id})=>({contents:[{uri:uri.href,mimeType:'application/json',text:redact(getJob(id))}]}));
  server.registerResource('job-artifact',new ResourceTemplate('potemkin://jobs/{id}/artifacts/{name}',{list:undefined}),{},(uri,{id,name})=>{
    const entry=artifact(id,name);
    if(entry.bytes>8*1024*1024)throw new AutomationError('ARTIFACT_TOO_LARGE',`Read the local artifact at ${entry.path}; MCP inline reads are limited to 8 MiB`);
    const data=fs.readFileSync(entry.file);
    return {contents:[{uri:uri.href,mimeType:entry.mimeType,...(entry.mimeType==='application/json'?{text:redact(data.toString())}:{blob:data.toString('base64')})}]};
  });
  server.registerPrompt('free-luxor-tour',{description:'Inspect, plan, render and export Luxor without paid generation.'},()=>({messages:[{role:'user',content:{type:'text',text:'Read potemkin://tutorial and potemkin://examples/free-luxor. Run the example using potemkin_job_start, poll to completion, then run potemkin_screenshot for Luxor and show its image artifact. Keep allowPaid=false. Explain that selfTest paints clay views rather than generating textures.'}}]}));
  return server;
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
  const handle=serveStdio(createServer,{onerror:e=>process.stderr.write(redact(e.message)+'\n')});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void handle.close().then(()=>process.exit(0));});
}
