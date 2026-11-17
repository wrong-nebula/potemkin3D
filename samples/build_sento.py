"""Build the sento blockout: the bathing hall of an old Tokyo public bathhouse.

Run: blender -b --factory-startup -P samples/build_sento.py -- samples/sento.glb [--open]

With --open the sliding door stands open and the sauna door is a doorway through the east wall, for joining the
hall to the rooms round it (experiments/sento/rooms.json).

One room, 12 x 9 m and 4 m to the ceiling, with a glazed lantern over its middle. Along the north wall two sunken
baths under a wall-wide mural; a round wooden plunge tub in a corner; rows of washing places (a ledge, a mirror, a
tap, a stool and a bowl each) along the south wall and both sides of a low partition down the middle; a sliding door
and a shelf of baskets on the west wall, a sauna door, a clock and two high windows on the east.

It is here to try image models on what the other samples lack: tile grids on every surface (a grid shows at once
whether a model kept the perspective), a wall that is a picture (the mural), water, mirrors, and round things.

Untextured, in metres, Blender's axes (x east, y north, z up). Every part is labelled; labels become glTF
materials, which the texturing prompts read. Faces nobody can see get next to no texture space.
"""
import math
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

W, D, H, T = 6.0, 4.5, 4.0, 0.25          # half length, half width, height of the room; wall thickness
DADO = 1.5                                # the walls are tiled up to here
LX0, LX1, LY0, LY1, LZ = -3.0, 3.0, -2.2, 1.6, 5.4   # the lantern's footprint and the underside of its roof
LABELS = []
OPEN = '--open' in sys.argv                # doorways instead of doors
SAUNA = (-0.45, 0.45, 2.0)                 # the sauna door in the east wall: y0, y1, height


def box(bm, x0, x1, y0, y1, z0, z1):
    c = Vector(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))
    bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation(c) @ Matrix.Diagonal((x1 - x0, y1 - y0, z1 - z0, 1)))


def cyl(bm, x, y, z0, h, r, seg=16, r2=None):
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r, radius2=r if r2 is None else r2, depth=h,
                          matrix=Matrix.Translation((x, y, z0 + h / 2)))


def disc_x(bm, x, y, z, r, depth, seg=20):
    """A flat round thing on a wall that faces along x."""
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r, radius2=r, depth=depth,
                          matrix=Matrix.Translation((x, y, z)) @ Matrix.Rotation(math.pi / 2, 4, 'Y'))


class tagged:
    """Label every face created inside the block. (By identity, not by position: bmesh does not promise that new
    faces come last in its table, and here they did not, which left a third of the room labelled as floor.)"""

    def __init__(self, bm, name):
        self.bm, self.name = bm, name

    def __enter__(self):
        if self.name not in LABELS:
            LABELS.append(self.name)
        self.before = set(self.bm.faces)
        return self

    def __exit__(self, *exc):
        for f in self.bm.faces:
            if f not in self.before:
                f.material_index = LABELS.index(self.name)


