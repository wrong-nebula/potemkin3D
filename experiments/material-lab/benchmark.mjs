// Reproducible, serial GPU benchmark. Both variants share one context per run.
// No split-screen timing: one complete scene render at a fixed resolution per sample.
import fs from 'node:fs/promises';
import path from 'node:path';
import { launchBrowser,startServer,ROOT } from '../../scripts/browser.mjs';

process.env.TROMPE_CHROME ??= '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const {server,url}=await startServer();
const browser=await launchBrowser();
const out=path.join(ROOT,'output/playwright/material-lab');
await fs.mkdir(out,{recursive:true});
const runs=[],errors=[],paired=[];
const save=async(name,data)=>fs.writeFile(path.join(out,name),Buffer.from(data.split(',')[1],'base64'));
try{
  for(const scene of ['luxor','sento']){
    // Two independent contexts. Each pair occupies adjacent animation frames.
    for(const round of [0,1]){
      const variant='after';
      const context=await browser.newContext({viewport:{width:1280,height:720},deviceScaleFactor:1});
      const page=await context.newPage();
      page.on('pageerror',e=>errors.push({scene,variant,error:e.message}));
      page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('404'))errors.push({scene,variant,error:m.text().slice(0,2000)});});
      await page.goto(`${url}experiments/material-lab/?scene=${scene}&capture&variant=${variant}`);
      await page.waitForFunction(()=>window.materialLab?.ready,null,{timeout:120000});
      await page.evaluate(()=>materialLab.pause());
      for(const pose of ['close','wide','grazing']){
        await page.evaluate(p=>materialLab.pose(p),pose);
        const result=await page.evaluate(()=>materialLab.measurePaired(96));
        paired.push({scene,pose,round,...result});
        runs.push({...result.before,pose,round},{...result.after,pose,round});
        console.log(`${scene} ${pose} run ${round}: GPU ${result.before.gpuMs.median?.toFixed(3)} → ${result.after.gpuMs.median?.toFixed(3)} ms · paired delta ${result.pairedDeltaMs.median?.toFixed(3)} ms`);
        if(round===0)for(const mode of ['before','after'])await save(`${scene}-${pose}-${mode}.png`,await page.evaluate(v=>materialLab.snapshot(v),mode));
      }
      if(round===1){
        await page.evaluate(()=>materialLab.pose('close'));
        await save(`${scene}-albedo-before.png`,await page.evaluate(()=>materialLab.preserveSnapshot(false)));
        await save(`${scene}-albedo-after.png`,await page.evaluate(()=>materialLab.preserveSnapshot(true)));
        await save(`${scene}-protected-pixels.png`,await page.evaluate(()=>materialLab.maskSnapshot()));
        await save(`${scene}-preservation-overlay.png`,await page.evaluate(()=>materialLab.snapshot('protection')));
        await save(`${scene}-roughness-after.png`,await page.evaluate(()=>materialLab.snapshot('roughness')));
        await page.evaluate(()=>materialLab.setLight(1.8));
        for(const mode of ['before','after'])await save(`${scene}-relit-${mode}.png`,await page.evaluate(m=>materialLab.snapshot(m),mode));
      }
      await context.close();
    }
  }
  const results={recordedAt:new Date().toISOString(),browser:browser.version(),resolution:[1280,720],
    method:'Paired timing: one complete render per animation frame, adjacent before/after frames alternating AB/BA order. GPU completion synchronized outside each timed query to isolate tile-based GPU work. Two fresh contexts per scene; 24 warmup frames and 96 pairs per pose per run. EXT_disjoint_timer_query_webgl2; static shadows cached; no post-processing or dynamic resolution. CPU is submission time. Texture figures describe required payload; both variants share base textures in the timing context.',
    runs,paired,errors};
  await fs.writeFile(path.join(out,'benchmark.json'),JSON.stringify(results,null,2)+'\n');
  await fs.writeFile(path.join(import.meta.dirname,'assets/benchmark.json'),JSON.stringify(results,null,2)+'\n');
  if(errors.length)throw new Error(`${errors.length} browser errors; see benchmark.json`);
}finally{await browser.close();await server.close();}
