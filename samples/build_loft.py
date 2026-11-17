"""Build the loft blockout: the Hall sample with more to it, and the buildings across the street outside its windows.

Run: blender -b --factory-startup -P samples/build_loft.py -- samples/loft.glb

The same room as samples/hall.glb (20 x 10 m, 6 m high, six columns, three girders, a mezzanine with stairs), with
what a loft has and the Hall only hinted at: walls with real window openings and steel frames, I-section beams and
joists under the ceiling, a duct and a sprinkler pipe, stairs with treads and rails, a kitchen, and furniture.
The loft is some floors up, so outside there is no ground: only the neighbours, two of them low enough to show a
roof with a water tower on it.

Untextured, in metres, Blender's axes (x east, y north, z up). Every part is labelled; labels become glTF
materials, which the texturing prompts read. Texture space goes to the room; the neighbours get a fraction of it and
faces nobody can see next to none.
"""
import math
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

W, D, H, T = 10.0, 5.0, 6.0, 0.3   # half length, half width, height of the room; wall thickness
LABELS = []
BACKGROUND = {'building across the street', 'rooftop water tower'}


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


def wall_along_x(bm, y0, y1, openings):
    """A wall from x = -(W+T) to W+T with openings (x0, x1, z0, z1): piers between them, wall under and over each."""
    x = -(W + T)
    for o in sorted(openings):
        box(bm, x, o[0], y0, y1, 0, H)
        if o[2] > 0:
            box(bm, o[0], o[1], y0, y1, 0, o[2])
        box(bm, o[0], o[1], y0, y1, o[3], H)
        x = o[1]
    box(bm, x, W + T, y0, y1, 0, H)


def wall_along_y(bm, x0, x1, openings):
    """An end wall from y = -D to D with openings (y0, y1, z0, z1)."""
    y = -D
    for o in sorted(openings):
        box(bm, x0, x1, y, o[0], 0, H)
        if o[2] > 0:
            box(bm, x0, x1, o[0], o[1], 0, o[2])
        box(bm, x0, x1, o[0], o[1], o[3], H)
        y = o[1]
    box(bm, x0, x1, y, D, 0, H)


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


def i_beam_y(bm, x, y0, y1, z0, z1, width):
    """An I-section beam running along y."""
    t = 0.05
    box(bm, x - width / 2, x + width / 2, y0, y1, z0, z0 + t)
    box(bm, x - width / 2, x + width / 2, y0, y1, z1 - t, z1)
    box(bm, x - 0.02, x + 0.02, y0, y1, z0 + t, z1 - t)


def i_beam_x(bm, y, x0, x1, z0, z1, width):
    """An I-section beam running along x."""
    t = 0.05
    box(bm, x0, x1, y - width / 2, y + width / 2, z0, z0 + t)
    box(bm, x0, x1, y - width / 2, y + width / 2, z1 - t, z1)
    box(bm, x0, x1, y - 0.02, y + 0.02, z0 + t, z1 - t)


NORTH = [(c - 1.2, c + 1.2, 1.0, 4.2) for c in (-8, -4, 0, 4)]   # windows in the north wall
SOUTH = [(c - 1.2, c + 1.2, 1.0, 4.2) for c in (-6, -2, 2, 6)]
WEST = [(-1.6, 1.6, 1.0, 4.2)]
DOOR = (-1.0, 1.0, 0.0, 2.4)                                      # in the east wall


