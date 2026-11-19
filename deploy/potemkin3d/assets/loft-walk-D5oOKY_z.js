import{A as e,C as t,D as n,E as r,F as i,I as a,M as o,N as s,P as c,S as l,T as u,_ as d,a as f,b as p,c as m,d as ee,f as te,g as ne,h,i as re,j as ie,k as g,l as ae,m as _,n as oe,o as se,p as ce,r as le,s as ue,t as de,u as fe,v,w as pe,x as y,y as b}from"./three-C260k_0J.js";(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel="modulepreload"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),t.credentials=e.crossOrigin===`use-credentials`?`include`:e.crossOrigin===`anonymous`?`omit`:`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();var me=`modulepreload`,he=function(e,t){return new URL(e,t).href},ge={},_e=function(e){return e.pathname.endsWith(`.css`)},ve=function(e,t,n){if(t in e)return e[t];let r=n();if(!r){e[t]=void 0;return}let i=r.then(()=>{e[t]=void 0},n=>{throw e[t]=void 0,n});return e[t]=i,i},ye=function(e,t,n){let r=Promise.resolve();if(t&&t.length>0){let e,i=document.querySelector(`meta[property=csp-nonce]`),a=i?.nonce||i?.getAttribute(`nonce`);function o(e){return Promise.all(e.map(e=>Promise.resolve(e).then(e=>({status:`fulfilled`,value:e}),e=>({status:`rejected`,reason:e}))))}function s(e){return import.meta.resolve?new URL(import.meta.resolve(e)):new URL(e,import.meta.url)}r=o(t.map(t=>{t=he(t,n);let r=s(t),i=_e(r);return ve(ge,r.href,()=>{if(e===void 0){e={all:new Set,styles:new Set};let t=document.getElementsByTagName(`link`);for(let n=t.length-1;n>=0;n--){let r=t[n];e.all.add(r.href),r.rel===`stylesheet`&&e.styles.add(r.href)}}if((i?e.styles:e.all).has(r.href))return;let t=document.createElement(`link`);if(t.rel=i?`stylesheet`:me,i||(t.as=`script`),t.crossOrigin=``,t.href=r.href,a&&t.setAttribute(`nonce`,a),document.head.appendChild(t),i)return new Promise((e,n)=>{t.addEventListener(`load`,e),t.addEventListener(`error`,()=>n(Error(`Unable to preload CSS for ${r}`)))})})}).filter(e=>e!==void 0))}function i(e){let t=new Event(`vite:preloadError`,{cancelable:!0});if(t.payload=e,window.dispatchEvent(t),!t.defaultPrevented)throw e}return r.then(t=>{for(let e of t||[])e.status===`rejected`&&i(e.reason);return e().catch(i)})},be=`
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
`;function xe(e){let t=document.createElement(`style`);t.textContent=be,document.head.append(t);let n=document.createElement(`div`);n.className=`potemkin-notes-ui`;let r=document.createElement(`button`);r.type=`button`,r.className=`potemkin-notes-btn`,r.setAttribute(`aria-expanded`,`false`),r.textContent=`Notes · I`,n.append(r),document.body.append(n);let i=null,a=null,o=async()=>{i?i.toggle():(a||=(r.textContent=`Loading…`,ye(()=>import(`./walk-notes-54s6nGo4.js`).then(t=>(r.textContent=`Notes · I`,i=t.attachWalkNotesDrawer({...e,root:n,btn:r}),i.setOpen(!0),i)),[],import.meta.url).catch(()=>{r.textContent=`Notes · I`,a=null})),await a)};return r.addEventListener(`click`,e=>{e.stopPropagation(),o()}),window.addEventListener(`keydown`,e=>{if(e.metaKey||e.ctrlKey||e.altKey||e.repeat)return;let t=e.key.toLowerCase();t===`i`||e.key===`?`?o():t===`escape`&&i&&!document.pointerLockElement&&i.setOpen(!1)}),{tick(){i?.tick()}}}y.prototype.raycast=de;var x=new URLSearchParams(location.search),S=x.get(`run`)??document.documentElement.dataset.run??`loft-h3-soft-scout`,C=document.documentElement.dataset.base??`/runs/`,w=document.getElementById(`view`),Se=document.getElementById(`hud`),T=document.getElementById(`msg`),E=new se({canvas:w,antialias:!1,powerPreference:`high-performance`}),Ce=Math.min(window.devicePixelRatio,2),we=Number(new URLSearchParams(location.search).get(`res`))||0,D=we||1;E.setPixelRatio(1),E.autoClear=!1;var O={hdr:!0,lens:!0,dof:!0,blur:!0,film:!0,glass:!0,maps:!0,clay:!1,aa:!1,tour:!1},Te=`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,k=(t,n)=>new e({vertexShader:Te,fragmentShader:t,uniforms:n,depthTest:!1,depthWrite:!1,toneMapped:!1}),Ee=`attribute vec3 bary; varying vec2 vUv; varying vec3 vWorld, vNormal, vBary;
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
}`;function We(){let e=1024,t=document.createElement(`canvas`);t.width=t.height=e;let n=t.getContext(`2d`);n.fillStyle=`#000`,n.fillRect(0,0,e,e),n.globalCompositeOperation=`lighter`;let r=1234567,i=()=>(r=r*1664525+1013904223>>>0)/4294967296,a=e=>{let t=i(),[n,r,a]=t<.3?[255,236,210]:t<.55?[215,232,255]:[255,255,255];return t=>`rgba(${n},${r},${a},${e*t})`},o=(e,t,r,i)=>{let a=n.createRadialGradient(e,t,0,e,t,r);for(let[e,t]of i)a.addColorStop(e,t);n.fillStyle=a,n.beginPath(),n.arc(e,t,r,0,Math.PI*2),n.fill()};for(let t=0;t<26;t++){let t=a(.035+i()*.05);o(i()*e,i()*e,90+i()*220,[[0,t(1)],[.6,t(.5)],[1,t(0)]])}for(let t=0;t<110;t++){let t=a(.04+i()*.16);o(i()*e,i()*e,8+i()**2.2*120,[[0,t(1)],[.5,t(.45)],[1,t(0)]])}for(let t=0;t<40;t++){let t=a(.05+i()*.12);o(i()*e,i()*e,4+i()**1.8*26,[[0,t(.35)],[.6,t(.5)],[.86,t(1)],[1,t(0)]])}n.lineCap=`round`;for(let t=0;t<7;t++){let t=i()*e,r=i()*e,o=120+i()*360,s=i()*Math.PI*2,c=.3+i()*.7,l=a(.025+i()*.04);for(let e=0;e<16;e++)n.strokeStyle=l(.4+i()*.6),n.lineWidth=.6+i()*1.6,n.beginPath(),n.arc(t,r,o+e*(2+i()*3),s+i()*.08,s+c-i()*.1),n.stroke()}for(let t=0;t<5;t++){n.strokeStyle=a(.12+i()*.12)(1),n.lineWidth=.8+i()*.8,n.beginPath();let t=i()*e,r=i()*e;n.moveTo(t,r);for(let e=0;e<3;e++){let e=t+(i()-.5)*140,a=r+(i()-.5)*140;n.quadraticCurveTo(t+(i()-.5)*90,r+(i()-.5)*90,e,a),t=e,r=a}n.stroke()}for(let t=0;t<1400;t++){let t=a(.15+i()**3*.75);o(i()*e,i()*e,.8+i()**4*4.5,[[0,t(1)],[.5,t(.7)],[1,t(0)]])}let s=new ae(t);return s.colorSpace=``,s.minFilter=v,s}var Ge=.05,Ke=400,A=new u(58,1,Ge,Ke),j=new g,qe=new g,Je=new pe(-1,1,1,-1,0,1),Ye=new y(new r(2,2));Ye.frustumCulled=!1,qe.add(Ye);var Xe={type:ne,minFilter:d,magFilter:d,depthBuffer:!1},M=(e,t,n={})=>new a(Math.max(1,Math.round(e)),Math.max(1,Math.round(t)),{...Xe,...n}),N=null;function Ze(){let e=Math.max(64,Math.floor(window.innerWidth*Ce*D)),n=Math.max(64,Math.floor(window.innerHeight*Ce*D));if(E.setSize(e,n,!1),A.aspect=e/n,A.updateProjectionMatrix(),N)for(let e of N.all)e.dispose();let r=M(e,n,{depthBuffer:!0,depthTexture:new ce(e,n,s),samples:4}),i=Array.from({length:6},(t,r)=>M(e/2**(r+1),n/2**(r+1))),o=Array.from({length:5},(t,r)=>M(e/2**(r+1),n/2**(r+1)));N={w:e,h:n,scene:r,dof:M(e,n),blur:M(e,n),mips:i,ups:o,ldr:new a(e,n,{minFilter:d,magFilter:d,depthBuffer:!1}),flareA:M(e/4,n/4),flareB:M(e/4,n/4),streakA:M(e/4,n/4),streakB:M(e/4,n/4),lum:new a(32,32,{type:h,minFilter:t,magFilter:t,depthBuffer:!1})},N.all=[r,N.ldr,N.dof,N.blur,...i,...o,N.flareA,N.flareB,N.streakA,N.streakB,N.lum]}var P=e=>new c(1/e.width,1/e.height),Qe=(e,t)=>e.elements.some((e,n)=>Math.abs(e-t.elements[n])>1e-5);function F(e,t,n={}){for(let[t,r]of Object.entries(n)){let n=e.uniforms[t];r?.isVector2||r?.isVector3||r?.isMatrix4||r?.isColor?n.value.copy(r):n.value=r}Ye.material=e,E.setRenderTarget(t),E.render(qe,Je)}var $e=()=>({tDepth:{value:null},uNear:{value:Ge},uFar:{value:Ke}}),I={dof:k(Me,{...$e(),tSrc:{value:null},uTexel:{value:new c},uFocus:{value:4},uCoc:{value:0},uMaxCoc:{value:14},uFrame:{value:0}}),blur:k(Ne,{...$e(),tSrc:{value:null},uInvViewProj:{value:new p},uPrevViewProj:{value:new p},uShutter:{value:.5}}),down:k(Pe,{tSrc:{value:null},uTexel:{value:new c},uKnee:{value:0}}),up:k(Fe,{tSrc:{value:null},tAdd:{value:null},uTexel:{value:new c}}),threshold:k(Ie,{tSrc:{value:null},uTexel:{value:new c},uLevel:{value:3},uRange:{value:4},uCap:{value:1e4}}),flareBlur:k(Le,{tSrc:{value:null},uTexel:{value:new c},uOffset:{value:1.5}}),features:k(Re,{tSrc:{value:null},uTexel:{value:new c},uGhost:{value:.05},uHalo:{value:.06},uChroma:{value:24},uSpin:{value:0}}),streak:k(ze,{tSrc:{value:null},uTexel:{value:new c},uStep:{value:1},uDecay:{value:.4}}),lum:k(Be,{tSrc:{value:null}}),fxaa:k(Ve,{tSrc:{value:null},uTexel:{value:new c}}),sharp:k(He,{tSrc:{value:null},uTexel:{value:new c},uAmount:{value:.8}}),final:k(Ue,{tSrc:{value:null},tBloom:{value:null},tBloomWide:{value:null},tDirt:{value:We()},tFlare:{value:null},tStreak:{value:null},tStreakCore:{value:null},uRes:{value:new c},uExposure:{value:1},uBloomI:{value:.018},uDirtI:{value:.06},uFlareI:{value:.5},uStreakI:{value:.12},uFlareDirt:{value:1.5},uStreakTint:{value:new ee(.55,.75,1)},uCA:{value:.012},uVignette:{value:.8},uGrain:{value:.022},uTime:{value:0},uLens:{value:1},uFilm:{value:1}})},et=.6,tt=4,nt=6,rt=Number(x.get(`relief`)??.012),it=Number(x.get(`gloss`)??1),L=!1,R=new e({vertexShader:Ee,fragmentShader:De,side:2,toneMapped:!1,uniforms:{map:{value:null},uBoxMin:{value:new i},uBoxMax:{value:new i},uLift:{value:et},uOutside:{value:tt},tMaps:{value:null},tRelief:{value:null},tEnv:{value:null},uProbe:{value:new i},uRoomMin:{value:new i},uRoomMax:{value:new i},uMaps:{value:0},uClay:{value:0},uRelief:{value:rt},uEnvLod:{value:0},uGloss:{value:it},uShow:{value:0}}}),at=new y(new ie(300,24,12),new e({side:1,depthWrite:!1,toneMapped:!1,uniforms:{uSky:{value:nt}},fragmentShader:Ae,vertexShader:`varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0); }`}));j.add(at);var ot=[...[-8,-4,0,4].map(e=>({axis:`z`,at:-5.15,from:e-1.2,to:e+1.2,cols:3,rows:4,inward:1})),...[-6,-2,2,6].map(e=>({axis:`z`,at:5.15,from:e-1.2,to:e+1.2,cols:3,rows:4,inward:-1})),{axis:`x`,at:-10.15,from:-1.6,to:1.6,cols:4,rows:4,inward:1}];function st(e,t=1,n=4.2,r=.07){let i=[],a=[],o=[],s=[],c=[];for(let l of e){let e=l.from+r,u=l.to-r,d=t+r,f=n-r,p=i.length/3;for(let[t,n]of[[0,0],[1,0],[1,1],[0,1]]){let r=e+(u-e)*t,c=d+(f-d)*n;i.push(...l.axis===`z`?[r,c,l.at]:[l.at,c,r]),a.push(...l.axis===`z`?[0,0,l.inward]:[l.inward,0,0]),o.push(t,n),s.push(l.cols,l.rows)}c.push(p,p+1,p+2,p,p+2,p+3)}let l=new m;return l.setAttribute(`position`,new _(i,3)),l.setAttribute(`normal`,new _(a,3)),l.setAttribute(`uv`,new _(o,2)),l.setAttribute(`grid`,new _(s,2)),l.setIndex(c),l}var z=new e({vertexShader:Oe,fragmentShader:ke,side:2,transparent:!0,depthWrite:!1,toneMapped:!1,blending:5,blendSrc:201,blendDst:205,blendSrcAlpha:201,blendDstAlpha:205,uniforms:{tEnv:{value:null},uProbe:{value:new i},uBoxMin:{value:new i},uBoxMax:{value:new i},uDay:{value:4}}}),B=null,V=null;function ct(e){let t=e.index?e.toNonIndexed():e,n=t.getAttribute(`position`),r=new Float32Array(n.count*3),a=[new i,new i,new i],o=new i,s=new i;for(let e=0;e<n.count;e+=3){for(let t=0;t<3;t++)a[t].fromBufferAttribute(n,e+t);let t=-1;for(let e=0;e<3;e++)o.subVectors(a[(e+1)%3],a[e]),s.subVectors(a[(e+2)%3],a[e]),Math.abs(o.dot(s))<.02*o.length()*s.length()&&(t=e);for(let n=0;n<3;n++)r[(e+n)*3+n]=1,t>=0&&(r[(e+n)*3+t]=1)}return t.setAttribute(`bary`,new _(r,3)),t}var lt=1.65,ut=1.15,dt=.74,H=null,U=null,W=0,G=new n;function ft(e,t){let n=new i().subVectors(t,e),r=n.length();n.divideScalar(r);for(let t of[0,-.75,-1.3])if(G.set(new i(e.x,e.y+t,e.z),n),G.far=r,G.intersectObject(H,!1).length)return!1;return!0}function pt(e){let t=e.length,n=e.map(()=>[]);for(let r=0;r<t;r++)for(let i=r+1;i<t;i++){let t=e[r].distanceTo(e[i]);t<9&&ft(e[r],e[i])&&(n[r].push({to:i,d:t}),n[i].push({to:r,d:t}))}let r=e.reduce((e,t)=>e.add(t),new i).divideScalar(t),a=0;for(let n=1;n<t;n++)e[n].distanceTo(r)<e[a].distanceTo(r)&&(a=n);let o=new Set([a]),s=[],c=(e,t)=>{s.push(e);let r=n[e].filter(e=>!o.has(e.to)).sort((e,t)=>e.d-t.d);for(let t of r)o.has(t.to)||(o.add(t.to),c(t.to,e),s.push(e))};c(a,-1),s.length>1&&s[s.length-1]===s[0]&&s.pop();let l=new fe(s.map(t=>e[t].clone()),!0,`centripetal`);return l.arcLengthDivisions=1200,l}var K={dist:0,yaw:0,pitch:0,focus:4,exposure:1,time:0,stride:0,speed:0,show:Number(x.get(`show`)??0)},q=new i,J=new i,Y=new Set,mt=new p,X=new p,ht=new p,gt=new Float32Array(4096),Z=0,Q=null,_t=!1;function vt(e,t,n){for(let r of[-.2,-.75,-1.3])if(G.set(new i(e.x,e.y+r,e.z),t),G.far=n+.35,G.intersectObject(H,!1).length)return!1;return!0}function yt(e){let t=0;if(O.tour){K.dist=((K.dist+ut*e)%W+W)%W;let n=K.dist/W,r=U.getPointAt(n),a=U.getPointAt((n+2.2/W)%1),o=new i().subVectors(a,r).setY(0).normalize();q.copy(r);let s=K.time,c=1-Math.exp(-e*2.2),l=Math.atan2(-o.x,-o.z)+.38*Math.sin(s*.21)+.2*Math.sin(s*.53+1.3);K.yaw+=Math.atan2(Math.sin(l-K.yaw),Math.cos(l-K.yaw))*c,K.pitch+=(-.05+.07*Math.sin(s*.17+.6)-K.pitch)*c,K.stride+=ut*e/dt*Math.PI,t=1}else{let n=(Y.has(`w`)||Y.has(`arrowup`)?1:0)-(Y.has(`s`)||Y.has(`arrowdown`)?1:0),r=(Y.has(`d`)||Y.has(`arrowright`)?1:0)-(Y.has(`a`)||Y.has(`arrowleft`)?1:0),a=new i(-Math.sin(K.yaw)*n+Math.cos(K.yaw)*r,0,-Math.cos(K.yaw)*n-Math.sin(K.yaw)*r);a.lengthSq()>0&&a.normalize().multiplyScalar(Y.has(`shift`)?3.4:1.7),J.lerp(a,1-Math.exp(-e*9));for(let t of[`x`,`z`]){let n=J[t]*e;Math.abs(n)<1e-5||(vt(q,new i(t===`x`?Math.sign(n):0,0,t===`z`?Math.sign(n):0),Math.abs(n))?q[t]+=n:J[t]=0)}q.x=b.clamp(q.x,Q[0]+.4,Q[3]-.4),q.z=b.clamp(q.z,Q[2]+.4,Q[5]-.4);let o=Math.hypot(J.x,J.z);K.stride+=o*e/dt*Math.PI,t=Math.min(1,o/1.7)}K.speed+=(t-K.speed)*(1-Math.exp(-e*6));let n=Math.abs(Math.sin(K.stride))*.03*K.speed,r=Math.sin(K.stride)*.016*K.speed;A.position.set(q.x+Math.cos(K.yaw)*r,q.y+n,q.z-Math.sin(K.yaw)*r),A.rotation.set(K.pitch,K.yaw,Math.sin(K.stride)*.005*K.speed,`YXZ`),A.updateMatrixWorld(!0)}function bt(e){let t=1/0;for(let[e,n]of[[0,0],[.08,-.06],[-.08,-.06],[0,-.14],[0,.08]]){G.setFromCamera(new c(e,n),A),G.far=60;let r=G.intersectObject(H,!1)[0];r&&(t=Math.min(t,r.distance))}t===1/0&&(t=30);let n=t<K.focus?5:2.2;K.focus+=(t-K.focus)*(1-Math.exp(-e*n))}function xt(e){let{w:t,h:n}=N;R.uniforms.uLift.value=O.hdr?et:0,R.uniforms.uOutside.value=O.hdr?tt:1,at.material.uniforms.uSky.value=O.hdr?nt:1,B&&(B.visible=O.glass&&!O.clay,z.uniforms.uDay.value=O.hdr?tt:1),R.uniforms.uMaps.value=O.maps&&L&&!O.clay?1:0,R.uniforms.uClay.value=+!!O.clay,R.uniforms.uShow.value=K.show,E.setRenderTarget(N.scene),E.setClearColor(0,1),E.clear(),E.render(j,A),X.multiplyMatrices(A.projectionMatrix,A.matrixWorldInverse);let r=N.scene.depthTexture,i=N.scene;O.dof&&(F(I.dof,N.dof,{tSrc:i.texture,tDepth:r,uTexel:P(N.scene),uFocus:K.focus,uCoc:.009*n,uMaxCoc:Math.max(4,n/130),uFrame:Z%64}),i=N.dof),O.blur&&Qe(X,mt)&&(F(I.blur,N.blur,{tSrc:i.texture,tDepth:r,uInvViewProj:ht.copy(X).invert(),uPrevViewProj:mt,uShutter:.5*Math.min(1,1/60/Math.max(e,.001))*(e>0)+0}),i=N.blur),mt.copy(X);let a=i,o=Math.max(K.exposure,.05);N.mips.forEach((e,t)=>{F(I.down,e,{tSrc:a.texture,uTexel:P(a),uKnee:t===0?2.2/o:0}),a=e});let s=N.mips[5];for(let e=4;e>=0;e--)F(I.up,N.ups[e],{tSrc:s.texture,tAdd:N.mips[e].texture,uTexel:P(s)}),s=N.ups[e];let l=N.flareA,u=N.flareB,d=N.streakA,f=N.streakB;F(I.threshold,u,{tSrc:i.texture,uTexel:P(i).multiplyScalar(2),uLevel:3.5/o,uRange:6/o,uCap:12/o}),F(I.flareBlur,l,{tSrc:u.texture,uTexel:P(u),uOffset:1.5}),F(I.flareBlur,u,{tSrc:l.texture,uTexel:P(u),uOffset:2.5}),F(I.flareBlur,l,{tSrc:u.texture,uTexel:P(u),uOffset:3.5}),F(I.threshold,f,{tSrc:i.texture,uTexel:P(i).multiply(new c(2,.5)),uLevel:5/o,uRange:6/o,uCap:7/o}),F(I.streak,d,{tSrc:f.texture,uTexel:P(d),uStep:1,uDecay:.35}),F(I.streak,f,{tSrc:d.texture,uTexel:P(d),uStep:4,uDecay:.5}),F(I.streak,d,{tSrc:f.texture,uTexel:P(d),uStep:16,uDecay:.75}),F(I.features,u,{tSrc:l.texture,uTexel:P(l),uGhost:.018,uHalo:.012,uChroma:24,uSpin:K.yaw*9+K.pitch*6}),Z%6==0&&!_t&&(F(I.lum,N.lum,{tSrc:N.mips[2].texture}),_t=!0,E.readRenderTargetPixelsAsync(N.lum,0,0,32,32,gt).then(()=>{let e=0,t=0;for(let n=0;n<gt.length;n+=4)e+=gt[n],t+=gt[n+1];let n=Math.exp(e/Math.max(t,.001));K.wantExposure=O.hdr?b.clamp(.14/n,.25,2):1}).catch(()=>{}).finally(()=>{_t=!1}));let p=K.wantExposure??1;K.exposure+=(p-K.exposure)*(1-Math.exp(-e*(p<K.exposure?5:1.1))),F(I.final,N.ldr,{tSrc:i.texture,tBloom:N.ups[0].texture,tBloomWide:N.ups[3].texture,tFlare:u.texture,tStreak:d.texture,tStreakCore:f.texture,uRes:new c(t,n),uExposure:K.exposure,uTime:K.time,uLens:+!!O.lens,uFilm:+!!O.film}),O.aa?F(I.fxaa,null,{tSrc:N.ldr.texture,uTexel:P(N.ldr)}):F(I.sharp,null,{tSrc:N.ldr.texture,uTexel:P(N.ldr)}),Z++}var $={sum:0,n:0,fps:60,since:0};function St(e){if(we||!(e>0)||e>250||($.sum+=e,$.n++,$.since+=e,$.n<30))return;let t=$.sum/$.n;if($.fps=1e3/t,$.sum=$.n=0,$.since<1e3)return;let n=t>22?Math.max(.75,D*.9):t<15&&D<1?Math.min(1,D*1.08):D;Math.abs(n-D)>.01&&(D=n,$.since=0,Ze())}function Ct(){let e=(e,t,n=!0)=>`<span class="${n?``:`off`}"><b>${e}</b> ${t}</span>`;Se.innerHTML=[e(`W A S D`,`walk · shift: run`),e(`click`,document.pointerLockElement?`mouse looks · esc releases it`:`to look with the mouse (or drag)`),e(`H`,`fake HDR + auto exposure`,O.hdr),e(`L`,`lens: bloom, dirt, flare`,O.lens),e(`F`,`auto-focus depth of field`,O.dof),e(`B`,`motion blur`,O.blur),e(`G`,`fringe, vignette, grain`,O.film),e(`P`,`glass panes in the windows`,O.glass),e(`M`,L?`materials: reflections, relief`:`materials (this run has no maps)`,O.maps&&L),e(`X`,`clay + wireframe`,O.clay),e(`K`,`extra edge smoothing (softer)`,O.aa),e(`T`,`tour: walks by itself`,O.tour)].join(`
`)+`\nfocus ${K.focus.toFixed(1)} m · exposure ${K.exposure>=1?`+`:``}${Math.log2(K.exposure).toFixed(1)} EV · ${Math.round($.fps)} fps at ${N.w} × ${N.h}`}async function wt(){let e=await(await fetch(`${C}${S}/run.json`)).json(),t=E.capabilities.maxTextureSize>=8192,n=[...(x.get(`tex`)??(t?`8k`:`4k`))===`8k`?[`level_8k.glb`]:[],`level_4k.glb`,`level_textured.glb`],r=null;for(let e of n){let t=await fetch(`${C}${S}/${e}`,{method:`HEAD`}).catch(()=>null);if(t?.ok&&!/text\/html/.test(t.headers.get(`content-type`)??``)){T.textContent=`loading the loft (${e.includes(`8k`)?`8192`:`4096`} px of texture)…`,r=await new le().loadAsync(`${C}${S}/${e}`);break}}if(!r)throw Error(`no level file found`);r.scene.updateMatrixWorld(!0);let a=[];r.scene.traverse(e=>{e.isMesh&&a.push(e)});let s=e=>(e.colorSpace=``,e.generateMipmaps=!0,e.minFilter=v,e.magFilter=d,e.anisotropy=E.capabilities.getMaxAnisotropy(),e.needsUpdate=!0,e),c;if(a.length===1)H=a[0],c=s(H.material.map),R.uniforms.map.value=c,H.material=R,H.geometry=ct(H.geometry);else{for(let e of a){let t=R.clone();t.uniforms={...R.uniforms,map:{value:s(e.material.map)},tMaps:{value:null},tRelief:{value:null}},e.material=t,e.geometry=ct(e.geometry)}c=a[0].material.uniforms.map.value,H=new y(re(a.map(e=>e.geometry.clone().applyMatrix4(e.matrixWorld))),new l({side:2}))}let u=a.length;H.geometry.boundsTree=new oe(H.geometry),j.add(r.scene);let p=new ue().setFromObject(H);Q=e.area??[...p.min.toArray(),...p.max.toArray()],R.uniforms.uBoxMin.value.set(Q[0]-.6,Q[1]-1,Q[2]-.6),R.uniforms.uBoxMax.value.set(Q[3]+.6,Q[4]+1,Q[5]+.6);let m=async(e,t)=>{let n=await fetch(`${C}${S}/${e}`,{method:`HEAD`}).catch(()=>null);if(!n?.ok||/text\/html/.test(n.headers.get(`content-type`)??``))return null;let r=await new o().loadAsync(`${C}${S}/${e}`);return r.flipY=!1,r.colorSpace=``,t&&(r.format=t),r.generateMipmaps=!0,r.minFilter=v,r.magFilter=d,r.anisotropy=c.anisotropy,r};if(x.get(`maps`)!==`off`){T.textContent=`loading the material maps…`;let e=c.image.width*Math.sqrt(u)>=8192&&x.get(`maps`)!==`4k`?`8k`:`4k`,t=async t=>{let n=await m(`maps_${e}${t}.jpg`)??(e===`8k`?await m(`maps_4k${t}.jpg`):null),r=n&&(await m(`relief_${e}${t}.jpg`,1028)??(e===`8k`?await m(`relief_4k${t}.jpg`,1028):null));return n&&r?{maps:n,relief:r}:null},n=u===1?[R]:a.map(e=>e.material),r=await Promise.all(n.map((e,n)=>t(u===1?``:`_p${n}`)));r.every(Boolean)&&(n.forEach((e,t)=>{e.uniforms.tMaps.value=r[t].maps,e.uniforms.tRelief.value=r[t].relief}),L=!0)}let ee=/loft/.test(e.level??S);if(ee||L){let e=L?512:256,t=new f(e,{type:ne,generateMipmaps:!0,minFilter:v});V=new te(.1,400,t),V.position.set((Q[0]+Q[3])/2,(Q[1]+Q[4])/2,(Q[2]+Q[5])/2),j.add(V),V.update(E,j);for(let e of[z,R])e.uniforms.tEnv.value=t.texture,e.uniforms.uProbe.value.copy(V.position);z.uniforms.uBoxMin.value.set(Q[0],Q[1],Q[2]),z.uniforms.uBoxMax.value.set(Q[3],Q[4],Q[5]),R.uniforms.uRoomMin.value.set(Q[0]-.15,Q[1],Q[2]-.15),R.uniforms.uRoomMax.value.set(Q[3]+.15,Q[4],Q[5]+.15),R.uniforms.uEnvLod.value=Math.log2(e*1.273)-1}ee&&(B=new y(st(ot),z),B.renderOrder=2,j.add(B));let h=Q[1],ie=e.plan.points.map(e=>new i(e[0],e[1],e[2])).filter(e=>Math.abs(e.y-1.6-h)<.25).map(e=>e.setY(h+lt));U=pt(ie),W=U.getLength();let g=new i((Q[0]+Q[3])/2,h+lt,(Q[2]+Q[5])/2);q.copy(ie.reduce((e,t)=>t.distanceTo(g)<e.distanceTo(g)?t:e)),K.yaw=Q[3]-Q[0]>Q[5]-Q[2]?Math.PI/2:0,Ze(),T.remove(),Se.hidden=!1;let ae=xe({sceneKind:`loft`,getSnapshot:()=>({pos:q,on:{...O},meta:e,hasMaps:L,focus:K.focus,runId:S})});window.demo={state:K,on:O,path:U,camera:A,position:q,keys:Y,pace:$,get length(){return W},get scale(){return D},get size(){return[N.w,N.h]},bench(e=120,t=!0){let n=E.getContext(),r=new Uint8Array(4),i=()=>{E.setRenderTarget(null),n.readPixels(0,0,1,1,n.RGBA,n.UNSIGNED_BYTE,r)};xt(.016),i();let a=performance.now();for(let n=0;n<e;n++)t&&(A.rotation.y+=(n%2?1:-1)*.004,A.updateMatrixWorld(!0)),xt(.016);return i(),(performance.now()-a)/e}};let _=performance.now(),se=_;E.setAnimationLoop(e=>{let t=b.clamp((e-_)/1e3,0,.1);_=e,K.time+=t,yt(t),bt(t),xt(t),St(e-se),se=e,Z%10==0&&(Ct(),ae.tick())})}window.addEventListener(`resize`,Ze),window.addEventListener(`keydown`,e=>{let t=e.key.toLowerCase();Y.add(t);let n={h:`hdr`,l:`lens`,f:`dof`,b:`blur`,g:`film`,p:`glass`,m:`maps`,x:`clay`,k:`aa`,t:`tour`}[t];if(n&&!e.repeat&&(O[n]=!O[n],n===`tour`&&O.tour)){let e=0,t=1/0;for(let n=0;n<400;n++){let r=U.getPointAt(n/400).distanceTo(q);r<t&&(t=r,e=n/400)}K.dist=e*W}[`w`,`a`,`s`,`d`,` `,`arrowup`,`arrowdown`,`arrowleft`,`arrowright`].includes(t)&&e.preventDefault()}),window.addEventListener(`keyup`,e=>Y.delete(e.key.toLowerCase())),window.addEventListener(`blur`,()=>Y.clear());var Tt=(e,t)=>{O.tour||(K.yaw-=e*.0024,K.pitch=b.clamp(K.pitch-t*.0024,-1.3,1.3))},Et=!1;w.addEventListener(`click`,()=>{if(!document.pointerLockElement)try{Promise.resolve(w.requestPointerLock?.()).catch(()=>{})}catch{}}),w.addEventListener(`pointerdown`,()=>{Et=!0}),window.addEventListener(`pointerup`,()=>{Et=!1}),window.addEventListener(`mousemove`,e=>{(document.pointerLockElement===w||Et)&&Tt(e.movementX,e.movementY)}),wt().catch(e=>{T.textContent=`could not load run "${S}": ${e.message}`,console.error(e)});export{ye as t};