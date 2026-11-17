"""Deterministic Tatooine-inspired courtyard for matched texturing experiments.

blender -b --factory-startup -P samples/build_tatooine.py -- samples/tatooine.glb

Original procedural geometry, metres, Blender Z-up. The GLB is Y-up. Both exports
share globally nonoverlapping UVs and named semantic parts. No external assets.
"""
import json
import math
from pathlib import Path
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

LABELS = []
BM = None


class tagged:
    def __init__(self, name):
        self.name = name

    def __enter__(self):
        if self.name not in LABELS:
            LABELS.append(self.name)
        BM.faces.ensure_lookup_table()
        self.start = len(BM.faces)

    def __exit__(self, *args):
        BM.faces.ensure_lookup_table()
        for i in range(self.start, len(BM.faces)):
            BM.faces[i].material_index = LABELS.index(self.name)


def box(x0, x1, y0, y1, z0, z1):
    centre = ((x0+x1)/2, (y0+y1)/2, (z0+z1)/2)
    bmesh.ops.create_cube(BM, size=1, matrix=Matrix.Translation(centre) @ Matrix.Diagonal((x1-x0, y1-y0, z1-z0, 1)))


def lathe(x, y, profile, segments=48):
    rings = []
    for r, z in profile:
        rings.append([BM.verts.new((x+r*math.cos(2*math.pi*i/segments), y+r*math.sin(2*math.pi*i/segments), z)) for i in range(segments)])
    for a, b in zip(rings, rings[1:]):
        for i in range(segments):
            f = BM.faces.new((a[i], a[(i+1)%segments], b[(i+1)%segments], b[i]))
            f.smooth = True
    BM.faces.new(list(reversed(rings[0])))
    BM.faces.new(rings[-1])


def pipe(a, b, radius, segments=16):
    a, b = Vector(a), Vector(b)
    m = (b-a).to_track_quat('Z', 'Y').to_matrix().to_4x4()
    m.translation = (a+b)/2
    out = bmesh.ops.create_cone(BM, cap_ends=True, cap_tris=False, segments=segments, radius1=radius, radius2=radius, depth=(b-a).length, matrix=m)
    for v in out['verts']:
        for f in v.link_faces:
            if len(f.verts) == 4:
                f.smooth = True


def dome(x, y, radius, base, height, label):
    with tagged(label):
        profile = [(radius*math.cos(math.pi*k/48), base+height*math.sin(math.pi*k/48)) for k in range(24)]
        profile.append((0.012, base+height))
        lathe(x, y, profile, segments=64)


def arch(x, y, z, radius, shoulder, width, depth, label='arched plaster surrounds'):
    """A real arched surround in the XZ plane, facing south, with a recessed opening."""
    with tagged(label):
        box(x-radius-width, x-radius, y-depth/2, y+depth/2, z, z+shoulder)
        box(x+radius, x+radius+width, y-depth/2, y+depth/2, z, z+shoulder)
        for i in range(32):
            a, b = math.pi*i/32, math.pi*(i+1)/32
            corners = [(x+r*math.cos(t), yy, z+shoulder+r*math.sin(t))
                       for yy in (y-depth/2,y+depth/2) for r,t in ((radius,a),(radius,b),(radius+width,b),(radius+width,a))]
            v = [BM.verts.new(c) for c in corners]
            for inds in ((0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)):
                BM.faces.new([v[k] for k in inds])


def doorway(x, front, z=0, radius=0.72, shoulder=1.45):
    arch(x, front-.18, z, radius, shoulder, .25, .38)
    with tagged('recessed ribbed metal doors'):
        # A recessed arch-shaped door, silhouette real rather than painted.
        vv=[BM.verts.new((x-radius,front+.11,z)),BM.verts.new((x+radius,front+.11,z))]
        vv += [BM.verts.new((x+radius*math.cos(math.pi*k/32),front+.11,z+shoulder+radius*math.sin(math.pi*k/32))) for k in range(33)]
        BM.faces.new(vv)
        for k in range(9):
            xx=x-radius+.12+k*(2*radius-.24)/8
            top=z+shoulder+math.sqrt(max(0,radius*radius-(xx-x)**2))-.06
            box(xx-.022,xx+.022,front+.07,front+.105,z+.1,top)
        box(x-.09,x+.09,front+.01,front+.075,z+.85,z+1.14)


