"""Build the post hall blockout: the public hall of an old post office, a second interior beside the Loft.

Run: blender -b --factory-startup -P samples/build_posthall.py -- samples/posthall.glb

A hall 22 x 12 m and 8 m high, at street level. Tall barred windows high in both long walls, stone walls with a
darker base, a wooden counter screen with six grilled windows along the north side and the back office behind it,
the street door in the east wall and a shuttered doorway in the west one, benches, writing desks, telephone
booths, a parcel trolley, lamps on rods. Outside, a few buildings across the street show through the windows.

Untextured, in metres, Blender's axes (x east, y north, z up). Every part is labelled; labels become glTF
materials, which the texturing prompts read. Texture space goes to the hall; the office behind the counters gets
half as much, the buildings outside a fraction, and faces nobody can see next to none.

Where players can be (glTF axes, for --area): -11,0,-3.9,11,8,6
"""
import math
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

W, D, H, T = 11.0, 6.0, 8.0, 0.4   # half length, half width, height of the hall; wall thickness
SCREEN = 4.0                       # the counter screen's front, north of the middle
LABELS = []
BACKGROUND = {'building across the street'}


def box(bm, x0, x1, y0, y1, z0, z1):
    c = Vector(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))
    bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation(c) @ Matrix.Diagonal((x1 - x0, y1 - y0, z1 - z0, 1)))


def slanted(bm, origin, ex, ey, ez):
    """A box with edges ex, ey, ez from `origin` (they need not be square to each other): stair stringers and rails."""
    o, a, b, c = Vector(origin), Vector(ex), Vector(ey), Vector(ez)
    m = Matrix.Identity(4)
    for i in range(3):
        m[i][0], m[i][1], m[i][2] = a[i], b[i], c[i]
        m[i][3] = o[i] + (a[i] + b[i] + c[i]) / 2
    bmesh.ops.create_cube(bm, size=1.0, matrix=m)


def cyl(bm, x, y, z0, h, r, seg=16, r2=None):
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r, radius2=r if r2 is None else r2, depth=h,
                          matrix=Matrix.Translation((x, y, z0 + h / 2)))


def pipe_x(bm, x0, x1, y, z, r, seg=8):
    """A pipe running along x."""
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r, radius2=r, depth=x1 - x0,
                          matrix=Matrix.Translation(((x0 + x1) / 2, y, z)) @ Matrix.Rotation(math.pi / 2, 4, 'Y'))


class tagged:
    """Label every face created inside the block."""

    def __init__(self, bm, name):
        self.bm, self.name = bm, name

    def __enter__(self):
        if self.name not in LABELS:
            LABELS.append(self.name)
        self.bm.faces.ensure_lookup_table()
        self.start = len(self.bm.faces)
        return self

    def __exit__(self, *exc):
        self.bm.faces.ensure_lookup_table()
        for i in range(self.start, len(self.bm.faces)):
            self.bm.faces[i].material_index = LABELS.index(self.name)


def window_frame(bm, along, a0, a1, z0, z1, at, cols=3, rows=4):
    """A steel factory window in an opening: a frame and a grid of glazing bars, no glass (the view is the point).

    `along` is the axis the wall runs along; `at` is where the frame sits across the wall's thickness."""
    f, m, d = 0.07, 0.035, 0.04   # frame and glazing bar widths, half depth

    def bar(p0, p1, q0, q1):
        if along == 'x':
            box(bm, p0, p1, at - d, at + d, q0, q1)
        else:
            box(bm, at - d, at + d, p0, p1, q0, q1)

    bar(a0, a0 + f, z0, z1)
    bar(a1 - f, a1, z0, z1)
    bar(a0 + f, a1 - f, z0, z0 + f)
    bar(a0 + f, a1 - f, z1 - f, z1)
    for k in range(1, cols):
        c = a0 + (a1 - a0) * k / cols
        bar(c - m / 2, c + m / 2, z0 + f, z1 - f)
    for k in range(1, rows):
        c = z0 + (z1 - z0) * k / rows
        # between the uprights, so no bar runs through another
        edges = [a0 + f] + [a0 + (a1 - a0) * j / cols for j in range(1, cols)] + [a1 - f]
        for j in range(cols):
            bar(edges[j] + (m / 2 if j else 0), edges[j + 1] - (m / 2 if j < cols - 1 else 0), c - m / 2, c + m / 2)




