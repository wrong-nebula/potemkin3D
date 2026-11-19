import{A as e,C as t,D as n,E as r,F as i,I as a,L as o,M as s,N as c,O as l,P as u,S as d,T as f,_ as p,a as ee,b as m,c as te,d as h,f as ne,g,h as _,i as re,j as v,l as ie,m as ae,n as oe,o as se,p as ce,r as le,s as ue,t as y,u as de,v as b,w as fe,x,y as pe}from"./three-DHHd1w-W.js";(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel="modulepreload"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),t.credentials=e.crossOrigin===`use-credentials`?`include`:e.crossOrigin===`anonymous`?`omit`:`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();var me=`modulepreload`,he=function(e,t){return new URL(e,t).href},ge={},_e=function(e){return e.pathname.endsWith(`.css`)},ve=function(e,t,n){if(t in e)return e[t];let r=n();if(!r){e[t]=void 0;return}let i=r.then(()=>{e[t]=void 0},n=>{throw e[t]=void 0,n});return e[t]=i,i},ye=function(e,t,n){let r=Promise.resolve();if(t&&t.length>0){let e,i=document.querySelector(`meta[property=csp-nonce]`),a=i?.nonce||i?.getAttribute(`nonce`);function o(e){return Promise.all(e.map(e=>Promise.resolve(e).then(e=>({status:`fulfilled`,value:e}),e=>({status:`rejected`,reason:e}))))}function s(e){return import.meta.resolve?new URL(import.meta.resolve(e)):new URL(e,import.meta.url)}r=o(t.map(t=>{t=he(t,n);let r=s(t),i=_e(r);return ve(ge,r.href,()=>{if(e===void 0){e={all:new Set,styles:new Set};let t=document.getElementsByTagName(`link`);for(let n=t.length-1;n>=0;n--){let r=t[n];e.all.add(r.href),r.rel===`stylesheet`&&e.styles.add(r.href)}}if((i?e.styles:e.all).has(r.href))return;let t=document.createElement(`link`);if(t.rel=i?`stylesheet`:me,i||(t.as=`script`),t.crossOrigin=``,t.href=r.href,a&&t.setAttribute(`nonce`,a),document.head.appendChild(t),i)return new Promise((e,n)=>{t.addEventListener(`load`,e),t.addEventListener(`error`,()=>n(Error(`Unable to preload CSS for ${r}`)))})})}).filter(e=>e!==void 0))}function i(e){let t=new Event(`vite:preloadError`,{cancelable:!0});if(t.payload=e,window.dispatchEvent(t),!t.defaultPrevented)throw e}return r.then(t=>{for(let e of t||[])e.status===`rejected`&&i(e.reason);return e().catch(i)})},be=`
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
`;function xe(e){let t=document.createElement(`style`);t.textContent=be,document.head.append(t);let n=document.createElement(`div`);n.className=`potemkin-notes-ui`;let r=document.createElement(`button`);r.type=`button`,r.className=`potemkin-notes-btn`,r.setAttribute(`aria-expanded`,`false`),r.textContent=`Notes · I`,n.append(r),document.body.append(n);let i=null,a=null,o=async()=>{i?i.toggle():(a||=(r.textContent=`Loading…`,ye(()=>import(`./walk-notes-XXiFy2a_.js`).then(t=>(r.textContent=`Notes · I`,i=t.attachWalkNotesDrawer({...e,root:n,btn:r}),i.setOpen(!0),i)),[],import.meta.url).catch(()=>{r.textContent=`Notes · I`,a=null})),await a)};return r.addEventListener(`click`,e=>{e.stopPropagation(),o()}),window.addEventListener(`keydown`,e=>{if(e.metaKey||e.ctrlKey||e.altKey||e.repeat)return;let t=e.key.toLowerCase();t===`i`||e.key===`?`?o():t===`escape`&&i&&!document.pointerLockElement&&i.setOpen(!1)}),{tick(){i?.tick()}}}d.prototype.raycast=y;var S=new URLSearchParams(location.search),C=S.get(`run`)??document.documentElement.dataset.run??`loft-h3-soft-scout`,w=document.documentElement.dataset.base??`/runs/`,T=document.getElementById(`view`),Se=document.getElementById(`hud`),E=document.getElementById(`msg`),D=new ue({canvas:T,antialias:!1,powerPreference:`high-performance`}),Ce=Math.min(window.devicePixelRatio,2),we=Number(new URLSearchParams(location.search).get(`res`))||0,O=we||1;D.setPixelRatio(1),D.autoClear=!1;var k={hdr:!0,lens:!0,dof:!0,blur:!0,film:!0,glass:!0,maps:!0,clay:!1,aa:!1,tour:!1},Te=`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,A=(e,t)=>new v({vertexShader:Te,fragmentShader:e,uniforms:t,depthTest:!1,depthWrite:!1,toneMapped:!1}),Ee=`attribute vec3 bary; varying vec2 vUv; varying vec3 vWorld, vNormal, vBary;
void main() { vUv = uv; vBary = bary; vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; vNormal = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`,De=`
uniform sampler2D map, tMaps, tRelief; uniform samplerCube tEnv;
uniform vec3 uBoxMin, uBoxMax, uProbe, uRoomMin, uRoomMax;
uniform float uLift, uOutside, uMaps, uRelief, uEnvLod, uGloss, uShow, uClay;
varying vec2 vUv; varying vec3 vWorld, vNormal, vBary;
// how much of the surroundings a surface of this roughness mirrors at this angle (Karis's fit to the split sum)
float mirror(float rough, float nv) {
  vec4 r = rough * vec4(-1.0, -0.0275, -0.572, 0.022) + vec4(1.0, 0.0425, 1.04, -0.04);
  float a = min(r.x * r.x, exp2(-9.28 * nv)) * r.x + r.y;
  vec2 ab = vec2(-1.04, 1.04) * a + r.zw;
  return clamp(0.04 * ab.x + ab.y, 0.0, 1.0);
}
void main() {
  vec2 uv = vUv, dx = dFdx(vUv), dy = dFdy(vUv);
  vec3 d = max(uBoxMin - vWorld, vWorld - uBoxMax);
  float outside = step(0.0, max(d.x, max(d.y, d.z)));
  vec3 env = vec3(0.0); float amount = 0.0;
  vec3 shown = vec3(0.0);
  if (uMaps > 0.5 && outside < 0.5) {
    vec3 V = normalize(cameraPosition - vWorld), p1 = dFdx(vWorld), p2 = dFdy(vWorld);
    vec3 G = normalize(cross(p1, p2));
    if (dot(G, V) < 0.0) G = -G;
    vec3 N = normalize(vNormal);
    if (dot(N, G) < 0.0) N = -N;
    // which way the texture's u and v run across the surface (per metre): no tangents are stored
    vec3 q2 = cross(p2, N), q1 = cross(N, p1);
    vec3 T = q2 * dx.x + q1 * dy.x, B = q2 * dx.y + q1 * dy.y;
    float det = dot(p1, q2);
    if (det > 1e-12 && dot(T, T) > 0.0 && dot(B, B) > 0.0) {
      float nv = clamp(dot(N, V), 0.0, 1.0);
      // relief: a point below the surface is seen a little further along the line of sight
      float h = (textureGrad(tRelief, uv, dx, dy).r - 0.5) * 2.0;
      vec3 along = (V - N * dot(N, V)) / max(nv, 0.35) * h * uRelief;
      uv += vec2(dot(along, T), dot(along, B)) / det;
      vec3 m = textureGrad(tMaps, uv, dx, dy).rgb;
      vec2 tilt = m.rg * 2.0 - 254.0 / 255.0;
      vec3 Np = normalize(N + normalize(T) * tilt.x - normalize(B) * tilt.y);
      float rough = clamp(m.b / uGloss, 0.05, 1.0);
      vec3 R = reflect(-V, Np);
      R -= N * min(dot(R, N), 0.0) * 1.2;   // never into the surface
      vec3 a = (uRoomMax - vWorld) / R, b = (uRoomMin - vWorld) / R, far = max(a, b);
      vec3 dir = vWorld + R * max(min(min(far.x, far.y), far.z), 0.0) - uProbe;
      env = textureLod(tEnv, dir, clamp(2.0 * log2(rough) + uEnvLod, 0.0, uEnvLod)).rgb;
      float pit = smoothstep(-0.9, -0.1, (textureGrad(tRelief, uv, dx, dy).r - 0.5) * 2.0);
      amount = mirror(rough, clamp(dot(Np, V), 0.0, 1.0)) * mix(0.35, 1.0, pit);
      shown = uShow < 1.5 ? Np * 0.5 + 0.5 : uShow < 2.5 ? vec3(rough) : uShow < 3.5 ? vec3(h * 0.5 + 0.5) : env * amount;
    }
  }
  vec3 c = pow(textureGrad(map, uv, dx, dy).rgb, vec3(2.2));
  float l = max(c.r, max(c.g, c.b));
  // the painting's whites were brighter than white before they were clipped
  c *= 1.0 + uLift * pow(l, 5.0);
  // outside the room it is day
  c *= mix(1.0, uOutside, outside);
  c = c * (1.0 - amount) + env * amount;
  if (uShow > 0.5) c = shown;
  if (uClay > 0.5) {
    // the blockout under the paint: plain clay in the room's own light (the cube map, blurred right down), and the
    // model's edges as thin lines
    vec3 Vc = normalize(cameraPosition - vWorld), Nc = normalize(vNormal);
    if (dot(Nc, Vc) < 0.0) Nc = -Nc;
    vec3 light = uEnvLod > 0.0 ? mix(textureLod(tEnv, Nc, uEnvLod - 1.0).rgb, textureLod(tEnv, Nc, uEnvLod - 3.5).rgb, 0.65) * 1.5 + 0.04 : vec3(0.45 + 0.25 * Nc.y);
    light += 0.1 * max(dot(Nc, normalize(vec3(0.35, 0.85, 0.4))), 0.0);
    c = vec3(0.62, 0.6, 0.57) * light * mix(1.0, uOutside, outside);
    vec3 w = fwidth(vBary);
    vec3 e = smoothstep(vec3(0.0), w * 1.25, vBary);
    c *= mix(0.55, 1.0, min(e.x, min(e.y, e.z)));
  }
  gl_FragColor = vec4(c, 1.0);
}`,Oe=`attribute vec2 grid; varying vec2 vUv, vGrid; varying vec3 vWorld, vNormal;
void main() { vUv = uv; vGrid = grid; vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; vNormal = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`,ke=`
uniform samplerCube tEnv; uniform vec3 uProbe, uBoxMin, uBoxMax; uniform float uDay;
varying vec2 vUv, vGrid; varying vec3 vWorld, vNormal;
vec2 hash2(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i).x, hash2(i + vec2(1, 0)).x, f.x), mix(hash2(i + vec2(0, 1)).x, hash2(i + vec2(1, 1)).x, f.x), f.y); }
void main() {
  vec3 V = normalize(cameraPosition - vWorld), N = normalize(vNormal);
  float inside = step(0.0, dot(N, V));   // the geometry's normal points into the room
  if (inside < 0.5) N = -N;
  vec3 T = normalize(cross(N, vec3(0.0, 1.0, 0.0))), B = cross(N, T);
  vec2 cell = vUv * vGrid, pane = floor(cell), f = fract(cell);
  vec2 along = vec2(dot(vWorld, T), vWorld.y);
  vec2 tilt = (hash2(pane + along.x * 0.0 + floor(vWorld.xz * 0.37)) - 0.5) * 0.03;
  vec2 wave = (vec2(noise(along * 2.3), noise(along * 2.3 + 17.0)) - 0.5) * 0.02;
  N = normalize(N + T * (tilt.x + wave.x) + B * (tilt.y + wave.y));
  float c = clamp(dot(N, V), 0.0, 1.0);
  float fr = 0.04 + 0.96 * pow(1.0 - c, 5.0);
  fr = 2.0 * fr / (1.0 + fr);   // two faces
  vec3 R = reflect(-V, N);
  // fit the cube map to the room: follow the reflected ray to the room's box
  vec3 a = (uBoxMax - vWorld) / R, b = (uBoxMin - vWorld) / R, far = max(a, b);
  vec3 dir = vWorld + R * min(min(far.x, far.y), far.z) - uProbe;
  // from outside, what the glass reflects is the street and the sky: stand in for it with the day's light
  vec3 env = mix(vec3(0.75, 0.82, 0.95) * uDay * 0.6, textureCube(tEnv, dir).rgb, inside);
  // dirt: a thin film everywhere, more at each pane's edges and in its corners, and a few specks
  float edge = pow(max(abs(f.x - 0.5), abs(f.y - 0.5)) * 2.0, 5.0);
  float film = 0.035 + 0.11 * edge + 0.05 * smoothstep(0.55, 0.9, noise(along * 9.0)) + 0.12 * step(0.985, noise(along * 70.0));
  vec3 haze = vec3(0.9, 0.92, 0.95) * film * uDay * 0.16;
  float through = (1.0 - fr) * (1.0 - 0.7 * film) * 0.94;
  gl_FragColor = vec4(env * fr + haze, 1.0 - through);
}`,Ae=`
uniform float uSky; varying vec3 vDir;
void main() {
  float h = clamp(normalize(vDir).y, -0.2, 1.0);
  vec3 c = mix(vec3(1.0, 0.97, 0.92), vec3(0.62, 0.74, 0.95), smoothstep(0.0, 0.7, h));
  gl_FragColor = vec4(c * uSky, 1.0);
}`,je=`
uniform sampler2D tDepth; uniform float uNear, uFar;
float viewZ(vec2 uv) { float z = texture2D(tDepth, uv).x * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }`,Me=`
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uFocus, uCoc, uMaxCoc, uFrame;
varying vec2 vUv;
${je}
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
}`,Ne=`
uniform sampler2D tSrc; uniform mat4 uInvViewProj, uPrevViewProj; uniform float uShutter;
varying vec2 vUv;
${je}
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
}`,Pe=`
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
}`,Fe=`
uniform sampler2D tSrc, tAdd; uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec2 o = uTexel * 0.5;
  vec3 c = (texture2D(tSrc, vUv + vec2(-o.x * 2.0, 0.0)).rgb + texture2D(tSrc, vUv + vec2(o.x * 2.0, 0.0)).rgb
    + texture2D(tSrc, vUv + vec2(0.0, -o.y * 2.0)).rgb + texture2D(tSrc, vUv + vec2(0.0, o.y * 2.0)).rgb
    + (texture2D(tSrc, vUv + o).rgb + texture2D(tSrc, vUv - o).rgb + texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb
      + texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb) * 2.0) / 12.0;
  gl_FragColor = vec4(c + texture2D(tAdd, vUv).rgb, 1.0);
}`,Ie=`
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
}`,Le=`
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uOffset;
varying vec2 vUv;
void main() {
  vec2 o = uTexel * uOffset;
  gl_FragColor = vec4((texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb + texture2D(tSrc, vUv + o).rgb
    + texture2D(tSrc, vUv - o).rgb + texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb) * 0.25, 1.0);
}`,Re=`
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
}`,ze=`
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
}`,Be=`
uniform sampler2D tSrc; varying vec2 vUv;
void main() {
  float l = dot(texture2D(tSrc, vUv).rgb, vec3(0.2126, 0.7152, 0.0722));
  float w = 1.0 - 0.6 * smoothstep(0.2, 0.75, distance(vUv, vec2(0.5)));
  gl_FragColor = vec4(log(max(l, 1e-4)) * w, w, 0.0, 1.0);
}`,Ve=`
uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  vec3 m = texture2D(tSrc, vUv).rgb;
  float nw = lum(texture2D(tSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb), ne = lum(texture2D(tSrc, vUv + vec2(1.0, -1.0) * uTexel).rgb);
  float sw = lum(texture2D(tSrc, vUv + vec2(-1.0, 1.0) * uTexel).rgb), se = lum(texture2D(tSrc, vUv + vec2(1.0, 1.0) * uTexel).rgb);
  float lm = lum(m), lo = min(lm, min(min(nw, ne), min(sw, se))), hi = max(lm, max(max(nw, ne), max(sw, se)));
  vec2 dir = vec2(-((nw + ne) - (sw + se)), (nw + sw) - (ne + se));
  float reduce = max((nw + ne + sw + se) * 0.03125, 0.0078125);
  dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + reduce), -8.0, 8.0) * uTexel;
  vec3 a = 0.5 * (texture2D(tSrc, vUv + dir * (1.0 / 3.0 - 0.5)).rgb + texture2D(tSrc, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture2D(tSrc, vUv - dir * 0.5).rgb + texture2D(tSrc, vUv + dir * 0.5).rgb);
  float lb = lum(b);
  gl_FragColor = vec4(lb < lo || lb > hi ? a : b, 1.0);
}`,He=`
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uAmount; varying vec2 vUv;
void main() {
  vec3 m = texture2D(tSrc, vUv).rgb;
  vec3 n = texture2D(tSrc, vUv + vec2(0.0, -uTexel.y)).rgb, s = texture2D(tSrc, vUv + vec2(0.0, uTexel.y)).rgb;
  vec3 w = texture2D(tSrc, vUv + vec2(-uTexel.x, 0.0)).rgb, e = texture2D(tSrc, vUv + vec2(uTexel.x, 0.0)).rgb;
  vec3 lo = min(m, min(min(n, s), min(w, e))), hi = max(m, max(max(n, s), max(w, e)));
  vec3 amp = sqrt(clamp(min(lo, 1.0 - hi) / max(hi, 1e-3), 0.0, 1.0));
  vec3 k = -amp * uAmount * 0.2;
  gl_FragColor = vec4(clamp((m + (n + s + w + e) * k) / (1.0 + 4.0 * k), 0.0, 1.0), 1.0);
}`,Ue=`
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
}`;function We(){let e=1024,t=document.createElement(`canvas`);t.width=t.height=e;let n=t.getContext(`2d`);n.fillStyle=`#000`,n.fillRect(0,0,e,e),n.globalCompositeOperation=`lighter`;let r=1234567,i=()=>(r=r*1664525+1013904223>>>0)/4294967296,a=e=>{let t=i(),[n,r,a]=t<.3?[255,236,210]:t<.55?[215,232,255]:[255,255,255];return t=>`rgba(${n},${r},${a},${e*t})`},o=(e,t,r,i)=>{let a=n.createRadialGradient(e,t,0,e,t,r);for(let[e,t]of i)a.addColorStop(e,t);n.fillStyle=a,n.beginPath(),n.arc(e,t,r,0,Math.PI*2),n.fill()};for(let t=0;t<26;t++){let t=a(.035+i()*.05);o(i()*e,i()*e,90+i()*220,[[0,t(1)],[.6,t(.5)],[1,t(0)]])}for(let t=0;t<110;t++){let t=a(.04+i()*.16);o(i()*e,i()*e,8+i()**2.2*120,[[0,t(1)],[.5,t(.45)],[1,t(0)]])}for(let t=0;t<40;t++){let t=a(.05+i()*.12);o(i()*e,i()*e,4+i()**1.8*26,[[0,t(.35)],[.6,t(.5)],[.86,t(1)],[1,t(0)]])}n.lineCap=`round`;for(let t=0;t<7;t++){let t=i()*e,r=i()*e,o=120+i()*360,s=i()*Math.PI*2,c=.3+i()*.7,l=a(.025+i()*.04);for(let e=0;e<16;e++)n.strokeStyle=l(.4+i()*.6),n.lineWidth=.6+i()*1.6,n.beginPath(),n.arc(t,r,o+e*(2+i()*3),s+i()*.08,s+c-i()*.1),n.stroke()}for(let t=0;t<5;t++){n.strokeStyle=a(.12+i()*.12)(1),n.lineWidth=.8+i()*.8,n.beginPath();let t=i()*e,r=i()*e;n.moveTo(t,r);for(let e=0;e<3;e++){let e=t+(i()-.5)*140,a=r+(i()-.5)*140;n.quadraticCurveTo(t+(i()-.5)*90,r+(i()-.5)*90,e,a),t=e,r=a}n.stroke()}for(let t=0;t<1400;t++){let t=a(.15+i()**3*.75);o(i()*e,i()*e,.8+i()**4*4.5,[[0,t(1)],[.5,t(.7)],[1,t(0)]])}let s=new de(t);return s.colorSpace=``,s.minFilter=pe,s}var Ge=.05,Ke=400,j=new r(58,1,Ge,Ke),M=new e,qe=new e,Je=new f(-1,1,1,-1,0,1),Ye=new d(new n(2,2));Ye.frustumCulled=!1,qe.add(Ye);var Xe={type:p,minFilter:b,magFilter:b,depthBuffer:!1},N=(e,t,n={})=>new o(Math.max(1,Math.round(e)),Math.max(1,Math.round(t)),{...Xe,...n}),P=null;function Ze(){let e=Math.max(64,Math.floor(window.innerWidth*Ce*O)),t=Math.max(64,Math.floor(window.innerHeight*Ce*O));if(D.setSize(e,t,!1),j.aspect=e/t,j.updateProjectionMatrix(),P)for(let e of P.all)e.dispose();let n=N(e,t,{depthBuffer:!0,depthTexture:new ae(e,t,u),samples:4}),r=Array.from({length:6},(n,r)=>N(e/2**(r+1),t/2**(r+1))),i=Array.from({length:5},(n,r)=>N(e/2**(r+1),t/2**(r+1)));P={w:e,h:t,scene:n,dof:N(e,t),blur:N(e,t),mips:r,ups:i,ldr:new o(e,t,{minFilter:b,magFilter:b,depthBuffer:!1}),flareA:N(e/4,t/4),flareB:N(e/4,t/4),streakA:N(e/4,t/4),streakB:N(e/4,t/4),lum:new o(32,32,{type:g,minFilter:fe,magFilter:fe,depthBuffer:!1})},P.all=[n,P.ldr,P.dof,P.blur,...r,...i,P.flareA,P.flareB,P.streakA,P.streakB,P.lum]}var F=e=>new i(1/e.width,1/e.height),Qe=(e,t)=>e.elements.some((e,n)=>Math.abs(e-t.elements[n])>1e-5);function I(e,t,n={}){for(let[t,r]of Object.entries(n)){let n=e.uniforms[t];r?.isVector2||r?.isVector3||r?.isMatrix4||r?.isColor?n.value.copy(r):n.value=r}Ye.material=e,D.setRenderTarget(t),D.render(qe,Je)}var $e=()=>({tDepth:{value:null},uNear:{value:Ge},uFar:{value:Ke}}),L={dof:A(Me,{...$e(),tSrc:{value:null},uTexel:{value:new i},uFocus:{value:4},uCoc:{value:0},uMaxCoc:{value:14},uFrame:{value:0}}),blur:A(Ne,{...$e(),tSrc:{value:null},uInvViewProj:{value:new x},uPrevViewProj:{value:new x},uShutter:{value:.5}}),down:A(Pe,{tSrc:{value:null},uTexel:{value:new i},uKnee:{value:0}}),up:A(Fe,{tSrc:{value:null},tAdd:{value:null},uTexel:{value:new i}}),threshold:A(Ie,{tSrc:{value:null},uTexel:{value:new i},uLevel:{value:3},uRange:{value:4},uCap:{value:1e4}}),flareBlur:A(Le,{tSrc:{value:null},uTexel:{value:new i},uOffset:{value:1.5}}),features:A(Re,{tSrc:{value:null},uTexel:{value:new i},uGhost:{value:.05},uHalo:{value:.06},uChroma:{value:24},uSpin:{value:0}}),streak:A(ze,{tSrc:{value:null},uTexel:{value:new i},uStep:{value:1},uDecay:{value:.4}}),lum:A(Be,{tSrc:{value:null}}),fxaa:A(Ve,{tSrc:{value:null},uTexel:{value:new i}}),sharp:A(He,{tSrc:{value:null},uTexel:{value:new i},uAmount:{value:.8}}),final:A(Ue,{tSrc:{value:null},tBloom:{value:null},tBloomWide:{value:null},tDirt:{value:We()},tFlare:{value:null},tStreak:{value:null},tStreakCore:{value:null},uRes:{value:new i},uExposure:{value:1},uBloomI:{value:.018},uDirtI:{value:.06},uFlareI:{value:.5},uStreakI:{value:.12},uFlareDirt:{value:1.5},uStreakTint:{value:new ne(.55,.75,1)},uCA:{value:.012},uVignette:{value:.8},uGrain:{value:.022},uTime:{value:0},uLens:{value:1},uFilm:{value:1}})},et=.6,tt=4,nt=6,rt=Number(S.get(`relief`)??.012),it=Number(S.get(`gloss`)??1),R=!1,z=new v({vertexShader:Ee,fragmentShader:De,side:2,toneMapped:!1,uniforms:{map:{value:null},uBoxMin:{value:new a},uBoxMax:{value:new a},uLift:{value:et},uOutside:{value:tt},tMaps:{value:null},tRelief:{value:null},tEnv:{value:null},uProbe:{value:new a},uRoomMin:{value:new a},uRoomMax:{value:new a},uMaps:{value:0},uClay:{value:0},uRelief:{value:rt},uEnvLod:{value:0},uGloss:{value:it},uShow:{value:0}}}),at=new d(new s(300,24,12),new v({side:1,depthWrite:!1,toneMapped:!1,uniforms:{uSky:{value:nt}},fragmentShader:Ae,vertexShader:`varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0); }`}));M.add(at);var ot=[...[-8,-4,0,4].map(e=>({axis:`z`,at:-5.15,from:e-1.2,to:e+1.2,cols:3,rows:4,inward:1})),...[-6,-2,2,6].map(e=>({axis:`z`,at:5.15,from:e-1.2,to:e+1.2,cols:3,rows:4,inward:-1})),{axis:`x`,at:-10.15,from:-1.6,to:1.6,cols:4,rows:4,inward:1}];function st(e,t=1,n=4.2,r=.07){let i=[],a=[],o=[],s=[],c=[];for(let l of e){let e=l.from+r,u=l.to-r,d=t+r,f=n-r,p=i.length/3;for(let[t,n]of[[0,0],[1,0],[1,1],[0,1]]){let r=e+(u-e)*t,c=d+(f-d)*n;i.push(...l.axis===`z`?[r,c,l.at]:[l.at,c,r]),a.push(...l.axis===`z`?[0,0,l.inward]:[l.inward,0,0]),o.push(t,n),s.push(l.cols,l.rows)}c.push(p,p+1,p+2,p,p+2,p+3)}let l=new ie;return l.setAttribute(`position`,new _(i,3)),l.setAttribute(`normal`,new _(a,3)),l.setAttribute(`uv`,new _(o,2)),l.setAttribute(`grid`,new _(s,2)),l.setIndex(c),l}var B=new v({vertexShader:Oe,fragmentShader:ke,side:2,transparent:!0,depthWrite:!1,toneMapped:!1,blending:5,blendSrc:201,blendDst:205,blendSrcAlpha:201,blendDstAlpha:205,uniforms:{tEnv:{value:null},uProbe:{value:new a},uBoxMin:{value:new a},uBoxMax:{value:new a},uDay:{value:4}}}),V=null,H=null;function ct(e){let t=e.index?e.toNonIndexed():e,n=t.getAttribute(`position`),r=new Float32Array(n.count*3),i=[new a,new a,new a],o=new a,s=new a;for(let e=0;e<n.count;e+=3){for(let t=0;t<3;t++)i[t].fromBufferAttribute(n,e+t);let t=-1;for(let e=0;e<3;e++)o.subVectors(i[(e+1)%3],i[e]),s.subVectors(i[(e+2)%3],i[e]),Math.abs(o.dot(s))<.02*o.length()*s.length()&&(t=e);for(let n=0;n<3;n++)r[(e+n)*3+n]=1,t>=0&&(r[(e+n)*3+t]=1)}return t.setAttribute(`bary`,new _(r,3)),t}var lt=1.65,ut=1.15,dt=.74,U=null,W=null,G=0,K=new l;function ft(e,t){let n=new a().subVectors(t,e),r=n.length();n.divideScalar(r);for(let t of[0,-.75,-1.3])if(K.set(new a(e.x,e.y+t,e.z),n),K.far=r,K.intersectObject(U,!1).length)return!1;return!0}function pt(e){let t=e.length,n=e.map(()=>[]);for(let r=0;r<t;r++)for(let i=r+1;i<t;i++){let t=e[r].distanceTo(e[i]);t<9&&ft(e[r],e[i])&&(n[r].push({to:i,d:t}),n[i].push({to:r,d:t}))}let r=e.reduce((e,t)=>e.add(t),new a).divideScalar(t),i=0;for(let n=1;n<t;n++)e[n].distanceTo(r)<e[i].distanceTo(r)&&(i=n);let o=new Set([i]),s=[],c=(e,t)=>{s.push(e);let r=n[e].filter(e=>!o.has(e.to)).sort((e,t)=>e.d-t.d);for(let t of r)o.has(t.to)||(o.add(t.to),c(t.to,e),s.push(e))};c(i,-1),s.length>1&&s[s.length-1]===s[0]&&s.pop();let l=new h(s.map(t=>e[t].clone()),!0,`centripetal`);return l.arcLengthDivisions=1200,l}var q={dist:0,yaw:0,pitch:0,focus:4,exposure:1,time:0,stride:0,speed:0,show:Number(S.get(`show`)??0)},J=new a,Y=new a,X=new Set,mt=new x,Z=new x,ht=new x,gt=new Float32Array(4096),_t=0,Q=null,vt=!1;function yt(e,t,n){for(let r of[-.2,-.75,-1.3])if(K.set(new a(e.x,e.y+r,e.z),t),K.far=n+.35,K.intersectObject(U,!1).length)return!1;return!0}function bt(e){let t=0;if(k.tour){q.dist=((q.dist+ut*e)%G+G)%G;let n=q.dist/G,r=W.getPointAt(n),i=W.getPointAt((n+2.2/G)%1),o=new a().subVectors(i,r).setY(0).normalize();J.copy(r);let s=q.time,c=1-Math.exp(-e*2.2),l=Math.atan2(-o.x,-o.z)+.38*Math.sin(s*.21)+.2*Math.sin(s*.53+1.3);q.yaw+=Math.atan2(Math.sin(l-q.yaw),Math.cos(l-q.yaw))*c,q.pitch+=(-.05+.07*Math.sin(s*.17+.6)-q.pitch)*c,q.stride+=ut*e/dt*Math.PI,t=1}else{let n=(X.has(`w`)||X.has(`arrowup`)?1:0)-(X.has(`s`)||X.has(`arrowdown`)?1:0),r=(X.has(`d`)||X.has(`arrowright`)?1:0)-(X.has(`a`)||X.has(`arrowleft`)?1:0),i=new a(-Math.sin(q.yaw)*n+Math.cos(q.yaw)*r,0,-Math.cos(q.yaw)*n-Math.sin(q.yaw)*r);i.lengthSq()>0&&i.normalize().multiplyScalar(X.has(`shift`)?3.4:1.7),Y.lerp(i,1-Math.exp(-e*9));for(let t of[`x`,`z`]){let n=Y[t]*e;Math.abs(n)<1e-5||(yt(J,new a(t===`x`?Math.sign(n):0,0,t===`z`?Math.sign(n):0),Math.abs(n))?J[t]+=n:Y[t]=0)}J.x=m.clamp(J.x,Q[0]+.4,Q[3]-.4),J.z=m.clamp(J.z,Q[2]+.4,Q[5]-.4);let o=Math.hypot(Y.x,Y.z);q.stride+=o*e/dt*Math.PI,t=Math.min(1,o/1.7)}q.speed+=(t-q.speed)*(1-Math.exp(-e*6));let n=Math.abs(Math.sin(q.stride))*.03*q.speed,r=Math.sin(q.stride)*.016*q.speed;j.position.set(J.x+Math.cos(q.yaw)*r,J.y+n,J.z-Math.sin(q.yaw)*r),j.rotation.set(q.pitch,q.yaw,Math.sin(q.stride)*.005*q.speed,`YXZ`),j.updateMatrixWorld(!0)}function xt(e){let t=1/0;for(let[e,n]of[[0,0],[.08,-.06],[-.08,-.06],[0,-.14],[0,.08]]){K.setFromCamera(new i(e,n),j),K.far=60;let r=K.intersectObject(U,!1)[0];r&&(t=Math.min(t,r.distance))}t===1/0&&(t=30);let n=t<q.focus?5:2.2;q.focus+=(t-q.focus)*(1-Math.exp(-e*n))}function St(e){let{w:t,h:n}=P;z.uniforms.uLift.value=k.hdr?et:0,z.uniforms.uOutside.value=k.hdr?tt:1,at.material.uniforms.uSky.value=k.hdr?nt:1,V&&(V.visible=k.glass&&!k.clay,B.uniforms.uDay.value=k.hdr?tt:1),z.uniforms.uMaps.value=k.maps&&R&&!k.clay?1:0,z.uniforms.uClay.value=+!!k.clay,z.uniforms.uShow.value=q.show,D.setRenderTarget(P.scene),D.setClearColor(0,1),D.clear(),D.render(M,j),Z.multiplyMatrices(j.projectionMatrix,j.matrixWorldInverse);let r=P.scene.depthTexture,a=P.scene;k.dof&&(I(L.dof,P.dof,{tSrc:a.texture,tDepth:r,uTexel:F(P.scene),uFocus:q.focus,uCoc:.009*n,uMaxCoc:Math.max(4,n/130),uFrame:_t%64}),a=P.dof),k.blur&&Qe(Z,mt)&&(I(L.blur,P.blur,{tSrc:a.texture,tDepth:r,uInvViewProj:ht.copy(Z).invert(),uPrevViewProj:mt,uShutter:.5*Math.min(1,1/60/Math.max(e,.001))*(e>0)+0}),a=P.blur),mt.copy(Z);let o=a,s=Math.max(q.exposure,.05);P.mips.forEach((e,t)=>{I(L.down,e,{tSrc:o.texture,uTexel:F(o),uKnee:t===0?2.2/s:0}),o=e});let c=P.mips[5];for(let e=4;e>=0;e--)I(L.up,P.ups[e],{tSrc:c.texture,tAdd:P.mips[e].texture,uTexel:F(c)}),c=P.ups[e];let l=P.flareA,u=P.flareB,d=P.streakA,f=P.streakB;I(L.threshold,u,{tSrc:a.texture,uTexel:F(a).multiplyScalar(2),uLevel:3.5/s,uRange:6/s,uCap:12/s}),I(L.flareBlur,l,{tSrc:u.texture,uTexel:F(u),uOffset:1.5}),I(L.flareBlur,u,{tSrc:l.texture,uTexel:F(u),uOffset:2.5}),I(L.flareBlur,l,{tSrc:u.texture,uTexel:F(u),uOffset:3.5}),I(L.threshold,f,{tSrc:a.texture,uTexel:F(a).multiply(new i(2,.5)),uLevel:5/s,uRange:6/s,uCap:7/s}),I(L.streak,d,{tSrc:f.texture,uTexel:F(d),uStep:1,uDecay:.35}),I(L.streak,f,{tSrc:d.texture,uTexel:F(d),uStep:4,uDecay:.5}),I(L.streak,d,{tSrc:f.texture,uTexel:F(d),uStep:16,uDecay:.75}),I(L.features,u,{tSrc:l.texture,uTexel:F(l),uGhost:.018,uHalo:.012,uChroma:24,uSpin:q.yaw*9+q.pitch*6}),_t%6==0&&!vt&&(I(L.lum,P.lum,{tSrc:P.mips[2].texture}),vt=!0,D.readRenderTargetPixelsAsync(P.lum,0,0,32,32,gt).then(()=>{let e=0,t=0;for(let n=0;n<gt.length;n+=4)e+=gt[n],t+=gt[n+1];let n=Math.exp(e/Math.max(t,.001));q.wantExposure=k.hdr?m.clamp(.14/n,.25,2):1}).catch(()=>{}).finally(()=>{vt=!1}));let p=q.wantExposure??1;q.exposure+=(p-q.exposure)*(1-Math.exp(-e*(p<q.exposure?5:1.1))),I(L.final,P.ldr,{tSrc:a.texture,tBloom:P.ups[0].texture,tBloomWide:P.ups[3].texture,tFlare:u.texture,tStreak:d.texture,tStreakCore:f.texture,uRes:new i(t,n),uExposure:q.exposure,uTime:q.time,uLens:+!!k.lens,uFilm:+!!k.film}),k.aa?I(L.fxaa,null,{tSrc:P.ldr.texture,uTexel:F(P.ldr)}):I(L.sharp,null,{tSrc:P.ldr.texture,uTexel:F(P.ldr)}),_t++}var $={sum:0,n:0,fps:60,since:0};function Ct(e){if(we||!(e>0)||e>250||($.sum+=e,$.n++,$.since+=e,$.n<30))return;let t=$.sum/$.n;if($.fps=1e3/t,$.sum=$.n=0,$.since<1e3)return;let n=t>22?Math.max(.75,O*.9):t<15&&O<1?Math.min(1,O*1.08):O;Math.abs(n-O)>.01&&(O=n,$.since=0,Ze())}function wt(){let e=(e,t,n=!0)=>`<span class="${n?``:`off`}"><b>${e}</b> ${t}</span>`;Se.innerHTML=[e(`W A S D`,`walk · shift: run`),e(`click`,document.pointerLockElement?`mouse looks · esc releases it`:`to look with the mouse (or drag)`),e(`H`,`fake HDR + auto exposure`,k.hdr),e(`L`,`lens: bloom, dirt, flare`,k.lens),e(`F`,`auto-focus depth of field`,k.dof),e(`B`,`motion blur`,k.blur),e(`G`,`fringe, vignette, grain`,k.film),e(`P`,`glass panes in the windows`,k.glass),e(`M`,R?`materials: reflections, relief`:`materials (this run has no maps)`,k.maps&&R),e(`X`,`clay + wireframe`,k.clay),e(`K`,`extra edge smoothing (softer)`,k.aa),e(`T`,`tour: walks by itself`,k.tour)].join(`
`)+`\nfocus ${q.focus.toFixed(1)} m · exposure ${q.exposure>=1?`+`:``}${Math.log2(q.exposure).toFixed(1)} EV · ${Math.round($.fps)} fps at ${P.w} × ${P.h}`}async function Tt(){let e=await(await fetch(`${w}${C}/run.json`)).json(),n=D.capabilities.maxTextureSize>=8192,r=[...(S.get(`tex`)??(n?`8k`:`4k`))===`8k`?[`level_8k.glb`]:[],`level_4k.glb`,`level_textured.glb`],i=null,o=new le().detectSupport(D),s=new re().setKTX2Loader(o);for(let e of r){let t=await fetch(`${w}${C}/${e}`,{method:`HEAD`}).catch(()=>null);if(t?.ok&&!/text\/html/.test(t.headers.get(`content-type`)??``)){E.textContent=`loading the loft (${e.includes(`8k`)?`8192`:`4096`} px of texture)…`,i=await s.loadAsync(`${w}${C}/${e}`);break}}if(!i)throw Error(`no level file found`);i.scene.updateMatrixWorld(!0);let l=[];i.scene.traverse(e=>{e.isMesh&&l.push(e)});let u=e=>(e.colorSpace=``,e.isCompressedTexture||(e.generateMipmaps=!0),e.minFilter=e.isCompressedTexture&&(e.mipmaps?.length??0)<=1?b:pe,e.magFilter=b,e.anisotropy=D.capabilities.getMaxAnisotropy(),e.needsUpdate=!0,e),f;if(l.length===1)U=l[0],f=u(U.material.map),z.uniforms.map.value=f,U.material=z,U.geometry=ct(U.geometry);else{for(let e of l){let t=z.clone();t.uniforms={...z.uniforms,map:{value:u(e.material.map)},tMaps:{value:null},tRelief:{value:null}},e.material=t,e.geometry=ct(e.geometry)}f=l[0].material.uniforms.map.value,U=new d(ee(l.map(e=>e.geometry.clone().applyMatrix4(e.matrixWorld))),new t({side:2}))}let h=l.length;U.geometry.boundsTree=new oe(U.geometry),M.add(i.scene);let ne=new te().setFromObject(U);Q=e.area??[...ne.min.toArray(),...ne.max.toArray()],z.uniforms.uBoxMin.value.set(Q[0]-.6,Q[1]-1,Q[2]-.6),z.uniforms.uBoxMax.value.set(Q[3]+.6,Q[4]+1,Q[5]+.6);let g=async(e,t)=>{let n=await fetch(`${w}${C}/${e}`,{method:`HEAD`}).catch(()=>null);if(!n?.ok||/text\/html/.test(n.headers.get(`content-type`)??``))return null;let r=await new c().loadAsync(`${w}${C}/${e}`);return r.flipY=!1,r.colorSpace=``,t&&(r.format=t),r.generateMipmaps=!0,r.minFilter=pe,r.magFilter=b,r.anisotropy=f.anisotropy,r};if(S.get(`maps`)!==`off`){E.textContent=`loading the material maps…`;let e=f.image.width*Math.sqrt(h)>=8192&&S.get(`maps`)!==`4k`?`8k`:`4k`,t=async t=>{let n=await g(`maps_${e}${t}.jpg`)??(e===`8k`?await g(`maps_4k${t}.jpg`):null),r=n&&(await g(`relief_${e}${t}.jpg`,1028)??(e===`8k`?await g(`relief_4k${t}.jpg`,1028):null));return n&&r?{maps:n,relief:r}:null},n=h===1?[z]:l.map(e=>e.material),r=await Promise.all(n.map((e,n)=>t(h===1?``:`_p${n}`)));r.every(Boolean)&&(n.forEach((e,t)=>{e.uniforms.tMaps.value=r[t].maps,e.uniforms.tRelief.value=r[t].relief}),R=!0)}let _=/loft/.test(e.level??C);if(_||R){let e=R?512:256,t=new se(e,{type:p,generateMipmaps:!0,minFilter:pe});H=new ce(.1,400,t),H.position.set((Q[0]+Q[3])/2,(Q[1]+Q[4])/2,(Q[2]+Q[5])/2),M.add(H),H.update(D,M);for(let e of[B,z])e.uniforms.tEnv.value=t.texture,e.uniforms.uProbe.value.copy(H.position);B.uniforms.uBoxMin.value.set(Q[0],Q[1],Q[2]),B.uniforms.uBoxMax.value.set(Q[3],Q[4],Q[5]),z.uniforms.uRoomMin.value.set(Q[0]-.15,Q[1],Q[2]-.15),z.uniforms.uRoomMax.value.set(Q[3]+.15,Q[4],Q[5]+.15),z.uniforms.uEnvLod.value=Math.log2(e*1.273)-1}_&&(V=new d(st(ot),B),V.renderOrder=2,M.add(V));let v=Q[1],ie=e.plan.points.map(e=>new a(e[0],e[1],e[2])).filter(e=>Math.abs(e.y-1.6-v)<.25).map(e=>e.setY(v+lt));W=pt(ie),G=W.getLength();let ae=new a((Q[0]+Q[3])/2,v+lt,(Q[2]+Q[5])/2);J.copy(ie.reduce((e,t)=>t.distanceTo(ae)<e.distanceTo(ae)?t:e)),q.yaw=Q[3]-Q[0]>Q[5]-Q[2]?Math.PI/2:0,Ze(),E.remove(),Se.hidden=!1;let ue=xe({sceneKind:`loft`,getSnapshot:()=>({pos:J,on:{...k},meta:e,hasMaps:R,focus:q.focus,runId:C})});window.demo={state:q,on:k,path:W,camera:j,position:J,keys:X,pace:$,get length(){return G},get scale(){return O},get size(){return[P.w,P.h]},bench(e=120,t=!0){let n=D.getContext(),r=new Uint8Array(4),i=()=>{D.setRenderTarget(null),n.readPixels(0,0,1,1,n.RGBA,n.UNSIGNED_BYTE,r)};St(.016),i();let a=performance.now();for(let n=0;n<e;n++)t&&(j.rotation.y+=(n%2?1:-1)*.004,j.updateMatrixWorld(!0)),St(.016);return i(),(performance.now()-a)/e}};let y=performance.now(),de=y;D.setAnimationLoop(e=>{let t=m.clamp((e-y)/1e3,0,.1);y=e,q.time+=t,bt(t),xt(t),St(t),Ct(e-de),de=e,_t%10==0&&(wt(),ue.tick())})}window.addEventListener(`resize`,Ze),window.addEventListener(`keydown`,e=>{let t=e.key.toLowerCase();X.add(t);let n={h:`hdr`,l:`lens`,f:`dof`,b:`blur`,g:`film`,p:`glass`,m:`maps`,x:`clay`,k:`aa`,t:`tour`}[t];if(n&&!e.repeat&&(k[n]=!k[n],n===`tour`&&k.tour)){let e=0,t=1/0;for(let n=0;n<400;n++){let r=W.getPointAt(n/400).distanceTo(J);r<t&&(t=r,e=n/400)}q.dist=e*G}[`w`,`a`,`s`,`d`,` `,`arrowup`,`arrowdown`,`arrowleft`,`arrowright`].includes(t)&&e.preventDefault()}),window.addEventListener(`keyup`,e=>X.delete(e.key.toLowerCase())),window.addEventListener(`blur`,()=>X.clear());var Et=(e,t)=>{k.tour||(q.yaw-=e*.0024,q.pitch=m.clamp(q.pitch-t*.0024,-1.3,1.3))},Dt=!1;T.addEventListener(`click`,()=>{if(!document.pointerLockElement)try{Promise.resolve(T.requestPointerLock?.()).catch(()=>{})}catch{}}),T.addEventListener(`pointerdown`,()=>{Dt=!0}),window.addEventListener(`pointerup`,()=>{Dt=!1}),window.addEventListener(`mousemove`,e=>{(document.pointerLockElement===T||Dt)&&Et(e.movementX,e.movementY)}),Tt().catch(e=>{E.textContent=`could not load run "${C}": ${e.message}`,console.error(e)});export{ye as t};