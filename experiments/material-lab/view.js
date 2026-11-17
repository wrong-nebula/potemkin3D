import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { installDetail,loadDetail,textureBytes } from './material.js';

const query=new URLSearchParams(location.search);
const which=query.get('scene')==='sento'?'sento':'luxor';
const baselineOnly=query.get('variant')==='before';
const capture=query.has('capture');
if(capture)document.body.classList.add('capture');
const canvas=document.querySelector('#view-canvas');
const renderer=new THREE.WebGLRenderer({canvas,antialias:false,preserveDrawingBuffer:true,powerPreference:'high-performance'});
renderer.setPixelRatio(1);renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=which==='luxor'?.95:1;
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;
const scene=new THREE.Scene();scene.background=new THREE.Color(which==='luxor'?'#b5b8ab':'#b3c9d3');
const camera=new THREE.PerspectiveCamera(52,1,.03,200);
const controls=new OrbitControls(camera,canvas);controls.enableDamping=false;controls.maxDistance=60;
const sun=new THREE.DirectionalLight(0xfff2df,which==='luxor'?3.4:1.5);
sun.position.set(4,12,8);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);
sun.shadow.bias=-.0002;sun.shadow.normalBias=.025;
Object.assign(sun.shadow.camera,{left:-35,right:35,top:35,bottom:-35,near:.1,far:120});
scene.add(sun,sun.target,new THREE.HemisphereLight(0xcadcec,0x93816b,which==='luxor'?1.3:.3));
const pmrem=new THREE.PMREMGenerator(renderer);
const environmentScene=new RoomEnvironment();
const environment=pmrem.fromScene(environmentScene,.04);
scene.environment=environment.texture;
environmentScene.dispose();pmrem.dispose();
const settings={enabled:{value:baselineOnly?0:1},debug:{value:0},strength:{value:1}};
const originals=[],targetMaterials=[],auxiliary=[],targetBindings=[];
let display=query.get('variant')??'split',split=.5,paused=false,lightMoves=false,lightAngle=0;
const poses=which==='luxor'?{
  close:{eye:[-11.45,2.15,10],target:[-13,2.15,9.7]},
  wide:{eye:[-9.4,2.1,14.2],target:[-13,2.3,7.5]},
  grazing:{eye:[-11.7,1.65,12],target:[-13,1.9,8]},
}:{
  close:{eye:[-1.3,.7,-.15],target:[-1.3,0,-1.3]},
  wide:{eye:[-1.6,1.75,-.35],target:[1,1,-3]},
  grazing:{eye:[-1.3,.32,-.15],target:[-1.3,0,-1.6]},
};

