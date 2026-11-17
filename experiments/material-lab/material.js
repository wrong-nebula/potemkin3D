import * as THREE from 'three';

export async function loadDetail(kind) {
  const loader = new THREE.TextureLoader();
  const packed = await loader.loadAsync(`./assets/${kind}-packed.png`);
  packed.colorSpace = THREE.NoColorSpace;
  packed.flipY = false;
  packed.minFilter = THREE.LinearMipmapLinearFilter;
  packed.anisotropy = 8;
  const image = await loader.loadAsync(`./assets/${kind}-protect.png`);
  const canvas = document.createElement('canvas');
  canvas.width=image.image.width; canvas.height=image.image.height;
  const context=canvas.getContext('2d'); context.drawImage(image.image,0,0);
  const rgba=context.getImageData(0,0,canvas.width,canvas.height).data;
  const bytes=new Uint8Array(canvas.width*canvas.height);
  for(let i=0;i<bytes.length;i++)bytes[i]=rgba[i*4];
  image.dispose();
  const protect=new THREE.DataTexture(bytes,canvas.width,canvas.height,THREE.RedFormat);
  protect.minFilter=THREE.LinearMipmapLinearFilter; protect.magFilter=THREE.LinearFilter;
  protect.generateMipmaps=true;protect.needsUpdate=true;
  const statistics=kind==='tile' ? await loader.loadAsync('./assets/tile-statistics.png') : null;
  if(statistics){statistics.flipY=false;statistics.generateMipmaps=false;statistics.minFilter=statistics.magFilter=THREE.NearestFilter;}
  return {packed,protect,statistics};
}

