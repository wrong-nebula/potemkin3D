import{A as e,B as t,C as n,D as r,E as i,F as a,I as o,L as s,M as c,N as l,O as u,P as d,R as f,S as p,T as m,V as h,_ as ee,a as te,b as ne,c as re,d as ie,f as ae,g as oe,h as se,i as ce,j as le,k as ue,l as de,m as fe,n as pe,o as me,p as he,r as ge,s as _e,t as ve,u as ye,v as be,w as xe,x as g,y as _,z as v}from"./three-CQYU3ptT.js";(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel="modulepreload"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),t.credentials=e.crossOrigin===`use-credentials`?`include`:e.crossOrigin===`anonymous`?`omit`:`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();var Se=10;function Ce(e,n=38){let r=Math.cos(g.degToRad(n)),i=[],a=new Map,o=new t,s=new t,c=new t,l=e=>`${Math.round(e.x*2e3)},${Math.round(e.y*2e3)},${Math.round(e.z*2e3)}`;for(let n of e){n.geometry.index&&(n.geometry=n.geometry.toNonIndexed()),n.updateWorldMatrix(!0,!1);let e=n.geometry.getAttribute(`position`);n.userData.firstFace=i.length;for(let r=0;r<e.count/3;r++){o.fromBufferAttribute(e,3*r).applyMatrix4(n.matrixWorld),s.fromBufferAttribute(e,3*r+1).applyMatrix4(n.matrixWorld),c.fromBufferAttribute(e,3*r+2).applyMatrix4(n.matrixWorld);let u=new t().subVectors(s,o).cross(new t().subVectors(c,o)),d=u.length()/2;u.normalize();let f=[l(o),l(s),l(c)],p=[s.distanceTo(c),c.distanceTo(o),o.distanceTo(s)],m={normal:u,centre:new t().add(o).add(s).add(c).divideScalar(3),area:d,lengths:p,hard:[!1,!1,!1]};if(i.push(m),!(d<1e-10))for(let e=0;e<3;e++){let t=f[(e+1)%3],n=f[(e+2)%3];if(t===n)continue;let r=t<n?`${t}|${n}`:`${n}|${t}`,i=a.get(r);i?i.push([m,e]):a.set(r,[[m,e]])}}}let u=0;for(let e of a.values()){if(e.length!==2)continue;let[[t,n],[i,a]]=e;t.normal.dot(i.normal)>r||t.normal.dot(o.subVectors(i.centre,t.centre))>-1e-5||(t.hard[n]=i.hard[a]=!0,u++)}for(let t of e){let e=t.geometry.getAttribute(`position`).count,n=new Float32Array(e*3).fill(Se);for(let r=0;r<e/3;r++){let e=i[t.userData.firstFace+r];for(let t=0;t<3;t++){if(!e.hard[t])continue;let i=2*e.area/Math.max(e.lengths[t],1e-6);for(let e=0;e<3;e++)n[3*(3*r+e)+t]=e===t?i:0}}t.geometry.setAttribute(`edge`,new de(n,3))}return u}function we(e,t){let n=new Uint32Array(t*t),r=new Uint8Array(t*t);for(let t=0;t<n.length;t++)n[t]=e[4*t]+e[4*t+1]*256+e[4*t+2]*65536,r[t]=n[t]?15:0;let i=[[[-1,0],[-1,-1],[0,-1],[1,-1]],[[1,0],[-1,1],[0,1],[1,1]]],a=(e,a,o)=>{let s=a*t+e,c=n[s];if(!c)return;let l=Math.min(r[s],e,a,t-1-e,t-1-a);for(let[s,u]of i[+!!o]){let i=e+s,o=a+u;if(i<0||o<0||i>=t||o>=t){l=0;continue}let d=o*t+i;l=Math.min(l,n[d]===c?r[d]+1:0)}r[s]=l};for(let e=0;e<t;e++)for(let n=0;n<t;n++)a(n,e,!1);for(let e=t-1;e>=0;e--)for(let n=t-1;n>=0;n--)a(n,e,!0);for(let t=0;t<r.length;t++)e[4*t+3]=r[t]*17}function Te(e,t=1024){let n=e.getAttribute(`uv`),r=e.getAttribute(`position`);if(e.index)throw Error(`POM atlas needs non-indexed triangles`);let i=r.count/3,a=Array.from({length:i},(e,t)=>t),o=new Map,s=e=>{for(;a[e]!==e;)a[e]=a[a[e]],e=a[e];return e},c=e=>[r.getX(e),r.getY(e),r.getZ(e),n.getX(e),n.getY(e)].map(e=>Math.round(e*1e6)).join(`,`);for(let e=0;e<i;e++){let t=[c(e*3),c(e*3+1),c(e*3+2)];for(let n=0;n<3;n++){let r=t[n],i=t[(n+1)%3],c=r<i?`${r}|${i}`:`${i}|${r}`,l=o.get(c);l===void 0?o.set(c,e):a[s(e)]=s(l)}}let l=new Map,u=new Float32Array(r.count),d=new Uint8Array(t*t*4);for(let e=0;e<i;e++){let r=s(e);l.has(r)||l.set(r,l.size+1);let i=l.get(r);u.fill(i,e*3,e*3+3);let a=[0,1,2].map(r=>n.getX(e*3+r)*t),o=[0,1,2].map(r=>n.getY(e*3+r)*t),c=(a[1]-a[0])*(o[2]-o[0])-(o[1]-o[0])*(a[2]-a[0]);if(Math.abs(c)<1e-8)continue;let f=Math.max(0,Math.floor(Math.min(...a))),p=Math.min(t-1,Math.ceil(Math.max(...a))),m=Math.max(0,Math.floor(Math.min(...o))),h=Math.min(t-1,Math.ceil(Math.max(...o)));for(let e=m;e<=h;e++)for(let n=f;n<=p;n++){let r=((a[1]-n-.5)*(o[2]-e-.5)-(o[1]-e-.5)*(a[2]-n-.5))/c,s=((a[2]-n-.5)*(o[0]-e-.5)-(o[2]-e-.5)*(a[0]-n-.5))/c;if(r<-1e-6||s<-1e-6||r+s>1.000001)continue;let l=4*(e*t+n);d[l]=i&255,d[l+1]=i>>8&255,d[l+2]=i>>16&255,d[l+3]=255}}e.setAttribute(`pomIsland`,new de(u,1)),we(d,t);let f=new he(d,t,t);return f.minFilter=f.magFilter=xe,f.generateMipmaps=!1,f.needsUpdate=!0,f}var y={uPomDepth:{value:.025},uPomEnabled:{value:1},uPomShadow:{value:.8}},Ee=new WeakMap,De=new he(new Uint8Array([255]),1,1,le);De.needsUpdate=!0;function Oe(e,t){let n=Ee.get(e);if(!n)throw Error(`Install pomLayer before setting its height map`);if(t&&t.colorSpace!==``)throw Error(`POM height maps must use linear data`);n.tPomHeight.value=t??De,n.uPomHeightReady.value=+!!t}var ke=`
uniform sampler2D tPomIslands, tPomHeight;
uniform float uPomDepth, uPomEnabled, uPomShadow, uPomHeightReady;
flat varying float vPomIsland;
float pomWeight = 0.0, pomThickness = 0.0, pomHitDepth = 0.0;
vec2 pomHitUv = vec2(0.0), pomDx = vec2(0.0), pomDy = vec2(0.0), pomPixelMetres = vec2(1.0);
vec3 pomGradU = vec3(0.0), pomGradV = vec3(0.0), pomNormal = vec3(0.0);
#ifdef USE_MAP
bool pomInside(vec2 uv) {
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return false;
  float id = dot(floor(texture2D(tPomIslands, uv).rgb * 255.0 + 0.5), vec3(1.0, 256.0, 65536.0));
  return abs(id - vPomIsland) < 0.5;
}
float pomClearanceAt(ivec2 cell) {
  ivec2 size = textureSize(tPomIslands, 0);
  if (any(lessThan(cell, ivec2(0))) || any(greaterThanEqual(cell, size))) return 0.0;
  vec4 mask = texelFetch(tPomIslands, cell, 0);
  float id = dot(floor(mask.rgb * 255.0 + 0.5), vec3(1.0, 256.0, 65536.0));
  return abs(id - vPomIsland) < 0.5 ? mask.a * 15.0 : 0.0;
}
float pomClearance(vec2 uv) {
  vec2 cell = uv * vec2(textureSize(tPomIslands, 0)) - 0.5, f = fract(cell);
  ivec2 i = ivec2(floor(cell));
  return mix(mix(pomClearanceAt(i), pomClearanceAt(i + ivec2(1, 0)), f.x),
    mix(pomClearanceAt(i + ivec2(0, 1)), pomClearanceAt(i + ivec2(1, 1)), f.x), f.y);
}
// Reconstruct enlarged height texels with a cubic filter, avoiding angular cavity rims. No derivatives
// inside a march; explicit gradients select the mip consistently for view, bump and shadow samples.
vec4 pomSmooth(sampler2D t, vec2 uv, vec2 dx, vec2 dy) {
  vec2 size = vec2(textureSize(t, 0));
  float footprint = max(length(dx * size), length(dy * size));
  vec4 plain = textureGrad(t, uv, dx, dy);
  if (footprint >= 0.8) return plain;
  vec2 px = uv * size - 0.5, f = fract(px), i = floor(px), f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0, w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0;
  vec2 w3 = f3 / 6.0, w2 = 1.0 - w0 - w1 - w3, s0 = w0 + w1, s1 = w2 + w3;
  vec2 t0 = (i - 0.5 + w1 / s0) / size, t1 = (i + 1.5 + w3 / s1) / size;
  vec4 cubic = (textureLod(t, vec2(t0.x, t0.y), 0.0) * s0.x + textureLod(t, vec2(t1.x, t0.y), 0.0) * s1.x) * s0.y
    + (textureLod(t, vec2(t0.x, t1.y), 0.0) * s0.x + textureLod(t, vec2(t1.x, t1.y), 0.0) * s1.x) * s1.y;
  return mix(cubic, plain, smoothstep(0.35, 0.8, footprint));
}
float pomDepthAt(vec2 uv, vec2 dx, vec2 dy) {
  return 1.0 - clamp(pomSmooth(tPomHeight, uv, dx, dy).r, 0.0, 1.0);
}
vec2 pomTrace(vec2 uv, vec3 at) {
  vec3 px = dFdx(at), py = dFdy(at);
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec3 crossed = cross(px, py);
  float area = length(crossed);
  if (area < 1e-12 || uPomEnabled < 0.5 || uPomDepth <= 0.0 || uPomHeightReady < 0.5) return vec2(0.0);
  vec3 n = crossed / area, view = normalize(-at);
  float facing = abs(dot(n, view));
  float fade = (1.0 - smoothstep(8.0, 22.0, length(at))) * smoothstep(0.08, 0.24, facing);
  float amount = uPomDepth * fade;
  if (amount < 0.00001 || !pomInside(uv)) return vec2(0.0);
  // Dual basis converts metres along the view ray into atlas UVs: no tangents required, and both mirrored
  // islands and differently scaled islands retain the same physical depth.
  vec3 r1 = cross(py, n), r2 = cross(n, px);
  vec3 gradU = (dx.x * r1 + dy.x * r2) / area, gradV = (dx.y * r1 + dy.y * r2) / area;
  vec2 travel = -vec2(dot(gradU, view), dot(gradV, view)) * amount / max(facing, 0.10);
  vec2 size = vec2(textureSize(tPomHeight, 0));
  // Keep a fixed UV limit across texture streaming. Feather before tracing instead of snapping all the way
  // back to zero when a ray hits the edge of a packed island. Reserve a texel for filtering as well.
  float limit = min(1.0, (12.0 / 4096.0) / max(length(travel), 1e-8));
  travel *= limit; amount *= limit;
  float seam = smoothstep(0.0, 2.0 + length(travel * vec2(textureSize(tPomIslands, 0))), max(0.0, pomClearance(uv) - 1.0));
  travel *= seam; amount *= seam;
  if (amount < 0.00001) return vec2(0.0);
  pomWeight = fade * seam;
  pomThickness = amount; pomDx = dx; pomDy = dy;
  pomGradU = gradU; pomGradV = gradV; pomNormal = n;
  pomPixelMetres = max(vec2(length(px), length(py)), vec2(1e-6));
  pomHitUv = uv;
  float first = pomDepthAt(uv, dx, dy);
  // Straight-on viewing still needs a depth for cavity shadows and matching bump shading.
  if (length(travel * size) < 0.02 || first < 0.0001) { pomHitDepth = first; return vec2(0.0); }
  float layers = ceil(clamp(12.0 + length(travel * size) * 2.0, 12.0, 40.0)), stepDepth = 1.0 / layers;
  float before = 0.0, after = 0.0;
  for (int i = 0; i < 40; i++) {
    after = min(1.0, float(i + 1) * stepDepth);
    vec2 sampleUv = uv + travel * after;
    if (!pomInside(sampleUv)) { pomWeight = pomThickness = 0.0; return vec2(0.0); }
    if (after >= pomDepthAt(sampleUv, dx, dy)) break;
    before = after;
  }
  // Refine the first crossing, so even a close, grazing view does not expose the march's layers.
  for (int i = 0; i < 5; i++) {
    float middle = (before + after) * 0.5;
    vec2 sampleUv = uv + travel * middle;
    if (!pomInside(sampleUv)) { pomWeight = pomThickness = 0.0; return vec2(0.0); }
    if (middle < pomDepthAt(sampleUv, dx, dy)) before = middle; else after = middle;
  }
  // A secant between the final bracket samples removes the remaining discrete depth steps.
  float a = pomDepthAt(uv + travel * before, dx, dy) - before;
  float b = pomDepthAt(uv + travel * after, dx, dy) - after;
  pomHitDepth = mix(before, after, clamp(a / max(a - b, 1e-6), 0.0, 1.0));
  pomHitUv = uv + travel * pomHitDepth;
  return travel * pomHitDepth;
}

