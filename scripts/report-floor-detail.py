"""Verify protected pixels from the MAIN viewer and arrange the unmodified captures."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import json
import numpy as np

root = Path(__file__).resolve().parents[1]
out = root / 'output/playwright/sento-main'
checks = json.loads((out / 'checks.json').read_text())
assert not checks['errors']
mask = np.array(Image.open(out / 'protected-after.png').convert('RGB')).min(axis=2) > 220
assert int(mask.sum()) > 100
preservation = {'protectedPixels': int(mask.sum())}
for mode in ['off', 'albedo']:
    before, after = [np.array(Image.open(out / f'{mode}-{side}.png').convert('RGB'), dtype=np.int16) for side in ['before', 'after']]
    error = int(np.abs(before - after)[mask].max())
    assert error == 0, f'{mode}: protected material changed by {error} output bytes'
    preservation[mode + 'MaxError'] = error
(out / 'preservation.json').write_text(json.dumps(preservation, indent=2) + '\n')
board = Image.new('RGB', (1920, 626), '#101713')
draw = ImageDraw.Draw(board)
font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 22)
for k, side in enumerate(['before', 'after']):
    label = 'BEFORE · original painted atlas' if k == 0 else 'AFTER · Sento floor detail in the main renderer'
    draw.text((24 + k * 960, 17), label, fill='#e1eee5', font=font)
    frame = Image.open(out / f'off-{side}.png').convert('RGB')
    board.paste(frame.resize((960, 540), Image.Resampling.LANCZOS), (k * 960, 56))
small = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 15)
draw.text((24, 603), 'Matched camera and lighting · original paint unchanged · +6.67 MiB texture payload · no additional draw calls', fill='#afc9b7', font=small)
board.save(out / 'comparison.png')
print(json.dumps(preservation))