function pose(name='close'){
  const p=poses[name]??poses.close;camera.position.fromArray(p.eye);controls.target.fromArray(p.target);controls.update();
  document.querySelector('#view').value=name;render();
}
function resize(w=canvas.parentElement.clientWidth,h=canvas.parentElement.clientHeight){
  renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();
}
const textures=new THREE.TextureLoader();
async function readTexture(url,color=false){
  const t=await textures.loadAsync(url);t.flipY=false;t.colorSpace=color?THREE.SRGBColorSpace:THREE.NoColorSpace;t.anisotropy=8;return t;
}
function setLight(angle){
  lightAngle=angle;
  if(which==='luxor'){
    sun.position.set(-4+Math.sin(angle)*13,9,10+Math.cos(angle)*15);sun.target.position.set(-13,2,9);
  }else{
    sun.position.set(Math.sin(angle)*3,3.5,-1+Math.cos(angle)*3);sun.target.position.set(0,0,-1);
  }
  sun.target.updateMatrixWorld();sun.shadow.needsUpdate=true;
}
function sceneTextures(){
  const set=new Set([environment.texture]);
  scene.traverse(o=>{if(o.isMesh)for(const m of(Array.isArray(o.material)?o.material:[o.material])){
    for(const value of Object.values(m))if(value?.isTexture)set.add(value);
  }});
  for(const t of auxiliary)set.add(t);
  if(sun.shadow.map)set.add(sun.shadow.map.texture);
  return [...set];
}
function memory(){
  const textures=sceneTextures();
  const geometry=new Set();scene.traverse(o=>{if(o.geometry)geometry.add(o.geometry);});
  const buffers=new Set();
  for(const g of geometry){for(const a of Object.values(g.attributes))buffers.add(a.array.buffer);if(g.index)buffers.add(g.index.array.buffer);}
  const detailBytes=auxiliary.reduce((n,t)=>n+textureBytes(t),0);
  return {textureBytes:textures.reduce((n,t)=>n+textureBytes(t),0),detailBytes,
    geometryBytes:[...buffers].reduce((n,b)=>n+b.byteLength,0),textureCount:renderer.info.memory.textures,
    geometryCount:renderer.info.memory.geometries,
    note:'Estimated texture payload from actual dimensions/formats/mip levels; includes environment and colour shadow map. Excludes driver overhead, depth renderbuffers and browser/compositor buffers.'};
}
function paint(after){
  settings.enabled.value=after&&!baselineOnly?1:0;
  for(const binding of targetBindings)binding.mesh.material=after||settings.debug.value>0?binding.after:binding.before;
  renderer.render(scene,camera);
}
function render(){
  renderer.setScissorTest(false);renderer.setViewport(0,0,canvas.width,canvas.height);
  if(display==='split'&&!baselineOnly){
    const boundary=Math.round(canvas.width*split);
    renderer.setScissorTest(true);renderer.setScissor(0,0,boundary,canvas.height);paint(false);
    renderer.setScissor(boundary,0,canvas.width-boundary,canvas.height);paint(true);
    renderer.setScissorTest(false);
  }else{paint(display!=='before');}
}
function setDisplay(value){
  display=value;settings.debug.value={protection:1,albedo:2,roughness:3,protected:4}[value]??0;
  document.querySelector('#display').value=value;
  for(const selector of ['#divider','#tag-before','#tag-after'])document.querySelector(selector).hidden=value!=='split';
  render();
}
const quantile=(a,q)=>{
  if(!a.length)return null;
  const sorted=a.slice().sort((x,y)=>x-y),position=(sorted.length-1)*q,lo=Math.floor(position),hi=Math.ceil(position);
  return sorted[lo]+(sorted[hi]-sorted[lo])*(position-lo);
};
const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
async function measure(samples=120){
  paused=true;lightMoves=false;settings.debug.value=0;display=baselineOnly?'before':'after';
  const gl=renderer.getContext(),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
  for(let k=0;k<24;k++){render();await nextFrame();}
  gl.finish();
  const gpu=[],cpu=[],frame=[],pending=[];let rejected=0,previous=performance.now();
  for(let k=0;k<samples;k++){
    await nextFrame();const start=performance.now();frame.push(start-previous);previous=start;
    const q=ext?gl.createQuery():null;
    if(q)gl.beginQuery(ext.TIME_ELAPSED_EXT,q);
    render();cpu.push(performance.now()-start);
    if(q){gl.endQuery(ext.TIME_ELAPSED_EXT);pending.push(q);}
    gl.flush();
    if(ext&&gl.getParameter(ext.GPU_DISJOINT_EXT)){
      rejected+=pending.length;for(const item of pending)gl.deleteQuery(item);pending.length=0;
    }
    while(pending.length&&gl.getQueryParameter(pending[0],gl.QUERY_RESULT_AVAILABLE)){
      const item=pending.shift();gpu.push(gl.getQueryParameter(item,gl.QUERY_RESULT)/1e6);gl.deleteQuery(item);
    }
  }
  const deadline=performance.now()+6000;
  while(pending.length&&performance.now()<deadline){
    await nextFrame();
    if(gl.getParameter(ext.GPU_DISJOINT_EXT)){rejected+=pending.length;for(const q of pending)gl.deleteQuery(q);pending.length=0;break;}
    while(pending.length&&gl.getQueryParameter(pending[0],gl.QUERY_RESULT_AVAILABLE)){
      const item=pending.shift();gpu.push(gl.getQueryParameter(item,gl.QUERY_RESULT)/1e6);gl.deleteQuery(item);
    }
  }
  for(const q of pending)gl.deleteQuery(q);
  const debug=gl.getExtension('WEBGL_debug_renderer_info');
  const summary=a=>({samples:a.length,median:quantile(a,.5),p95:quantile(a,.95),min:quantile(a,0),max:quantile(a,1)});
  return {scene:which,variant:baselineOnly?'before':'after',size:[canvas.width,canvas.height],
    renderer:gl.getParameter(debug?debug.UNMASKED_RENDERER_WEBGL:gl.RENDERER),
    gpuMs:summary(gpu),cpuSubmitMs:summary(cpu),rafIntervalMs:summary(frame),disjointRejected:rejected,
    pendingExpired:pending.length,memory:memory(),drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,
    camera:{eye:camera.position.toArray(),target:controls.target.toArray()},lightAngle};
}