def room(bm):
    with tagged(bm, 'tiled bathhouse floor'):
        box(bm, -(W + T), W + T, -(D + T), D + T, -0.2, 0)
    d = 0.04                                                   # the tiled dado stands this far proud of the plaster
    DOOR = (-3.2, -1.6, 2.1)                                   # the doorway in the west wall: y0, y1, height
    with tagged(bm, 'white tiled wall'):
        box(bm, -(W + T), W + T, -(D + T), -D + d, 0, DADO)    # south
        box(bm, -(W + T), W + T, D - d, D + T, 0, DADO)        # north (behind the baths)
        if OPEN:
            box(bm, W - d, W + T, -D + d, SAUNA[0], 0, DADO)   # east, either side of the sauna doorway
            box(bm, W - d, W + T, SAUNA[1], D - d, 0, DADO)
        else:
            box(bm, W - d, W + T, -D + d, D - d, 0, DADO)      # east
        box(bm, -(W + T), -W + d, -D + d, DOOR[0], 0, DADO)    # west, either side of the doorway
        box(bm, -(W + T), -W + d, DOOR[1], D - d, 0, DADO)
    with tagged(bm, 'pale green painted plaster wall'):
        box(bm, -(W + T), W + T, -(D + T), -D, DADO, H)
        box(bm, -(W + T), W + T, D, D + T, DADO, H)
        if OPEN:
            box(bm, W, W + T, -D, SAUNA[0], DADO, H)
            box(bm, W, W + T, SAUNA[1], D, DADO, H)
            box(bm, W, W + T, SAUNA[0], SAUNA[1], SAUNA[2], H)   # over the doorway
        else:
            box(bm, W, W + T, -D, D, DADO, H)
        box(bm, -(W + T), -W, -D, DOOR[0], DADO, H)
        box(bm, -(W + T), -W, DOOR[1], D, DADO, H)
        box(bm, -(W + T), -W, DOOR[0], DOOR[1], DOOR[2], H)    # over the door
    with tagged(bm, 'painted mural of Mount Fuji over a lake'):
        box(bm, -W + 0.15, W - 0.15, D - 0.06, D, DADO + 0.05, 3.7)
    with tagged(bm, 'wooden sliding door with frosted glass panes'):
        # (open, it stands slid aside behind the wall to the north of the doorway)
        y0, y1, z1, x = DOOR[0] + (1.62 if OPEN else 0), DOOR[1] + (1.62 if OPEN else 0), DOOR[2], -W - (0.29 if OPEN else 0.12)
        box(bm, x - 0.03, x, y0, y1, 0, z1)                    # the panes
        f = 0.07
        for a, b in ((y0, y0 + f), (y1 - f, y1), ((y0 + y1) / 2 - f / 2, (y0 + y1) / 2 + f / 2)):
            box(bm, x, x + 0.04, a, b, 0, z1)                  # stiles
        for a, b in ((0, 0.25), (z1 - f, z1), (0.95, 0.95 + f)):
            for s0, s1 in ((y0 + f, (y0 + y1) / 2 - f / 2), ((y0 + y1) / 2 + f / 2, y1 - f)):
                box(bm, x, x + 0.04, s0, s1, a, b)             # rails
    with tagged(bm, 'wooden door frame'):
        box(bm, -(W + T), -W + 0.06, DOOR[0] - 0.1, DOOR[0], 0, DOOR[2] + 0.1)
        box(bm, -(W + T), -W + 0.06, DOOR[1], DOOR[1] + 0.1, 0, DOOR[2] + 0.1)
        box(bm, -(W + T), -W + 0.06, DOOR[0], DOOR[1], DOOR[2], DOOR[2] + 0.1)
    # the east wall: a sauna door, a clock, two high windows
    with tagged(bm, 'wooden sauna door'):
        if OPEN:                                               # swung open, flat against the wall beside the doorway
            box(bm, W - d - 0.05, W - d, SAUNA[1] + 0.02, SAUNA[1] + 0.92, 0, 2.0)
        else:
            box(bm, W - d - 0.05, W - d, -0.45, 0.45, 0, 2.0)
            box(bm, W - d - 0.09, W - d - 0.05, -0.2, 0.2, 1.2, 1.7)  # its little window
    with tagged(bm, 'round wall clock'):
        disc_x(bm, W - 0.03, -2.0, 2.6, 0.26, 0.06)
    with tagged(bm, 'high frosted glass window'):
        for c in (-2.6, 2.4):
            box(bm, W - 0.04, W, c - 0.9, c + 0.9, 2.3, 3.4)
    with tagged(bm, 'white painted window frame'):
        for c in (-2.6, 2.4):
            f, x = 0.06, W - 0.07
            box(bm, x, x + 0.03, c - 0.9, c - 0.9 + f, 2.3, 3.4)
            box(bm, x, x + 0.03, c + 0.9 - f, c + 0.9, 2.3, 3.4)
            box(bm, x, x + 0.03, c - f / 2, c + f / 2, 2.3 + f, 3.4 - f)
            box(bm, x, x + 0.03, c - 0.9 + f, c + 0.9 - f, 2.3, 2.3 + f)
            box(bm, x, x + 0.03, c - 0.9 + f, c + 0.9 - f, 3.4 - f, 3.4)