def hut(x, y, w, d, h, r, label):
    front=y-d/2
    # Front wall is split around an arch-shaped recess. No full wall behind door.
    with tagged(label):
        box(x-w/2,x-.74,front,front+.34,0,h)
        box(x+.74,x+w/2,front,front+.34,0,h)
        for k in range(24):
            xx0=-.74+1.48*k/24
            xx1=-.74+1.48*(k+1)/24
            arc=1.45+math.sqrt(max(0,.74*.74-((xx0+xx1)/2)**2))
            box(x+xx0,x+xx1,front,front+.34,arc,h)
        box(x-w/2,x+w/2,front+.34,y+d/2,0,h)
        # Thin exterior ledge and softly stepped roof rim.
        box(x-w/2-.09,x+w/2+.09,front-.09,y+d/2+.09,h-.18,h+.06)
    doorway(x,front)
    dome(x,y,r,h+.04,r*.68,'rounded plaster domes')
    with tagged('plaster buttresses and roof parapets'):
        for xx in (x-w/2+.15,x+w/2-.15):
            box(xx-.2,xx+.2,front-.38,front+.1,0,h-.36)
            box(xx-.26,xx+.26,front-.44,front+.13,0,.3)
        box(x-w/2-.03,x+w/2+.03,y+d/2-.14,y+d/2+.1,h,h+.32)


def vaporator(x,y):
    with tagged('moisture vaporator white metal'):
        lathe(x,y,[(.7,0),(.7,.18),(.42,.2),(.42,.7),(.27,.8),(.27,3.35),(.37,3.42),(.37,3.6),(.15,3.65),(.15,4.7),(.23,4.72),(.23,4.9),(.1,5.0)],32)
        for z in (1.18,1.45,1.72,2.0,2.28,2.56,2.84):
            lathe(x,y,[(.28,z),(.64,z+.03),(.64,z+.09),(.28,z+.13)],32)
        for dx,dy in ((.49,.49),(-.49,.49),(.49,-.49),(-.49,-.49)):
            pipe((x+dx,y+dy,.27),(x+dx,y+dy,3.26),.045,12)
            pipe((x+dx,y+dy,3.26),(x,y,3.62),.035,12)
        pipe((x,y,4.3),(x+.6,y,4.3),.05,12)
        pipe((x+.6,y,4.3),(x+.6,y,4.7),.04,12)
    with tagged('dark vaporator machinery'):
        box(x-.36,x+.36,y-.35,y+.35,.28,.77)
        for dx in (-.26,.26):
            box(x+dx-.07,x+dx+.07,y-.39,y-.35,.35,.64)


def crate(x,y,z,w=.9):
    with tagged('ribbed cargo crates'):
        box(x-w/2,x+w/2,y-w*.4,y+w*.4,z,z+w*.75)
        for zz in (z+.08,z+w*.65):
            box(x-w/2-.035,x+w/2+.035,y-w*.4-.025,y-w*.4+.03,zz,zz+.06)
        for xx in (x-w*.37,x+w*.37):
            box(xx-.04,xx+.04,y-w*.4-.05,y+w*.4+.05,z-.02,z+w*.75+.03)


