"""Render camera-independent synthetic albedo for projection calibration.

blender -b --factory-startup -P samples/render_tatooine_truth.py -- --size 512

The source scene and camera specification are read-only inputs. Output is an
unlit, world-coordinate checker/grain field: it is synthetic ground truth for
geometry/projection tests, not an AI-quality result or a photoreal benchmark.
"""
import argparse
import colorsys
import hashlib
import json
import math
from pathlib import Path
import sys

import bpy
from mathutils import Vector


def synthetic_material(name, index):
    material=bpy.data.materials.new('synthetic truth '+name)
    material.use_nodes=True
    nodes=material.node_tree.nodes
    nodes.clear()
    links=material.node_tree.links
    out=nodes.new('ShaderNodeOutputMaterial')
    emission=nodes.new('ShaderNodeEmission')
    emission.inputs['Strength'].default_value=1
    links.new(emission.outputs['Emission'],out.inputs['Surface'])
    geometry=nodes.new('ShaderNodeNewGeometry')
    checker=nodes.new('ShaderNodeTexChecker')
    checker.inputs['Scale'].default_value=1.35
    hue=(.055+index*.618033988749895)%1
    a=colorsys.hsv_to_rgb(hue,.48,.72)
    b=colorsys.hsv_to_rgb((hue+.035)%1,.32,.37)
    checker.inputs['Color1'].default_value=(*a,1)
    checker.inputs['Color2'].default_value=(*b,1)
    links.new(geometry.outputs['Position'],checker.inputs['Vector'])
    noise=nodes.new('ShaderNodeTexNoise')
    noise.noise_dimensions='3D'
    noise.inputs['Scale'].default_value=14
    noise.inputs['Detail'].default_value=2
    noise.inputs['Roughness'].default_value=.65
    links.new(geometry.outputs['Position'],noise.inputs['Vector'])
    remap=nodes.new('ShaderNodeMapRange')
    remap.inputs['From Min'].default_value=0
    remap.inputs['From Max'].default_value=1
    remap.inputs['To Min'].default_value=.82
    remap.inputs['To Max'].default_value=1.04
    links.new(noise.outputs['Fac'],remap.inputs['Value'])
    multiply=nodes.new('ShaderNodeMixRGB')
    multiply.blend_type='MULTIPLY'
    multiply.inputs[0].default_value=1
    links.new(checker.outputs['Color'],multiply.inputs[1])
    links.new(remap.outputs['Result'],multiply.inputs[2])
    links.new(multiply.outputs['Color'],emission.inputs['Color'])
    return material


def main():
    root=Path(__file__).resolve().parent.parent
    parser=argparse.ArgumentParser()
    parser.add_argument('--size',type=int,default=512)
    parser.add_argument('--output',default=str(root/'output/benchmark/tatooine/truth'))
    args=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    output=Path(args.output).resolve()
    output.mkdir(parents=True,exist_ok=True)
    source=root/'samples/tatooine.blend'
    specs_path=root/'samples/tatooine-cameras.json'
    specs=json.loads(specs_path.read_text())
    source_sha=hashlib.sha256(source.read_bytes()).hexdigest()
    bpy.ops.wm.open_mainfile(filepath=str(source))
    bpy.context.preferences.filepaths.save_version=0
    scene=bpy.context.scene
    meshes=sorted((o for o in scene.objects if o.type=='MESH'),key=lambda o:o.name)
    for i,obj in enumerate(meshes):
        mat=synthetic_material(obj.name,i)
        obj.data.materials.clear()
        obj.data.materials.append(mat)
        for poly in obj.data.polygons:poly.material_index=0
    scene.render.engine='CYCLES'
    scene.cycles.device='CPU'
    scene.cycles.samples=8
    scene.cycles.use_denoising=False
    scene.cycles.use_animated_seed=False
    scene.cycles.seed=0
    scene.render.resolution_x=args.size
    scene.render.resolution_y=args.size
    scene.render.resolution_percentage=100
    scene.render.film_transparent=True
    scene.render.image_settings.file_format='PNG'
    scene.render.image_settings.color_mode='RGBA'
    scene.render.image_settings.color_depth='8'
    scene.render.dither_intensity=0
    scene.view_settings.view_transform='Standard'
    scene.view_settings.look='None'
    scene.view_settings.exposure=0
    scene.view_settings.gamma=1
    manifest={
        'kind':'synthetic-ground-truth','purpose':'projection and camera calibration only; not AI output',
        'sourceSceneSHA256':source_sha,'cameraSpecSHA256':hashlib.sha256(specs_path.read_bytes()).hexdigest(),
        'resolution':[args.size,args.size], 'render':'Cycles CPU, 8 samples, emission, Standard sRGB, transparent background',
        'material':'object-specific hue, world-position 3D checker at scale 1.35, multiplicative 3D noise at scale 14',
        'images':[],
    }
    for group,key in (('source','cameras'),('novel','novelCameras')):
        for spec in specs[key]:
            name=spec['name']
            if group=='source':
                cam=bpy.data.objects[name]
                # Verify rather than silently rewriting the established camera.
                eye=Vector(spec['blenderEye'])
                if (cam.location-eye).length>1e-6:raise ValueError(f'Camera location mismatch: {name}')
                if abs(math.degrees(cam.data.angle_x)-spec['fov'])>1e-4:raise ValueError(f'Camera FOV mismatch: {name}')
            else:
                data=bpy.data.cameras.new(name)
                data.type='PERSP'
                data.sensor_fit='HORIZONTAL'
                data.sensor_width=36
                data.lens=36/(2*math.tan(math.radians(spec['fov'])/2))
                data.clip_start=.05
                data.clip_end=2000
                cam=bpy.data.objects.new(name,data)
                scene.collection.objects.link(cam)
                cam.location=spec['blenderEye']
                cam.rotation_euler=(Vector(spec['blenderTarget'])-cam.location).to_track_quat('-Z','Y').to_euler()
            scene.camera=cam
            path=output/f'{name}.png'
            scene.render.filepath=str(path)
            bpy.ops.render.render(write_still=True)
            manifest['images'].append({'name':name,'split':group,'file':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'camera':spec})
    # Store a reproducible derivative without touching the shared source file.
    scene['benchmark_truth']='Synthetic camera-independent emission field; geometry/projection calibration only.'
    bpy.ops.wm.save_as_mainfile(filepath=str(output/'synthetic-truth.blend'))
    if hashlib.sha256(source.read_bytes()).hexdigest()!=source_sha:raise RuntimeError('Source scene changed')
    (output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print('TRUTH_READY',output,len(manifest['images']))


if __name__=='__main__':main()
