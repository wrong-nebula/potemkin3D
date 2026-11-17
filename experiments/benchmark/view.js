import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
const $ = id => document.getElementById(id);
const root = new URLSearchParams(location.search).get('run') ?? '/output/benchmark/tatooine';
if (!/^\/[\w/.-]+$/.test(root) || root.includes('..')) throw new Error('Invalid report path');
let report, layout = 'side', renderer, controls, orbitCamera, orbitScenes, frame, generation = 0;
const fmt = n => n == null ? 'No evidence' : n.toFixed(2);
const pct = n => n == null ? '—' : (n * 100).toFixed(1) + '%';
function textCell(row, text, tag='td') { const el=document.createElement(tag); el.textContent=text; row.append(el); }
function tableRow(table, label, a, b) { const row=document.createElement('tr'); [label,a,b].forEach(t=>textCell(row,t)); table.append(row); }
function message(s) { $('message').hidden=!s; $('message').textContent=s; }
const pose = () => [...report.cameras,...report.novel].find(c=>c.name===$('camera').value);
const dataset = () => report.datasets[$('dataset').value];
const upstreamFolder = () => dataset().upstreamCase;

async function update() {
  const token=++generation, ds=$('dataset').value, camera=pose(); if(!camera)return;
  const mode=$('display').value, held=mode==='heldout', d=dataset();
  const record=(held?d.heldOut:d.views).find(r=>r.name===camera.name);
  if(!record){message('No paired held-out reconstruction exists for this camera. It may have been rejected by upstream, or reserved as a novel view. Switch to Appearance or choose an accepted training camera.');$('stage').hidden=true;$('metrics').replaceChildren();$('parts').replaceChildren();$('support').textContent='No paired evidence for this selection.';return;}
  $('stage').hidden=false;
  message(''); $('legend').hidden=mode!=='overlay';
  document.querySelector('.intro p').textContent=ds==='native'?'The same geometry and cameras, with different generation strategies. Inspect appearance and coverage without treating either output as ground truth.':'The same geometry, cameras and input images. Inspect the textures, then check what the numbers actually measure.';
  $('caption').textContent=held?'This camera’s raw target was excluded from fusion. Amber or missing regions are not evidence.':mode==='overlay'?'Green: projected observation. Amber: inferred or low-confidence fill. Magenta: missing.':'Matched camera, unlit color, no post-processing. Images are evaluated at 512 × 512.';
  $('metrics').replaceChildren();
  const s=held?d.heldOutSummary:d.summary;
  tableRow($('metrics'),'Observed surface · selected camera',pct(record.methods.trompe.observed),pct(record.methods.multiview.observed));
  tableRow($('metrics'),held?'Held-out error · shared support':'Reference error · shared support',fmt(record.methods.trompe.commonError?.mae),fmt(record.methods.multiview.commonError?.mae));
  tableRow($('metrics'),'Low-frequency color error',fmt(record.methods.trompe.commonError?.low),fmt(record.methods.multiview.commonError?.low));
  tableRow($('metrics'),'High-frequency detail error',fmt(record.methods.trompe.commonError?.high),fmt(record.methods.multiview.commonError?.high));
  tableRow($('metrics'),'Mean error · all evaluated cameras',fmt(s.trompe.commonError.mae),fmt(s.multiview.commonError.mae));
  tableRow($('metrics'),'Allocated color texels','4.19 million','4.98 million');
  $('metric-note').textContent=ds==='native'?'Generation strategies use different targets. Image error is not comparable; inspect appearance and coverage.':d.kind==='synthetic'?'Synthetic calibration against known surface colors. Lower error is better.':'Agreement with generated references, not a measure of physical truth. Lower error is better.';
  $('support').textContent=`Both errors use the same ${record.commonPixels.toLocaleString()} pixels (${pct(record.commonSupport)} of eligible surface). Error units: sRGB values on a 0–255 scale.`;
  $('parts').replaceChildren();
  Object.entries(record.methods.trompe.parts).forEach(([label,a])=>{const b=record.methods.multiview.parts[label];if(!a.pixels)return;tableRow($('parts'),report.partNames[+label-1]??'Surface '+label,pct(a.observed/a.pixels),b?pct(b.observed/b.pixels):'—');});
  const accepted=Object.values(d.acceptance??{}).filter(v=>v.usable).length;
  $('comparison-note').textContent=(ds==='native'?'The same scene and cameras, with sequential generation on the left and joint-grid generation on the right. Native generation/compositing ablations; no adaptive camera, repair, ground or PBR passes.':report.protocol.comparability)+` Upstream accepted ${accepted} of 6 source views; its rejected views and refinements remain excluded.`;
  if(layout==='orbit'){await showOrbit(camera,token);return;}
  $('image-loading').hidden=false;
  const suffix=mode==='overlay'?'overlay':'image', section=held?'heldout':'renders';
  const urls=['trompe','multiview'].map(method=>`${root}/${ds}/${method}/${section}/${camera.name}-${suffix}.png`);
  try { await Promise.all(urls.map((url,i)=>new Promise((resolve,reject)=>{const img=i?$('right-image'):$('left-image');img.onload=resolve;img.onerror=()=>reject(new Error('Missing comparison image'));img.src=url;}))); }
  catch(e){message(e.message+'. Run the benchmark again or select another completed dataset.');}
  finally{if(token===generation)$('image-loading').hidden=true;}
}

