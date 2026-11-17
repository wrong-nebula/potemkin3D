"""Prepare source exemplars without changing the existing scene assets."""
from pathlib import Path
from PIL import Image
import json

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ASSETS = HERE / 'assets'
ASSETS.mkdir(exist_ok=True)
# Plain stone inside the pedestal, avoiding the surrounding relief and inscriptions.
stone = Image.open(ROOT / 'references/luxor/05_relief_detail.jpg').convert('RGB')
stone.crop((530, 774, 716, 960)).resize((512, 512), Image.Resampling.LANCZOS).save(ASSETS / 'stone-source.png')
Image.open(ROOT / 'experiments/sento/out/world/sento/mosaic.jpg').convert('RGB').save(ASSETS / 'tile-source.png')
(ASSETS / 'sources.json').write_text(json.dumps({
    'stone': {'file': 'references/luxor/05_relief_detail.jpg', 'cropPixels': [530,774,716,960],
              'nativeCropPixels': 186, 'sampleMetres': 0.22, 'note': 'Material exemplar only; no inscriptions are copied into the detail layer.'},
    'tile': {'file': 'experiments/sento/out/world/sento/mosaic.jpg', 'sampleMetres': 1.0,
             'note': 'Original Sento kit exemplar; world mapping matches Kit.surface.'},
}, indent=2)+'\n')
print('Prepared two source exemplars.')
