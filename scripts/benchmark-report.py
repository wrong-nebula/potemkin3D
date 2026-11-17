"""Shared image-space evaluator. Both methods are scored on EXACTLY the same common-support pixels.
Coverage has a fixed geometric denominator and is shown separately. No AI target is called ground truth.
"""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from PIL import Image
from scipy.ndimage import binary_erosion, gaussian_filter

p = argparse.ArgumentParser(); p.add_argument('--root', type=Path, default=Path('output/benchmark/tatooine')); a = p.parse_args()
root = a.root
scene = json.loads(Path('samples/tatooine-cameras.json').read_text())
cfg = json.loads((root / 'upstream/case.json').read_text())
views = [{**next(c for c in scene['cameras'] if c['name'] == v['camera']), 'key': v['name']} for v in cfg['views']['cameras']]
novel = scene.get('novelCameras', scene.get('novel', []))

def read(path): return np.asarray(Image.open(path).convert('RGB'), np.float32)
def score(target, prediction, labels, mask):
    if not mask.any(): return {'mae': None, 'low': None, 'high': None, 'pixels': 0}
    low_t = np.zeros_like(target); low_p = np.zeros_like(prediction)
    for label in np.unique(labels[mask]):
        support = (labels == label).astype(np.float32)
        weight = gaussian_filter(support, 3)
        for c in range(3):
            for src, dst in [(target, low_t), (prediction, low_p)]:
                band = gaussian_filter(src[..., c] * support, 3) / np.maximum(weight, 1e-6)
                dst[..., c][support > 0] = band[support > 0]
    return {'mae': float(np.abs(target[mask] - prediction[mask]).mean()),
        'low': float(np.abs(low_t[mask] - low_p[mask]).mean()),
        'high': float(np.abs((target-low_t)[mask] - (prediction-low_p)[mask]).mean()), 'pixels': int(mask.sum())}

def evaluate(dataset, pose, heldout=False):
    section = 'heldout' if heldout else 'renders'; name = pose['name']
    dirs = [root / dataset / method / section for method in ['trompe', 'multiview']]
    if not all((d / f'{name}-image.png').exists() for d in dirs): return None
    images = [read(d / f'{name}-image.png') for d in dirs]
    masks = [read(d / f'{name}-masks.png') for d in dirs]
    geom = binary_erosion(masks[0][..., 0] > 127, iterations=2)
    obs = [(m[..., 1] > 240) & geom for m in masks]
    common = obs[0] & obs[1]
    label_path = dirs[0] / f'{name}-labels.png'
    labels = read(label_path)[..., 0].astype(int)
    target_path = root / 'truth' / f'{name}.png' if dataset == 'truth' else root / (dataset + '-targets') / (pose.get('key', '') + '.png')
    target = read(target_path) if target_path.exists() else None
    row = {'name': name, 'heldOut': heldout, 'geometryPixels': int(geom.sum()), 'commonPixels': int(common.sum()),
           'commonSupport': float(common.sum()/max(1,geom.sum())), 'methods': {}}
    for i, method in enumerate(['trompe','multiview']):
        perpart = {}
        for label in np.unique(labels[geom]):
            region = geom & (labels == label)
            perpart[str(label)] = {'pixels': int(region.sum()), 'observed': int((region & obs[i]).sum())}
        row['methods'][method] = {'observed': float(obs[i].sum()/max(1,geom.sum())),
            'inferred': float(((masks[i][...,2]>127)&geom).sum()/max(1,geom.sum())), 'parts': perpart,
            'commonError': score(target,images[i],labels,common) if target is not None else None,
            'fullSurfaceError': score(target,images[i],labels,geom) if target is not None else None}
    return row

def aggregate(rows):
    out = {}
    for method in ['trompe','multiview']:
        valid = [r for r in rows if r]; area = sum(r['geometryPixels'] for r in valid)
        out[method] = {'observed': sum(r['methods'][method]['observed']*r['geometryPixels'] for r in valid)/max(1,area)}
        for kind in ['commonError','fullSurfaceError']:
            scored = [r['methods'][method][kind] for r in valid if r['methods'][method][kind] and r['methods'][method][kind]['pixels']]
            count = sum(r['pixels'] for r in scored)
            out[method][kind] = {k: sum(r[k]*r['pixels'] for r in scored)/count if count else None for k in ['mae','low','high']}
            out[method][kind]['pixels'] = count
    return out

result = {'version':1,'scene':scene,'cameras':views,'novel':novel,'datasets':{},
 'protocol': {'upstreamCommit':'4885e248aa58f425eba88309b14176524a4ec3ef', 'model':'FLUX 3 Klein', 'calibrationResolution':512,
  'trompeAtlasTexels':2048**2,'multiviewAtlasTexels':512**2*19,
  'comparability':'Same geometry, cameras, targets and browser appearance renderer. Native UV layouts differ. Upstream uses 19 × 512² maps; Trompe uses one 2048² map. This is a projection/fusion ablation, not a full quality ranking.',
  'metrics':'sRGB mean absolute error in 0–255 code values. Both errors use the exact same intersection of confidently observed pixels. Coverage denominator is fixed geometry with a 2-pixel border erosion.',
  'limitations':['One scene and one stochastic sample per view; no statistical ranking.', 'AI targets are references, not physical ground truth.', 'Trompe controlled replay uses raw targets without SAM or plane rejection; upstream retains its strict mask/alignment gates.', 'Fusion holdout excludes the raw image from projection; jointly/sequentially generated images may still share information.', 'Cross-view agreement cannot prove semantic correctness.', 'Native camera planning, PBR maps, ground synthesis and repair budgets are outside the controlled fusion ablation.']},
 'budget': json.loads((root/'budget.json').read_text()) if (root/'budget.json').exists() else {'reserved':0,'calls':[]}}
for dataset in ['common','truth','native']:
    rows = [evaluate(dataset,v) for v in views+novel]; held = [evaluate(dataset,v,True) for v in views]
    if not any(rows): continue
    out = {'label':{'common':'Shared AI targets','truth':'Synthetic calibration','native':'Sequential vs joint grid'}[dataset],
      'kind':'synthetic' if dataset=='truth' else 'ai', 'views':[r for r in rows if r], 'heldOut':[r for r in held if r],
      'summary':aggregate(rows), 'heldOutSummary':aggregate(held)}
    vp=root/dataset/'trompe/validation.json'
    if vp.exists(): out['agreement']=json.loads(vp.read_text())['agreement']['score']
    upstream_case = root / ('upstream' if dataset=='common' else 'upstream-grid' if dataset=='native' else 'upstream-truth')
    tp=upstream_case/'targets/targets.json'
    if tp.exists():
        targets=json.loads(tp.read_text())['views']
        out['acceptance']={k:{'status':v['status'],'usable':v.get('usable',v['status']!='rejected'),'nativeSize':v.get('native_size'),
            'reasons':v.get('reasons',v.get('rejection_reasons',[]))} for k,v in targets.items()}
    out['upstreamCase']=upstream_case.name
    result['datasets'][dataset]=out
part_config=root/'common/trompe/config.json'
if part_config.exists(): result['partNames']=json.loads(part_config.read_text())['parts']
else: result['partNames']=scene['geometry']['labels']
result['hashes']={f:hashlib.sha256(Path(f).read_bytes()).hexdigest() for f in ['samples/tatooine.glb','samples/tatooine.blend','samples/tatooine-cameras.json']}
(root/'results.json').write_text(json.dumps(result,indent=2,allow_nan=False))
print(json.dumps({k:{'summary':v['summary'],'heldOut':v['heldOutSummary']} for k,v in result['datasets'].items()},indent=2))