def room(bm):
    with tagged(bm, 'concrete floor'):
        box(bm, -(W + T), W + T, -(D + T), D + T, -0.2, 0)
    with tagged(bm, 'ceiling'):
        box(bm, -(W + T), W + T, -(D + T), D + T, H, H + 0.3)
    with tagged(bm, 'brick wall'):
        wall_along_x(bm, D, D + T, NORTH)
        wall_along_x(bm, -(D + T), -D, SOUTH)
        wall_along_y(bm, -(W + T), -W, WEST)
        wall_along_y(bm, W, W + T, [DOOR])
    with tagged(bm, 'steel window frame'):
        for o in NORTH:
            window_frame(bm, 'x', *o, D + 0.15)
        for o in SOUTH:
            window_frame(bm, 'x', *o, -(D + 0.15))
        for o in WEST:
            window_frame(bm, 'y', *o, -(W + 0.15), cols=4)
    with tagged(bm, 'stone window sill'):
        for o in NORTH:
            box(bm, o[0] - 0.06, o[1] + 0.06, D - 0.07, D + 0.11, o[2] - 0.02, o[2] + 0.04)
        for o in SOUTH:
            box(bm, o[0] - 0.06, o[1] + 0.06, -(D + 0.11), -(D - 0.07), o[2] - 0.02, o[2] + 0.04)
        for o in WEST:
            box(bm, -(W + 0.11), -(W - 0.07), o[0] - 0.06, o[1] + 0.06, o[2] - 0.02, o[2] + 0.04)
    with tagged(bm, 'steel door'):
        y0, y1, _, z1 = DOOR
        box(bm, W + 0.16, W + 0.22, y0, y1, 0, z1)                # the double door, set back in its opening
        box(bm, W + 0.13, W + 0.16, -0.02, 0.02, 0, z1)           # where the two leaves meet
        for y in (y0 + 0.5, y1 - 0.5):
            box(bm, W + 0.13, W + 0.16, y - 0.05, y + 0.05, 1.0, 1.25)   # pull handles
    with tagged(bm, 'steel door frame'):
        y0, y1, _, z1 = DOOR
        box(bm, W - 0.03, W + 0.05, y0 - 0.1, y0, 0, z1 + 0.1)
        box(bm, W - 0.03, W + 0.05, y1, y1 + 0.1, 0, z1 + 0.1)
        box(bm, W - 0.03, W + 0.05, y0, y1, z1, z1 + 0.1)


def structure(bm):
    with tagged(bm, 'steel column'):
        for x in (-5, 0, 5):
            for y in (-2, 2):
                box(bm, x - 0.15, x + 0.15, y - 0.15, y + 0.15, 0.04, 5.4)
                box(bm, x - 0.26, x + 0.26, y - 0.26, y + 0.26, 0, 0.04)        # base plate
                box(bm, x - 0.22, x + 0.22, y - 0.22, y + 0.22, 5.36, 5.4)      # cap plate under the girder
    with tagged(bm, 'steel beam'):
        for x in (-5, 0, 5):
            i_beam_y(bm, x, -D, D, 5.4, 6.0, 0.3)                              # girders across the room, on the columns
        for y in (-2, 2):
            for x0, x1 in ((-W, -5.15), (-4.85, -0.15), (0.15, 4.85), (5.15, W)):
                i_beam_x(bm, y, x0, x1, 5.6, 6.0, 0.2)                         # beams along it, between the girders
    with tagged(bm, 'ceiling joist'):
        x = -W + 1.25
        while x < W - 0.1:
            if abs(x % 5) > 0.1 and abs(x % 5 - 5) > 0.1:                      # not where a girder is
                for y0, y1 in ((-D, -2.1), (-1.9, 1.9), (2.1, D)):
                    box(bm, x - 0.06, x + 0.06, y0, y1, 5.78, 6.0)
            x += 1.25
    with tagged(bm, 'metal air duct'):
        box(bm, -9.6, 5.6, 3.0, 3.5, 4.9, 5.25)
        for x in (-7.5, -2.5, 2.5):
            box(bm, x - 0.25, x + 0.25, 3.08, 3.42, 4.86, 4.9)                 # vents under it
        for x in (-8.5, -3.5, 1.5, 4.8):
            box(bm, x - 0.02, x + 0.02, 2.97, 3.0, 4.9, 5.78)                  # hanger straps up to the joists
            box(bm, x - 0.02, x + 0.02, 3.5, 3.53, 4.9, 5.78)
    with tagged(bm, 'sprinkler pipe'):
        pipe_x(bm, -9.8, 9.8, -3.4, 5.3, 0.045)
        for x in (-7.5, -2.5, 2.5, 7.5):
            cyl(bm, x, -3.4, 5.12, 0.14, 0.03, seg=6)                          # sprinkler heads