def ceiling(bm):
    with tagged(bm, 'wooden plank ceiling'):
        box(bm, -(W + T), W + T, LY1, D + T, H, H + 0.2)       # round the lantern's opening
        box(bm, -(W + T), W + T, -(D + T), LY0, H, H + 0.2)
        box(bm, -(W + T), LX0, LY0, LY1, H, H + 0.2)
        box(bm, LX1, W + T, LY0, LY1, H, H + 0.2)
        box(bm, LX0 - 0.2, LX1 + 0.2, LY0 - 0.2, LY1 + 0.2, LZ, LZ + 0.2)   # the lantern's own roof
    with tagged(bm, 'dark timber ceiling beam'):
        for y in (LY0, LY1):
            box(bm, -W, W, y - 0.1, y + 0.1, H - 0.3, H)
        for x in (LX0, LX1):
            box(bm, x - 0.1, x + 0.1, LY0 + 0.1, LY1 - 0.1, H - 0.3, H)
        for x in (-4.5, 4.5):
            box(bm, x - 0.09, x + 0.09, -D, LY0 - 0.1, H - 0.25, H)
            box(bm, x - 0.09, x + 0.09, LY1 + 0.1, D, H - 0.25, H)
    with tagged(bm, 'white painted timber lantern window frame'):
        p, z0, z1 = 0.14, H + 0.2, LZ
        for x in (LX0, LX1):                                    # corner posts
            for y in (LY0, LY1):
                box(bm, x - p / 2, x + p / 2, y - p / 2, y + p / 2, z0, z1)
        for y in (LY0, LY1):                                    # the long sides: sill, head, mullions
            box(bm, LX0 + p / 2, LX1 - p / 2, y - p / 2, y + p / 2, z0, z0 + 0.16)
            box(bm, LX0 + p / 2, LX1 - p / 2, y - p / 2, y + p / 2, z1 - 0.16, z1)
            for k in range(1, 6):
                x = LX0 + (LX1 - LX0) * k / 6
                box(bm, x - 0.035, x + 0.035, y - 0.04, y + 0.04, z0 + 0.16, z1 - 0.16)
        for x in (LX0, LX1):                                    # the short sides
            box(bm, x - p / 2, x + p / 2, LY0 + p / 2, LY1 - p / 2, z0, z0 + 0.16)
            box(bm, x - p / 2, x + p / 2, LY0 + p / 2, LY1 - p / 2, z1 - 0.16, z1)
            for k in range(1, 4):
                y = LY0 + (LY1 - LY0) * k / 4
                box(bm, x - 0.04, x + 0.04, y - 0.035, y + 0.035, z0 + 0.16, z1 - 0.16)
    with tagged(bm, 'tiled square column'):
        for x in (LX0, LX1):
            for y in (LY0, LY1):
                box(bm, x - 0.2, x + 0.2, y - 0.2, y + 0.2, 0, H - 0.3)
    with tagged(bm, 'white glass globe pendant lamp'):
        for x, y in ((-4.5, -3.3), (4.5, -3.3), (-4.5, 3.0), (4.5, 3.0)):
            bmesh.ops.create_uvsphere(bm, u_segments=14, v_segments=8, radius=0.19, matrix=Matrix.Translation((x, y, 3.05)))
            cyl(bm, x, y, 3.22, H - 0.25 - 3.22, 0.015, seg=6)


def baths(bm):
    BY = 2.2                                                    # the baths' front edge
    with tagged(bm, 'blue tiled bath rim'):
        box(bm, -W + 0.04, W - 0.04, BY, BY + 0.25, 0, 0.6)     # the front wall of both baths
        box(bm, 0.4, 0.65, BY + 0.25, D - 0.04, 0, 0.6)         # the wall between them
    with tagged(bm, 'tiled bath step'):
        box(bm, -W + 0.04, W - 0.04, BY - 0.32, BY, 0, 0.2)
    with tagged(bm, 'clear bath water'):
        box(bm, -W + 0.04, 0.4, BY + 0.25, D - 0.04, 0.44, 0.5)
    with tagged(bm, 'milky green herbal bath water'):
        box(bm, 0.65, W - 0.04, BY + 0.25, D - 0.04, 0.44, 0.5)
    with tagged(bm, 'stone water spout'):
        box(bm, 0.36, 0.69, D - 0.5, D - 0.04, 0.6, 0.95)
        box(bm, 0.45, 0.6, D - 0.72, D - 0.5, 0.74, 0.84)
    # the cold plunge tub: a cooper's tub, full to the brim
    tx, ty = 4.6, -3.1
    with tagged(bm, 'round cypress wood plunge tub'):
        cyl(bm, tx, ty, 0, 0.72, 0.9, seg=24)
        cyl(bm, tx, ty, 0.72, 0.06, 0.95, seg=24)
        cyl(bm, tx, ty, 0.2, 0.05, 0.92, seg=24)                # hoops
        cyl(bm, tx, ty, 0.5, 0.05, 0.92, seg=24)
    with tagged(bm, 'cold plunge water'):
        cyl(bm, tx, ty, 0.78, 0.015, 0.82, seg=24)


