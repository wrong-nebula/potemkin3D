"""Make a copy of an exported level that a web page can load: the same mesh, its textures smaller and as JPEGs.

Run: python3 scripts/web_glb.py runs/luxor-02/level_textured.glb deploy/luxor/level.glb [--size 2048] [--quality 90]

A level exported with its maps carries every texture as a PNG at full size: four pages of 4096 px with normal and
roughness maps come to 200 MB and over a gigabyte of GPU memory, which a browser tab may not give. Here every image
in the file is scaled to at most --size px a side and stored as a JPEG; the geometry and materials are untouched.

With --split DIR nothing is repacked: the file's textures are written to DIR at --size, one JPEG a map
(p0_base.jpg, p0_normal.jpg, p0_orm.jpg, ...), with a textures.json that lists them in the order of the mesh's
primitives. A page can then start on a small copy of the level and fetch the sharp textures as it needs them.
"""
import argparse
import io
import json
import os
import struct

from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def main():
    p = argparse.ArgumentParser()
    p.add_argument('src')
    p.add_argument('out', nargs='?')
    p.add_argument('--size', type=int, default=2048)
    p.add_argument('--quality', type=int, default=90)
    p.add_argument('--split', help='write the textures to this folder instead of making a .glb (the second argument is then not used)')
    a = p.parse_args()
    with open(a.src, 'rb') as f:
        magic, version, _ = struct.unpack('<III', f.read(12))
        assert magic == 0x46546C67, 'not a .glb file'
        n, _ = struct.unpack('<II', f.read(8))
        gltf = json.loads(f.read(n))
        n, _ = struct.unpack('<II', f.read(8))
        data = f.read(n)
    views = gltf['bufferViews']
    chunks = [data[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']] for v in views]
    if a.split:
        os.makedirs(a.split, exist_ok=True)
        source = lambda ref: chunks[gltf['images'][gltf['textures'][ref['index']]['source']]['bufferView']] if ref else None
        listed, total = [], 0
        for k, prim in enumerate(pr for mesh in gltf['meshes'] for pr in mesh['primitives']):
            m = gltf['materials'][prim['material']]
            maps = {'base': m.get('pbrMetallicRoughness', {}).get('baseColorTexture'), 'normal': m.get('normalTexture'),
                    'orm': m.get('pbrMetallicRoughness', {}).get('metallicRoughnessTexture')}
            entry = {}
            for kind, ref in maps.items():
                raw = source(ref)
                if raw is None:
                    continue
                im = Image.open(io.BytesIO(raw)).convert('RGB')
                if max(im.size) > a.size:
                    im = im.resize((a.size, a.size * im.height // im.width), Image.LANCZOS)
                name = f'p{k}_{kind}.jpg'
                im.save(os.path.join(a.split, name), 'JPEG', quality=a.quality, subsampling=0)
                total += os.path.getsize(os.path.join(a.split, name))
                entry[kind] = name
            entry['size'] = a.size
            listed.append(entry)
        with open(os.path.join(a.split, 'textures.json'), 'w') as f:
            json.dump(listed, f)
        print(f'{a.split}: textures of {len(listed)} materials at up to {a.size} px, {total / 1e6:.1f} MB')
        return
    for image in gltf.get('images', []):
        k = image['bufferView']
        im = Image.open(io.BytesIO(chunks[k])).convert('RGB')
        if max(im.size) > a.size:
            im = im.resize((a.size, a.size * im.height // im.width), Image.LANCZOS)
        out = io.BytesIO()
        im.save(out, 'JPEG', quality=a.quality, subsampling=0)   # no chroma subsampling: normal maps are not pictures
        chunks[k] = out.getvalue()
        image['mimeType'] = 'image/jpeg'
    # the buffer again, every view on a 4-byte boundary
    blob = bytearray()
    for v, c in zip(views, chunks):
        blob += b'\0' * (-len(blob) % 4)
        v['byteOffset'], v['byteLength'] = len(blob), len(c)
        blob += c
    blob += b'\0' * (-len(blob) % 4)
    gltf['buffers'] = [{'byteLength': len(blob)}]
    head = json.dumps(gltf, separators=(',', ':')).encode()
    head += b' ' * (-len(head) % 4)
    with open(a.out, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, version, 12 + 8 + len(head) + 8 + len(blob)))
        f.write(struct.pack('<II', len(head), 0x4E4F534A) + head)
        f.write(struct.pack('<II', len(blob), 0x004E4942) + blob)
    print(f'{a.out}: {len(gltf.get("images", []))} textures at up to {a.size} px, {(12 + 16 + len(head) + len(blob)) / 1e6:.1f} MB')


main()
