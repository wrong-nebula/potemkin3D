"""Arrange actual main-renderer captures; keep rendering and timing evidence separate."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import json

root = Path(__file__).resolve().parents[1]
out = root / 'output/playwright/material-presets'
checks = json.loads((out / 'checks.json').read_text())
assert checks['albedoIdentical'] and all(row['preserved'] for row in checks['rows'])
assert all(checks['maps'].values()) and checks['exported']
assert not checks['errors'] and not checks['modelRequests']
font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 24)
small = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 17)

presets = [
    ('limestone', 'Limestone', 'roughness 0.82 · height span 1.20 mm'),
    ('glazed-tile', 'Glazed tile', 'roughness 0.32 · height span 2.00 mm'),
    ('painted-metal', 'Painted metal', 'roughness 0.42 · height span 0.25 mm'),
    ('timber', 'Timber', 'roughness 0.62 · height span 0.70 mm'),
]
board = Image.new('RGB', (1600, 1068), '#101713')
draw = ImageDraw.Draw(board)
for k, (name, label, detail) in enumerate(presets):
    x, y = (k % 2) * 800, (k // 2) * 516
    draw.text((x + 18, y + 12), label, font=font, fill='#e1eee5')
    draw.text((x + 18, y + 41), detail, font=small, fill='#afc9b7')
    frame = Image.open(out / f'{name}.png').convert('RGB')
    board.paste(frame.resize((800, 450), Image.Resampling.LANCZOS), (x, y + 66))
draw.text((18, 1044), 'Same Sento painting, camera and lighting · only the floor response changes · no new texture synthesis', font=small, fill='#afc9b7')
board.save(out / 'responses.png')

board = Image.new('RGB', (1920, 626), '#101713')
draw = ImageDraw.Draw(board)
for k, (name, label) in enumerate([
    ('before', 'BEFORE · Sento detail with a shared base response'),
    ('after', 'AFTER · material-specific responses and aligned height'),
]):
    draw.text((24 + k * 960, 17), label, font=font, fill='#e1eee5')
    frame = Image.open(out / f'{name}.png').convert('RGB')
    board.paste(frame.resize((960, 540), Image.Resampling.LANCZOS), (k * 960, 56))
draw.text((24, 603), 'Original painted atlas unchanged · same camera and light · 4 draw calls in both · +10.67 MiB for two 1024² material maps', font=small, fill='#afc9b7')
board.save(out / 'comparison.png')
print(json.dumps(checks['performance'], indent=2))