def station(bm, x, y, facing):
    """One washing place: a mirror and a tap on the wall at y, a stool and a bowl in front. `facing` is +1 when the
    bather faces north (the wall is to the north of them), -1 when south."""
    with tagged(bm, 'wall mirror'):
        box(bm, x - 0.22, x + 0.22, min(y, y - facing * 0.02), max(y, y - facing * 0.02), 0.62, 1.2)
    with tagged(bm, 'chrome tap'):
        a, b = sorted((y, y - facing * 0.14))
        box(bm, x - 0.03, x + 0.03, a, b, 0.5, 0.56)
        a, b = sorted((y - facing * 0.1, y - facing * 0.14))
        box(bm, x - 0.03, x + 0.03, a, b, 0.44, 0.5)
    with tagged(bm, 'yellow plastic wash bowl'):
        cyl(bm, x + 0.28, y - facing * 0.17, 0.4, 0.09, 0.085, seg=12, r2=0.125)
    with tagged(bm, 'low plastic bath stool'):
        cyl(bm, x, y - facing * 0.62, 0, 0.27, 0.17, seg=12)


def washing(bm):
    # along the south wall
    with tagged(bm, 'tiled washing ledge'):
        box(bm, -5.4, 3.0, -D + 0.04, -D + 0.34, 0.32, 0.4)
    for k in range(8):
        station(bm, -4.9 + k * 1.05, -D + 0.04, -1)
    # the partition down the middle, places on both sides
    with tagged(bm, 'low tiled partition wall'):
        box(bm, -3.6, 3.6, -0.6, -0.3, 0, 1.3)
    with tagged(bm, 'tiled washing ledge'):
        box(bm, -3.6, 3.6, -0.3, 0.0, 0.32, 0.4)
        box(bm, -3.6, 3.6, -0.9, -0.6, 0.32, 0.4)
    for k in range(6):
        station(bm, -3.0 + k * 1.2, -0.3, -1)                   # on its north face, the bather looking south
        station(bm, -3.0 + k * 1.2, -0.6, 1)


def furniture(bm):
    # the shelf of baskets on the west wall, north of the door
    x0, x1, y0, y1 = -W + 0.04, -W + 0.44, -0.9, 1.5
    with tagged(bm, 'wooden shelf unit'):
        box(bm, x0, x1, y0, y0 + 0.04, 0, 1.75)
        box(bm, x0, x1, y1 - 0.04, y1, 0, 1.75)
        for z in (0.12, 0.66, 1.2, 1.71):
            box(bm, x0, x1, y0 + 0.04, y1 - 0.04, z, z + 0.04)
    with tagged(bm, 'woven bamboo clothes basket'):
        for z in (0.16, 0.7, 1.24):
            for k in range(4):
                y = y0 + 0.14 + k * 0.57
                box(bm, x0 + 0.03, x1 - 0.02, y, y + 0.44, z, z + 0.26)
    with tagged(bm, 'stack of yellow plastic wash bowls'):
        cyl(bm, -5.3, -1.25, 0, 0.55, 0.14, seg=12)
        cyl(bm, -5.0, -1.2, 0, 0.4, 0.14, seg=12)
    with tagged(bm, 'stack of plastic bath stools'):
        cyl(bm, -5.35, 1.95, 0, 0.7, 0.18, seg=12)
    with tagged(bm, 'wooden bench'):
        box(bm, 2.4, 4.0, 0.55, 0.95, 0.38, 0.44)
        for x in (2.5, 3.84):
            box(bm, x, x + 0.06, 0.6, 0.9, 0, 0.38)