def wall_x(bm, x0, x1, y0, y1, top, openings, z0=0.0):
    """A wall along x from x0 to x1, z0 to top, with openings (xa, xb, za, zb)."""
    x = x0
    for o in sorted(openings):
        box(bm, x, o[0], y0, y1, z0, top)
        if o[2] > z0:
            box(bm, o[0], o[1], y0, y1, z0, o[2])
        if o[3] < top:
            box(bm, o[0], o[1], y0, y1, o[3], top)
        x = o[1]
    box(bm, x, x1, y0, y1, z0, top)


def wall_y(bm, x0, x1, top, openings):
    """An end wall from y = -D to D with openings (ya, yb, za, zb)."""
    y = -D
    for o in sorted(openings):
        box(bm, x0, x1, y, o[0], 0, top)
        if o[2] > 0:
            box(bm, x0, x1, o[0], o[1], 0, o[2])
        box(bm, x0, x1, o[0], o[1], o[3], top)
        y = o[1]
    box(bm, x0, x1, y, D, 0, top)


BAYS = (-6.6, -2.2, 2.2, 6.6)                                  # the middles of the four bays
SOUTH = [(c - 1.2, c + 1.2, 2.8, 7.0) for c in BAYS]           # tall windows in the south wall
NORTH = [(c - 1.2, c + 1.2, 4.4, 7.0) for c in BAYS]           # shorter ones over the office
STREET = (-1.2, 1.2, 0.0, 3.0)                                 # the street door, in the east wall
PASSAGE = (-1.1, 1.1, 0.0, 2.6)                                # the shuttered doorway, in the west wall
TELLERS = [(c - 0.65, c + 0.65, 1.05, 2.3) for c in (-8.4, -5.1, -1.8, 1.5, 4.8, 8.1)]