def scene_geometry():
    with tagged('sand and worn stone courtyard'):
        box(-14,14,-14,14,-.18,0)
    hut(-7.5,5.4,6,5.2,3.1,2.7,'west ochre plaster dwelling')
    hut(1.0,7.25,7.6,5.5,3.75,3.2,'north pale plaster cantina')
    hut(9.0,4.8,5,4.5,3.0,2.22,'east pale plaster dwelling')
    hut(-9.1,-3.6,5.2,5.6,2.9,2.3,'west ochre plaster dwelling')
    # East workshop with roof tank, recessed panel windows, roof stair.
    with tagged('east utility workshop'):
        box(7.2,12.5,-5.8,-.4,0,3.25)
        box(7.1,12.6,-5.9,-.3,3.1,3.4)
        box(7.1,7.35,-5.9,-.3,3.4,3.85)
        box(12.3,12.6,-5.9,-.3,3.4,3.85)
        box(7.35,12.3,-5.9,-5.65,3.4,3.85)
    with tagged('dark inset vents and panels'):
        box(7.15,7.19,-4.5,-2.8,1.35,2.15)
        box(7.15,7.19,-1.8,-.9,.7,1.5)
        for yy in (-4.35,-4.1,-3.85,-3.6,-3.35,-3.1):
            box(7.10,7.15,yy,yy+.075,1.4,2.1)
        box(-8.6,-7.4,2.74,2.79,1.35,2.15)
    with tagged('exposed utility pipes'):
        for yy,rr in ((-5.1,.13),(-4.75,.07)):
            pipe((7.02,yy,.28),(7.02,yy,2.65),rr)
            pipe((7.02,yy,2.65),(7.02,-1.0,2.65),rr)
            pipe((7.02,-1.0,2.65),(7.02,-1.0,3.55),rr)
        for xx in (-5.25,-4.95):
            pipe((xx,2.5,.2),(xx,2.5,2.7),.07)
        pipe((-5.25,2.5,.4),(-3.5,2.5,.4),.07)
    with tagged('rooftop tanks and chimneys'):
        lathe(10.1,-3.7,[(.8,3.4),(.85,3.48),(.85,4.75),(.65,4.95),(.45,5.05),(.45,5.2)],48)
        for z in (3.5,4.1,4.7):
            lathe(10.1,-3.7,[(.87,z),(.89,z+.07)],48)
        for x,y,z in ((-9.1,6.2,3.17),(3.5,8.3,3.8),(10.5,5.3,3.05),(-10.6,-2.6,3.0)):
            lathe(x,y,[(.23,z),(.23,z+.9),(.32,z+.93),(.32,z+1.08),(.23,z+1.1)],24)
    with tagged('sandstone steps and low walls'):
        for k in range(13):
            box(12.7,13.65,-5.8+k*.36,-5.44+k*.36,0,(k+1)*.25)
        for k in range(3):
            box(-.3-k*.25,2.3+k*.25,4.1-k*.3,4.8,0,(3-k)*.13)
        box(-13.5,-12.95,-10.5,9.8,0,1.1)
        box(-12.95,-10.7,-10.5,-10,0,1.1)
        box(10.5,13.65,-10.3,-9.8,0,1.0)
    # Freestanding arched street entrance; silhouette visible from inner square.
    arch(4.8,-9.8,0,1.65,2.0,.52,.9,'plaster street gateway')
    with tagged('plaster street gateway'):
        box(1.4,2.63,-10.25,-9.35,0,3.0)
        box(6.97,9.0,-10.25,-9.35,0,3.0)
        box(1.32,2.73,-10.32,-9.28,2.9,3.18)
        box(6.87,9.1,-10.32,-9.28,2.9,3.18)
    vaporator(3.6,1.1)
    crate(-3.8,2.0,0,1.2)
    crate(-3.7,2.0,.93,.8)
    crate(-2.6,2.3,0,.85)
    crate(6.35,-4.7,0,1.0)
    with tagged('ceramic storage jars'):
        for x,y,r,h in ((-5.6,1.9,.4,.9),(-5.0,2.05,.32,.7),(6.4,-1.2,.4,1.0),(-11.7,-7.2,.5,1.1)):
            lathe(x,y,[(r*.6,0),(r*.7,.1*h),(r,.35*h),(r*.93,.65*h),(r*.45,.9*h),(r*.45,h),(r*.36,h+.035)],40)
    with tagged('plaster benches and trough'):
        box(-2.8,-1.0,4.08,4.6,0,.42)
        box(-2.8,-1.0,4.47,4.62,.4,.82)
        box(4.25,6.1,4.05,4.55,0,.42)
        box(4.25,6.1,4.43,4.62,.4,.82)
        box(4.6,5.9,.85,1.75,0,.3)
        box(4.6,5.9,.85,.98,.3,.63)
        box(4.6,5.9,1.62,1.75,.3,.63)
        box(4.6,4.73,.98,1.62,.3,.63)
        box(5.77,5.9,.98,1.62,.3,.63)


