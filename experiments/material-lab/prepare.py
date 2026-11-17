"""Pack aligned material fields and preservation masks. No original assets are modified.

R = linear luminance detail, G = calibrated roughness, B = inferred height,
A = tile region ID (stone: 0). Normals are differentiated from B at runtime.
"""
from pathlib import Path
from collections import deque
from PIL import Image, ImageFilter
import numpy as np
import hashlib
import json

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ASSETS = HERE / 'assets'

def load(file, size=None):
    image = Image.open(file).convert('RGB')
    if size: image = image.resize((size, size), Image.Resampling.LANCZOS)
    return np.asarray(image, np.float32) / 255

def blur(a, radius):
    # Floating point separable box blur, repeated three times. Clamp at image edges.
    out = a.astype(np.float32)
    r = max(1, int(radius))
    for _ in range(3):
        for axis in [0, 1]:
            pad = [(0, 0)] * out.ndim
            pad[axis] = (r, r)
            p = np.pad(out, pad, mode='edge')
            c = np.cumsum(p, axis=axis, dtype=np.float64)
            zeros = list(c.shape); zeros[axis] = 1
            c = np.concatenate([np.zeros(zeros), c], axis=axis)
            hi = [slice(None)] * out.ndim; lo = hi.copy()
            hi[axis] = slice(2*r+1, None); lo[axis] = slice(None, -2*r-1)
            out = ((c[tuple(hi)] - c[tuple(lo)]) / (2*r+1)).astype(np.float32)
    return out

def smooth(a, b, x):
    t = np.clip((x-a)/(b-a), 0, 1)
    return t*t*(3-2*t)

def save(a, file):
    Image.fromarray(np.uint8(np.clip(a, 0, 1)*255+.5)).save(ASSETS/file)

def linear(a):
    return np.where(a <= .04045, a/12.92, ((a+.055)/1.055)**2.4)

def luminance(a):
    return (a * [.2126,.7152,.0722]).sum(-1)

def dilate(a, radius):
    return np.asarray(Image.fromarray(np.uint8(a*255)).filter(ImageFilter.MaxFilter(2*radius+1)), np.float32)/255

def regions(mask):
    """Connected tile interiors, not a guessed uniform grid. Zero is grout."""
    h,w = mask.shape
    labels = np.zeros((h,w), np.uint16)
    rid = 0
    for y,x in zip(*np.where(mask)):
        if labels[y,x]: continue
        rid += 1
        queue = deque([(int(y),int(x))]); labels[y,x] = rid
        pixels = []
        while queue:
            yy,xx = queue.popleft(); pixels.append((yy,xx))
            for dy,dx in [(0,1),(0,-1),(1,0),(-1,0)]:
                y2,x2=yy+dy,xx+dx
                if 0<=y2<h and 0<=x2<w and mask[y2,x2] and not labels[y2,x2]:
                    labels[y2,x2]=rid;queue.append((y2,x2))
        if len(pixels) < 120:
            for yy,xx in pixels: labels[yy,xx]=65535
            rid -= 1
    labels[labels==65535]=0
    if rid>254: raise ValueError(f'{rid} regions exceed the packed ID budget')
    return labels.astype(np.uint8),rid

