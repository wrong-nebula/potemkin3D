// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { ROOT, AutomationError, inside, readJSON } from './files.mjs';
import { pipelineOptions, filename } from './schema.mjs';

export async function executeJob(kind,input,ctx) {
  let browser,server,child;
  const close=async()=>{
    if(child&&child.exitCode===null&&child.signalCode===null) {
      if(process.platform==='win32')spawn('taskkill.exe',['/pid',String(child.pid),'/t','/f'],{stdio:'ignore'});
      else {try{process.kill(-child.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}}
    }
    await browser?.close().catch(()=>{}); await server?.close();
  };
  const abort=()=>{void close().catch(()=>{});};
  ctx.signal.addEventListener('abort',abort,{once:true});
  try {
    ctx.signal.throwIfAborted();
    if(kind==='build') {
      ctx.progress(0,'build');
      const file=input.target==='scenes'?'scripts/build-potemkin.mjs':'node_modules/vite/bin/vite.js';
      await new Promise((resolve,reject)=>{
        child=spawn(process.execPath,[path.join(ROOT,file),...(input.target==='author'?['build']:[])],{cwd:ROOT,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
        for(const stream of [child.stdout,child.stderr])stream.on('data',b=>ctx.event({type:'build-log',message:b.toString().slice(0,2000)}));
        child.on('error',reject);child.on('exit',(code,signal)=>code===0?resolve():reject(new AutomationError('BUILD_FAILED',`Build exited with ${code??signal}`)));
      });
      return [{target:input.target,directory:input.target==='scenes'?'dist-potemkin':'dist'}];
    }
    const {launchBrowser,openApp}=await import('../scripts/browser.mjs');
    if(kind==='screenshot') {
      ctx.progress(0,'screenshot');
      const base=inside(ROOT,'deploy/potemkin3d');
      const native=http.createServer((req,res)=>{
        try {
          let relative=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\//,'')||'index.html';
          if(relative.endsWith('/'))relative+='index.html';
          const file=inside(base,relative);
          const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.glb':'model/gltf-binary','.woff2':'font/woff2'}[path.extname(file)]??'application/octet-stream';
          res.setHeader('content-type',mime);fs.createReadStream(file).on('error',()=>res.destroy()).pipe(res);
        } catch {res.statusCode=404;res.end('Not found');}
      });
      await new Promise((resolve,reject)=>{native.once('error',reject);native.listen(0,'127.0.0.1',resolve);});
      server={close:()=>new Promise(resolve=>{native.closeAllConnections();native.close(resolve);})};
      browser=await launchBrowser();ctx.signal.throwIfAborted();
      const page=await browser.newPage({viewport:{width:input.width,height:input.height}});
      const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(`http://127.0.0.1:${native.address().port}/${input.scene==='luxor'?'luxor/':''}?res=0.75&ratio=1&tex=4k&maps=4k`);
      await page.waitForFunction(()=>!!(window.luxorView?.ready()||window.demo),null,{timeout:90000});
      if(input.scene==='luxor')await page.keyboard.press(String(input.preset));
      if(!input.hud)await page.evaluate(()=>{for(const el of document.querySelectorAll('#hud,.potemkin-menu-trigger,.potemkin-notes-ui'))el.style.display='none';});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      if(errors.length)throw new AutomationError('VIEWER_ERROR',errors.join('; '));
      return [ctx.artifact(`${input.scene}.png`,await page.screenshot(), 'image/png')];
    }
    const {createServer}=await import('vite');
    server=await createServer({root:ROOT,logLevel:'silent',server:{host:'127.0.0.1',port:0,hmr:false,watch:null}});
    await server.listen();ctx.signal.throwIfAborted();
    browser=await launchBrowser();ctx.signal.throwIfAborted();
    const url=server.resolvedUrls.local[0];
    // This is a second boundary beyond step classification: free workflows cannot reach paid providers.
    const context=await browser.newContext({viewport:{width:1280,height:720},serviceWorkers:'block'});
    await context.route('**/*',route=>{
      const u=new URL(route.request().url());
      if(!input.allowPaid && (/\/api\/fal\//.test(u.pathname)||/(^|\.)fal\.(ai|run|media)$/.test(u.hostname)))return route.abort('blockedbyclient');
      return route.continue();
    });
    const page=await openApp(context,url,{onEvent:ctx.event,onLog:message=>ctx.event({type:'browser-log',message})});
    let loaded=false,currentRun,defaults={};
    const results=[];
    for(let index=0;index<input.steps.length;index++) {
      ctx.signal.throwIfAborted();
      const step=input.steps[index];ctx.progress(index,step.op);
      let args=[],method=step.op;
      if(step.op==='load') {
        const look=step.look?readJSON(inside(ROOT,step.look)):{};
        const file=step.path??look.level;
        if(typeof file!=='string'||!file.endsWith('.glb'))throw new AutomationError('INVALID_INPUT','load needs a GLB path or a look file with a GLB level');
        inside(ROOT,file);
        defaults=pipelineOptions.parse(Object.fromEntries(Object.entries(look).filter(([k])=>Object.hasOwn(pipelineOptions.shape,k))));
        args=['/'+file.split('/').map(encodeURIComponent).join('/'),{lighting:look.lighting??'overcast',atlasSize:look.atlas??1024,viewSize:512,...step.options}];loaded=true;currentRun=undefined;
      } else if(step.op==='loadRun') {
        const meta=readJSON(inside(ROOT,`runs/${step.id}/run.json`));
        if(!loaded) {
          const file=`samples/${meta.level}.glb`;inside(ROOT,file);
          await page.evaluate(async({file,meta})=>window.trompe.load('/'+file.split('/').map(encodeURIComponent).join('/'),{lighting:meta.lighting?.name??'overcast',
            atlasSize:meta.pages?.size??meta.atlasSize??4096,viewSize:meta.viewSize??1024,layout:meta.layout?.kind??'file',area:meta.area,pages:meta.pages?.count??1,
            unwrap:meta.unwrap?.reason==='asked'?'always':'auto',cavity:meta.layout?.cavity??0,weights:!!(meta.layout?.weights??meta.weights),paths:!!(meta.layout?.paths??meta.paths),mode:meta.mode??'auto'}),{file,meta});
          loaded=true;
        }
        currentRun=step.id;defaults=meta.options??{};args=[step.id];
      } else if(step.op==='loadSentoFloor') {loaded=true;currentRun=undefined;}
      else if(step.op!=='provider' && !loaded)throw new AutomationError('INVALID_WORKFLOW',`${step.op} needs load, loadRun or loadSentoFloor first`);
      if(step.saveAs && fs.existsSync(path.join(ROOT,'runs',step.saveAs)) && (step.op==='run'||step.saveAs!==currentRun))
        throw new AutomationError('RUN_EXISTS','Run ID already exists; use loadRun and topUp to resume it');
      if(['run','topUp'].includes(step.op))args=[{...defaults,...step.options,plan:{...defaults.plan,...step.options?.plan}},undefined,step.saveAs];
      else if(['parts','ground','props'].includes(step.op))args=[step.options??{},undefined,step.saveAs];
      else if(step.op==='repair')args=[step.regions,undefined,step.saveAs,step.dry??false];
      else if(step.op==='groundNotes')args=[step.notes,undefined,step.saveAs];
      else if(step.op==='nameParts')args=[step.style??defaults.style];
      else if(['provider','plan','quote','projection','consolidate','uvRefine','ao','pbr','exportPbr','materialMaps','pick','promptTest','critique'].includes(step.op))args=[step.options??{}];
      else if(step.op==='walk')args=[step.options===null?null:step.options??{}];
      else if(step.op==='floorDetail')args=[step.options??undefined];
      else if(step.op==='materialPresets')args=[step.assignments];
      else if(step.op==='floorDetailEnabled')args=[step.enabled];
      else if(step.op==='checkRun')args=[step.id,step.threshold,step.planes??false,step.cells??false];
      else if(step.op==='validate')args=[step.id,step.options??{}];
      else if(step.op==='save') {
        if(fs.existsSync(path.join(ROOT,'runs',step.id))&&step.id!==currentRun)throw new AutomationError('RUN_EXISTS','Refusing to replace a different saved run');
        args=[step.id];
      } else if(step.op==='snapshot')args=[step.camera];
      else if(step.op==='weights')args=step.overlay?[step.overlay]:[];
      else if(step.op==='selfTest')args=[step.views??2];
      let value;
      if(step.op==='export') {
        const encoded=await page.evaluate(async()=>{
          const bytes=new Uint8Array(await window.trompe.exportGlb());let binary='';
          for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
          return btoa(binary);
        });
        value=ctx.artifact(step.output??`step-${index+1}.glb`,Buffer.from(encoded,'base64'),'model/gltf-binary');
      } else {
        // Only the validated discriminated union can select a method; no arbitrary script evaluation API.
        value=await page.evaluate(async({method,args})=>await window.trompe[method](...args),{method,args});
        value=materialize(value,step.output??`step-${index+1}`,ctx);
      }
      if(step.saveAs)currentRun=step.saveAs;
      if(step.op==='save')currentRun=step.id;
      const serialized=JSON.stringify(value??null);
      if(serialized.length>32000)value={...ctx.artifact(`step-${index+1}-result.json`,Buffer.from(serialized),'application/json'),summary:'Large result saved as an artifact'};
      const result={step:index+1,op:step.op,result:value??null};results.push(result);ctx.result(result);
    }
    return results;
  } finally {ctx.signal.removeEventListener('abort',abort);await close();}
}

function materialize(value,name,ctx) {
  if(typeof value==='string'&&/^data:[^;,]+;base64,/.test(value)) {
    const [,mime,data]=value.match(/^data:([^;,]+);base64,(.*)$/s);
    const extension={'image/png':'.png','image/jpeg':'.jpg'}[mime]??'.bin';
    const out=/\.(png|jpe?g|bin)$/.test(name)?name:name+extension;filename.parse(out);
    return ctx.artifact(out,Buffer.from(data,'base64'),mime);
  }
  if(Array.isArray(value))return value.map((v,i)=>materialize(v,`${name}-${i}`,ctx));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,materialize(v,`${name}-${k}`,ctx)]));
  return value;
}