async function measurePaired(samples=96){
  if(baselineOnly)throw new Error('Paired timing requires both materials');
  paused=true;lightMoves=false;settings.debug.value=0;renderer.setScissorTest(false);
  const gl=renderer.getContext(),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if(!ext)throw new Error('GPU timer queries unavailable');
  for(let k=0;k<24;k++){await nextFrame();paint(k%2===0);gl.finish();}
  const pairs=Array.from({length:samples},()=>({})),pending=[];
  let rejected=0;
  const drain=()=>{
    if(gl.getParameter(ext.GPU_DISJOINT_EXT)){
      rejected+=pending.length;for(const p of pending){pairs[p.pair].invalid=true;gl.deleteQuery(p.query);}pending.length=0;return;
    }
    while(pending.length&&gl.getQueryParameter(pending[0].query,gl.QUERY_RESULT_AVAILABLE)){
      const p=pending.shift();pairs[p.pair][p.mode]=gl.getQueryParameter(p.query,gl.QUERY_RESULT)/1e6;gl.deleteQuery(p.query);
    }
  };
  for(let i=0;i<samples;i++){
    for(const after of i%2?[true,false]:[false,true]){
      await nextFrame();
      const mode=after?'after':'before',query=gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT,query);const start=performance.now();paint(after);
      pairs[i][`${mode}Cpu`]=performance.now()-start;gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push({query,pair:i,mode});
      // Isolate tile-based GPU work across frames. Synchronization is outside the timed query.
      gl.finish();drain();
    }
  }
  const deadline=performance.now()+6000;
  while(pending.length&&performance.now()<deadline){await nextFrame();drain();}
  for(const p of pending){pairs[p.pair].invalid=true;gl.deleteQuery(p.query);}
  const valid=pairs.filter(p=>!p.invalid&&Number.isFinite(p.before)&&Number.isFinite(p.after));
  const stats=a=>({samples:a.length,median:quantile(a,.5),p95:quantile(a,.95),min:quantile(a,0),max:quantile(a,1)});
  paint(true);const mem=memory();
  const debug=gl.getExtension('WEBGL_debug_renderer_info');
  const common={scene:which,size:[canvas.width,canvas.height],renderer:gl.getParameter(debug?debug.UNMASKED_RENDERER_WEBGL:gl.RENDERER),
    disjointRejected:rejected,pendingExpired:pending.length,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,
    camera:{eye:camera.position.toArray(),target:controls.target.toArray()},lightAngle};
  const modeResult=mode=>({...common,variant:mode,gpuMs:stats(valid.map(p=>p[mode])),cpuSubmitMs:stats(valid.map(p=>p[`${mode}Cpu`])),
    memory:{...mem,textureBytes:mem.textureBytes-(mode==='before'?mem.detailBytes:0),detailBytes:mode==='before'?0:mem.detailBytes,
      note:'Required texture payload estimate. The paired timing context keeps both materials resident and shares all base textures; baseline excludes the unused detail assets. Excludes driver/depth/compositor overhead.'}});
  return {before:modeResult('before'),after:modeResult('after'),pairs:valid,
    pairedDeltaMs:stats(valid.map(p=>p.after-p.before)),pairedRatio:stats(valid.map(p=>p.after/p.before))};
}