meta = {}
for kind,size in [('stone',512),('tile',1024)]:
    source = load(ASSETS/f'{kind}-source.png',size)
    base = load(ASSETS/f'{kind}-basecolor.png',size)
    height = luminance(load(ASSETS/f'{kind}-height.png',size))
    rough = luminance(load(ASSETS/f'{kind}-roughness.png',size))
    if kind=='stone':
        # Exclude broad photographic shading/lean. This is sub-mm relief, never glyph geometry.
        h = height - blur(height,20)
        scale = max(float(np.percentile(np.abs(h),99)),.02)
        h = np.clip(.5 + h/(2*scale),.02,.98)
        c = luminance(linear(base)); c = np.clip(.5 + (c-blur(c,15))*2.5,.15,.85)
        rough = np.clip(.82 + .35*(rough-blur(rough,14)),.65,.96)
        ids = np.zeros_like(h)
        # Periodic reflection: no discontinuity in the sample value at its boundary.
        count=0
    else:
        # The original sample fixes tile layout and physical scale; predicted albedo never replaces it.
        c = luminance(linear(source))
        interior = (source[...,2]-source[...,0]>.035) & (luminance(source)>.35)
        interior = np.asarray(Image.fromarray(np.uint8(interior)*255).filter(ImageFilter.MinFilter(3)))>127
        ids,count = regions(interior)
        tile = ids>0
        # Remove model tilt per tile. Preserve a shallow bowl and fine glaze; grout is recessed.
        h = np.full_like(height,.08)
        stats=np.zeros((1,256,4),np.float32)
        stats[0,0]=[float(c[~tile].mean()),.88,0,1]
        for rid in range(1,count+1):
            yy,xx=np.where(ids==rid); values=height[yy,xx]
            design=np.stack([xx/size,yy/size,np.ones(len(xx))],1)
            plane=design@np.linalg.lstsq(design,values,rcond=None)[0]
            local=np.clip(values-plane,-.25,.25)
            h[yy,xx]=.68+local*.45
            stats[0,rid]=[float(c[yy,xx].mean()),float(rough[yy,xx].mean()),0,1]
        # Feather the inferred grout-to-glaze transition by one sample texel.
        h=blur(h,1)
        rough=np.clip(np.where(tile,.32+.18*(rough-.5),.88),.22,.96)
        save(stats,'tile-statistics.png')
        save(np.repeat((ids/255)[...,None],3,-1),'tile-regions.png')
    save(np.stack([c,rough,h,ids/255],-1),f'{kind}-packed.png')
    save(h,f'{kind}-height-calibrated.png')
    meta[kind]={'size':size,'regions':count,'heightSpanMetres':.0012 if kind=='stone' else .002,
                'baseRoughness':.82 if kind=='stone' else .32,
                'note':'Inferred height with artist-selected physical amplitude, not measured displacement.'}

# Protect the original glyph strokes, coloured paint and high-contrast boundaries.
atlas = load(ROOT/'deploy/luxor/hi/p0_base.jpg')
lum = luminance(atlas)
local = blur(lum,9)
contrast = np.abs(lum-local)/np.maximum(local,.08)
# Red pigment has excess red beyond the stone's warm yellow/brown axis.
# Simply testing R-G would incorrectly lock almost the entire sandstone wall.
red = np.maximum((atlas[...,0]-atlas[...,1])-1.4*(atlas[...,1]-atlas[...,2])-.04,0)
protect = smooth(.045,.16,contrast) + smooth(.02,.09,red)
protect = np.maximum(protect,dilate(smooth(.10,.22,contrast),3))
protect = np.clip(protect,0,1)
# Max-filter before downsampling: fine original strokes must not disappear from the mask.
mask = Image.fromarray(np.uint8(protect*255)).filter(ImageFilter.MaxFilter(5)).resize((1024,1024),Image.Resampling.BOX)
mask.save(ASSETS/'stone-protect.png')

# Any authored paint added after the kit is explicitly preserved on the Sento atlas.
floor = load(ROOT/'experiments/sento/out/world/hall/texture.jpg')
kit = load(ROOT/'experiments/sento/out/world/hall/texture_kit.jpg')
delta=np.max(np.abs(floor-kit),-1)
protect=smooth(.035,.14,blur(delta,1))
Image.fromarray(np.uint8(dilate(protect,2)*255)).resize((1024,1024),Image.Resampling.BOX).save(ASSETS/'tile-protect.png')

paths=['deploy/luxor/level_2k.glb','deploy/luxor/hi/p0_base.jpg','experiments/sento/out/world/hall/hall_textured.glb',
       'experiments/sento/out/world/hall/texture.jpg','experiments/sento/out/world/hall/normal.png','experiments/sento/out/world/hall/orm.jpg']
meta['originalAssets']={p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in paths}
(ASSETS/'prepared.json').write_text(json.dumps(meta,indent=2)+'\n')
print(json.dumps({k:v for k,v in meta.items() if k!='originalAssets'},indent=2))