// Differentiate the height field at the intersection, not the warped screen image. Screen-space differences
// across a visibility jump made the old shader draw black outlines and changed its bump strength with view.
vec2 pomBump() {
  if (pomThickness <= 0.0) return vec2(0.0);
  vec2 texel = 1.0 / vec2(textureSize(tPomHeight, 0));
  float u = pomDepthAt(pomHitUv + vec2(texel.x, 0.0), pomDx, pomDy) - pomDepthAt(pomHitUv - vec2(texel.x, 0.0), pomDx, pomDy);
  float v = pomDepthAt(pomHitUv + vec2(0.0, texel.y), pomDx, pomDy) - pomDepthAt(pomHitUv - vec2(0.0, texel.y), pomDx, pomDy);
  vec2 slope = -pomThickness * vec2(u, v) / (2.0 * texel);
  return clamp(vec2(dot(slope, pomDx), dot(slope, pomDy)) / pomPixelMetres, -0.65, 0.65);
}

// March from the visible recess towards the light. Only direct light is attenuated; skylight still fills
// the carving. A growing bias/penumbra keeps shallow cuts soft and avoids self-shadow acne.
float pomVisibility(vec3 light) {
  if (pomThickness <= 0.0 || pomHitDepth < 0.01 || uPomShadow <= 0.0) return 1.0;
  float above = dot(pomNormal, light);
  if (above <= 0.04) return 1.0;
  vec2 travel = vec2(dot(pomGradU, light), dot(pomGradV, light)) * pomThickness * pomHitDepth / above;
  float occlusion = 0.0;
  for (int i = 1; i <= 12; i++) {
    float t = float(i) / 12.0;
    vec2 uv = pomHitUv + travel * t;
    if (!pomInside(uv)) break;
    float rayDepth = pomHitDepth * (1.0 - t);
    float surface = pomDepthAt(uv, pomDx, pomDy);
    occlusion = max(occlusion, smoothstep(0.015, 0.055 + t * 0.08, rayDepth - surface));
  }
  return 1.0 - occlusion * uPomShadow * pomWeight * smoothstep(0.04, 0.16, above);
}
#endif
`;function Ae(e,t,n=y){let r=e.onBeforeCompile,i=e.customProgramCacheKey(),a={tPomHeight:{value:De},uPomHeightReady:{value:0}};Ee.set(e,a),e.defines={...e.defines,TROMPE_POM:1},e.onBeforeCompile=function(e,i){r.call(this,e,i),Object.assign(e.uniforms,n,a,{tPomIslands:{value:t}}),e.vertexShader=e.vertexShader.replace(`#include <common>`,`#include <common>
attribute float pomIsland; flat varying float vPomIsland;`).replace(`#include <begin_vertex>`,`#include <begin_vertex>
vPomIsland = pomIsland;`),e.fragmentShader=e.fragmentShader.replace(`#include <clipping_planes_pars_fragment>`,`#include <clipping_planes_pars_fragment>
`+ke);for(let t of[`map_fragment`,`normal_fragment_maps`,`roughnessmap_fragment`,`metalnessmap_fragment`,`aomap_fragment`])e.fragmentShader=e.fragmentShader.replace(`#include <${t}>`,me[t]);e.fragmentShader=e.fragmentShader.replace(/(texture2D|sandSmooth)\(\s*(map|normalMap|roughnessMap|metalnessMap|aoMap)\s*,\s*(v\w+Uv)\s*\)/g,`$1( $2, $3 + pomOffset )`).replace(`#include <clipping_planes_fragment>`,`#include <clipping_planes_fragment>
vec2 pomOffset = vec2(0.0);
#ifdef USE_MAP
pomOffset = pomTrace(vMapUv, -vViewPosition);
#endif`),e.fragmentShader=e.fragmentShader.replace(`#include <lights_fragment_begin>`,me.lights_fragment_begin.replace(`getDirectionalLightInfo( directionalLight, directLight );`,`getDirectionalLightInfo( directionalLight, directLight );
#ifdef USE_MAP
directLight.color *= pomVisibility(directLight.direction);
#endif`))},e.customProgramCacheKey=()=>`${i}|pom-height-3`,e.needsUpdate=!0}var je=class{constructor(t,n,r,{base:i=`./hi/`,budget:a=4}={}){this.renderer=t,this.camera=n,this.meshes=r,this.base=i,this.budget=a,this.pages=r.map(e=>({mesh:e,need:0,state:`low`,low:{map:e.material.map,normalMap:e.material.normalMap,heightMap:null},high:null,heightError:null})),this.list=null,this.loading=!1,this.heightLoading=!0,this.since=0,this.ray=new e,this.ray.firstHitOnly=!0,this.loader=new be,this.loader.setOptions({imageOrientation:`none`,premultiplyAlpha:`none`}),this.dataLoader=new be,this.dataLoader.setOptions({imageOrientation:`none`,premultiplyAlpha:`none`,colorSpaceConversion:`none`}),this.ready=this.loadManifest()}async loadManifest(){try{let e=await fetch(`${this.base}textures.json`,{cache:`no-store`});if(!e.ok)throw Error(`Texture manifest: ${e.status}`);this.list=await e.json();for(let[e,t]of this.pages.entries())try{let n=this.list[e]?.heightLow;if(!n)throw Error(`No generated height map`);let r=await this.loadHeight(n);this.renderer.initTexture(r),t.low.heightMap=r,Oe(t.mesh.material,r),await new Promise(e=>requestAnimationFrame(e))}catch(e){t.heightError=e.message}}catch(e){for(let t of this.pages)t.heightError=e.message}finally{this.heightLoading=!1}}async loadHeight(e){let t=await this.dataLoader.loadAsync(this.base+e);try{let e=new OffscreenCanvas(t.width,t.height).getContext(`2d`,{willReadFrequently:!0});e.drawImage(t,0,0);let n=e.getImageData(0,0,t.width,t.height).data,r=new Uint8Array(t.width*t.height);for(let e=0;e<r.length;e++)r[e]=n[e*4];let i=new he(r,t.width,t.height,le);return i.colorSpace=``,i.flipY=!1,i.minFilter=ne,i.magFilter=_,i.generateMipmaps=!0,i.anisotropy=Math.min(8,this.renderer.capabilities.getMaxAnisotropy()),i.needsUpdate=!0,i}finally{t.close()}}get status(){let e=this.pages.filter(e=>e.state===`high`).length,t=this.pages.map(e=>(e.state===`high`?e.high:e.low)?.heightMap?.image.width??0);return{sharp:e,pages:this.pages.length,size:this.list?.[0]?.size??0,loading:this.loading||this.heightLoading,heightPages:t.filter(Boolean).length,heightSizes:t,heightLoading:this.heightLoading,heightErrors:this.pages.map(e=>e.heightError).filter(Boolean)}}update(e,t){if(this.since+=e,this.since<.5)return;this.since=0;let n=t/(2*Math.tan(g.degToRad(this.camera.fov)/2));for(let e of this.pages)e.need*=.8;let r=1/0,i=0;for(let e=-.8;e<=.81;e+=.32)for(let t=-.9;t<=.91;t+=.3){this.ray.setFromCamera(new v(t,e),this.camera),this.ray.far=120;let a=this.ray.intersectObjects(this.meshes,!1)[0];if(!a){i=1/0;continue}r=Math.min(r,a.distance),i=Math.max(i,a.distance);let o=this.pages[this.meshes.indexOf(a.object)];o.need=Math.max(o.need,n/Math.max(a.distance,.5))}if(this.nearest=r,this.farthest=i,this.loading||this.heightLoading||!this.list||this.budget<=0)return;let a=this.pages.filter(e=>e.state===`high`),o=this.pages.filter(e=>e.state===`low`&&e.need>12).sort((e,t)=>t.need-e.need)[0];if(o){if(a.length>=this.budget){let e=a.sort((e,t)=>e.need-t.need)[0];if(e.need*1.5>o.need)return;this.lower(e)}this.raise(o)}}async raise(e){let t=this.list[this.pages.indexOf(e)];if(!t)return;this.loading=!0;let n=[];try{let r=e.mesh.material,i=async(e,t)=>{let n=await this.loader.loadAsync(this.base+e),r=new o(n);return r.colorSpace=t.colorSpace,r.wrapS=t.wrapS,r.wrapT=t.wrapT,r.flipY=!1,r.minFilter=ne,r.magFilter=_,r.generateMipmaps=!0,r.anisotropy=Math.min(8,this.renderer.capabilities.getMaxAnisotropy()),r.needsUpdate=!0,r},a=await i(t.base,e.low.map);n.push(a);let s=t.normal&&e.low.normalMap?await i(t.normal,e.low.normalMap):null;s&&n.push(s);let c=t.height?await this.loadHeight(t.height):null;c&&n.push(c),this.renderer.initTexture(a),await new Promise(e=>requestAnimationFrame(e)),s&&this.renderer.initTexture(s),await new Promise(e=>requestAnimationFrame(e)),c&&this.renderer.initTexture(c),e.high={map:a,normalMap:s,heightMap:c},r.map=a,s&&(r.normalMap=s),Oe(r,c),c&&(e.heightError=null),e.state=`high`}catch{for(let e of n)e.dispose(),e.image?.close?.();e.need=0}finally{this.loading=!1}}lower(e){let t=e.mesh.material;t.map=e.low.map,e.low.normalMap&&(t.normalMap=e.low.normalMap),Oe(t,e.low.heightMap),e.high?.map.dispose(),e.high?.map.image?.close?.(),e.high?.normalMap?.dispose(),e.high?.normalMap?.image?.close?.(),e.high?.heightMap?.dispose(),e.high=null,e.state=`low`}};function Me(e=256,t=16){let n=(e,t,n)=>{let r=Math.sin(e*127.1+t*311.7+n*74.7)*43758.5453;return r-Math.floor(r)},r=(e,t,r,i)=>{let a=Math.floor(e),o=Math.floor(t),s=e-a,c=t-o,l=s*s*(3-2*s),u=c*c*(3-2*c),d=(e,t)=>n(((a+e)%r+r)%r,((o+t)%r+r)%r,i);return(d(0,0)*(1-l)+d(1,0)*l)*(1-u)+(d(0,1)*(1-l)+d(1,1)*l)*u},i=(e,n,i)=>(r(e,n,t,i)*4+r(e*2,n*2,t*2,i+1)*2+r(e*4,n*4,t*4,i+2))/7,a=new Uint8Array(e*e*4);for(let o=0;o<e;o++)for(let s=0;s<e;s++){let c=s/e*t,l=o/e*t,u=4*(o*e+s);a[u]=255*i(c,l,1),a[u+1]=255*i(c,l,9),a[u+2]=255*r(c,l,t,17),a[u+3]=255*n(s,o,23)}let o=new he(a,e,e,ue,s);return o.wrapS=o.wrapT=c,o.minFilter=ne,o.magFilter=_,o.generateMipmaps=!0,o.needsUpdate=!0,o}var Ne=Me(),b=`0.0625`,x={uSand:{value:.5},uSandTime:{value:0},uWind:{value:new v(.94,.34)},uDetail:{value:1},uSandColor:{value:new ae(.62,.44,.22)},uAge:{value:1},uChips:{value:1},tSandNoise:{value:Ne}};function Pe(e){e.onBeforeCompile=e=>{Object.assign(e.uniforms,x),e.vertexShader=e.vertexShader.replace(`#include <common>`,`#include <common>
attribute vec3 edge; varying vec3 vSandPos; varying vec3 vSandNormal; varying vec3 vSandEdge;`).replace(`#include <begin_vertex>`,`#include <begin_vertex>
vSandPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vSandNormal = normalize(mat3(modelMatrix) * objectNormal); vSandEdge = edge;`),e.fragmentShader=e.fragmentShader.replace(`#include <common>`,`#include <common>
varying vec3 vSandPos; varying vec3 vSandNormal; varying vec3 vSandEdge;
uniform float uSand, uSandTime, uDetail, uChips, uAge; uniform vec2 uWind; uniform vec3 uSandColor; uniform sampler2D tSandNoise;
// sandBump: a height's change over one pixel; sandSlope: a slope in metres a metre, along the pixel's two directions
float sandMask = 0.0, sandGlint = 0.0, sandChip = 0.0; vec2 sandBump = vec2(0.0), sandSlope = vec2(0.0);
#define SAND_GRAIN(q) (texture2D(tSandNoise, (q) * 70.0).b * 0.55 + texture2D(tSandNoise, (q) * 230.0 + 0.37).g * 0.45)
// A texture read smoothly when it is enlarged. Close to a wall one texel covers many pixels, and the ordinary lookup
// draws each as a little pyramid: carved lines turn to staircases. Here the sixteen texels around the point are
// weighed by a cubic curve (in four lookups, each between two texels), which rounds the steps off. Where the
// texture is not enlarged the ordinary lookup, with its mipmaps, is the right one and is used.
vec4 sandSmooth(sampler2D t, vec2 uv) {
  vec2 size = vec2(textureSize(t, 0)), px = uv * size;
  vec2 grow = fwidth(px);
  vec4 plain = texture2D(t, uv);
  if (max(grow.x, grow.y) > 0.7) return plain;
  px -= 0.5;
  vec2 f = fract(px), i = px - f, f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0, w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0, w3 = f3 / 6.0, w2 = 1.0 - w0 - w1 - w3;
  vec2 s0 = w0 + w1, s1 = w2 + w3;
  vec2 t0 = (i - 0.5 + w1 / s0) / size, t1 = (i + 1.5 + w3 / s1) / size;
  vec4 smoothed = (textureLod(t, vec2(t0.x, t0.y), 0.0) * s0.x + textureLod(t, vec2(t1.x, t0.y), 0.0) * s1.x) * s0.y
    + (textureLod(t, vec2(t0.x, t1.y), 0.0) * s0.x + textureLod(t, vec2(t1.x, t1.y), 0.0) * s1.x) * s1.y;
  // eased in as the enlargement grows, so there is no line where one lookup hands over to the other
  return mix(smoothed, plain, smoothstep(0.35, 0.7, max(grow.x, grow.y)));
}
// a fine relief from a height's change across the pixel (three's own bump mapping, for a height not in a texture)
vec3 sandRelief(vec3 at, vec3 n, vec2 dH, float facing) {
  vec3 sx = normalize(dFdx(at)), sy = normalize(dFdy(at));
  vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1) * facing;
  return normalize(abs(det) * n - sign(det) * (dH.x * r1 + dH.y * r2));
}`).replace(`#include <map_fragment>`,`${me.map_fragment.replace(`texture2D( map, vMapUv )`,`sandSmooth( map, vMapUv )`)}
{
  vec3 sp = vSandPos; vec3 sn = normalize(vSandNormal);
  float away = distance(cameraPosition, sp);
  // the stone's grain, close up only. One flat lookup stands in for noise through the stone: the plane it is read
  // on is tilted, so walls facing any way get two changing coordinates.
  float near = (1.0 - smoothstep(2.0, 9.0, away)) * uDetail;
  vec2 gp = (sp.xz + sp.y * vec2(0.37, 0.61)) * ${b};
  // The grain is read for every pixel, near or far (far off its mipmaps have smoothed it to nothing, at next to no
  // cost), so that its relief can come from how it changes across the pixel and not from reading it three times.
  float grain = SAND_GRAIN(gp);
  vec2 grainWay = vec2(dFdx(grain), dFdy(grain));
  // What the texture draws dark is lower: a joint, a carved line, a crack. Its brightness, taken as a height, gives
  // those a wall and a floor for the sun to light and shade, at the size the screen shows them.
  float lum = dot(diffuseColor.rgb, vec3(0.3, 0.6, 0.1));
  sandBump = clamp(vec2(dFdx(lum), dFdy(lum)), -0.07, 0.07) * 2.4 * (1.0 - smoothstep(10.0, 30.0, away)) * uDetail * uAge;
#if defined(TROMPE_POM) && defined(USE_MAP)
  sandBump = mix(sandBump, pomBump() * uDetail, pomWeight);
#endif
  if (uAge > 0.0) {
    // No two blocks weathered alike: the tone wanders over a few metres, the colour (warmer, cooler) over more
    // (one lookup for both: its two cloudy channels are unrelated to each other)
    vec2 drifted = texture2D(tSandNoise, gp * 0.27).rg;
    diffuseColor.rgb *= 0.89 + 0.24 * drifted.x;
    diffuseColor.rgb *= mix(vec3(1.035, 1.0, 0.95), vec3(0.97, 1.0, 1.045), drifted.y);
    // and on upright faces, streaks where water and dust have run down
    float upright = 1.0 - abs(sn.y);
    diffuseColor.rgb *= 1.0 - 0.16 * upright * smoothstep(0.50, 0.80, texture2D(tSandNoise, vec2((sp.x + sp.z) * 2.3, sp.y * 0.085) * ${b}).b);
    // a film of dust: seen at a glance the stone is paler, as dusty things are
    vec3 toEye = normalize(cameraPosition - sp);
    diffuseColor.rgb = mix(diffuseColor.rgb, uSandColor * 1.15, 0.22 * pow(1.0 - abs(dot(sn, toEye)), 3.0));
  }
  // how far the nearest edge that can chip is, and which way across the pixel it lies (worked out here, where every
  // pixel passes: a slope taken inside a branch is not to be trusted)
  float toEdge = min(vSandEdge.x, min(vSandEdge.y, vSandEdge.z));
  vec2 edgeWay = vec2(dFdx(toEdge), dFdy(toEdge)) / max(vec2(length(dFdx(sp)), length(dFdy(sp))), vec2(1e-5));
  if (near > 0.001) {
    float pit = smoothstep(0.66, 0.76, texture2D(tSandNoise, gp * 31.0 + 0.11).g);
    diffuseColor.rgb *= 1.0 + near * (0.34 * (grain - 0.5) - 0.12 * pit);
    // the same grain as a relief, for the light to catch
    sandBump += grainWay * near * 1.5;
  }
  if (uSand > 0.001) {
    float up = smoothstep(0.55, 0.95, sn.y);
    float low = 1.0 - smoothstep(0.05, 2.2, sp.y);
    float lying = 0.0, foot = 0.0;
    vec2 xz = sp.xz * ${b};
    vec2 across = vec2(-uWind.y, uWind.x);
    // (each part is worked out only where it can show: most of a wall is neither ground nor foot)
    if (up > 0.01) {
      // where the drifts lie: big patches, their edges broken up, more of them the more sand there is
      float drift = texture2D(tSandNoise, xz * 0.21 + 0.37).r * 0.72 + texture2D(tSandNoise, xz * 2.6).g * 0.28;
      lying = up * (0.18 + 0.82 * low) * smoothstep(0.60 - 0.36 * uSand, 0.72 - 0.36 * uSand, drift);
    }
    // banked against the foot of whatever stands on the ground
    if (up < 0.99 && sp.y < 0.9) foot = (1.0 - up) * (1.0 - smoothstep(0.0, 0.10 + 0.55 * uSand * texture2D(tSandNoise, (sp.xz * 1.7 + sp.y) * ${b}).b, sp.y)) * 0.8;
    sandMask = clamp(max(lying, foot), 0.0, 1.0);
    if (sandMask > 0.001) {
      // ripples across the wind (they fade out a few metres off: further away they are finer than a pixel)
      float fine = 1.0 - smoothstep(3.0, 11.0, away);
      float ripple = sin(dot(sp.xz, uWind) * 26.0 + texture2D(tSandNoise, xz * 1.3).r * 9.0 + dot(sp.xz, across) * 3.0) * 0.5 + 0.5;
      vec3 sand = uSandColor * (1.0 - 0.14 * fine * (1.0 - ripple)) * (0.92 + 0.16 * texture2D(tSandNoise, xz * 23.0).b);
      diffuseColor.rgb = mix(diffuseColor.rgb, sand, sandMask * 0.92);
      // one grain in a few dozen is a clean face of quartz: it mirrors the sun where the rest only scatter it
      sandGlint = step(0.972, texture2D(tSandNoise, xz * 190.0).a) * sandMask * fine * up;
    }
    // veils of sand blowing along the ground: long streaks that run with the wind and come in gusts
    if (up * low > 0.01 && away < 45.0) {
      float gust = smoothstep(0.30, 0.70, texture2D(tSandNoise, vec2(uSandTime * 0.11, 4.2) * ${b} + xz * 0.03).b);
      float streak = texture2D(tSandNoise, vec2(dot(sp.xz, uWind) * 0.35 - uSandTime * 1.6, dot(sp.xz, across) * 2.4) * ${b}).g;
      float veil = up * low * smoothstep(0.50, 0.66, streak) * gust * min(1.0, uSand * 1.4) * (1.0 - smoothstep(18.0, 45.0, away));
      diffuseColor.rgb = mix(diffuseColor.rgb, uSandColor * 1.12, veil * 0.6);
    }
  }
  // Worn and chipped edges. Every outward edge has lost its arris (a centimetre, rounded off); here and there a
  // piece has broken away, up to a hand wide, with small nicks between. The broken face slopes down to the edge
  // and shows the stone as it is inside: paler, without the carving.
  if (uChips > 0.0 && toEdge < 0.14 && away < 42.0) {
    float piece = texture2D(tSandNoise, gp * 7.0 + 0.3).r, nick = texture2D(tSandNoise, gp * 43.0).g;
    float width = (0.011 + 0.105 * smoothstep(0.50, 0.74, piece) + 0.024 * nick) * uChips;
    sandChip = (1.0 - smoothstep(0.72 * width, width, toEdge)) * (1.0 - sandMask) * (1.0 - smoothstep(26.0, 42.0, away));
    sandSlope = edgeWay * 0.95 * sandChip;
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.22 + vec3(0.035, 0.028, 0.018), sandChip * (0.45 + 0.4 * nick));
  }
}`).replace(`#include <roughnessmap_fragment>`,`#include <roughnessmap_fragment>
roughnessFactor = mix(mix(roughnessFactor, 0.96, sandMask), 0.22, sandGlint);
#ifdef USE_ROUGHNESSMAP
  // dirt gathers where the baked occlusion says little light gets in (it is the red of the lookup just made)
  diffuseColor.rgb *= mix(vec3(1.0), vec3(0.58, 0.51, 0.44), clamp((1.0 - texelRoughness.r) * 1.5, 0.0, 1.0) * (1.0 - sandMask) * (1.0 - sandChip) * uAge);