def hall(bm):
    with tagged(bm, 'terrazzo floor'):
        box(bm, -(W + T), W + T, -(D + T), D + T, -0.2, 0)
    with tagged(bm, 'plaster ceiling'):
        box(bm, -(W + T), W + T, -(D + T), D + T, H, H + 0.3)
    with tagged(bm, 'ceiling beam'):
        for x in (-8.8, -4.4, 0, 4.4, 8.8):
            box(bm, x - 0.22, x + 0.22, -D, D, H - 0.5, H)
    with tagged(bm, 'limestone block wall'):
        wall_x(bm, -(W + T), W + T, -(D + T), -D, H, SOUTH)
        wall_x(bm, -(W + T), W + T, D, D + T, H, NORTH)
        wall_y(bm, -(W + T), -W, H, [PASSAGE])
        wall_y(bm, W, W + T, H, [STREET])
    with tagged(bm, 'dark stone wall base'):
        # the lower wall, a little proud of the stone above it, with a band on top; not across the doorways
        d = 0.04
        box(bm, -W, W, -D, -D + d, 0, 1.2)
        box(bm, -W, W, -D, -D + d + 0.03, 1.2, 1.34)
        for y0, y1 in ((-D + d, PASSAGE[0] - 0.12), (PASSAGE[1] + 0.12, SCREEN)):
            box(bm, -W, -W + d, y0, y1, 0, 1.2)
            box(bm, -W, -W + d + 0.03, y0, y1, 1.2, 1.34)
        for y0, y1 in ((-D + d, STREET[0] - 0.3), (STREET[1] + 0.3, SCREEN)):
            box(bm, W - d, W, y0, y1, 0, 1.2)
            box(bm, W - d - 0.03, W, y0, y1, 1.2, 1.34)
    with tagged(bm, 'stone pilaster'):
        for x in (-8.8, -4.4, 0, 4.4, 8.8):
            box(bm, x - 0.3, x + 0.3, -D + 0.07, -D + 0.2, 0, H - 0.5)
            box(bm, x - 0.36, x + 0.36, -D + 0.07, -D + 0.26, 0, 0.3)          # its foot
            box(bm, x - 0.36, x + 0.36, -D + 0.07, -D + 0.26, H - 0.8, H - 0.5)  # and its head, under the beam
    with tagged(bm, 'iron window frame'):
        for o in SOUTH:
            window_frame(bm, 'x', *o, -(D + 0.2), cols=4, rows=7)
        for o in NORTH:
            window_frame(bm, 'x', *o, D + 0.2, cols=4, rows=4)
    with tagged(bm, 'stone window sill'):
        for o in SOUTH:
            box(bm, o[0] - 0.08, o[1] + 0.08, -D - 0.1, -D + 0.12, o[2] - 0.03, o[2] + 0.05)
        for o in NORTH:
            box(bm, o[0] - 0.08, o[1] + 0.08, D - 0.12, D + 0.1, o[2] - 0.03, o[2] + 0.05)
    with tagged(bm, 'wooden double door'):
        y0, y1, _, z1 = STREET
        box(bm, W + 0.18, W + 0.26, y0, y1, 0, z1)
        box(bm, W + 0.14, W + 0.18, -0.03, 0.03, 0, z1)                        # where the two leaves meet
        for y in (-0.22, 0.14):
            box(bm, W + 0.1, W + 0.18, y, y + 0.08, 1.0, 1.3)                  # handles
    with tagged(bm, 'stone door surround'):
        y0, y1, _, z1 = STREET
        box(bm, W - 0.1, W, y0 - 0.3, y0, 0, z1 + 0.3)
        box(bm, W - 0.1, W, y1, y1 + 0.3, 0, z1 + 0.3)
        box(bm, W - 0.1, W, y0, y1, z1, z1 + 0.3)
    with tagged(bm, 'steel roller shutter'):
        y0, y1, _, z1 = PASSAGE
        box(bm, -(W + 0.24), -(W + 0.18), y0, y1, 0, z1)
        box(bm, -(W + 0.18), -(W + 0.04), y0, y1, z1 - 0.3, z1)                # the box the shutter rolls into
    with tagged(bm, 'steel door frame'):
        y0, y1, _, z1 = PASSAGE
        box(bm, -W - 0.02, -W + 0.06, y0 - 0.12, y0, 0, z1 + 0.12)
        box(bm, -W - 0.02, -W + 0.06, y1, y1 + 0.12, 0, z1 + 0.12)
        box(bm, -W - 0.02, -W + 0.06, y0, y1, z1, z1 + 0.12)
    with tagged(bm, 'wall clock'):
        pipe_x(bm, W - 0.12, W, 0, 4.7, 0.6, seg=24)
    with tagged(bm, 'notice board'):
        for y0, y1 in ((-4.6, -2.0), (2.0, 3.6)):
            box(bm, -W, -W + 0.06, y0, y1, 1.5, 2.7)
    with tagged(bm, 'cast iron letter box'):
        box(bm, W - 0.28, W, -3.4, -2.8, 1.0, 1.75)
    with tagged(bm, 'pendant lamp'):
        for x in BAYS:
            for y in (-2.6, 1.4):
                box(bm, x - 0.015, x + 0.015, y - 0.015, y + 0.015, 5.5, H)    # the rod
                cyl(bm, x, y, 5.38, 0.12, 0.1, seg=10)                         # the fitting
                cyl(bm, x, y, 5.0, 0.38, 0.3, seg=12, r2=0.2)                  # the glass shade


def counters(bm):
    """The screen along the north side: a panelled wooden wall with six grilled windows, and the office behind it."""
    with tagged(bm, 'wooden counter screen'):
        wall_x(bm, -W, W, SCREEN, SCREEN + 0.15, 3.4, TELLERS)
        box(bm, -W, W, SCREEN - 0.1, SCREEN + 0.25, 3.4, 3.58)                 # the cornice along its top
        box(bm, -W, W, SCREEN - 0.05, SCREEN, 0, 0.16)                         # and the plinth along its foot
    with tagged(bm, 'worn wooden counter top'):
        for o in TELLERS:
            box(bm, o[0] - 0.12, o[1] + 0.12, SCREEN - 0.32, SCREEN + 0.45, o[2] - 0.05, o[2])
    with tagged(bm, 'brass counter grille'):
        for o in TELLERS:
            n = 9
            for k in range(n):
                x = o[0] + (o[1] - o[0]) * (k + 0.5) / n
                box(bm, x - 0.01, x + 0.01, SCREEN + 0.06, SCREEN + 0.08, o[2] + 0.28, o[3])
            box(bm, o[0], o[1], SCREEN + 0.055, SCREEN + 0.085, o[2] + 0.26, o[2] + 0.29)
            box(bm, o[0], o[1], SCREEN + 0.055, SCREEN + 0.085, o[2] + 0.8, o[2] + 0.83)
    with tagged(bm, 'enamel counter sign'):
        for o in TELLERS:
            c = (o[0] + o[1]) / 2
            box(bm, c - 0.4, c + 0.4, SCREEN - 0.03, SCREEN, 2.55, 2.85)
    with tagged(bm, 'wooden pigeonhole shelves'):
        y0, y1, top = D - 0.4, D, 2.4                                          # against the office's back wall
        box(bm, -W + 0.5, W - 0.5, y1 - 0.02, y1, 0, top)
        for k in range(7):
            z = k * (top - 0.04) / 6
            box(bm, -W + 0.5, W - 0.5, y0, y1 - 0.02, z, z + 0.04)
        x = -W + 0.5
        while x < W - 0.45:
            box(bm, x, x + 0.04, y0, y1 - 0.02, 0, top)
            x += 1.3
    with tagged(bm, 'office desk'):
        for o in TELLERS[::2]:
            c = (o[0] + o[1]) / 2 + 1.65
            box(bm, c - 0.7, c + 0.7, SCREEN + 0.5, SCREEN + 1.15, 0.72, 0.76)
            box(bm, c - 0.7, c - 0.3, SCREEN + 0.5, SCREEN + 1.15, 0, 0.72)    # a pedestal of drawers
            box(bm, c + 0.64, c + 0.7, SCREEN + 0.5, SCREEN + 1.15, 0, 0.72)