export function installDetail(material,kind,assets,settings,regionCount=0) {
  material.defines={...material.defines,USE_UV:''};
  const previous=material.onBeforeCompile, cache=material.customProgramCacheKey();
  const uniforms={
    tLabPacked:{value:assets.packed},tLabProtect:{value:assets.protect},tLabStats:{value:assets.statistics ?? assets.packed},
    uLabEnabled:settings.enabled,uLabDebug:settings.debug,uLabStrength:settings.strength,
    uLabRegions:{value:regionCount},
  };
  material.onBeforeCompile=function(shader,renderer){
    previous.call(this,shader,renderer);
    Object.assign(shader.uniforms,uniforms);
    shader.vertexShader=shader.vertexShader.replace('#include <common>',`#include <common>
varying vec3 vLabWorld; varying vec3 vLabGeomNormal;`)
      .replace('#include <begin_vertex>',`#include <begin_vertex>
vLabWorld=(modelMatrix*vec4(transformed,1.0)).xyz;
vLabGeomNormal=normalize(mat3(modelMatrix)*objectNormal);`);
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
#define LAB_STONE ${kind==='stone' ? 1 : 0}
uniform sampler2D tLabPacked,tLabProtect,tLabStats;
uniform float uLabEnabled,uLabDebug,uLabStrength,uLabRegions;
varying vec3 vLabWorld,vLabGeomNormal;
float labWeight=0.0,labProtection=0.0,labHeight=0.0,labRough=0.8,labSelected=0.0;
vec3 labOriginal=vec3(0.0);
float labHash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
vec2 labMirror(vec2 p){return 1.0-abs(mod(p,2.0)-1.0);}
vec4 labRead(vec2 p,vec2 dx,vec2 dy){
  vec2 signUV=sign(1.0-mod(p,2.0));
  return textureGrad(tLabPacked,labMirror(p),dx*signUV,dy*signUV);
}
vec4 labStone(vec2 p,vec2 dx,vec2 dy){
  // Three overlapping samples share one transform for colour, roughness and height.
  // Coordinates are fixed in world metres, independent of the camera and UV islands.
  vec2 skew=vec2(p.x-p.y*0.57735027,p.y*1.15470054)*0.5;
  vec2 cell=floor(skew),f=fract(skew);
  vec3 w;vec2 a,b,c;
  if(f.x+f.y<1.0){w=vec3(1.0-f.x-f.y,f.x,f.y);a=cell;b=cell+vec2(1,0);c=cell+vec2(0,1);}
  else{w=vec3(f.x+f.y-1.0,1.0-f.x,1.0-f.y);a=cell+1.0;b=cell+vec2(0,1);c=cell+vec2(1,0);}
  w=w*w*(3.0-2.0*w);w/=dot(w,vec3(1));
  vec4 x=labRead(p+vec2(labHash(a),labHash(a+17.0))*11.0,dx,dy);
  vec4 y=labRead(p+vec2(labHash(b),labHash(b+17.0))*11.0,dx,dy);
  vec4 z=labRead(p+vec2(labHash(c),labHash(c+17.0))*11.0,dx,dy);
  vec4 result=x*w.x+y*w.y+z*w.z;
  result.r=.5+(result.r-.5)/sqrt(dot(w,w));
  return result;
}
vec3 labBump(vec3 at,vec3 n,vec2 dH,float facing){
  vec3 dx=dFdx(at),dy=dFdy(at),r1=cross(dy,n),r2=cross(n,dx);
  float det=dot(dx,r1)*facing;
  return normalize(abs(det)*n-sign(det)*(dH.x*r1+dH.y*r2));
}`);
    shader.fragmentShader=shader.fragmentShader.replace('#include <alphamap_fragment>',`
labOriginal=diffuseColor.rgb;
vec2 labWorldUV=${kind==='stone'?'vec2(vLabWorld.z,vLabWorld.y)/0.22':'vec2(vLabWorld.x,-vLabWorld.z)'};
vec2 labDx=dFdx(labWorldUV),labDy=dFdy(labWorldUV);
${kind==='stone' ? 'labSelected=(1.0-smoothstep(.008,.025,abs(vLabWorld.x+13.0)))*smoothstep(.94,.99,vLabGeomNormal.x);' : 'labSelected=smoothstep(.92,.99,vLabGeomNormal.y);'}
labProtection=texture2D(tLabProtect,vUv).r;
float labPreserve=1.0-smoothstep(.35,.82,labProtection);
float labDistance=length(vViewPosition);
float labNear=1.0-smoothstep(4.0,10.0,labDistance);
labWeight=labSelected*labPreserve*labNear*uLabEnabled*uLabStrength;
if(labSelected>0.0 && uLabEnabled>0.0){
  vec4 field;
#if LAB_STONE
  field=labStone(labWorldUV,labDx,labDy);
  diffuseColor.rgb*=1.0+labWeight*(field.r-.5)*.7;
  labHeight=(field.b-.5)*.0012*labWeight;
#else
  field=labRead(labWorldUV,labDx,labDy);
  // Restore only frequencies the original atlas could not hold, retaining its colour and stains.
  vec2 atlasSize=vec2(textureSize(map,0));
  float atlasFoot=max(length(dFdx(vUv)*atlasSize),length(dFdy(vUv)*atlasSize));
  float metresFoot=max(length(labDx),length(labDy));
  float density=atlasFoot/max(metresFoot,1e-7);
  float lowMip=clamp(log2(1024.0/max(density,1.0)),0.0,6.0);
  float low=textureLod(tLabPacked,labMirror(labWorldUV),lowMip).r;
  float restore=clamp((field.r+.015)/(low+.015),.65,1.35);
  // Local mean exchange on identified tile interiors, with a fixed grout layout.
  ivec2 cell=clamp(ivec2(labMirror(labWorldUV)*1024.0),ivec2(0),ivec2(1023));
  int region=int(texelFetch(tLabPacked,cell,0).a*255.0+.5);
  int other=1+int(labHash(floor(labWorldUV)+vec2(float(region)*.71,float(region)*1.17))*max(uLabRegions,1.0));
  float fromMean=texelFetch(tLabStats,ivec2(region,0),0).r;
  float toMean=texelFetch(tLabStats,ivec2(other,0),0).r;
  float variation=region>0 ? clamp(toMean-fromMean,-.08,.08)*.18 : 0.0;
  diffuseColor.rgb*=mix(1.0,restore+variation,labWeight);
  labHeight=(field.b-.5)*.002*labWeight;
#endif
  labRough=field.g;
}
#include <alphamap_fragment>`);
    shader.fragmentShader=shader.fragmentShader.replace('#include <lights_physical_fragment>',`
vec2 labHeightGradient=vec2(dFdx(labHeight),dFdy(labHeight));
#if !LAB_STONE
// The high-resolution height replaces the floor's blurry baked fine normal, not its geometry.
normal=normalize(mix(normal,nonPerturbedNormal,labWeight));
#endif
normal=labBump(-vViewPosition,normal,labHeightGradient,faceDirection);
roughnessFactor=mix(roughnessFactor,labRough,labWeight);
#include <lights_physical_fragment>`);
    shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',`
if(uLabDebug>0.5 && uLabDebug<1.5)outgoingLight=mix(vec3(.08),mix(vec3(.08,.52,.35),vec3(.9,.18,.13),labProtection),labSelected);
if(uLabDebug>1.5 && uLabDebug<2.5)outgoingLight=diffuseColor.rgb;
if(uLabDebug>2.5 && uLabDebug<3.5)outgoingLight=vec3(roughnessFactor);
if(uLabDebug>3.5)outgoingLight=vec3(labSelected*step(.82,labProtection));
#include <opaque_fragment>`);
  };
  material.customProgramCacheKey=()=>`${cache}|material-lab-4-${kind}`;
  material.needsUpdate=true;
  return uniforms;
}

export function textureBytes(texture){
  if(!texture?.image)return 0;
  const image=texture.image;
  let w=image.width??image[0]?.width??0,h=image.height??image[0]?.height??0;
  const channels=texture.format===THREE.RedFormat?1:texture.format===THREE.RGFormat?2:4;
  const component=texture.type===THREE.FloatType?4:texture.type===THREE.HalfFloatType?2:1;
  let pixels=w*h;
  if(texture.generateMipmaps){while(w>1||h>1){w=Math.max(1,w>>1);h=Math.max(1,h>>1);pixels+=w*h;}}
  return pixels*channels*component*(texture.isCubeTexture?6:1);
}
