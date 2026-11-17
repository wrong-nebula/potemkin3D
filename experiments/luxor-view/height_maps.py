"""Prepare overlapping PATINA inputs and assemble their predicted height data (no albedo-derived height)."""
import argparse
import hashlib
import json
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def digest(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def broad_height(values, radius):
    """Three separable box passes approximate a Gaussian without quantizing the baseline to 8 bits."""
    result = values.astype(np.float32)
    r = max(1, round(radius))
    for _ in range(3):
        for axis in [0, 1]:
            pad = [(r, r) if k == axis else (0, 0) for k in range(2)]
            padded = np.pad(result, pad, mode='edge')
            prefix = np.cumsum(padded, axis=axis, dtype=np.float64)
            prefix = np.concatenate([np.zeros_like(np.take(prefix, [0], axis=axis)), prefix], axis=axis)
            a, b = [slice(None)] * 2, [slice(None)] * 2
            a[axis], b[axis] = slice(2 * r + 1, None), slice(None, -2 * r - 1)
            result = ((prefix[tuple(a)] - prefix[tuple(b)]) / (2 * r + 1)).astype(np.float32)
    return result


def atlas_islands(glb, page, size):
    """Rasterize connected UV islands from the exported geometry, keeping background out of height analysis."""
    with open(glb, 'rb') as f:
        magic, version, _ = struct.unpack('<III', f.read(12))
        if magic != 0x46546C67 or version != 2:
            raise ValueError('Expected a glTF 2 binary export')
        n, _ = struct.unpack('<II', f.read(8))
        doc = json.loads(f.read(n))
        n, _ = struct.unpack('<II', f.read(8))
        binary = f.read(n)
    def accessor(index):
        a = doc['accessors'][index]
        b = doc['bufferViews'][a['bufferView']]
        dtype = np.dtype({5126: '<f4', 5125: '<u4', 5123: '<u2', 5121: 'u1'}[a['componentType']])
        components = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3}[a['type']]
        stride = b.get('byteStride', components * dtype.itemsize)
        return np.ndarray((a['count'], components), dtype=dtype, buffer=binary,
                          offset=b.get('byteOffset', 0) + a.get('byteOffset', 0), strides=(stride, dtype.itemsize))
    primitive = [p for mesh in doc['meshes'] for p in mesh['primitives']][page]
    uv = accessor(primitive['attributes']['TEXCOORD_0'])
    pos = accessor(primitive['attributes']['POSITION'])
    indices = accessor(primitive['indices']).ravel() if 'indices' in primitive else np.arange(len(uv))
    triangles = indices.reshape(-1, 3)
    parents = list(range(len(triangles)))
    def root(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i
    keys = [tuple(row) for row in np.round(np.concatenate([pos, uv], axis=1) * 1e6).astype(np.int64)]
    edges = {}
    for t, corners in enumerate(triangles):
        for k in range(3):
            edge = tuple(sorted((keys[corners[k]], keys[corners[(k + 1) % 3]])))
            if edge in edges:
                parents[root(t)] = root(edges[edge])
            else:
                edges[edge] = t
    ids, boxes = {}, {}
    image = Image.new('I', (size, size))
    draw = ImageDraw.Draw(image)
    for t, corners in enumerate(triangles):
        group = root(t)
        if group not in ids:
            ids[group] = len(ids) + 1
        ident = ids[group]
        points = uv[corners] * size
        draw.polygon([tuple(p) for p in points], fill=ident)
        bounds = [max(0, int(np.floor(points[:, 0].min()))), max(0, int(np.floor(points[:, 1].min()))),
                  min(size, int(np.ceil(points[:, 0].max())) + 1), min(size, int(np.ceil(points[:, 1].max())) + 1)]
        if ident in boxes:
            old = boxes[ident]
            bounds = [min(old[0], bounds[0]), min(old[1], bounds[1]), max(old[2], bounds[2]), max(old[3], bounds[3])]
        boxes[ident] = bounds
    return np.asarray(image), boxes


def surface_detail(height, islands, boxes, radius):
    """Remove the predicted broad shape within each island; neighbouring packed surfaces cannot bias it."""
    detail = np.zeros_like(height)
    for ident, (x0, y0, x1, y1) in boxes.items():
        if x1 <= x0 or y1 <= y0:
            continue
        mask = (islands[y0:y1, x0:x1] == ident).astype(np.float32)
        if not np.any(mask):
            continue
        values = height[y0:y1, x0:x1]
        weights = broad_height(mask, radius)
        baseline = broad_height(values * mask, radius) / np.maximum(weights, 1e-6)
        cut = detail[y0:y1, x0:x1]
        cut[mask > 0] = (values - baseline)[mask > 0]
    return detail


def prepare(run, out):
    meta = json.loads((run / 'run.json').read_text())
    pages = meta.get('pages', {'count': 1, 'size': meta.get('atlasSize', 4096)})
    sources = [run / (f'texture_{i}.png' if pages['count'] > 1 else 'texture.png') for i in range(pages['count'])]
    spec = {'version': 1, 'model': 'fal-ai/patina', 'seed': 7, 'overlap': 256,
            'sources': [{'file': str(f), 'sha256': digest(f)} for f in sources],
            'layout': meta.get('pages', {}).get('hash', meta.get('layout', {}).get('hash'))}
    file = out / 'inputs.json'
    if file.exists():
        existing = json.loads(file.read_text())
        if existing['spec'] != spec:
            raise ValueError('The source textures changed. Use a new --out folder to preserve paid height predictions.')
        return existing
    out.mkdir(parents=True, exist_ok=True)
    tiles, page_specs = [], []
    for page, source in enumerate(sources):
        im = Image.open(source).convert('RGB')
        if im.width != im.height:
            raise ValueError('Expected square atlas pages')
        size = im.width
        n = max(1, round(size / 2048))
        region = int(np.ceil((size + (n - 1) * spec['overlap']) / n))
        starts = [round(k * (size - region) / (n - 1)) if n > 1 else 0 for k in range(n)]
        page_specs.append({'page': page, 'size': size, 'source_sha256': spec['sources'][page]['sha256']})
        for row, y in enumerate(starts):
            for col, x in enumerate(starts):
                name = f'p{page}_r{row}_c{col}'
                tile = im.crop((x, y, x + region, y + region))
                sent = min(2048, region)
                if sent != region:
                    tile = tile.resize((sent, sent), Image.Resampling.LANCZOS)
                tile.save(out / f'{name}_input.png')
                tiles.append({'id': name, 'page': page, 'row': row, 'col': col, 'x': x, 'y': y,
                              'region': region, 'sent': sent, 'input': f'{name}_input.png', 'raw': f'{name}_raw.png'})
    result = {'spec': spec, 'pages': page_specs, 'tiles': tiles}
    file.write_text(json.dumps(result, indent=2) + '\n')
    return result


def blend_page(tiles, raw, size):
    """Match tile offsets in their overlap, then feather. Keep one common height scale across all pages."""
    total = np.zeros((size, size), np.float32)
    weight = np.zeros_like(total)
    diagnostics = []
    for tile, values in zip(tiles, raw):
        x, y, s = tile['x'], tile['y'], tile['region']
        cut = total[y:y+s, x:x+s]
        weights = weight[y:y+s, x:x+s]
        seen = weights > 0.01
        offset = float(np.median((cut / np.maximum(weights, 1e-6) - values)[seen])) if np.any(seen) else 0.0
        values = values + offset
        # Use actual overlap, not the nominal setting, so arbitrary sizes/rounding remain seamless.
        wx, wy = np.ones(s, np.float32), np.ones(s, np.float32)
        left = max((t['x'] + t['region'] - x for t in tiles if t['row'] == tile['row'] and t['col'] == tile['col'] - 1), default=0)
        top = max((t['y'] + t['region'] - y for t in tiles if t['col'] == tile['col'] and t['row'] == tile['row'] - 1), default=0)
        if left > 0:
            ramp = (np.arange(left) + 0.5) / left
            wx[:left] = ramp * ramp * (3 - 2 * ramp)
        if top > 0:
            ramp = (np.arange(top) + 0.5) / top
            wy[:top] = ramp * ramp * (3 - 2 * ramp)
        w = wy[:, None] * wx[None, :]
        # Existing data hands over to the next tile, rather than being averaged at full weight up to its edge.
        old = np.where(seen, cut / np.maximum(weights, 1e-6), values)
        cut[:] = old * (1 - w) + values * w
        weights[:] = 1
        diagnostics.append({'tile': tile['id'], 'offset': offset})
    if np.any(weight == 0):
        raise ValueError('Tiles did not cover the page')
    return total, diagnostics


def pack(out):
    manifest = json.loads((out / 'inputs.json').read_text())
    details, diagnostics, samples = [], [], []
    for page in manifest['pages']:
        tiles = [t for t in manifest['tiles'] if t['page'] == page['page']]
        raw = []
        for tile in tiles:
            im = Image.open(out / tile['raw']).convert('L')
            if im.size != (tile['sent'], tile['sent']):
                raise ValueError(f"Unexpected model output size for {tile['id']}: {im.size}")
            im = im.resize((tile['region'], tile['region']), Image.Resampling.BICUBIC)
            raw.append(np.asarray(im, dtype=np.float32) / 255)
        height, offsets = blend_page(tiles, raw, page['size'])
        # Atlas predictions carry broad island/tile depth drift. Keep the actual predicted surface detail,
        # as the existing normal-map pipeline does; never re-derive relief from brightness.
        radius = page['size'] / 128
        source_dir = Path(manifest['spec']['sources'][page['page']]['file']).parent
        islands, boxes = atlas_islands(source_dir / 'level_textured.glb', page['page'], page['size'])
        detail = surface_detail(height, islands, boxes, radius)
        details.append(detail)
        samples.append(detail[::4, ::4][islands[::4, ::4] > 0])
        diagnostics.append({'page': page['page'], 'offsets': offsets, 'detrend_radius_px': radius, 'islands': len(boxes)})
    # One range for the whole scene: crossing a material page must not change the depth scale.
    sampled = np.concatenate(samples)
    low, high = np.percentile(sampled, [0.5, 99.5]).tolist()
    if high - low < 1e-4:
        raise ValueError('Predicted height maps have no usable relief')
    pages = []
    for page, detail in zip(manifest['pages'], details):
        height = np.clip((detail - low) / (high - low), 0, 1)
        # Keep a 16-bit master of the blended field, plus a linear, lossless 8-bit web texture at each LOD.
        name = f"height_{page['page']}"
        Image.fromarray(np.round(height * 65535).astype(np.uint16)).save(out / f'{name}_16.png')
        im = Image.fromarray(np.round(height * 255).astype(np.uint8))
        im.save(out / f'{name}.png')
        im.resize((page['size'] // 2, page['size'] // 2), Image.Resampling.BOX).save(out / f'{name}_2k.png')
        pages.append({**page, 'height': f'{name}.png', 'low': f'{name}_2k.png', 'master': f'{name}_16.png',
                      'sha256': digest(out / f'{name}.png')})
    result = {'version': 1, 'model': manifest['spec']['model'], 'seed': manifest['spec']['seed'],
              'convention': 'white-high', 'colorSpace': 'linear', 'layout': manifest['spec']['layout'],
              'normalization': {'low': low, 'high': high, 'sharedAcrossPages': True},
              'pages': pages, 'diagnostics': diagnostics}
    (out / 'height.json').write_text(json.dumps(result, indent=2) + '\n')
    print(f"Packed {len(pages)} height pages; shared predicted-height range {low:.4f} to {high:.4f}")


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('mode', choices=['prepare', 'pack'])
    p.add_argument('--run', type=Path)
    p.add_argument('--out', type=Path, required=True)
    a = p.parse_args()
    if a.mode == 'prepare':
        m = prepare(a.run, a.out)
        print(f"Prepared {len(m['tiles'])} overlapping height inputs for {len(m['pages'])} pages")
    else:
        pack(a.out)