def bench(bm, x, y, length=2.6):
    """Two seats back to back along x."""
    x0, x1 = x - length / 2, x + length / 2
    box(bm, x0, x1, y - 0.5, y - 0.05, 0.42, 0.47)
    box(bm, x0, x1, y + 0.05, y + 0.5, 0.42, 0.47)
    box(bm, x0, x1, y - 0.05, y + 0.05, 0.3, 0.98)                             # the shared back
    for xe in (x0, x1 - 0.07, x - 0.035):
        box(bm, xe, xe + 0.07, y - 0.5, y + 0.5, 0, 0.42)                      # end frames and one in the middle
    for xe in (x0, x1 - 0.07):
        box(bm, xe, xe + 0.07, y - 0.5, y + 0.5, 0.6, 0.66)                    # armrests
        box(bm, xe, xe + 0.07, y - 0.5, y - 0.44, 0.47, 0.6)
        box(bm, xe, xe + 0.07, y + 0.44, y + 0.5, 0.47, 0.6)


def furniture(bm):
    with tagged(bm, 'wooden bench'):
        for x in (-5.4, -1.2, 3.0):
            bench(bm, x, -1.4)
    with tagged(bm, 'wooden writing desk'):
        for c in (-6.6, 2.2):                                                  # standing desks under two of the windows
            box(bm, c - 0.9, c + 0.9, -D + 0.07, -D + 0.62, 1.04, 1.1)
            box(bm, c - 0.9, c + 0.9, -D + 0.07, -D + 0.12, 1.1, 1.36)         # the rail at its back
            for x in (c - 0.86, c + 0.8):
                box(bm, x, x + 0.06, -D + 0.1, -D + 0.58, 0, 1.04)
            box(bm, c - 0.8, c + 0.8, -D + 0.3, -D + 0.36, 0.3, 0.36)          # the footrail between them
    with tagged(bm, 'cast iron radiator'):
        for c in (-2.2, 6.6):
            for k in range(12):
                x = c - 0.63 + k * 0.105
                box(bm, x, x + 0.06, -D + 0.1, -D + 0.24, 0.14, 0.82)
            pipe_x(bm, c - 0.7, c + 0.7, -D + 0.17, 0.2, 0.025, seg=6)
            pipe_x(bm, c - 0.7, c + 0.7, -D + 0.17, 0.76, 0.025, seg=6)
    with tagged(bm, 'wooden telephone booth'):
        for y0 in (1.75, 2.8):                                                 # two of them, on the east wall
            box(bm, W - 0.95, W, y0, y0 + 0.95, 0, 2.25)
            box(bm, W - 1.0, W, y0 - 0.03, y0 + 0.98, 2.25, 2.33)              # its top
            box(bm, W - 0.98, W - 0.95, y0 + 0.12, y0 + 0.83, 0.1, 2.05)       # the door's panel
    with tagged(bm, 'parcel trolley'):
        x0, x1, y0, y1 = 6.6, 8.0, -0.4, 0.5
        box(bm, x0, x1, y0, y1, 0.26, 0.32)
        for x in (x0 + 0.12, x1 - 0.12):
            for y in (y0 + 0.1, y1 - 0.1):
                cyl(bm, x, y, 0, 0.26, 0.07, seg=8)                            # castors
        for y in (y0, y1 - 0.04):
            box(bm, x1 - 0.04, x1, y, y + 0.04, 0.32, 1.1)                     # the push handle
        box(bm, x1 - 0.04, x1, y0, y1, 1.06, 1.1)
    with tagged(bm, 'cardboard parcel'):
        box(bm, 6.7, 7.3, -0.3, 0.2, 0.32, 0.72)                               # on the trolley
        box(bm, 7.32, 7.8, -0.25, 0.4, 0.32, 0.6)
        box(bm, 6.8, 7.25, -0.2, 0.15, 0.72, 0.98)
        box(bm, -10.4, -9.6, -5.4, -4.7, 0, 0.55)                              # a pile in the south-west corner
        box(bm, -9.5, -8.9, -5.5, -4.9, 0, 0.4)
        box(bm, -10.3, -9.7, -5.3, -4.8, 0.55, 0.9)
    with tagged(bm, 'brass queue rail'):
        for x0, x1 in ((-9.4, -3.4), (3.2, 9.4)):                              # in front of the counters
            n = 4
            for k in range(n):
                cyl(bm, x0 + (x1 - x0) * k / (n - 1), 2.5, 0, 0.98, 0.03, seg=8)
                cyl(bm, x0 + (x1 - x0) * k / (n - 1), 2.5, 0, 0.03, 0.12, seg=10)   # the post's foot
            pipe_x(bm, x0, x1, 2.5, 0.95, 0.02, seg=6)
    with tagged(bm, 'steel litter bin'):
        cyl(bm, 9.9, -1.9, 0, 0.72, 0.22, seg=12, r2=0.26)