def unwrap(obj):
    bpy.context.view_layer.objects.active=obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66),island_margin=.0015,area_weight=0,correct_aspect=True,scale_to_bounds=False)
    bpy.ops.uv.average_islands_scale()
    bpy.ops.uv.pack_islands(rotate=True,scale=True,margin=.0015,shape_method='CONCAVE')
    bpy.ops.object.mode_set(mode='OBJECT')


CAMERAS = [
    ('courtyard_north',(0,-7.6,1.7),(0,4.0,2.05)),
    ('workshop_east',(-4.5,-3.0,1.7),(7.3,0,2.0)),
    ('domes_west',(5.0,-3.0,1.7),(-6.0,3.0,2.0)),
    ('gateway_south',(-1.0,3.1,1.7),(4.1,-8.4,2.1)),
    ('cantina_close',(4.6,2.9,1.7),(-1.0,6.3,2.2)),
    ('dwelling_close',(-3.8,-.9,1.7),(-7.5,3.1,1.7)),
]
NOVEL = [
    ('novel_courtyard',(0,-4.4,1.7),(0,4.8,2.1)),
    ('novel_vaporator',(-2.8,1.0,1.7),(5.0,1.2,2.0)),
    ('novel_gateway',(3.1,-1.8,1.7),(3.6,-9.3,2.0)),
]