def mezzanine(bm):
    with tagged(bm, 'mezzanine floor'):
        box(bm, 6.5, W, 2.5, D, 2.8, 3.0)
    with tagged(bm, 'steel beam'):
        box(bm, 6.5, W, 2.5, 2.6, 2.56, 2.8)                                   # edge beams under the deck
        box(bm, 6.5, 6.6, 2.6, D, 2.56, 2.8)
    with tagged(bm, 'steel column'):
        box(bm, 6.5, 6.62, 2.5, 2.62, 0, 2.56)                                 # the post at its free corner
    with tagged(bm, 'steel railing'):
        for x in (6.52, 7.68, 8.84, 9.94):                                     # along the front edge
            box(bm, x, x + 0.04, 2.52, 2.56, 3.0, 4.0)
        for z in (3.5, 3.96):
            box(bm, 6.52, 9.98, 2.52, 2.56, z, z + 0.04)
        for y in (3.86, 4.92):                                                 # along the side, past the stair head
            box(bm, 6.52, 6.56, y, y + 0.04, 3.0, 4.0)
        for z in (3.5, 3.96):
            box(bm, 6.52, 6.56, 3.86, 4.96, z, z + 0.04)
    with tagged(bm, 'steel stairs'):
        n, x0, x1, y0, y1, top = 14, 3.5, 6.5, 2.6, 3.8, 2.8
        run, rise = (x1 - x0) / n, top / n
        for i in range(1, n):
            box(bm, x0 + run * (i - 1), x0 + run * i + 0.03, y0 + 0.05, y1 - 0.05, rise * i - 0.04, rise * i)
        for y in (y0, y1 - 0.05):                                              # stringers under each side
            slanted(bm, (x0, y, -0.12), (x1 - x0, 0, top), (0, 0.05, 0), (0, 0, 0.26))
    with tagged(bm, 'steel railing'):
        x0, x1, top = 3.5, 6.5, 2.8
        for y in (2.6, 3.76):                                                  # a handrail up each side of the stairs
            slanted(bm, (x0, y, 0.95), (x1 - x0, 0, top), (0, 0.04, 0), (0, 0, 0.05))
            for k in range(4):
                x = x0 + 0.1 + (x1 - x0 - 0.2) * k / 3
                z = top * (x - x0) / (x1 - x0)
                box(bm, x - 0.02, x + 0.02, y, y + 0.04, z, z + 0.97)
    with tagged(bm, 'bed'):
        box(bm, 7.7, 9.8, 3.1, 4.8, 3.0, 3.28)                                 # platform
        box(bm, 7.76, 9.7, 3.16, 4.74, 3.28, 3.5)                              # mattress
        box(bm, 9.7, 9.86, 3.1, 4.8, 3.0, 3.95)                                # headboard, against the end wall
        for y in (3.3, 4.1):
            box(bm, 9.2, 9.66, y, y + 0.5, 3.5, 3.6)                           # pillows