def street(bm):
    """What shows through the windows: the upper floors of buildings on both sides."""
    # low and well back: the sun has to clear them to reach the hall's floor
    blocks = [(-36, -10, -44, -30, 10), (-8, 14, -46, -31, 12), (16, 38, -43, -30, 9),
              (-32, -4, 30, 44, 11), (-2, 30, 29, 42, 9)]
    with tagged(bm, 'building across the street'):
        for x0, x1, y0, y1, top in blocks:
            box(bm, x0, x1, y0, y1, -0.2, top)
            face = y1 if y1 < 0 else y0 - 0.3
            box(bm, x0, x1, face, face + 0.3, top - 0.7, top)                  # a cornice on the side that faces the hall


def group_of(f):
    """Texture-space share for a face: the hall gets it; the office half; the street a little; the unseen next to none."""
    c, n = f.calc_center_median(), f.normal
    name = LABELS[f.material_index]
    if name in BACKGROUND:
        to_hall = Vector((0, 0, 4)) - c
        return 'far' if n.dot(to_hall) > 0 and abs(n.z) < 0.5 and c.z > 2 else 'hidden'
    outside = abs(c.x) > W + T - 0.01 or abs(c.y) > D + T - 0.01 or c.z > H + 0.29 or c.z < -0.19
    if outside:
        return 'hidden'
    return 'back' if c.y > SCREEN + 0.16 and c.z < 4.2 else 'room'


SCALE = {'room': 1.0, 'back': 0.25, 'far': 0.12, 'hidden': 0.04}


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
    room = math.sqrt(share['room'] / area['room'])
    print(f'the hall gets {room * 4096:.0f} texels per metre on a 4096 px texture')


def main():
    out = sys.argv[sys.argv.index('--') + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bm = bmesh.new()
    hall(bm)
    counters(bm)
    furniture(bm)
    street(bm)
    # drop faces resting on the floor (and the buildings' feet): never visible, they'd only waste texture space
    bm.faces.ensure_lookup_table()
    drop = [f for f in bm.faces if f.normal.z < -0.99 and (abs(f.calc_center_median().z) < 0.02 or f.calc_center_median().z < -1)]
    bmesh.ops.delete(bm, geom=drop, context='FACES')
    for f in bm.faces:
        f.smooth = False
    mesh = bpy.data.meshes.new('posthall')
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new('posthall', mesh)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    for name in LABELS:
        obj.data.materials.append(bpy.data.materials.new(name))
    unwrap(obj)
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True)
    print('DONE', out, len(mesh.polygons), 'faces', round(sum(p.area for p in mesh.polygons)), 'm2', len(LABELS), 'parts')


main()
