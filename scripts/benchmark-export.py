"""Blender: export upstream appearance and provenance GLBs for a common browser renderer.
Usage: blender -b --python scripts/benchmark-export.py -- CASE [--heldout]
"""
import json
import sys
import re
from pathlib import Path
import bpy

argv = sys.argv[sys.argv.index('--') + 1:]
case = Path(argv[0]).resolve()
bpy.ops.wm.open_mainfile(filepath=str(case / 'blockout.blend'))
cov = json.loads((case / 'proj/coverage.json').read_text())
objects = [o for o in bpy.context.scene.objects if o.type == 'MESH']
out = case / 'exports'; out.mkdir(exist_ok=True)
def folder_name(name):
    return re.sub(r'[^A-Za-z0-9_.-]+', '_', name).strip('._')

def material(obj, image_path):
    mat = bpy.data.materials.new('benchmark_' + obj.name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes; nodes.clear()
    output = nodes.new('ShaderNodeOutputMaterial'); bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.inputs['Base Color'].default_value = (1, 1, 1, 1)
    bsdf.inputs['Roughness'].default_value = 1
    if image_path.exists():
        image = nodes.new('ShaderNodeTexImage'); image.image = bpy.data.images.load(str(image_path), check_existing=True)
        image.interpolation = 'Linear'
        mat.node_tree.links.new(image.outputs['Color'], bsdf.inputs['Base Color'])
    else:
        bsdf.inputs['Base Color'].default_value = (.5, .5, .5, 1)
    mat.node_tree.links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
    obj.data.materials.clear(); obj.data.materials.append(mat)
    for face in obj.data.polygons: face.material_index = 0

def export(root, name, coverage=False):
    for obj in objects:
        # Main projection uses upstream's sanitized names; heldout adapter stores exact object names.
        folder = root / obj.name
        if not folder.exists(): folder = root / folder_name(obj.name)
        path = folder / ('benchmark-coverage.png' if coverage else 'texture.png')
        if not path.exists(): raise FileNotFoundError(f'Missing real benchmark texture: {path}')
        material(obj, path)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects: obj.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(out / (name + '.glb')), export_format='GLB', use_selection=True,
        export_cameras=False, export_lights=False, export_yup=True, export_apply=True)

# Upstream's original coverage separates confident observations from soft/grazing and inferred fill.
for obj in objects:
    folder = case / 'proj/auto' / folder_name(obj.name)
    if not folder.exists(): raise FileNotFoundError(f'Missing projected object: {folder}')
    image = bpy.data.images.load(str(folder / 'coverage.png'), check_existing=True)
    soft_path = folder / 'soft_observed.png'
    soft = bpy.data.images.load(str(soft_path), check_existing=True) if soft_path.exists() else None
    import numpy as np
    pixels = np.empty(len(image.pixels), np.float32); image.pixels.foreach_get(pixels)
    if soft:
        sp = np.empty(len(soft.pixels), np.float32); soft.pixels.foreach_get(sp)
    else: sp = np.zeros_like(pixels)
    observed = (pixels[0::4] > .5) & (sp[0::4] < .5)
    rgba = np.ones_like(pixels); rgba[1::4] = observed; rgba[2::4] = ~observed
    dest = bpy.data.images.new('coverage_' + obj.name, width=image.size[0], height=image.size[1])
    dest.pixels.foreach_set(rgba); dest.filepath_raw = str(folder / 'benchmark-coverage.png'); dest.file_format = 'PNG'; dest.save()
export(case / 'proj/auto', 'appearance')
export(case / 'proj/auto', 'coverage', True)
if '--heldout' in argv:
    manifest = json.loads((case / 'heldout/manifest.json').read_text())
    for view in manifest['views']:
        export(case / 'heldout' / view, view + '-heldout')
        export(case / 'heldout' / view, view + '-coverage', True)
print('Exported common-renderer GLBs:', out)
