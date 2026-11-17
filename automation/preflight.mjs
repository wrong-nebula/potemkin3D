// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import { ROOT, AutomationError, inside, readJSON } from './files.mjs';

/** Catch missing inputs and unsafe destinations before starting Chromium or a paid call. */
export function preflight(input,root=ROOT) {
  let loaded=false,planned=false;
  const created=new Set();
  for(const step of input.steps) {
    if(step.op==='load') {
      const look=step.look?readJSON(inside(root,step.look)):{};
      const file=step.path??look.level;
      if(typeof file!=='string'||!file.endsWith('.glb'))throw new AutomationError('INVALID_WORKFLOW','load needs a GLB path or a look file with a GLB level');
      inside(root,file);loaded=true;planned=false;
    } else if(step.op==='loadRun') {
      const meta=readJSON(inside(root,`runs/${step.id}/run.json`));
      if(!loaded)inside(root,`samples/${meta.level}.glb`);
      loaded=true;planned=true;
    } else if(step.op==='loadSentoFloor') {loaded=true;planned=false;}
    else if(!loaded)throw new AutomationError('INVALID_WORKFLOW',`${step.op} needs load, loadRun or loadSentoFloor first`);
    if(step.op==='plan')planned=true;
    if(step.op==='quote'&&!planned)throw new AutomationError('INVALID_WORKFLOW','quote needs plan first');
    const run=step.saveAs??(step.op==='save'?step.id:undefined);
    if(run)inside(root,`runs/${run}`,{exists:false});
    if(step.op==='run'&&fs.existsSync(inside(root,`runs/${run}`,{exists:false})))
      throw new AutomationError('RUN_EXISTS','Run ID already exists; use loadRun and topUp to resume it');
    if(run)created.add(run);
    if(['validate','checkRun','promptTest'].includes(step.op)) {
      const referenced=step.id??step.options.run;
      if(!created.has(referenced))inside(root,`runs/${referenced}/run.json`);
    }
  }
  return input;
}