function setLayout(next) {
  layout=next; cancelAnimationFrame(frame);
  for(const id of ['side','wipe','orbit'])$(id).setAttribute('aria-pressed',String(next===id));
  $('stage').className='stage '+(next==='side'?'':next); $('orbit-canvas').hidden=next!=='orbit';$('wipe-control').hidden=next!=='wipe';
  $('display').disabled=next==='orbit'; update();
}

async function showOrbit(p,token) {
  $('image-loading').hidden=false;
  try {
    if(!renderer){renderer=new THREE.WebGLRenderer({canvas:$('orbit-canvas'),antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setScissorTest(true);orbitCamera=new THREE.PerspectiveCamera(65,1,.05,2000);controls=new OrbitControls(orbitCamera,renderer.domElement);controls.enableDamping=false;}
    const urls=[`${root}/${$('dataset').value}/trompe/appearance.glb`,`${root}/${upstreamFolder()}/exports/appearance.glb`];
    orbitScenes=await Promise.all(urls.map(async url=>{const gltf=await new GLTFLoader().loadAsync(url);const scene=new THREE.Scene();scene.background=new THREE.Color('#131313');gltf.scene.traverse(o=>{if(!o.isMesh)return;const mats=Array.isArray(o.material)?o.material:[o.material];const basic=mats.map(m=>new THREE.MeshBasicMaterial({map:m.map??m.emissiveMap,color:0xffffff,side:THREE.DoubleSide,toneMapped:false}));o.material=Array.isArray(o.material)?basic:basic[0];});scene.add(gltf.scene);return scene;}));
    if(token!==generation)return;
    orbitCamera.position.fromArray(p.eye??p.position);controls.target.fromArray(p.target);orbitCamera.fov=p.fov;orbitCamera.lookAt(controls.target);controls.update();
    $('caption').textContent='Drag to orbit; scroll to zoom. Both models share one camera. Left: Trompe. Right: multiview-to-real. Metrics above remain tied to the selected calibrated camera.';
    function render(){if(layout!=='orbit')return;const canvas=$('orbit-canvas'),w=canvas.clientWidth,h=canvas.clientHeight;renderer.setSize(w,h,false);const half=w/2;orbitCamera.aspect=half/h;orbitCamera.updateProjectionMatrix();for(let i=0;i<2;i++){renderer.setViewport(i*half,0,half,h);renderer.setScissor(i*half,0,half,h);renderer.render(orbitScenes[i],orbitCamera);}frame=requestAnimationFrame(render);}render();
  }catch(e){message('The 3D model could not be loaded. The image comparisons remain available.');}
  finally{if(token===generation)$('image-loading').hidden=true;}
}

try {
  const r=await fetch(root+'/results.json');if(!r.ok)throw new Error('No completed benchmark report is available yet');report=await r.json();
  $('dataset').replaceChildren();Object.entries(report.datasets).forEach(([key,d])=>$('dataset').add(new Option(d.label,key)));
  $('camera').replaceChildren();report.cameras.forEach(c=>$('camera').add(new Option(c.name.replaceAll('_',' '),c.name)));report.novel.forEach(c=>$('camera').add(new Option('Novel · '+c.name.replaceAll('_',' '),c.name)));
  $('camera').value='courtyard_north';
  $('run-state').textContent=`${report.scene.geometry.triangles.toLocaleString()} triangles · 6 source cameras · $${(report.budget.estimatedCost??report.budget.reserved).toFixed(2)} estimated API cost`;
  $('comparison-note').textContent=report.protocol.comparability;
  report.protocol.limitations.forEach(t=>{const li=document.createElement('li');li.textContent=t;$('limitations').append(li);});
  $('provenance').textContent=JSON.stringify({protocol:report.protocol,hashes:report.hashes},null,2);$('download').href=root+'/results.json';
  for(const id of ['dataset','camera','display'])$(id).addEventListener('change',update);
  for(const id of ['side','wipe','orbit'])$(id).addEventListener('click',()=>setLayout(id));
  $('boundary').addEventListener('input',()=>{$('stage').style.setProperty('--split',$('boundary').value+'%');});
  await update();
}catch(e){message(e.message+'. Run the commands in Method & reproduction, then reload this page.');$('run-state').textContent='Waiting for a benchmark';$('image-loading').hidden=true;for(const id of ['dataset','camera','display','side','wipe','orbit'])$(id).disabled=true;}