try{
  const model=await new GLTFLoader().loadAsync(which==='luxor'?'/deploy/luxor/level_2k.glb':'/experiments/sento/out/world/hall/hall_textured.glb');
  const meshes=[];model.scene.traverse(o=>{if(o.isMesh)meshes.push(o);});
  if(which==='luxor'){
    const m=meshes[0].material;
    for(const [slot,file] of [['map','base'],['normalMap','normal']]){
      const old=m[slot];m[slot]=await readTexture(`/deploy/luxor/hi/p0_${file}.jpg`,slot==='map');old?.dispose();
    }
    for(const o of meshes){o.material.normalScale.setScalar(1.35);o.material.envMapIntensity=.45;}
    targetMaterials.push(m);
  }else{
    const [normal,orm,light]=await Promise.all([
      readTexture('/experiments/sento/out/world/hall/normal.png'),
      readTexture('/experiments/sento/out/world/hall/orm.jpg'),
      readTexture('/experiments/sento/out/world/hall/light_day.png',true),
    ]);
    for(const o of meshes){
      const old=o.material;
      const m=new THREE.MeshStandardMaterial({name:old.name,map:old.map,normalMap:normal,normalMapType:THREE.ObjectSpaceNormalMap,
        roughnessMap:orm,metalnessMap:orm,roughness:1,metalness:1,side:THREE.DoubleSide,envMapIntensity:.65,
        lightMap:light,lightMapIntensity:4*Math.PI*.6});
      o.material=m;old.dispose();
      if(/tiled bathhouse floor/.test(m.name))targetMaterials.push(m);
    }
  }
  if(!targetMaterials.length)throw new Error('Could not identify the target surface');
  for(const o of meshes){o.castShadow=o.receiveShadow=true;originals.push(o.material);}
  scene.add(model.scene);scene.updateMatrixWorld(true);
  const prep=await fetch('./assets/prepared.json').then(r=>r.json());
  if(!baselineOnly){
    const kind=which==='luxor'?'stone':'tile';
    const detail=await loadDetail(kind);
    auxiliary.push(...Object.values(detail).filter(Boolean));
    for(const m of targetMaterials){
      const before=m.clone();
      for(const mesh of meshes.filter(o=>o.material===m))targetBindings.push({mesh,before,after:m});
      installDetail(m,kind,detail,settings,prep[kind].regions);
    }
  }
  resize();setLight(.4);pose(query.get('view')??'close');setDisplay(display);
  renderer.compile(scene,camera);render();
  sun.shadow.autoUpdate=false;
  document.querySelector('#loading').remove();
  for(const id of ['luxor','sento']){
    document.getElementById(id).setAttribute('aria-pressed',String(id===which));
    document.getElementById(id).onclick=()=>{location.href=`?scene=${id}`;};
  }
  document.querySelector('#view').onchange=e=>pose(e.target.value);
  document.querySelector('#display').onchange=e=>setDisplay(e.target.value);
  document.querySelector('#split').oninput=e=>{split=+e.target.value/100;document.querySelector('#divider').style.left=`${split*100}%`;render();};
  document.querySelector('#light').onclick=e=>{lightMoves=!lightMoves;e.target.setAttribute('aria-pressed',String(lightMoves));};
  controls.addEventListener('change',()=>{if(!paused)render();});
  window.addEventListener('resize',()=>{resize();render();});
  const mb=n=>(n/1024/1024).toFixed(2);
  const mem=memory();
  document.querySelector('#status').textContent=`${canvas.width} × ${canvas.height} · ${mb(mem.textureBytes)} MiB estimated texture payload · +${mb(mem.detailBytes)} MiB detail layer`;
  fetch('./assets/benchmark.json').then(r=>r.ok?r.json():null).then(data=>{
    if(!data)return;
    const range=variant=>{const rows=data.runs.filter(r=>r.scene===which&&r.pose==='close'&&r.variant===variant).map(r=>r.gpuMs.median);return rows.length?`${Math.min(...rows).toFixed(2)}–${Math.max(...rows).toFixed(2)}`:null;};
    const a=range('before'),b=range('after');
    if(a!==null&&b!==null)document.querySelector('#status').textContent+=` · recorded GPU run medians: ${a} → ${b} ms at 1280 × 720 (M1; variable load)`;
  }).catch(()=>{});
  let last=performance.now();
  renderer.setAnimationLoop(now=>{
    const dt=Math.min((now-last)/1000,.1);last=now;
    if(paused)return;if(lightMoves)setLight(lightAngle+dt*.25);render();
  });
  window.materialLab={ready:true,scene:which,renderer, camera,controls,settings,pose,setDisplay,setLight,resize,memory,measure,measurePaired,
    pause(value=true){paused=value;},
    snapshot(mode=display){setDisplay(mode);render();return canvas.toDataURL('image/png');},
    preserveSnapshot(after){settings.debug.value=2;display=after?'after':'before';render();return canvas.toDataURL('image/png');},
    maskSnapshot(){
      // Non-target meshes remain occluders but contribute no pixels to the measurement mask.
      const black=new THREE.MeshBasicMaterial({color:0,side:THREE.DoubleSide,toneMapped:false});
      const saved=[];scene.traverse(o=>{if(o.isMesh&&!targetMaterials.includes(o.material)&&!targetBindings.some(b=>b.mesh===o)){saved.push([o,o.material]);o.material=black;}});
      const background=scene.background;scene.background=new THREE.Color(0);
      settings.debug.value=4;display='after';render();const data=canvas.toDataURL('image/png');
      scene.background=background;for(const [o,m]of saved)o.material=m;black.dispose();return data;
    },
  };
}catch(e){document.querySelector('#loading').textContent=e.message;document.querySelector('#error').textContent=e.stack;console.error(e);}
