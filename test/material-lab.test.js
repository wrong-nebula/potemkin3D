import { describe,it,expect } from 'vitest';
import * as THREE from 'three';
import { textureBytes } from '../experiments/material-lab/material.js';

describe('material study memory accounting',()=>{
  it('counts all mip levels of the single-channel preservation mask',()=>{
    const t=new THREE.DataTexture(new Uint8Array(1024*1024),1024,1024,THREE.RedFormat);
    t.generateMipmaps=true;
    expect(textureBytes(t)).toBe(1398101);
  });
  it('counts four packed byte channels without treating PNG size as GPU storage',()=>{
    const t=new THREE.DataTexture(new Uint8Array(512*512*4),512,512,THREE.RGBAFormat);
    t.generateMipmaps=true;
    expect(textureBytes(t)).toBe(1398100);
  });
  it('includes floating-point component width and excludes absent mipmaps',()=>{
    const t=new THREE.DataTexture(new Uint16Array(16*8*4),16,8,THREE.RGBAFormat,THREE.HalfFloatType);
    t.generateMipmaps=false;
    expect(textureBytes(t)).toBe(1024);
  });
});
