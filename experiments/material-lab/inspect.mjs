import fs from 'node:fs/promises';
import path from 'node:path';
import { launchBrowser,startServer,ROOT } from '../../scripts/browser.mjs';
process.env.TROMPE_CHROME ??= '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const {server,url}=await startServer();
const browser=await launchBrowser();
const output=path.join(ROOT,'output/playwright/material-lab');
await fs.mkdir(output,{recursive:true});
try{
  for(const scene of ['luxor','sento']){
    const page=await browser.newPage({viewport:{width:1280,height:720},deviceScaleFactor:1});
    page.on('pageerror',e=>console.log('ERROR',e.message));
    page.on('console',m=>{if(m.type()==='error')console.log('CONSOLE',m.text().slice(0,6000));});
    await page.goto(`${url}experiments/material-lab/?scene=${scene}&capture&variant=after`);
    await page.waitForFunction(()=>window.materialLab?.ready,null,{timeout:120000});
    await page.evaluate(()=>materialLab.pause());
    for(const pose of ['close','wide','grazing']){
      await page.evaluate(p=>materialLab.pose(p),pose);
      for(const mode of ['before','after']){
        const data=await page.evaluate(m=>materialLab.snapshot(m),mode);
        await fs.writeFile(path.join(output,`${scene}-${pose}-${mode}.png`),Buffer.from(data.split(',')[1],'base64'));
      }
    }
    console.log(scene,JSON.stringify(await page.evaluate(()=>materialLab.memory())));
    await page.close();
  }
}finally{await browser.close();await server.close();}
