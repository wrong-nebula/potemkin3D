#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { commands, invoke } from './commands.mjs';
import { workflow, jsonSchema } from './schema.mjs';
import { getJob, terminal } from './jobs.mjs';
import { AutomationError, errorInfo, redact } from './files.mjs';

export function parseCLI(args) {
  const [command='help',...rest]=args;
  const input={};let json=false,wait=false,timeout=1800;
  for(let i=0;i<rest.length;i++) {
    const token=rest[i];
    if(token==='--json'){json=true;continue;}
    if(token==='--wait'){wait=true;continue;}
    if(token==='--help')return {command:'help',input:{name:command},json};
    if(!token.startsWith('--')) {
      if(command==='help'&&!input.name){input.name=token;continue;}
      throw new AutomationError('INVALID_INPUT',`Unexpected argument: ${token}`);
    }
    const equal=token.indexOf('=');const flag=equal<0?token:token.slice(0,equal);
    let raw=equal<0?rest[++i]:token.slice(equal+1);
    if(raw===undefined||raw.startsWith('--'))throw new AutomationError('INVALID_INPUT',`Missing value for ${flag}`);
    if(flag==='--input') {
      let parsed;
      try{parsed=JSON.parse(raw==='-'?fs.readFileSync(0,'utf8'):raw.startsWith('@')?fs.readFileSync(raw.slice(1),'utf8'):raw);}
      catch{throw new AutomationError('INVALID_INPUT','--input must contain JSON, @file.json, or - for stdin');}
      if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw new AutomationError('INVALID_INPUT','Command input must be an object');
      Object.assign(input,parsed);continue;
    }
    if(flag==='--wait-timeout') {timeout=Number(raw);if(!Number.isFinite(timeout)||timeout<=0)throw new AutomationError('INVALID_INPUT','Invalid wait timeout');continue;}
    const key=flag.slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
    // Numeric IDs and paths stay strings; numeric/boolean options and nested JSON retain their types.
    if(!['id','path','sample','name','target','scene','output'].includes(key)) {
      try{raw=JSON.parse(raw);}catch{}
    }
    input[key]=raw;
  }
  return {command:command==='--help'?'help':command,input,json,wait,timeout};
}
function help(name) {
  if(name) {
    if(name==='workflow')return {name,schema:jsonSchema(workflow)};
    if(!commands[name])throw new AutomationError('UNKNOWN_COMMAND','Unknown command');
    return {name,description:commands[name].description,schema:jsonSchema(commands[name].input)};
  }
  return {usage:'potemkin <command> [--input JSON|@file|-] [--field value] [--json] [--wait]',
    commands:Object.fromEntries(Object.entries(commands).map(([name,s])=>[name,s.description])),
    examples:['potemkin doctor --json','potemkin plan --sample luxor --views 4 --wait --json',
      'potemkin job-start --input @examples/automation/free-luxor.json --wait --json',
      'potemkin screenshot --scene luxor --wait --json'],
    wait:'--wait polls a returned job ID. --wait-timeout limits only client waiting; the job continues. Ctrl-C stops waiting, not the job.'};
}
export async function main(args=process.argv.slice(2)) {
  let json=args.includes('--json');
  try {
    const parsed=parseCLI(args);json=parsed.json;
    let data=parsed.command==='help'?help(parsed.input.name):await invoke(parsed.command,parsed.input);
    if(parsed.wait) {
      if(!data.id)throw new AutomationError('INVALID_INPUT','--wait requires a job-producing command or job-status');
      const deadline=Date.now()+parsed.timeout*1000;let cursor=0;
      for(;;) {
        data=getJob(data.id,{cursor,limit:100});
        for(const e of data.events)process.stderr.write(redact(JSON.stringify(e))+'\n');
        cursor=data.nextCursor;
        if(terminal.has(data.status))break;
        if(Date.now()>deadline)throw new AutomationError('WAIT_TIMEOUT',`Job ${data.id} is still running; poll job-status or cancel it explicitly`);
        await new Promise(resolve=>setTimeout(resolve,500));
      }
      if(data.status!=='succeeded')process.exitCode=data.status==='cancelled'?130:1;
    }
    const output={version:1,ok:!process.exitCode,data};
    process.stdout.write(redact(JSON.stringify(output,null,json?0:2))+'\n');
  } catch(error) {
    const info=errorInfo(error);process.exitCode=['INVALID_INPUT','UNKNOWN_COMMAND','PAID_OPT_IN_REQUIRED','INVALID_PATH'].includes(info.code)?2:1;
    process.stdout.write(redact(JSON.stringify({version:1,ok:false,error:info},null,json?0:2))+'\n');
  }
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url))await main();