def furniture(bm):
    with tagged(bm, 'wooden dining table'):
        box(bm, -4.1, -1.9, 2.6, 3.6, 0.72, 0.78)
        for x in (-3.85, -2.23):
            box(bm, x, x + 0.08, 2.75, 3.45, 0, 0.72)                          # a slab leg at each end
    with tagged(bm, 'wooden bench'):
        for y in (2.05, 3.8):
            box(bm, -3.95, -2.05, y, y + 0.35, 0.42, 0.47)
            for x in (-3.8, -2.28):
                box(bm, x, x + 0.08, y + 0.03, y + 0.32, 0, 0.42)
    with tagged(bm, 'rug'):
        box(bm, -8.5, -5.9, -1.6, 1.6, 0, 0.015)
    with tagged(bm, 'sofa'):
        box(bm, -9.6, -8.7, -1.2, 1.2, 0, 0.42)                                # base, under the west window
        box(bm, -9.6, -9.38, -1.2, 1.2, 0.42, 0.82)                            # back
        for y0, y1 in ((-1.42, -1.2), (1.2, 1.42)):
            box(bm, -9.6, -8.7, y0, y1, 0, 0.62)                               # arms
        for y0, y1 in ((-1.17, -0.02), (0.02, 1.17)):
            box(bm, -9.36, -8.72, y0, y1, 0.42, 0.54)                          # seat cushions
    with tagged(bm, 'coffee table'):
        box(bm, -7.7, -6.9, -0.6, 0.6, 0.34, 0.38)
        for y in (-0.5, 0.44):
            box(bm, -7.6, -7.0, y, y + 0.06, 0, 0.34)
    with tagged(bm, 'bookshelf'):
        x0, x1, y0, y1, top = -4.6, -3.4, -D, -(D - 0.32), 2.2                 # on the south wall, between two windows
        box(bm, x0, x0 + 0.04, y0, y1, 0, top)
        box(bm, x1 - 0.04, x1, y0, y1, 0, top)
        box(bm, x0 + 0.04, x1 - 0.04, y0, y0 + 0.02, 0, top)                   # back
        for k in range(6):
            z = k * (top - 0.04) / 5
            box(bm, x0 + 0.04, x1 - 0.04, y0 + 0.02, y1, z, z + 0.04)
    with tagged(bm, 'kitchen cabinets'):
        box(bm, 4.0, 9.7, -D, -(D - 0.6), 0.1, 0.86)                           # along the south wall, under two windows
        box(bm, 4.05, 9.65, -D, -(D - 0.54), 0, 0.1)                           # the recessed kick under them
        box(bm, 9.1, 9.7, -D, -(D - 0.6), 0.9, 2.2)                            # the tall unit at the end
        box(bm, 5.7, 7.9, -3.2, -2.3, 0.1, 0.86)                               # the island
        box(bm, 5.76, 7.84, -3.14, -2.36, 0, 0.1)
    with tagged(bm, 'kitchen countertop'):
        box(bm, 3.97, 9.1, -D, -(D - 0.63), 0.86, 0.9)
        box(bm, 5.6, 8.0, -3.3, -2.2, 0.86, 0.9)
    with tagged(bm, 'wooden crate'):
        box(bm, -9.0, -7.8, -3.9, -2.7, 0, 1.2)                                # the stack the Hall had, in the same corner
        box(bm, -8.5, -7.3, -3.85, -2.75, 1.2, 2.3)
        box(bm, -7.7, -6.6, -3.8, -2.7, 0, 1.1)
    with tagged(bm, 'cast iron radiator'):
        for c in (-4, 0):                                                      # under two of the north windows
            for k in range(10):
                x = c - 0.5 + k * 0.105
                box(bm, x, x + 0.06, D - 0.2, D - 0.06, 0.14, 0.78)
            pipe_x(bm, c - 0.56, c + 0.56, D - 0.13, 0.2, 0.025, seg=6)
            pipe_x(bm, c - 0.56, c + 0.56, D - 0.13, 0.72, 0.025, seg=6)


def water_tower(bm, x, y, z):
    with tagged(bm, 'rooftop water tower'):
        for dx in (-1.1, 1.1):
            for dy in (-1.1, 1.1):
                box(bm, x + dx - 0.1, x + dx + 0.1, y + dy - 0.1, y + dy + 0.1, z, z + 2.6)
        box(bm, x - 1.5, x + 1.5, y - 1.5, y + 1.5, z + 2.6, z + 2.8)
        cyl(bm, x, y, z + 2.8, 3.4, 1.6)
        cyl(bm, x, y, z + 6.2, 1.1, 1.75, r2=0.05)