def group_of(f):
    """Texture-space share for a face: the room gets it; what nobody can see next to none."""
    c, n = f.calc_center_median(), f.normal
    name = LABELS[f.material_index]
    if abs(c.x) > W + T - 0.01 or abs(c.y) > D + T - 0.01 or c.z > LZ + 0.19 or c.z < -0.19:
        return 'hidden'
    if name == 'wooden plank ceiling' and n.z > 0.5:
        return 'hidden'                                          # the roof from above
    if name == 'white painted timber lantern window frame':
        out = Vector((c.x - (LX0 + LX1) / 2, c.y - (LY0 + LY1) / 2, 0))
        if n.dot(out) > 0.05 and abs(n.z) < 0.5:
            return 'hidden'                                      # the lantern's outer faces
    if name == 'wooden sliding door with frosted glass panes' and n.x < -0.5 and not OPEN:
        return 'hidden'
    return 'room'


SCALE = {'room': 1.0, 'hidden': 0.04}


def unwrap(obj):
    """Smart UV project each group on its own, shrink the lesser ones, then pack together."""
    bpy.context.scene.tool_settings.use_uv_select_sync = True
    bpy.ops.object.mode_set(mode='EDIT')
    bm = bmesh.from_edit_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    groups = {}
    for f in bm.faces:
        groups.setdefault(group_of(f), []).append(f.index)
    for name, idx in groups.items():
        for f in bm.faces:
            f.select_set(False)
        for i in idx:
            bm.faces[i].select_set(True)
        bmesh.update_edit_mesh(obj.data)
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.002, area_weight=0.0,
                                 correct_aspect=True, scale_to_bounds=False)
        bm = bmesh.from_edit_mesh(obj.data)
        bm.faces.ensure_lookup_table()
        uv = bm.loops.layers.uv.active
        for i in idx:
            for loop in bm.faces[i].loops:
                loop[uv].uv *= SCALE[name]
        bmesh.update_edit_mesh(obj.data)
    for f in bm.faces:
        f.select_set(True)
    bmesh.update_edit_mesh(obj.data)
    bpy.ops.uv.pack_islands(rotate=True, scale=True, margin=0.0015)
    bm = bmesh.from_edit_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    uv = bm.loops.layers.uv.active
    share, area = {}, {}
    for f in bm.faces:
        pts = [l[uv].uv for l in f.loops]
        a = 0.0
        for k in range(1, len(pts) - 1):
            a += abs((pts[k].x - pts[0].x) * (pts[k + 1].y - pts[0].y) - (pts[k + 1].x - pts[0].x) * (pts[k].y - pts[0].y)) / 2
        g = group_of(f)
        share[g] = share.get(g, 0.0) + a
        area[g] = area.get(g, 0.0) + f.calc_area()
    bpy.ops.object.mode_set(mode='OBJECT')
    print('UV share by group:', {k: round(v, 3) for k, v in share.items()}, 'surface m2:', {k: round(v) for k, v in area.items()})
    print(f"the room gets {math.sqrt(share['room'] / area['room']) * 4096:.0f} texels per metre on a 4096 px texture")


def main():
    out = sys.argv[sys.argv.index('--') + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bm = bmesh.new()
    room(bm)
    ceiling(bm)
    baths(bm)
    washing(bm)
    furniture(bm)
    # drop faces resting on the floor: never visible, they'd only waste texture space
    bm.faces.ensure_lookup_table()
    drop = [f for f in bm.faces if f.normal.z < -0.99 and abs(f.calc_center_median().z) < 0.02]
    bmesh.ops.delete(bm, geom=drop, context='FACES')
    for f in bm.faces:
        f.smooth = False
    mesh = bpy.data.meshes.new('sento')
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new('sento', mesh)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    for name in LABELS:
        obj.data.materials.append(bpy.data.materials.new(name))
    import collections
    count = collections.Counter(p.material_index for p in mesh.polygons)
    print('faces by part:', {n: count[i] for i, n in enumerate(LABELS)})
    unwrap(obj)
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True)
    print('DONE', out, len(mesh.polygons), 'faces', round(sum(p.area for p in mesh.polygons)), 'm2', len(LABELS), 'parts')


main()
