"""Adapter around the pinned, unmodified MIT multiview-to-real implementation.

No generation here. Configure before generation; export genuine fusion-held-out atlases after projection.
Run with the benchmark venv, --upstream pointing to the pinned checkout.
"""
import argparse
import json
from pathlib import Path
import sys

p = argparse.ArgumentParser()
p.add_argument('action', choices=['configure', 'heldout'])
p.add_argument('case', type=Path)
p.add_argument('--upstream', type=Path, default=Path('/private/tmp/trompe-multiview-to-real'))
a = p.parse_args()
case = a.case.resolve()
sys.path.insert(0, str(a.upstream / 'skills/multiview-to-real/scripts'))
cfg = json.loads((case / 'case.json').read_text())

if a.action == 'configure':
    look = json.loads(Path('samples/tatooine.look.json').read_text())
    cfg['look'] = look['style'] + '. ' + look['setting']['light']
    cfg['fusion'] = {**cfg.get('fusion', {}), 'method': 'auto', 'tex_size': 512, 'gate_policy': 'strict', 'fill': 'smooth'}
    cfg['model'].update({'size_param': 'image_size', 'image_param': 'image_urls', 'max_refs': 10,
        'pixel_cap': {'max_area': 4194304, 'min_area': 65536, 'max_side': 4096, 'min_aspect': .0625, 'max_aspect': 16}})
    for obj in cfg['objects']:
        name = obj['name']
        obj['class'] = 'plaster' if any(s in name for s in ['plaster', 'dwelling', 'workshop', 'domes']) else 'stone' if any(s in name for s in ['sand', 'ceramic']) else 'metal'
        obj['description'] = name + ': ' + ('warm matte weathered plaster' if obj['class'] == 'plaster' else 'pale sand-coloured stone or terracotta' if obj['class'] == 'stone' else 'dull faded painted or oxidised metal')
        obj['class_source'] = 'benchmark material specification'
    (case / 'case.json').write_text(json.dumps(cfg, indent=2))
    model = case / 'gen/model.json'
    if model.exists():
        m = json.loads(model.read_text()); m.setdefault('fixed_arguments', {}).update({'seed': 7, 'enable_prompt_expansion': False})
        model.write_text(json.dumps(m, indent=2))
    print('Configured matched endpoint, seed, look, strict gates, and 512² per-object atlases. 4M grid cap is a benchmark setting.')
else:
    import numpy as np
    from mvb2r.fusion import fuse, resolve_method
    from mvb2r.fusion_io import write_srgb_png, write_png
    from mvb2r.projinputs import fusion_options, load_case_inputs, object_input, object_params
    from mvb2r.project import object_fill
    from mvb2r.visibility import VisParams
    cov = json.loads((case / 'proj/coverage.json').read_text())
    prm, by_class, opt = fusion_options(cfg)
    ci = load_case_inputs(case, cfg)
    for obj in ci.objects:
        rec = cov['objects'][obj['name']]
        if not rec.get('projected'): continue
        oi = object_input(ci, obj, rec['tex_size'], VisParams(), opt)
        method = resolve_method('auto', obj['class'], obj['detail_critical'], by_class)
        for k, cam in enumerate(ci.cams):
            dst = case / 'heldout' / cam.name / obj['name']; dst.mkdir(parents=True, exist_ok=True)
            result = fuse(oi.held_out(k), method, object_params(prm, obj, opt))
            full, _ = object_fill(oi.tex, result.color, result.observed, obj['class'], opt.get('fill', 'smooth'))
            write_srgb_png(dst / 'texture.png', full)
            hard = result.observed & ~result.extra.get('soft', np.zeros(oi.tex.n, bool))
            # Coverage map is encoded RGB: geometric surface, confidently observed, inferred-or-soft.
            mask = np.stack([np.ones(oi.tex.n), hard, ~hard], -1).astype(np.uint8) * 255
            write_png(dst / 'benchmark-coverage.png', oi.tex.scatter(mask, 0))
        print('Held-out atlases:', obj['name'], flush=True)
    (case / 'heldout/manifest.json').write_text(json.dumps({'views': [c.name for c in ci.cams],
        'note': 'Raw target fusion holdout; target generation can still be coupled.'}, indent=2))