#endif`).replace(`#include <normal_fragment_maps>`,me.normal_fragment_maps.replace(`vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz`,`vec3 mapN = sandSmooth( normalMap, vNormalMapUv ).xyz`)+`
normal = normalize(mix(normal, nonPerturbedNormal, max(sandMask * 0.85, sandChip * 0.75)));
normal = sandRelief(-vViewPosition, normal, sandBump * (1.0 - sandMask) * (1.0 - sandChip) + sandSlope, faceDirection);`)},e.customProgramCacheKey=()=>`sand-layer-6`,e.needsUpdate=!0}var Fe=`
precision highp sampler2DShadow;
uniform sampler2D tDepth; uniform sampler2DShadow tShadow; uniform mat4 uInvViewProj, uShadowMatrix; uniform vec3 uCam; uniform float uReach, uFrame;
varying vec2 vUv;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  float d = texture2D(tDepth, vUv).x;
  vec4 w = uInvViewProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec3 ray = w.xyz / w.w - uCam;
  float dist = d > 0.99999 ? uReach : min(length(ray), uReach);
  vec3 dir = normalize(ray);
  const int N = 12;
  float stepLen = dist / float(N), jitter = ign(gl_FragCoord.xy + 5.588238 * uFrame);
  // the line's two ends in the shadow map: every step lies on the straight line between them (the sun's map is flat)
  vec4 s0 = uShadowMatrix * vec4(uCam, 1.0), s1 = uShadowMatrix * vec4(uCam + dir * dist, 1.0);
  float lit = 0.0, whole = 0.0;
  for (int i = 0; i < N; i++) {
    float t = (float(i) + jitter) / float(N);
    float thick = exp(-max(uCam.y + dir.y * dist * t, 0.0) / 7.0);
    vec3 sc = mix(s0.xyz, s1.xyz, t);
    float inSun = all(greaterThan(sc, vec3(0.0))) && all(lessThan(sc, vec3(1.0))) ? texture(tShadow, vec3(sc.xy, sc.z - 0.0015)) : 1.0;
    lit += inSun * thick; whole += thick;
  }
  gl_FragColor = vec4(lit * stepLen, whole * stepLen, 0.0, 1.0);
}`,Ie=`
uniform sampler2D tSrc, tDepth, tRays, tNoise; uniform vec2 uRaysTexel; uniform mat4 uInvViewProj; uniform vec3 uCam, uSun, uDustColor;
uniform float uDensity, uTime, uFar, uShafts, uHeat;
varying vec2 vUv;
void main() {
  float d = texture2D(tDepth, vUv).x;
  vec4 w = uInvViewProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec3 ray = w.xyz / w.w - uCam;
  float dist = length(ray); vec3 dir = ray / max(dist, 1e-4);
  if (d > 0.99999) dist = uFar;   // the sky: dust all the way out
  // heat haze: stronger with distance, strongest just over the ground, rising
  float shimmer = uHeat * smoothstep(14.0, 70.0, dist) * exp(-max(uCam.y + dir.y * min(dist, 80.0), 0.0) / 2.5);
  vec2 wob = texture2D(tNoise, vUv * vec2(9.0, 5.0) + vec2(0.0, -uTime * 0.35)).rg - 0.5;
  vec3 col = texture2D(tSrc, vUv + wob * shimmer * 0.006).rgb;
  // density falls off with height (scale 7 m): its integral along the ray, in closed form
  const float H = 7.0;
  float a = max(uCam.y, 0.0) / H, b = dir.y * dist / H;
  float through = dist * exp(-a) * (abs(b) > 1e-3 ? (1.0 - exp(-b)) / b : 1.0);
  // it is not even: slow banks of it drift past
  float banks = 0.7 + 0.6 * texture2D(tNoise, dir.xz * 0.15 + vec2(uTime * 0.0013, dir.y * 0.19)).b;
  float keep = exp(-uDensity * through * banks);
  float mu = dot(dir, normalize(uSun));
  float lit = 0.55 + 0.20 * (1.0 + mu * mu) + 1.6 * pow(max(mu, 0.0), 10.0);
  // the shafts: the dust's sunlit share along this line (four taps of the half-size rays, which smooths their grain)
  vec4 rays = (texture2D(tRays, vUv + uRaysTexel * vec2(0.5, 0.5)) + texture2D(tRays, vUv + uRaysTexel * vec2(-0.5, 0.5))
    + texture2D(tRays, vUv + uRaysTexel * vec2(0.5, -0.5)) + texture2D(tRays, vUv + uRaysTexel * vec2(-0.5, -0.5))) * 0.25;
  float inSun = uShafts > 0.0 ? rays.r / max(rays.g, 1e-3) : 1.0;
  // dust in shade is lit by the sky alone; dust in the sun glows, most of all looking up the beam
  vec3 haze = uDustColor * lit * mix(1.0, 0.22 + 0.78 * inSun, min(uShafts, 1.0)) * (1.0 - keep);
  // (the beam is what stands out against shade: it counts by how much of the line is in the sun and how much is not)
  float contrast = inSun * (1.0 - inSun) * 4.0;
  vec3 beam = uDustColor * uShafts * (0.5 + 0.5 * (1.0 + mu * mu) * 0.5 + 3.0 * pow(max(mu, 0.0), 6.0)) * (0.25 + 0.75 * contrast) * (1.0 - exp(-uDensity * 7.0 * rays.r * banks));
  gl_FragColor = vec4(col * keep + haze + beam, 1.0);
}`;function Le(e=2600,n=18){let r=new Float32Array(e*3),i=new Float32Array(e);for(let t=0;t<e;t++)r[3*t]=Math.random(),r[3*t+1]=Math.random(),r[3*t+2]=Math.random(),i[t]=.4+1.6*Math.random()**3;let a=new ye;a.setAttribute(`position`,new de(r,3)),a.setAttribute(`aSize`,new de(i,1));let o=new d({transparent:!0,depthWrite:!1,blending:2,toneMapped:!1,uniforms:{uTime:{value:0},uBox:{value:n},uHeight:{value:800},uAmount:{value:1},uWind:x.uWind,uSun:{value:new t(0,1,0)},uLight:{value:new ae(3.2,2.5,1.7)}},vertexShader:`
attribute float aSize; uniform float uTime, uBox, uHeight; uniform vec2 uWind;
varying float vFade; varying float vGlint;
void main() {
  // a box of grains that travels with the camera: each drifts on the wind, sinks a little, and wraps round
  vec3 drift = vec3(uWind.x, -0.06, uWind.y) * uTime * 0.55 + 0.25 * sin(uTime * vec3(0.31, 0.23, 0.37) + position * 40.0);
  vec3 p = cameraPosition + (fract(position + (drift - cameraPosition) / uBox) - 0.5) * uBox;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float dist = -mv.z;
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * 0.012 * uHeight / max(dist, 0.3), 1.0, 7.0);
  // none right at the lens, none at the box's edge, fewer underfoot than at eye height
  vFade = smoothstep(0.5, 1.6, dist) * (1.0 - smoothstep(0.38 * uBox, 0.5 * uBox, dist)) * smoothstep(-0.2, 0.8, p.y);
  vGlint = 0.6 + 0.8 * fract(sin(dot(position, vec3(12.9, 78.2, 37.7))) * 43758.5 + uTime * 0.7);
}`,fragmentShader:`
uniform vec3 uLight; uniform float uAmount; varying float vFade; varying float vGlint;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = (1.0 - smoothstep(0.2, 1.0, r)) * vFade * uAmount;
  gl_FragColor = vec4(uLight * vGlint * a * 0.22, a);
}`}),s=new u(a,o);return s.frustumCulled=!1,s}var Re=`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,S=(e,t)=>new d({vertexShader:Re,fragmentShader:e,uniforms:t,depthTest:!1,depthWrite:!1,toneMapped:!1}),ze=`
uniform sampler2D tDepth; uniform float uNear, uFar;
float viewZ(vec2 uv) { float z = texture2D(tDepth, uv).x * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }`,Be=`
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uFocus, uCoc, uMaxCoc, uFrame;
varying vec2 vUv;
${ze}
float coc(float z) { return min(uMaxCoc, uCoc * abs(1.0 / uFocus - 1.0 / max(z, 0.05))); }
void main() {
  float z = viewZ(vUv), c0 = coc(z);
  vec3 acc = texture2D(tSrc, vUv).rgb; float w = 1.0 + 0.5 * min(luma(acc), 6.0);
  acc *= w;
  float spin = ign(gl_FragCoord.xy + 5.588238 * uFrame) * 6.2831853;
  // each sample a golden angle on from the last: one turn of the direction, no sine or cosine per sample
  vec2 dir = vec2(cos(spin), sin(spin));
  const mat2 turn = mat2(-0.73736888, 0.67549029, -0.67549029, -0.73736888);
  for (int i = 1; i <= 20; i++) {
    float r = sqrt(float(i) / 20.0), a = float(i) * 2.39996323 + spin;
    dir = turn * dir;
    // the blades: seven, a little straighter between their corners than a circle (an aperture near full open)
    float t = fract(a * 1.1140846 + 0.33) - 0.5;
    r *= 1.0 - 0.06 * (1.0 - 4.0 * t * t);
    vec2 o = dir * r * uMaxCoc;
    vec2 uv = vUv + o * uTexel;
    float sz = viewZ(uv), sc = coc(sz);
    // what lies behind a sharp thing does not smear over it
    if (sz > z) sc = min(sc, c0 * 2.0);
    vec3 s = texture2D(tSrc, uv).rgb;
    float k = smoothstep(r * uMaxCoc - 1.0, r * uMaxCoc + 1.0, sc) * (1.0 + 0.5 * min(luma(s), 6.0));
    acc += s * k; w += k;
  }
  gl_FragColor = vec4(acc / w, 1.0);
}`,Ve=`
uniform sampler2D tSrc; uniform mat4 uInvViewProj, uPrevViewProj; uniform float uShutter;
varying vec2 vUv;
${ze}
void main() {
  float d = texture2D(tDepth, vUv).x;
  vec4 world = uInvViewProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 prev = uPrevViewProj * vec4(world.xyz / world.w, 1.0);
  vec2 v = (vUv - (prev.xy / prev.w * 0.5 + 0.5)) * uShutter;
  float len = length(v);
  if (len < 0.0004) { gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.0); return; }
  if (len > 0.05) v *= 0.05 / len;
  vec3 acc = vec3(0.0);
  float j = ign(gl_FragCoord.xy) - 0.5;
  for (int i = 0; i < 8; i++) acc += texture2D(tSrc, vUv - v * ((float(i) + j) / 7.0 - 0.5)).rgb;
  gl_FragColor = vec4(acc / 8.0, 1.0);
}`,He=`
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uKnee;
varying vec2 vUv;
void main() {
  vec2 o = uTexel;
  vec3 m = texture2D(tSrc, vUv).rgb, a = texture2D(tSrc, vUv + o).rgb, b = texture2D(tSrc, vUv - o).rgb;
  vec3 e = texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb, f = texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb;
  vec3 c;
  if (uKnee > 0.0) {
    // the bright pass. Each sample counts less the brighter it is: one very bright texel (a window bar's edge, a
    // glint) then cannot swing the whole glow as the camera moves across it
    vec4 k = vec4(1.0) / (1.0 + vec4(max(a.r, max(a.g, a.b)), max(b.r, max(b.g, b.b)), max(e.r, max(e.g, e.b)), max(f.r, max(f.g, f.b))) / uKnee);
    float km = 4.0 / (1.0 + max(m.r, max(m.g, m.b)) / uKnee);
    c = (m * km + a * k.x + b * k.y + e * k.z + f * k.w) / (km + k.x + k.y + k.z + k.w);
    float l = max(c.r, max(c.g, c.b));
    c *= smoothstep(uKnee, uKnee * 3.0, l);
  } else c = m * 0.5 + (a + b + e + f) * 0.125;
  gl_FragColor = vec4(min(c, vec3(64.0)), 1.0);
}`,Ue=`
uniform sampler2D tSrc, tAdd; uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec2 o = uTexel * 0.5;
  vec3 c = (texture2D(tSrc, vUv + vec2(-o.x * 2.0, 0.0)).rgb + texture2D(tSrc, vUv + vec2(o.x * 2.0, 0.0)).rgb
    + texture2D(tSrc, vUv + vec2(0.0, -o.y * 2.0)).rgb + texture2D(tSrc, vUv + vec2(0.0, o.y * 2.0)).rgb
    + (texture2D(tSrc, vUv + o).rgb + texture2D(tSrc, vUv - o).rgb + texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb
      + texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb) * 2.0) / 12.0;
  gl_FragColor = vec4(c + texture2D(tAdd, vUv).rgb, 1.0);
}`,We=`
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uLevel, uRange, uCap;
varying vec2 vUv;
vec3 tap(vec2 o) { return min(texture2D(tSrc, vUv + o * uTexel).rgb, vec3(256.0)); }
void main() {
  vec3 c = tap(vec2(0)) * 0.125
    + (tap(vec2(-2, 2)) + tap(vec2(2, 2)) + tap(vec2(-2, -2)) + tap(vec2(2, -2))) * 0.03125
    + (tap(vec2(0, 2)) + tap(vec2(-2, 0)) + tap(vec2(2, 0)) + tap(vec2(0, -2))) * 0.0625
    + (tap(vec2(-1, 1)) + tap(vec2(1, 1)) + tap(vec2(-1, -1)) + tap(vec2(1, -1))) * 0.125;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = vec4(c * smoothstep(uLevel, uLevel + uRange, l) * min(1.0, uCap / max(l, 1e-4)), 1.0);
}`,Ge=`
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uOffset;
varying vec2 vUv;
void main() {
  vec2 o = uTexel * uOffset;
  gl_FragColor = vec4((texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb + texture2D(tSrc, vUv + o).rgb
    + texture2D(tSrc, vUv - o).rgb + texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb) * 0.25, 1.0);
}`,Ke=`
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uGhost, uHalo, uChroma, uSpin;
varying vec2 vUv;
float hash1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
// rays around the frame's centre: fine ones over broad ones, sliding as the camera turns
float rays(vec2 d) {
  float a = atan(d.y, d.x) * 0.15915494 + 0.5;
  float x = a * 120.0 + uSpin, y = a * 28.0 - uSpin * 0.37;
  float fx = fract(x), fy = fract(y);
  fx = fx * fx * (3.0 - 2.0 * fx); fy = fy * fy * (3.0 - 2.0 * fy);
  float fine = mix(hash1(mod(floor(x), 120.0)), hash1(mod(floor(x) + 1.0, 120.0)), fx);
  float broad = mix(hash1(mod(floor(y), 28.0) + 300.0), hash1(mod(floor(y) + 1.0, 28.0) + 300.0), fy);
  return 0.45 + 0.75 * fine * fine + 0.5 * broad;
}
vec3 ghost(vec2 dir, vec3 tint, float offset) {
  vec2 suv = clamp(1.0 - vUv + dir * offset, 0.0, 1.0);
  float d = clamp(length(0.5 - suv) / 0.70710678, 0.0, 1.0);
  // every reflection disperses a little: red lands slightly further out than blue, fringing each ghost
  vec2 cd = (suv - 0.5) * 0.012 * sign(offset);
  vec3 s = vec3(texture2D(tSrc, clamp(suv + cd, 0.0, 1.0)).r, texture2D(tSrc, suv).g, texture2D(tSrc, clamp(suv - cd, 0.0, 1.0)).b);
  return s * tint * pow(1.0 - d, 3.0);
}
float ring(float x, float radius, float thickness) {
  float v = min(abs(x - radius) / thickness, 1.0);
  return 1.0 - v * v * (3.0 - 2.0 * v);
}
void main() {
  vec2 dir = vUv - 0.5;
  vec3 c = ghost(dir, vec3(0.8, 0.8, 1.0), -5.0) + ghost(dir, vec3(1.0, 0.8, 0.4), -1.5)
    + ghost(dir, vec3(0.9, 1.0, 0.8), -0.4) + ghost(dir, vec3(1.0, 0.8, 0.4), -0.2)
    + ghost(dir, vec3(0.9, 0.7, 0.7), -0.1) + ghost(dir, vec3(0.5, 1.0, 0.4), 0.7)
    + ghost(dir, vec3(0.5, 0.5, 0.5), 1.0) + ghost(dir, vec3(1.0, 1.0, 0.6), 2.5)
    + ghost(dir, vec3(0.5, 0.8, 1.0), 10.0);
  c *= uGhost;
  // spectral halo ring: each channel refracted a little differently
  vec2 aspect = vec2(uTexel.x / uTexel.y, 1.0);
  vec2 hd = normalize(dir / aspect + 1e-6) * aspect;
  vec2 huv = fract(1.0 - vUv + hd * 0.3);
  vec3 off = vec3(uTexel.x * uChroma) * vec3(-1.0, 0.0, 1.0);
  vec3 halo = vec3(texture2D(tSrc, huv + hd * off.r).r, texture2D(tSrc, huv + hd * off.g).g, texture2D(tSrc, huv + hd * off.b).b);
  vec2 wuv = (vUv - vec2(0.5, 0.0)) / aspect + vec2(0.5, 0.0);
  c += halo * ring(clamp(distance(wuv, vec2(0.5)), 0.0, 1.0), 0.45, 0.25) * uHalo * rays(dir / aspect);
  gl_FragColor = vec4(c, 1.0);
}`,qe=`
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uStep, uDecay;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb; float w = 1.0;
  for (int i = 1; i <= 6; i++) {
    float k = exp(-float(i) * uDecay);
    vec2 o = vec2(float(i) * uStep * uTexel.x, 0.0);
    c += (texture2D(tSrc, vUv + o).rgb + texture2D(tSrc, vUv - o).rgb) * k; w += 2.0 * k;
  }
  gl_FragColor = vec4(c / w, 1.0);
}`,Je=`
uniform sampler2D tSrc; varying vec2 vUv;
void main() {
  float l = dot(texture2D(tSrc, vUv).rgb, vec3(0.2126, 0.7152, 0.0722));
  float w = 1.0 - 0.6 * smoothstep(0.2, 0.75, distance(vUv, vec2(0.5)));
  gl_FragColor = vec4(log(max(l, 1e-4)) * w, w, 0.0, 1.0);
}`,Ye=`
uniform sampler2D tSrc, tBloom, tBloomWide, tDirt, tFlare, tStreak, tStreakCore;
uniform vec2 uRes; uniform float uExposure, uBloomI, uDirtI, uFlareI, uStreakI, uFlareDirt, uCA, uVignette, uGrain, uTime, uLens, uFilm;
uniform vec3 uStreakTint;
varying vec2 vUv;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 AgX(vec3 color) {
  const mat3 R709to2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
  const mat3 R2020to709 = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
  const mat3 inset = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 outset = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  color = inset * (R709to2020 * color);
  color = clamp((log2(max(color, 1e-10)) + 12.47393) / 16.5, 0.0, 1.0);
  color = agxContrast(color);
  float l = luma(color);
  color = pow(max(color, 0.0), vec3(1.12));
  color = l + (color - l) * 1.06;
  color = outset * color;
  color = pow(max(color, 0.0), vec3(2.2));
  return clamp(R2020to709 * color, 0.0, 1.0);
}
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
void main() {
  vec2 uv = vUv, c = uv - 0.5;
  float aspect = uRes.x / uRes.y;
  // a little colour fringing towards the corners, as a wide lens has
  vec2 ca = c * dot(c, c) * uCA * uFilm;
  vec3 col = vec3(texture2D(tSrc, uv + ca).r, texture2D(tSrc, uv).g, texture2D(tSrc, uv - ca).b);
  // ---- bloom with lens dirt: smudges and dust on the front element scatter the light of any bright thing
  // nearby in frame; the wide, low bloom level is the light falling on each speck
  vec2 duv = c * vec2(aspect / 1.6, 1.0) + 0.5;
  vec3 dirt = texture2D(tDirt, duv).rgb;
  // The glow comes in two parts. Close around a light it leans warm, as light scattered back through the sensor's
  // layers does (halation); the wide part is the veil a lens lays over the frame when it faces a window.
  vec3 wide = texture2D(tBloomWide, uv).rgb, tight = max(texture2D(tBloom, uv).rgb - wide, 0.0);
  col += (tight * vec3(1.08, 0.97, 0.86) * 0.9 + wide * 1.2) * uBloomI * uLens + dirt * wide * uDirtI * uLens;
  // ghosts, halo and streaks from every bright source; the dirty front element catches them.
  // Streaks: a short warm core inside a long, cool anamorphic line.
  vec3 lens = texture2D(tFlare, uv).rgb * uFlareI
    + (texture2D(tStreakCore, uv).rgb * vec3(1.0, 0.88, 0.75) * 0.35 + texture2D(tStreak, uv).rgb * uStreakTint) * uStreakI;
  col += lens * (1.0 + luma(dirt) * uFlareDirt) * uLens;
  col *= uExposure;
  // the lens passes less light to the corners
  float r2 = dot(c * vec2(aspect, 1.0), c * vec2(aspect, 1.0));
  col *= mix(1.0, 1.0 / pow(1.0 + r2 * 0.9, 2.0), uVignette * uFilm);
  col = toSRGB(AgX(col));
  // grain: more of it in the shadows, where a sensor is noisiest
  // (two throws of the dice summed: most grains are faint and a few stand out, as silver does; each colour layer
  // has a little grain of its own)
  vec2 gp = gl_FragCoord.xy + fract(uTime) * 311.7;
  float g = hash(gp) + hash(gp + 71.3) - 1.0;
  vec3 g3 = vec3(g) + (fract(hash(gp + 13.1) * vec3(1.0, 7.13, 13.71)) - 0.5) * 0.3;
  col += g3 * uGrain * 0.8 * uFilm * mix(1.6, 0.5, luma(col));
  gl_FragColor = vec4(col, 1.0);
}`;function Xe(){let e=1024,t=document.createElement(`canvas`);t.width=t.height=e;let n=t.getContext(`2d`);n.fillStyle=`#000`,n.fillRect(0,0,e,e),n.globalCompositeOperation=`lighter`;let r=1234567,i=()=>(r=r*1664525+1013904223>>>0)/4294967296,a=e=>{let t=i(),[n,r,a]=t<.3?[255,236,210]:t<.55?[215,232,255]:[255,255,255];return t=>`rgba(${n},${r},${a},${e*t})`},o=(e,t,r,i)=>{let a=n.createRadialGradient(e,t,0,e,t,r);for(let[e,t]of i)a.addColorStop(e,t);n.fillStyle=a,n.beginPath(),n.arc(e,t,r,0,Math.PI*2),n.fill()};for(let t=0;t<26;t++){let t=a(.035+i()*.05);o(i()*e,i()*e,90+i()*220,[[0,t(1)],[.6,t(.5)],[1,t(0)]])}for(let t=0;t<110;t++){let t=a(.04+i()*.16);o(i()*e,i()*e,8+i()**2.2*120,[[0,t(1)],[.5,t(.45)],[1,t(0)]])}for(let t=0;t<40;t++){let t=a(.05+i()*.12);o(i()*e,i()*e,4+i()**1.8*26,[[0,t(.35)],[.6,t(.5)],[.86,t(1)],[1,t(0)]])}n.lineCap=`round`;for(let t=0;t<7;t++){let t=i()*e,r=i()*e,o=120+i()*360,s=i()*Math.PI*2,c=.3+i()*.7,l=a(.025+i()*.04);for(let e=0;e<16;e++)n.strokeStyle=l(.4+i()*.6),n.lineWidth=.6+i()*1.6,n.beginPath(),n.arc(t,r,o+e*(2+i()*3),s+i()*.08,s+c-i()*.1),n.stroke()}for(let t=0;t<5;t++){n.strokeStyle=a(.12+i()*.12)(1),n.lineWidth=.8+i()*.8,n.beginPath();let t=i()*e,r=i()*e;n.moveTo(t,r);for(let e=0;e<3;e++){let e=t+(i()-.5)*140,a=r+(i()-.5)*140;n.quadraticCurveTo(t+(i()-.5)*90,r+(i()-.5)*90,e,a),t=e,r=a}n.stroke()}for(let t=0;t<1400;t++){let t=a(.15+i()**3*.75);o(i()*e,i()*e,.8+i()**4*4.5,[[0,t(1)],[.5,t(.7)],[1,t(0)]])}let s=new ie(t);return s.colorSpace=``,s.minFilter=ne,s}var Ze=`modulepreload`,Qe=function(e,t){return new URL(e,t).href},$e={},et=function(e){return e.pathname.endsWith(`.css`)},tt=function(e,t,n){if(t in e)return e[t];let r=n();if(!r){e[t]=void 0;return}let i=r.then(()=>{e[t]=void 0},n=>{throw e[t]=void 0,n});return e[t]=i,i},nt=function(e,t,n){let r=Promise.resolve();if(t&&t.length>0){let e,i=document.querySelector(`meta[property=csp-nonce]`),a=i?.nonce||i?.getAttribute(`nonce`);function o(e){return Promise.all(e.map(e=>Promise.resolve(e).then(e=>({status:`fulfilled`,value:e}),e=>({status:`rejected`,reason:e}))))}function s(e){return import.meta.resolve?new URL(import.meta.resolve(e)):new URL(e,import.meta.url)}r=o(t.map(t=>{t=Qe(t,n);let r=s(t),i=et(r);return tt($e,r.href,()=>{if(e===void 0){e={all:new Set,styles:new Set};let t=document.getElementsByTagName(`link`);for(let n=t.length-1;n>=0;n--){let r=t[n];e.all.add(r.href),r.rel===`stylesheet`&&e.styles.add(r.href)}}if((i?e.styles:e.all).has(r.href))return;let t=document.createElement(`link`);if(t.rel=i?`stylesheet`:Ze,i||(t.as=`script`),t.crossOrigin=``,t.href=r.href,a&&t.setAttribute(`nonce`,a),document.head.appendChild(t),i)return new Promise((e,n)=>{t.addEventListener(`load`,e),t.addEventListener(`error`,()=>n(Error(`Unable to preload CSS for ${r}`)))})})}).filter(e=>e!==void 0))}function i(e){let t=new Event(`vite:preloadError`,{cancelable:!0});if(t.payload=e,window.dispatchEvent(t),!t.defaultPrevented)throw e}return r.then(t=>{for(let e of t||[])e.status===`rejected`&&i(e.reason);return e().catch(i)})},rt=`
.potemkin-notes-ui {
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  color: #f2f2f2;
}
.potemkin-notes-btn {
  position: fixed;
  right: max(18px, env(safe-area-inset-right));
  bottom: max(18px, env(safe-area-inset-bottom));
  z-index: 25;
  min-height: 44px;
  min-width: 76px;
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  background: rgba(20, 20, 22, 0.9);
  color: #f2f2f2;
  font: 500 13px/1.2 ui-sans-serif, system-ui, sans-serif;
  cursor: pointer;
}
body:has(.potemkin-menu-trigger) .potemkin-notes-btn {
  right: calc(max(18px, env(safe-area-inset-right)) + 86px);
}
.potemkin-notes-btn:hover {
  background: #242424;
  border-color: rgba(255, 255, 255, 0.38);
}
.potemkin-notes-btn:focus-visible {
  outline: 2px solid #e5e5e5;
  outline-offset: 2px;
}
`;function it(e){let t=document.createElement(`style`);t.textContent=rt,document.head.append(t);let n=document.createElement(`div`);n.className=`potemkin-notes-ui`;let r=document.createElement(`button`);r.type=`button`,r.className=`potemkin-notes-btn`,r.setAttribute(`aria-expanded`,`false`),r.textContent=`Notes · I`,n.append(r),document.body.append(n);let i=null,a=null,o=async()=>{i?i.toggle():(a||=(r.textContent=`Loading…`,nt(()=>import(`./walk-notes-CgRskEqF.js`).then(t=>(r.textContent=`Notes · I`,i=t.attachWalkNotesDrawer({...e,root:n,btn:r}),i.setOpen(!0),i)),[],import.meta.url).catch(()=>{r.textContent=`Notes · I`,a=null})),await a)};return r.addEventListener(`click`,e=>{e.stopPropagation(),o()}),window.addEventListener(`keydown`,e=>{if(e.metaKey||e.ctrlKey||e.altKey||e.repeat)return;let t=e.key.toLowerCase();t===`i`||e.key===`?`?o():t===`escape`&&i&&!document.pointerLockElement&&i.setOpen(!1)}),{tick(){i?.tick()}}}ye.prototype.computeBoundsTree=pe,n.prototype.raycast=ve;var C=new URLSearchParams(location.search),w=document.getElementById(`view`),at=document.getElementById(`hud`),ot=document.getElementById(`msg`),T=new _e({canvas:w,antialias:!1,powerPreference:`high-performance`}),st=Math.min(window.devicePixelRatio,Number(C.get(`ratio`))||1.5),ct=Number(C.get(`res`))||0,E=ct||1;T.setPixelRatio(1),T.autoClear=!1,T.toneMapping=0,T.shadowMap.enabled=!0,T.shadowMap.type=1;var D={hdr:!0,lens:!0,dof:!0,blur:!0,film:!0,maps:!0,dust:!0,rays:!0,chips:!0,age:!0,pom:C.get(`pom`)!==`0`,pomShadow:C.get(`pomShadow`)!==`0`},lt=Number(C.get(`depth`)??.025);y.uPomDepth.value=Number.isFinite(lt)?g.clamp(lt,0,.12):.025;var ut=.05,dt=400,O=new i(62,1,ut,dt),k=new l,ft=new l,pt=new m(-1,1,1,-1,0,1),mt=new n(new r(2,2));mt.frustumCulled=!1,ft.add(mt);var ht={type:ee,minFilter:_,magFilter:_,depthBuffer:!1},A=(e,t,n={})=>new h(Math.max(1,Math.round(e)),Math.max(1,Math.round(t)),{...ht,...n}),j=null;function gt(){let e=Math.max(64,Math.floor(window.innerWidth*st*E)),t=Math.max(64,Math.floor(window.innerHeight*st*E));if(T.setSize(e,t,!1),O.aspect=e/t,O.updateProjectionMatrix(),j)for(let e of j.all)e.dispose();let n=A(e,t,{depthBuffer:!0,depthTexture:new fe(e,t,f),samples:e*t>16e5?2:4}),r=Array.from({length:6},(n,r)=>A(e/2**(r+1),t/2**(r+1))),i=Array.from({length:5},(n,r)=>A(e/2**(r+1),t/2**(r+1)));j={w:e,h:t,scene:n,dust:A(e,t),rays:A(e/2,t/2),dof:A(e,t),blur:A(e,t),mips:r,ups:i,ldr:new h(e,t,{minFilter:_,magFilter:_,depthBuffer:!1}),flareA:A(e/4,t/4),flareB:A(e/4,t/4),streakA:A(e/4,t/4),streakB:A(e/4,t/4),meter:A(e/8,t/8),lum:new h(32,32,{type:oe,minFilter:xe,magFilter:xe,depthBuffer:!1})},j.all=[n,j.ldr,j.dust,j.rays,j.dof,j.blur,...r,...i,j.flareA,j.flareB,j.streakA,j.streakB,j.meter,j.lum]}var M=e=>new v(1/e.width,1/e.height),_t=(e,t)=>e.elements.some((e,n)=>Math.abs(e-t.elements[n])>.0012);function N(e,t,n={}){for(let[t,r]of Object.entries(n)){let n=e.uniforms[t];r?.isVector2||r?.isVector3||r?.isMatrix4||r?.isColor?n.value.copy(r):n.value=r}mt.material=e,T.setRenderTarget(t),T.render(ft,pt)}var vt=`
precision highp sampler3D;
uniform sampler2D tSrc; uniform sampler3D tLut; uniform vec2 uTexel; uniform float uSize, uAmount, uSharp;
varying vec2 vUv;
void main() {
  vec3 m = texture2D(tSrc, vUv).rgb;
  vec3 n = texture2D(tSrc, vUv + vec2(0.0, -uTexel.y)).rgb, s = texture2D(tSrc, vUv + vec2(0.0, uTexel.y)).rgb;
  vec3 w = texture2D(tSrc, vUv + vec2(-uTexel.x, 0.0)).rgb, e = texture2D(tSrc, vUv + vec2(uTexel.x, 0.0)).rgb;
  vec3 lo = min(m, min(min(n, s), min(w, e))), hi = max(m, max(max(n, s), max(w, e)));
  vec3 amp = sqrt(clamp(min(lo, 1.0 - hi) / max(hi, 1e-3), 0.0, 1.0));
  vec3 k = -amp * uSharp * 0.2;
  vec3 c = clamp((m + (n + s + w + e) * k) / (1.0 + 4.0 * k), 0.0, 1.0);
  // the cube's first and last entries sit at the centres of its outer texels
  vec3 g = uAmount > 0.0 ? texture(tLut, c * ((uSize - 1.0) / uSize) + 0.5 / uSize).rgb : c;
  gl_FragColor = vec4(mix(c, g, uAmount), 1.0);
}`,yt=()=>({tDepth:{value:null},uNear:{value:ut},uFar:{value:dt}}),P={dof:S(Be,{...yt(),tSrc:{value:null},uTexel:{value:new v},uFocus:{value:4},uCoc:{value:0},uMaxCoc:{value:14},uFrame:{value:0}}),blur:S(Ve,{...yt(),tSrc:{value:null},uInvViewProj:{value:new p},uPrevViewProj:{value:new p},uShutter:{value:.5}}),down:S(He,{tSrc:{value:null},uTexel:{value:new v},uKnee:{value:0}}),up:S(Ue,{tSrc:{value:null},tAdd:{value:null},uTexel:{value:new v}}),threshold:S(We,{tSrc:{value:null},uTexel:{value:new v},uLevel:{value:3},uRange:{value:4},uCap:{value:1e4}}),flareBlur:S(Ge,{tSrc:{value:null},uTexel:{value:new v},uOffset:{value:1.5}}),features:S(Ke,{tSrc:{value:null},uTexel:{value:new v},uGhost:{value:.05},uHalo:{value:.06},uChroma:{value:24},uSpin:{value:0}}),streak:S(qe,{tSrc:{value:null},uTexel:{value:new v},uStep:{value:1},uDecay:{value:.4}}),lum:S(Je,{tSrc:{value:null}}),rays:S(Fe,{tDepth:{value:null},tShadow:{value:null},uInvViewProj:{value:new p},uShadowMatrix:{value:new p},uCam:{value:new t},uReach:{value:70},uFrame:{value:0}}),dust:S(Ie,{tSrc:{value:null},tDepth:{value:null},tRays:{value:null},uRaysTexel:{value:new v},uShafts:{value:0},uInvViewProj:{value:new p},uCam:{value:new t},uSun:{value:new t(0,1,0)},uDustColor:{value:new ae(2.3,1.85,1.3)},uDensity:{value:.006},uTime:{value:0},uFar:{value:220},tNoise:{value:Ne},uHeat:{value:1}}),grade:S(vt,{tSrc:{value:null},tLut:{value:null},uTexel:{value:new v},uSize:{value:33},uAmount:{value:0},uSharp:{value:.8}}),final:S(Ye,{tSrc:{value:null},tBloom:{value:null},tBloomWide:{value:null},tDirt:{value:Xe()},tFlare:{value:null},tStreak:{value:null},tStreakCore:{value:null},uRes:{value:new v},uExposure:{value:1},uBloomI:{value:.018},uDirtI:{value:.06},uFlareI:{value:.5},uStreakI:{value:.12},uFlareDirt:{value:1.5},uStreakTint:{value:new ae(.55,.75,1)},uCA:{value:.012},uVignette:{value:.8},uGrain:{value:.022},uTime:{value:0},uLens:{value:1},uFilm:{value:1}})},bt=`
uniform vec3 uSun; uniform float uDisc; uniform sampler2D tNoise;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, 0.0, 1.0);
  vec3 c = mix(vec3(1.05, 1.0, 0.92) * 2.2, vec3(0.26, 0.48, 1.0) * 1.5, pow(h, 0.45));
  // the ground's own light, for what faces down: sunlit sand and paving
  c = mix(vec3(0.95, 0.76, 0.52) * 1.6, c, smoothstep(-0.06, 0.04, d.y));
  // a few high, thin clouds, drawn out along the wind; none near the horizon, where the dust is
  vec2 over = d.xz / (d.y + 0.18);
  float cirrus = smoothstep(0.50, 0.78, texture2D(tNoise, over * vec2(0.035, 0.012) + 0.21).r * 0.65 + texture2D(tNoise, over * vec2(0.16, 0.05)).g * 0.35);
  c = mix(c, vec3(2.9, 2.75, 2.55), cirrus * 0.42 * smoothstep(0.06, 0.35, d.y));
  float s = dot(d, normalize(uSun));
  c += vec3(1.0, 0.86, 0.62) * (0.9 * pow(max(s, 0.0), 24.0) + 5.0 * pow(max(s, 0.0), 900.0));   // the glow round the sun
  c += vec3(1.0, 0.95, 0.85) * 420.0 * smoothstep(0.99990, 0.99996, s) * uDisc;                  // its disc
  gl_FragColor = vec4(c, 1.0);
}`,xt={uSun:{value:new t(0,1,0)},uDisc:{value:1},tNoise:{value:Ne}},St=()=>new d({side:1,depthWrite:!1,toneMapped:!1,uniforms:xt,fragmentShader:bt,vertexShader:`varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0); }`}),Ct=new n(new a(300,32,16),St());Ct.frustumCulled=!1,k.add(Ct);var wt=new te(T),F=null;function Tt(){let e=new l;e.add(new n(new a(50,32,16),St())),xt.uDisc.value=0;let t=wt.fromScene(e,0,.1,100);xt.uDisc.value=1,F?.dispose(),F=t,k.environment=F.texture}var I=new se(16773596,26);I.castShadow=!0,I.shadow.mapSize.set(4096,4096),I.shadow.bias=-4e-4,I.shadow.normalBias=.04,k.add(I,I.target);var L=null,Et=[],R=new t,Dt=new t;function Ot(){let e=g.degToRad(X),n=g.degToRad(Rt),r=new t(Math.sin(e)*Math.cos(n),Math.sin(n),Math.cos(e)*Math.cos(n)),i=Math.max(Dt.x,Dt.z,40)*.75;I.position.copy(R).addScaledVector(r,i*2),I.target.position.copy(R);let a=I.shadow.camera;a.left=a.bottom=-i,a.right=a.top=i,a.near=1,a.far=i*4,a.updateProjectionMatrix();let o=1-g.smoothstep(Math.sin(n),.15,.6);I.color.setRGB(1,.945-.2*o,.86-.42*o),I.intensity=26-12*o,xt.uSun.value.copy(r),I.shadow.needsUpdate=!0,zt=F?performance.now()+250:0,F||Tt()}I.shadow.autoUpdate=!1;var z=1.65,kt=.74,At=.6,jt=.17,B={yaw:0,pitch:0,focus:6,exposure:jt,time:0,stride:0,speed:0},V=new t,H=new t,U=new Set,Mt=new p,Nt=new p,Pt=new p,Ft=new Float32Array(4096),W=0,It=!1,G=!1,K={lut:null,amount:.5},q={amount:.75},Lt=2.4,J=.6,Y=null,X=60,Rt=30,zt=0,Bt=Le();k.add(Bt);var Z=new e;Z.firstHitOnly=!0;function Q(e,n,r,i,a,o,s=!1){V.set(e,n,r),H.set(0,0,0);let c=new t(i-e,a-n,o-r).normalize();B.yaw=Math.atan2(-c.x,-c.z),B.pitch=Math.asin(c.y),G=s}function Vt(e,n,r){for(let i of[-.2,-.75,-.9999999999999998])if(Z.set(new t(e.x,e.y+i,e.z),n),Z.far=r+.35,Z.intersectObject(L,!0).length)return!1;return!0}function Ht(e){let n=(U.has(`w`)||U.has(`arrowup`)?1:0)-(U.has(`s`)||U.has(`arrowdown`)?1:0),r=(U.has(`d`)||U.has(`arrowright`)?1:0)-(U.has(`a`)||U.has(`arrowleft`)?1:0),i=G?9:1.7,a=new t(-Math.sin(B.yaw)*n+Math.cos(B.yaw)*r,0,-Math.cos(B.yaw)*n-Math.sin(B.yaw)*r);a.lengthSq()>0&&a.normalize().multiplyScalar(U.has(`shift`)?2*i:i),H.lerp(a,1-Math.exp(-e*9));for(let n of[`x`,`z`]){let r=H[n]*e;if(Math.abs(r)<1e-5)continue;let i=new t(n===`x`?Math.sign(r):0,0,n===`z`?Math.sign(r):0);G||Vt(V,i,Math.abs(r))?V[n]+=r:H[n]=0}if(!G){Z.set(new t(V.x,V.y-z+At,V.z),new t(0,-1,0)),Z.far=1.6;let n=Z.intersectObject(L,!0)[0];n&&(V.y+=(n.point.y+z-V.y)*Math.min(1,12*e))}let o=Math.hypot(H.x,H.z),s=G?0:Math.min(1,o/1.7);B.stride+=o*e/kt*Math.PI,B.speed+=(s-B.speed)*(1-Math.exp(-e*6));let c=Math.abs(Math.sin(B.stride))*.03*B.speed,l=Math.sin(B.stride)*.016*B.speed;O.position.set(V.x+Math.cos(B.yaw)*l,V.y+c,V.z-Math.sin(B.yaw)*l),O.rotation.set(B.pitch,B.yaw,Math.sin(B.stride)*.005*B.speed,`YXZ`),O.updateMatrixWorld(!0)}function Ut(e){let t=1/0;for(let[e,n]of[[0,0],[.08,-.06],[-.08,-.06],[0,-.14],[0,.08]]){Z.setFromCamera(new v(e,n),O),Z.far=80;let r=Z.intersectObject(L,!0)[0];r&&(t=Math.min(t,r.distance))}t===1/0&&(t=40);let n=t<B.focus?5:2.2;B.focus+=(t-B.focus)*(1-Math.exp(-e*n))}function Wt(e){let{w:t,h:n}=j;x.uSandTime.value=B.time,x.uSand.value=D.dust?q.amount:0,x.uChips.value=+!!D.chips,x.uAge.value=+!!D.age,y.uPomEnabled.value=D.pom&&D.maps?1:0,y.uPomShadow.value=D.pomShadow?.8:0,Bt.visible=D.dust&&q.amount>0;let r=Bt.material.uniforms;r.uTime.value=B.time,r.uHeight.value=n,r.uAmount.value=Math.min(1,q.amount*1.6),r.uLight.value.copy(I.color).multiplyScalar(.12*I.intensity),T.setRenderTarget(j.scene),T.setClearColor(0,1),T.clear(),T.render(k,O),Nt.multiplyMatrices(O.projectionMatrix,O.matrixWorldInverse);let i=j.scene.depthTexture,a=j.scene;if(Pt.copy(Nt).invert(),D.dust&&q.amount>0){let e=D.rays&&I.shadow.map?.depthTexture?1:0;e&&N(P.rays,j.rays,{tDepth:i,tShadow:I.shadow.map.depthTexture,uInvViewProj:Pt,uShadowMatrix:I.shadow.matrix,uCam:O.position,uFrame:W%64}),N(P.dust,j.dust,{tSrc:a.texture,tDepth:i,tRays:j.rays.texture,uRaysTexel:M(j.rays),uShafts:e*Lt,uInvViewProj:Pt,uCam:O.position,uSun:xt.uSun.value,uDensity:.012*q.amount,uTime:B.time}),a=j.dust}let o=.0045*n,s=e=>o*Math.abs(1/B.focus-1/Math.max(e,.05));D.dof&&Math.max(s(Y?.nearest??1),s(Y?.farthest??1e4))>.8&&(N(P.dof,j.dof,{tSrc:a.texture,tDepth:i,uTexel:M(j.scene),uFocus:B.focus,uCoc:o,uMaxCoc:Math.max(4,n/150),uFrame:W%64}),a=j.dof),D.blur&&_t(Nt,Mt)&&(N(P.blur,j.blur,{tSrc:a.texture,tDepth:i,uInvViewProj:Pt,uPrevViewProj:Mt,uShutter:.5*Math.min(1,1/60/Math.max(e,.001))*(e>0)}),a=j.blur),Mt.copy(Nt);let c=a,l=Math.max(B.exposure,.02);j.mips.forEach((e,t)=>{N(P.down,e,{tSrc:c.texture,uTexel:M(c),uKnee:t===0?2.2/l:0}),c=e});let u=j.mips[5];for(let e=4;e>=0;e--)N(P.up,j.ups[e],{tSrc:u.texture,tAdd:j.mips[e].texture,uTexel:M(u)}),u=j.ups[e];let d=j.flareA,f=j.flareB,p=j.streakA,m=j.streakB;N(P.threshold,f,{tSrc:a.texture,uTexel:M(a).multiplyScalar(2),uLevel:3.5/l,uRange:6/l,uCap:12/l}),N(P.flareBlur,d,{tSrc:f.texture,uTexel:M(f),uOffset:1.5}),N(P.flareBlur,f,{tSrc:d.texture,uTexel:M(f),uOffset:2.5}),N(P.flareBlur,d,{tSrc:f.texture,uTexel:M(f),uOffset:3.5}),N(P.threshold,m,{tSrc:a.texture,uTexel:M(a).multiply(new v(2,.5)),uLevel:5/l,uRange:6/l,uCap:7/l}),N(P.streak,p,{tSrc:m.texture,uTexel:M(p),uStep:1,uDecay:.35}),N(P.streak,m,{tSrc:p.texture,uTexel:M(p),uStep:4,uDecay:.5}),N(P.streak,p,{tSrc:m.texture,uTexel:M(p),uStep:16,uDecay:.75}),N(P.features,f,{tSrc:d.texture,uTexel:M(d),uGhost:.018,uHalo:.012,uChroma:24,uSpin:B.yaw*9+B.pitch*6}),W%6==0&&!It&&(N(P.down,j.meter,{tSrc:a.texture,uTexel:M(a).multiplyScalar(4),uKnee:0}),N(P.lum,j.lum,{tSrc:j.meter.texture}),It=!0,T.readRenderTargetPixelsAsync(j.lum,0,0,32,32,Ft).then(()=>{let e=0,t=0;for(let n=0;n<Ft.length;n+=4)e+=Ft[n],t+=Ft[n+1];let n=Math.exp(e/Math.max(t,.001));B.wantExposure=D.hdr?g.clamp(.24*2**J/n,.02,4):jt}).catch(()=>{}).finally(()=>{It=!1}));let h=B.wantExposure??B.exposure;B.exposure+=(h-B.exposure)*(1-Math.exp(-e*(h<B.exposure?5:1.1))),N(P.final,j.ldr,{tSrc:a.texture,tBloom:j.ups[0].texture,tBloomWide:j.ups[3].texture,tFlare:f.texture,tStreak:p.texture,tStreakCore:m.texture,uRes:new v(t,n),uExposure:B.exposure,uTime:B.time,uLens:+!!D.lens,uFilm:+!!D.film}),N(P.grade,null,{tSrc:j.ldr.texture,uTexel:M(j.ldr),tLut:K.lut?.texture3D??null,uSize:K.lut?.size??33,uAmount:K.lut?K.amount:0}),W++}var $={sum:0,n:0,fps:60,since:0,lastDrop:-1e9,patience:6e3};function Gt(e,t){if(ct||!(e>0)||e>250||Y?.status.loading||B.time<4){$.sum=$.n=0;return}if($.sum+=e,$.n++,$.since+=e,$.n<30)return;let n=$.sum/$.n;if($.fps=1e3/n,$.sum=$.n=0,$.since<1e3)return;let r=E;n>20?(r=Math.max(.6,E*.88),t-$.lastRaise<4e3&&($.patience=Math.min(6e4,$.patience*2)),$.lastDrop=t):n<17.5&&E<1&&t-$.lastDrop>$.patience&&(r=Math.min(1,E*1.07),$.lastRaise=t),Math.abs(r-E)>.01&&(E=r,$.since=0,gt())}var Kt={1:[`the avenue`,()=>Q(0,z,39,0,3.4,24)],2:[`the court`,()=>Q(2.5,z,13,-7,2.6,2)],3:[`the colonnade`,()=>Q(1.2,z,-3.5,-2.5,6.5,-14)],4:[`from above`,()=>Q(R.x+30,34,R.z+46,R.x,2,R.z,!0)],5:[`stone relief`,()=>Q(-11.7,z,12,-13,1.9,8)]};function qt(){for(let e of Et)e.normalScale.setScalar(D.maps?Jt:0),e.roughnessMap=D.maps?e.userData.rough:null,e.needsUpdate=!0}var Jt=1.35,Yt={h:`hdr`,l:`lens`,f:`dof`,b:`blur`,g:`film`,m:`maps`,u:`dust`,r:`rays`,c:`chips`,o:`age`,p:`pom`,j:`pomShadow`},Xt={"[":[`ev`,-1.2,-3,3],"]":[`ev`,1.2,-3,3],"-":[`dust`,-.45,0,1],"=":[`dust`,.45,0,1],9:[`depth`,-.02,0,.12],0:[`depth`,.02,0,.12],",":[`az`,-60,-1e9,1e9],".":[`az`,60,-1e9,1e9],";":[`el`,-30,6,86],"'":[`el`,30,6,86]};function Zt(e){let t=!1;for(let n of U){let r=Xt[n];if(!r)continue;let i=r[1]*e,a=e=>Math.min(r[3],Math.max(r[2],e+i));r[0]===`ev`?J=a(J):r[0]===`dust`?q.amount=a(q.amount):r[0]===`depth`?y.uPomDepth.value=a(y.uPomDepth.value):r[0]===`az`?(X=(a(X)+360)%360,t=!0):(Rt=a(Rt),t=!0)}t&&Ot(),zt&&performance.now()>zt&&(zt=0,Tt())}window.addEventListener(`keydown`,e=>{if(e.metaKey||e.ctrlKey||e.altKey)return;let t=e.key.toLowerCase();U.add(t);let n=Yt[t];n&&!e.repeat&&(D[n]=!D[n],n===`maps`&&qt()),Kt[t]&&!e.repeat&&L&&Kt[t][1](),[`w`,`a`,`s`,`d`,` `,`arrowup`,`arrowdown`,`arrowleft`,`arrowright`,`'`].includes(t)&&e.preventDefault()}),window.addEventListener(`keyup`,e=>U.delete(e.key.toLowerCase())),window.addEventListener(`blur`,()=>U.clear());var Qt=(e,t)=>{B.yaw-=e*.0026,B.pitch=g.clamp(B.pitch-t*.0026,-1.45,1.45)},$t=!1;w.addEventListener(`click`,()=>{document.pointerLockElement!==w&&w.requestPointerLock?.()}),w.addEventListener(`pointerdown`,()=>{$t=!0}),window.addEventListener(`pointerup`,()=>{$t=!1}),window.addEventListener(`mousemove`,e=>{(document.pointerLockElement===w||$t)&&Qt(e.movementX,e.movementY)}),window.addEventListener(`resize`,gt);function en(){let e=(e,t,n=!0)=>`<span class="${n?``:`off`}"><b>${e}</b> ${t}</span>`,t=Y?.status;at.innerHTML=[e(`W A S D`,`walk · shift: run`),e(`click`,document.pointerLockElement?`mouse looks · esc releases it`:`to look with the mouse (or drag)`),e(`1 2 3 4 5`,Object.values(Kt).map(e=>e[0]).join(` · `)),e(`H`,`auto exposure`,D.hdr),e(`L`,`lens: bloom, dirt, flare`,D.lens),e(`F`,`auto-focus depth of field`,D.dof),e(`B`,`motion blur`,D.blur),e(`G`,`fringe, vignette, grain`,D.film),e(`M`,`materials: relief, roughness`,D.maps),e(`P`,`carved depth (POM): ${Math.round(y.uPomDepth.value*1e3)} mm`,D.pom&&D.maps),e(`9 0`,`shallower · deeper carving`,D.pom&&D.maps),e(`J`,`shadows inside the carving`,D.pomShadow&&D.pom&&D.maps),e(`O`,`old stone: tone, streaks, dirt, dust film`,D.age),e(`C`,`worn and chipped edges`,D.chips),e(`U`,`sand and dust`,D.dust),e(`R`,`light shafts in the dust`,D.rays&&D.dust),e(`[ ]`,`exposure ${J>=0?`+`:``}${J.toFixed(1)} EV`),e(`- =`,`sand and dust ${Math.round(100*q.amount)}%`,D.dust),e(`, .`,`sun round ${Math.round(X)}°`)+`   `+e(`; '`,`sun up ${Math.round(Rt)}°`)].join(`
`)+`\nfocus ${B.focus.toFixed(1)} m · exposed ${Math.log2(B.exposure/jt)>=0?`+`:``}${Math.log2(B.exposure/jt).toFixed(1)} EV · ${Math.round($.fps)} fps at ${j.w} × ${j.h}`+(t?.size?` · textures ${t.size} px on ${t.sharp}/${t.pages} pages${t.loading?` …`:``}`:``)+(t?` · height maps ${t.heightPages}/${t.pages}${t.heightLoading?` loading`:t.heightErrors.length?` unavailable`:``}`:``)}fetch(`./luxor-gold.cube`).then(e=>e.ok?e.text():Promise.reject(Error(String(e.status)))).then(e=>{K.lut=new ge().parse(e)}).catch(()=>{}),gt(),Kt[1][1](),new ce().load(`./level_2k.glb`,e=>{L=e.scene;let t=T.capabilities.getMaxAnisotropy(),n=[];L.traverse(e=>{e.isMesh&&n.push(e)}),Ce(n),L.traverse(e=>{if(!e.isMesh)return;e.castShadow=e.receiveShadow=!0;let n=Te(e.geometry);e.geometry.computeBoundsTree();for(let r of Array.isArray(e.material)?e.material:[e.material]){for(let e of[r.map,r.normalMap,r.roughnessMap])e&&(e.anisotropy=Math.min(8,t));r.userData.rough=r.roughnessMap,r.shadowSide=2,r.envMapIntensity=1,r.normalScale.setScalar(Jt),r.aoMapIntensity=1.3,Pe(r),Ae(r,n),Et.push(r)}}),k.add(L);let r=[];L.traverse(e=>{e.isMesh&&r.push(e)}),Y=new je(T,O,r,{budget:C.has(`hi`)?Number(C.get(`hi`)):4}),new re().setFromObject(L).getCenter(R),new re().setFromObject(L).getSize(Dt),Ot(),ot.remove(),at.hidden=!1,tn=it({sceneKind:`luxor`,getSnapshot:()=>({pos:O.position,on:{...D},pomDepthMm:Math.round(y.uPomDepth.value*1e3),lodStatus:Y?.status})})},e=>{e.total&&(ot.textContent=`loading the temple… ${Math.round(100*e.loaded/e.total)}%`)},e=>{ot.textContent=`the level did not load: ${e?.message??e}`});var tn=null,nn=performance.now();T.setAnimationLoop(e=>{let t=e-nn,n=Math.min(.05,t/1e3);nn=e,B.time+=n,L&&(Zt(n),Ht(n),Ut(n),Y?.update(n,j.h),Wt(n),Gt(t,e),W%15==0&&(en(),tn?.tick()))}),window.luxorView={camera:O,stand:Q,state:B,on:D,grade:K,dust:q,pom:y,lod:()=>Y?.status,ready:()=>!!L?.parent,snapshot:()=>(Ht(0),Wt(0),w.toDataURL(`image/png`)),setSun:(e,t)=>{X=e,Rt=t,Ot()}};export{nt as t};