def neighbours(bm):
    """The buildings across the street on three sides. The street is far below: nothing here can be stood on from the loft."""
    low = -14.0
    blocks = [   # x0, x1, y0, y1, top, water tower?
        (-32, -15, 17, 30, 16, False), (-14, -2, 18, 30, 3.4, True), (-1, 12, 17, 30, 24, False), (13, 30, 19, 32, 12, False),
        (-30, -10, -30, -17, 20, False), (-9, 6, -31, -18, 2.6, True), (7, 28, -30, -17, 28, False),
        (-40, -25, -12, 12, 14, False),
    ]
    with tagged(bm, 'building across the street'):
        for x0, x1, y0, y1, top, _ in blocks:
            box(bm, x0, x1, y0, y1, low, top)
            # a parapet round the roof and a cornice under it on the side that faces the loft
            p = 0.35
            box(bm, x0, x1, y0, y0 + p, top, top + 0.9)
            box(bm, x0, x1, y1 - p, y1, top, top + 0.9)
            box(bm, x0, x0 + p, y0 + p, y1 - p, top, top + 0.9)
            box(bm, x1 - p, x1, y0 + p, y1 - p, top, top + 0.9)
            if y0 > 0:
                box(bm, x0, x1, y0 - 0.3, y0, top - 0.7, top)
            elif y1 < 0:
                box(bm, x0, x1, y1, y1 + 0.3, top - 0.7, top)
            else:
                box(bm, x1, x1 + 0.3, y0, y1, top - 0.7, top)
    for x0, x1, y0, y1, top, tower in blocks:
        if tower:
            water_tower(bm, (x0 + x1) / 2 + 1.5, y0 + 5 if y0 > 0 else y1 - 5, top)
            with tagged(bm, 'building across the street'):
                bx = x0 + 2.0
                by = (y0 + 6.5) if y0 > 0 else (y1 - 9.5)
                box(bm, bx, bx + 3, by, by + 3, top, top + 2.6)                # the stair bulkhead on the roof


def group_of(f):
    """Texture-space share for a face: the room gets it; the neighbours a little; what nobody can see next to none."""
    c, n = f.calc_center_median(), f.normal
    name = LABELS[f.material_index]
    if name in BACKGROUND:
        to_loft = Vector((0, 0, 2)) - c
        return 'far' if n.dot(to_loft) > 0 and (abs(n.z) < 0.5 or c.z < 8) else 'hidden'
    outside = abs(c.x) > W + T - 0.01 or abs(c.y) > D + T - 0.01 or c.z > H + 0.29 or c.z < -0.19
    return 'hidden' if outside else 'room'


SCALE = {'room': 1.0, 'far': 0.14, 'hidden': 0.04}


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
    print(f'the room gets {room * 4096:.0f} texels per metre on a 4096 px texture')


def main():
    out = sys.argv[sys.argv.index('--') + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bm = bmesh.new()
    room(bm)
    structure(bm)
    mezzanine(bm)
    furniture(bm)
    neighbours(bm)
    # drop faces resting on the floor (and the buildings' feet): never visible, they'd only waste texture space
    bm.faces.ensure_lookup_table()
    drop = [f for f in bm.faces if f.normal.z < -0.99 and (abs(f.calc_center_median().z) < 0.02 or f.calc_center_median().z < -1)]
    bmesh.ops.delete(bm, geom=drop, context='FACES')
    for f in bm.faces:
        f.smooth = False
    mesh = bpy.data.meshes.new('loft')
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new('loft', mesh)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    for name in LABELS:
        obj.data.materials.append(bpy.data.materials.new(name))
    unwrap(obj)
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True)
    print('DONE', out, len(mesh.polygons), 'faces', round(sum(p.area for p in mesh.polygons)), 'm2', len(LABELS), 'parts')


main()