def camera(name,eye,target,fov=65):
    data=bpy.data.cameras.new(name)
    data.type='PERSP'
    data.lens=36/(2*math.tan(math.radians(fov)/2))
    data.sensor_width=36
    data.sensor_fit='HORIZONTAL'
    data.clip_start=.05
    data.clip_end=2000
    obj=bpy.data.objects.new(name,data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location=eye
    obj.rotation_euler=(Vector(target)-Vector(eye)).to_track_quat('-Z','Y').to_euler()
    return obj


def camera_spec(i,name,eye,target):
    # glTF exporter converts Blender (x,y,z) to glTF (x,z,-y).
    pos=[eye[0],eye[2],-eye[1]]
    at=[target[0],target[2],-target[1]]
    direction=(Vector(at)-Vector(pos)).normalized()
    return dict(id=i,name=name,eye=pos,target=at,fov=65,position=pos,yaw=math.atan2(-direction.x,-direction.z),pitch=math.asin(direction.y),blenderEye=list(eye),blenderTarget=list(target))


def main():
    global BM
    root=Path(__file__).resolve().parent.parent
    out=Path(sys.argv[sys.argv.index('--')+1]).resolve() if '--' in sys.argv else root/'samples/tatooine.glb'
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version=0
    BM=bmesh.new()
    scene_geometry()
    bmesh.ops.recalc_face_normals(BM,faces=BM.faces[:])
    # Buried bottoms never contribute to either benchmark method.
    drop=[f for f in BM.faces if f.normal.z<-.99 and f.calc_center_median().z<.001]
    bmesh.ops.delete(BM,geom=drop,context='FACES')
    mesh=bpy.data.meshes.new('tatooine shared geometry')
    BM.to_mesh(mesh)
    BM.free()
    mesh.set_sharp_from_angle(angle=math.radians(40))
    obj=bpy.data.objects.new('tatooine shared geometry',mesh)
    bpy.context.scene.collection.objects.link(obj)
    for label in LABELS:
        mat=bpy.data.materials.new(label)
        mat.diffuse_color=(.52,.52,.52,1)
        mat.use_nodes=True
        mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(.52,.52,.52,1)
        mat.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value=.85
        mesh.materials.append(mat)
    unwrap(obj)
    # Triangulate ONCE before exporting either format; matched geometry is exact.
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.quads_convert_to_tris(quad_method='BEAUTY',ngon_method='BEAUTY')
    bpy.ops.mesh.separate(type='MATERIAL')
    bpy.ops.object.mode_set(mode='OBJECT')
    meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
    for o in meshes:
        used=next(iter({p.material_index for p in o.data.polygons}))
        mat=o.data.materials[used]
        for p in o.data.polygons:
            p.material_index=0
        o.data.materials.clear()
        o.data.materials.append(mat)
        o.name=mat.name
        o['description']=mat.name
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(out),export_format='GLB',use_selection=True,export_cameras=False,export_lights=False,export_yup=True)
    for name,eye,target in CAMERAS:camera(name,eye,target)
    # Novel cameras are stored in JSON only, so upstream tools cannot use them as sources.
    bpy.context.scene.camera=bpy.data.objects[CAMERAS[0][0]]
    world=bpy.data.worlds.new('soft neutral overcast')
    world.use_nodes=True
    world.node_tree.nodes['Background'].inputs['Color'].default_value=(.75,.75,.75,1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value=.8
    bpy.context.scene.world=world
    ld=bpy.data.lights.new('large soft sky','AREA')
    ld.energy=2300
    ld.shape='DISK'
    ld.size=22
    light=bpy.data.objects.new('large soft sky',ld)
    bpy.context.scene.collection.objects.link(light)
    light.location=(-5,-4,15)
    light.rotation_euler=(Vector((0,0,0))-light.location).to_track_quat('-Z','Y').to_euler()
    scene=bpy.context.scene
    scene.render.engine='CYCLES'
    scene.cycles.samples=24
    scene.cycles.use_denoising=True
    scene.render.resolution_x=1024
    scene.render.resolution_y=1024
    scene.render.resolution_percentage=100
    scene.view_settings.view_transform='Standard'
    scene.view_settings.look='None'
    scene.view_settings.exposure=0
    scene.view_settings.gamma=1
    scene.render.image_settings.file_format='PNG'
    scene['benchmark']='Tatooine-inspired shared scene. Six source cameras; novel cameras only in JSON. Original procedural asset.'
    blend=out.with_suffix('.blend')
    bpy.ops.wm.save_as_mainfile(filepath=str(blend))
    triangles=sum(len(o.data.polygons) for o in meshes)
    metadata={
        'version':1,'scene':'tatooine','description':'Original Tatooine-inspired desert courtyard, no external assets',
        'units':'metres','coordinateSystem':'glTF Y-up','blenderCoordinateSystem':'Z-up',
        'geometry':{'triangles':triangles,'objects':len(meshes),'labels':LABELS,'uv':'one global nonoverlapping atlas shared by both exports'},
        'bounds':{'min':[-14,-.18,-14],'max':[14,6.0,14]},
        'playArea':[-5.5,0,-4.0,6.5,2.5,8.5],
        'cameras':[camera_spec(i,*c) for i,c in enumerate(CAMERAS)],
        'novelCameras':[camera_spec(100+i,*c) for i,c in enumerate(NOVEL)]}
    out.with_name('tatooine-cameras.json').write_text(json.dumps(metadata,indent=2)+'\n')
    preview=root/'output/benchmark/tatooine-clay.png'
    preview.parent.mkdir(parents=True,exist_ok=True)
    overview=camera('preview_overview',(24,-32,25),(0,0,1.4),49)
    scene.camera=overview
    scene.render.resolution_x=1440
    scene.render.resolution_y=1100
    scene.render.filepath=str(preview)
    bpy.ops.render.render(write_still=True)
    print(json.dumps({'glb':str(out),'blend':str(blend),'preview':str(preview),'triangles':triangles,'parts':len(meshes)}))


if __name__=='__main__':main()
