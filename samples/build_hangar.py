"""Build the hangar blockout: the machine hangar of a police base on reclaimed land, after the hangars of late-1980s
mecha anime (the look file, samples/hangar.look.json, paints it from stills of one).

Run: blender -b --factory-startup -P samples/build_hangar.py -- samples/hangar.glb

A steel hall 26 x 15 m and 10 m high: portal columns, roof trusses, clerestory windows, an overhead crane, and at
the east end a great door, its shutter half up. Against the north wall a white police patrol robot stands
in a maintenance gantry with decks at two levels, hoses hanging to it from the roof; beside it an orange
construction robot under the crane. Along the south wall a transport truck, a generator, drums, crates and tool
cabinets. The west end has a mezzanine with the unit's office behind a glazed partition (desks, lockers, shelves of
binders) and, under it, a control corner with consoles and wall monitors.

Outside, the hall is one block among others on a platform of cast concrete standing in the sea: the door opens
between two buttress piers under a deep lintel onto an apron deck 22 m deep, walled in north and south by stepped
blocks 9 to 15 m high with buttress ribs up their faces, and closed to the east by a parapet with mooring bollards.
Across the water stand more platforms of the same kind, with blocks up to 24 m on them.

The robots are tapered armour over dark joints: the police machine with a visor helmet, two antennas, a cockpit
hatch, shoulder light bars and a riot shield; the construction machines with a cab, a roll bar and claws. One of
the orange ones stands out on the apron among containers, pipes and a covered load.

Untextured, in metres, Blender's axes (x east, y north, z up). Every part is labelled; labels become glTF
materials, which the texturing prompts read. Texture space goes to the hall; what faces the apron gets about half
as much per metre, the platforms across the water a fraction, and faces nobody can see next to none.

Where players can be, the hall and the apron (glTF axes, for --area): -13,0,-16,35.35,10,16
"""
import math
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

W, D, H, T = 13.0, 7.5, 10.0, 0.35   # half length, half width, height of the hall; wall thickness
MX, MZ = -7.5, 3.5                   # the mezzanine's front edge and the top of its deck
OY, OH = -5.6, 2.9                   # the office's south wall, and its height above the deck
FRAMES = (-12.7, -7.8, -2.6, 2.6, 7.8, 12.7)   # where the portal frames stand
BAYS = (-10.4, -5.2, 0.0, 5.2, 10.4)
LABELS = []
E0, AX, AY = W + T, W + T + 22.0, 16.0   # outside: the hall's east face, the apron's east edge and its half width
SEA = -13.0                              # the water, below the deck
YARD = {'massive cast concrete blocks', 'concrete buttress ribs', 'concrete apron deck', 'concrete parapet',
        'concrete barrier blocks', 'steel mooring bollards', 'concrete number panels', 'steel cargo containers',
        'stacked steel pipes', 'floodlight mast'}
BACKGROUND = {'sea water', 'concrete platforms across the water'}


def box(bm, x0, x1, y0, y1, z0, z1):
    c = Vector(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))
    bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation(c) @ Matrix.Diagonal((x1 - x0, y1 - y0, z1 - z0, 1)))


def slanted(bm, origin, ex, ey, ez):
    """A box with edges ex, ey, ez from `origin` (they need not be square to each other): stringers, rails, braces."""
    o, a, b, c = Vector(origin), Vector(ex), Vector(ey), Vector(ez)
    m = Matrix.Identity(4)
    for i in range(3):
        m[i][0], m[i][1], m[i][2] = a[i], b[i], c[i]
        m[i][3] = o[i] + (a[i] + b[i] + c[i]) / 2
    bmesh.ops.create_cube(bm, size=1.0, matrix=m)


def prism(bm, x0, x1, y0, y1, z0, z1, top=(1.0, 1.0), shift=(0.0, 0.0)):
    """A box whose top face is scaled by `top` (x, y) about its middle and moved by `shift` metres: armour plates,
    cabs, anything with a slope to it."""
    for v in bmesh.ops.create_cube(bm, size=1.0)['verts']:
        x, y, z = v.co
        up = z > 0
        v.co = Vector(((x0 + x1) / 2 + x * (x1 - x0) * (top[0] if up else 1) + (shift[0] if up else 0),
                       (y0 + y1) / 2 + y * (y1 - y0) * (top[1] if up else 1) + (shift[1] if up else 0),
                       (z0 + z1) / 2 + z * (z1 - z0)))


def cyl(bm, x, y, z0, h, r, seg=16, r2=None):
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r, radius2=r if r2 is None else r2, depth=h,
                          matrix=Matrix.Translation((x, y, z0 + h / 2)))


def rod(bm, p, q, r, seg=8):
    """A round bar from p to q: pipes, hoses in straight pieces, axles."""
    p, q = Vector(p), Vector(q)
    d = q - p
    rot = Vector((0, 0, 1)).rotation_difference(d.normalized()).to_matrix().to_4x4()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r, radius2=r, depth=d.length,
                          matrix=Matrix.Translation((p + q) / 2) @ rot)


def hose(bm, p, q, sag, r, pieces=7):
    """A hose hanging from p to q, `sag` metres below the straight line at its middle."""
    p, q = Vector(p), Vector(q)
    pts = []
    for k in range(pieces + 1):
        t = k / pieces
        pts.append(p.lerp(q, t) - Vector((0, 0, sag * 4 * t * (1 - t))))
    for a, b in zip(pts, pts[1:]):
        rod(bm, a - (b - a).normalized() * r * 0.4, b + (b - a).normalized() * r * 0.4, r)


class tagged:
    """Label every face created inside the block.

    By the faces themselves, not by their place in the face list: making a cylinder frees faces along the way, and
    Blender hands those slots to the faces made next, so "everything after where the list ended" misses some of a
    block's faces and leaves them to be claimed by the block after it."""

    def __init__(self, bm, name):
        self.bm, self.name = bm, name

    def __enter__(self):
        if self.name not in LABELS:
            LABELS.append(self.name)
        self.before = set(self.bm.faces)
        return self

    def __exit__(self, *exc):
        k = LABELS.index(self.name)
        for f in self.bm.faces:
            if f not in self.before:
                f.material_index = k


def wall(bm, along, a0, a1, p0, p1, z0, top, openings=()):
    """A wall running along x or y from a0 to a1, p0 to p1 across, z0 to top, with openings (a, b, za, zb)."""

    def piece(s0, s1, q0, q1):
        if s1 - s0 < 1e-4 or q1 - q0 < 1e-4:
            return
        if along == 'x':
            box(bm, s0, s1, p0, p1, q0, q1)
        else:
            box(bm, p0, p1, s0, s1, q0, q1)

    a = a0
    for o in sorted(openings):
        piece(a, o[0], z0, top)
        piece(o[0], o[1], z0, o[2])
        piece(o[0], o[1], o[3], top)
        a = o[1]
    piece(a, a1, z0, top)


def window_frame(bm, along, a0, a1, z0, z1, at, cols=3, rows=2):
    """A steel window in an opening: a frame and a grid of glazing bars, no glass (the view is the point)."""
    f, m, d = 0.07, 0.04, 0.04   # frame and glazing bar widths, half depth

    def bar(s0, s1, q0, q1):
        if along == 'x':
            box(bm, s0, s1, at - d, at + d, q0, q1)
        else:
            box(bm, at - d, at + d, s0, s1, q0, q1)

    bar(a0, a0 + f, z0, z1)
    bar(a1 - f, a1, z0, z1)
    bar(a0 + f, a1 - f, z0, z0 + f)
    bar(a0 + f, a1 - f, z1 - f, z1)
    for k in range(1, cols):
        c = a0 + (a1 - a0) * k / cols
        bar(c - m / 2, c + m / 2, z0 + f, z1 - f)
    edges = [a0 + f] + [a0 + (a1 - a0) * j / cols for j in range(1, cols)] + [a1 - f]
    for k in range(1, rows):
        c = z0 + (z1 - z0) * k / rows
        for j in range(cols):                                                  # between the uprights, so no bar runs through another
            bar(edges[j] + (m / 2 if j else 0), edges[j + 1] - (m / 2 if j < cols - 1 else 0), c - m / 2, c + m / 2)


def stairs(bm, along, a0, a1, p0, p1, z0, z1, n, label='steel stairs', rail='yellow safety railings'):
    """Open steel stairs climbing from a0 to a1 along x or y, between p0 and p1 across, with a handrail each side."""
    run, rise = (a1 - a0) / n, (z1 - z0) / n
    sgn = 1 if a1 > a0 else -1

    def at(s0, s1, q0, q1, zz0, zz1):
        s0, s1 = min(s0, s1), max(s0, s1)
        if along == 'x':
            box(bm, s0, s1, q0, q1, zz0, zz1)
        else:
            box(bm, q0, q1, s0, s1, zz0, zz1)

    def lean(s, q, z, ds, dq, dz, h):
        if along == 'x':
            slanted(bm, (s, q, z), (ds, 0, dz), (0, dq, 0), (0, 0, h))
        else:
            slanted(bm, (q, s, z), (0, ds, dz), (dq, 0, 0), (0, 0, h))

    with tagged(bm, label):
        for i in range(1, n):
            at(a0 + run * (i - 1), a0 + run * i + sgn * 0.03, p0 + 0.05, p1 - 0.05, z0 + rise * i - 0.04, z0 + rise * i)
        for q in (p0, p1 - 0.05):                                              # stringers under each side
            lean(a0, q, z0 - 0.12, a1 - a0, 0.05, z1 - z0, 0.26)
    with tagged(bm, rail):
        for q in (p0, p1 - 0.04):
            lean(a0, q, z0 + 0.95, a1 - a0, 0.04, z1 - z0, 0.05)
            for k in range(5):
                s = a0 + sgn * 0.1 + (a1 - a0 - sgn * 0.2) * k / 4
                z = z0 + (z1 - z0) * (s - a0) / (a1 - a0)
                at(s - 0.02, s + 0.02, q, q + 0.04, z, z + 0.97)


def railing(bm, along, a0, a1, at, z, label='yellow safety railings'):
    """A two-bar railing a metre high along x or y, standing on a deck at height z."""
    with tagged(bm, label):
        n = max(1, round((a1 - a0) / 1.3))
        for k in range(n + 1):
            s = a0 + (a1 - a0 - 0.05) * k / n
            if along == 'x':
                box(bm, s, s + 0.05, at - 0.025, at + 0.025, z, z + 1.0)
            else:
                box(bm, at - 0.025, at + 0.025, s, s + 0.05, z, z + 1.0)
        for zz in (z + 0.5, z + 0.96):
            if along == 'x':
                box(bm, a0, a1, at - 0.025, at + 0.025, zz, zz + 0.05)
            else:
                box(bm, at - 0.025, at + 0.025, a0, a1, zz, zz + 0.05)


WINDOWS = [(c - 1.9, c + 1.9, 6.4, 8.4) for c in BAYS]     # clerestory windows in both long walls
DOOR = (-5.0, 5.0, 0.0, 7.4)                                # the hangar door, in the east wall


def hall(bm):
    with tagged(bm, 'painted concrete hangar floor'):
        box(bm, -(W + T), W + T, -(D + T), D + T, -0.2, 0)
    with tagged(bm, 'ribbed steel roof deck'):
        box(bm, -(W + T), W + T, -(D + T), D + T, H, H + 0.3)
    with tagged(bm, 'ribbed steel wall panels'):
        wall(bm, 'x', -(W + T), W + T, D, D + T, 0, H, WINDOWS)
        wall(bm, 'x', -(W + T), W + T, -(D + T), -D, 0, H, WINDOWS)
        wall(bm, 'y', -D, D, -(W + T), -W, 0, H)
        wall(bm, 'y', -D, D, W, W + T, 0, H, [DOOR])
    with tagged(bm, 'concrete wall plinth'):
        for s in (1, -1):
            box(bm, MX, W, s * D - (0.12 if s > 0 else 0), s * D + (0.12 if s < 0 else 0), 0, 1.1)
        for y0, y1 in ((-D, DOOR[0] - 0.3), (DOOR[1] + 0.3, D)):
            box(bm, W - 0.12, W, y0, y1, 0, 1.1)
    with tagged(bm, 'steel-framed clerestory windows'):
        for s in (1, -1):
            for o in WINDOWS:
                window_frame(bm, 'x', o[0], o[1], o[2], o[3], s * (D + T / 2), cols=4, rows=2)
    with tagged(bm, 'steel roller shutter door'):
        box(bm, W + 0.1, W + 0.2, DOOR[0], DOOR[1], 5.2, DOOR[3])              # the curtain, half up
        box(bm, W + 0.05, W + 0.3, DOOR[0], DOOR[1], 5.05, 5.2)                # its bottom bar
        box(bm, W - 0.25, W + 0.3, DOOR[0] - 0.2, DOOR[1] + 0.2, DOOR[3], DOOR[3] + 0.7)   # the drum housing over the opening
        for y in (DOOR[0] - 0.2, DOOR[1]):
            box(bm, W - 0.08, W + 0.3, y, y + 0.2, 0, DOOR[3])                 # guide rails


def structure(bm):
    with tagged(bm, 'steel portal columns'):
        for x in FRAMES:
            for s in (1, -1):
                y = s * (D - 0.22)
                box(bm, x - 0.16, x + 0.16, y - 0.2, y - 0.17, 0, 8.9)         # an I-section: two flanges and a web
                box(bm, x - 0.16, x + 0.16, y + 0.17, y + 0.2, 0, 8.9)
                box(bm, x - 0.015, x + 0.015, y - 0.17, y + 0.17, 0, 8.9)
                box(bm, x - 0.2, x + 0.2, y - 0.24, y + 0.24, 0, 0.04)         # base plate
    with tagged(bm, 'steel roof trusses'):
        n = 6
        for x in FRAMES:
            box(bm, x - 0.08, x + 0.08, -D, D, 8.9, 9.05)                      # bottom chord
            box(bm, x - 0.08, x + 0.08, -D, D, 9.82, 9.95)                     # top chord
            for k in range(n + 1):
                y = -D + 2 * D * k / n
                yy = min(max(y, -D + 0.04), D - 0.04)
                box(bm, x - 0.05, x + 0.05, yy - 0.04, yy + 0.04, 9.05, 9.82)  # posts
            for k in range(n):
                y0, y1 = -D + 2 * D * k / n + 0.04, -D + 2 * D * (k + 1) / n - 0.04
                if k % 2:
                    y0, y1 = y1, y0
                slanted(bm, (x - 0.04, y0, 9.05), (0.08, 0, 0), (0, y1 - y0, 0.69), (0, 0, 0.08))   # diagonals
        for y in (-6.0, -3.0, 0.0, 3.0, 6.0):                                  # purlins over the trusses
            box(bm, -W, W, y - 0.05, y + 0.05, 9.95, 10.0)
    with tagged(bm, 'crane rail beams'):
        for s in (1, -1):
            box(bm, -W, W, s * (D - 0.42) - 0.15, s * (D - 0.42) + 0.15, 7.75, 8.1)
            for x in FRAMES:                                                   # brackets off the columns
                box(bm, x - 0.12, x + 0.12, s * (D - 0.3) - 0.28, s * (D - 0.3) + 0.28, 7.5, 7.75)
    with tagged(bm, 'yellow overhead crane'):
        cx, cy = 5.5, 1.6
        for x in (cx - 0.75, cx + 0.45):
            box(bm, x, x + 0.3, -(D - 0.15), D - 0.15, 8.1, 8.75)              # the bridge: two girders
        for s in (1, -1):
            box(bm, cx - 1.1, cx + 1.1, s * (D - 0.42) - 0.2, s * (D - 0.42) + 0.2, 8.1, 8.45)   # end carriages
        box(bm, cx - 0.7, cx + 0.7, cy - 0.6, cy + 0.6, 8.3, 8.86)             # the trolley
        cyl(bm, cx, cy, 6.6, 1.7, 0.035, seg=6)                                # cable
        box(bm, cx - 0.2, cx + 0.2, cy - 0.12, cy + 0.12, 6.2, 6.6)            # hook block
        box(bm, cx - 0.05, cx + 0.05, cy - 0.05, cy + 0.05, 5.85, 6.2)
        box(bm, cx - 0.16, cx + 0.16, cy - 0.05, cy + 0.05, 5.75, 5.85)        # hook
    with tagged(bm, 'ventilation duct'):
        box(bm, MX + 0.6, W - 0.6, -(D - 0.75), -(D - 1.45), 6.9, 7.45)
        for x in (-4.0, 1.0, 6.0, 10.5):
            box(bm, x - 0.3, x + 0.3, -(D - 1.48), -(D - 1.45), 7.0, 7.35)     # grilles on its face
        for x in (-6.0, -1.0, 4.0, 9.0):
            box(bm, x - 0.02, x + 0.02, -(D - 1.1) - 0.02, -(D - 1.1) + 0.02, 7.45, 8.9)   # hangers
    with tagged(bm, 'pipe runs'):
        for z, r in ((5.6, 0.07), (5.85, 0.05), (6.05, 0.035)):
            rod(bm, (MX + 0.2, D - 0.5, z), (W - 0.3, D - 0.5, z), r)
        for x in FRAMES[2:5]:
            box(bm, x + 0.25, x + 0.29, D - 0.58, D - 0.12, 5.45, 6.15)        # brackets
        for z, r in ((1.7, 0.05), (1.95, 0.035)):
            rod(bm, (MX + 0.4, -(D - 0.2), z), (W - 0.3, -(D - 0.2), z), r)
    with tagged(bm, 'hanging hangar lamps'):
        for x in (-5.2, 0.0, 5.2, 10.4):
            for y in (-3.6, 3.6) if x != 5.2 else (-3.6,):
                cyl(bm, x, y, 8.45, 0.45, 0.03, seg=6)                         # rod
                cyl(bm, x, y, 8.1, 0.35, 0.34, seg=12, r2=0.12)                # shade


def robot(bm, ox, oy, s, armour, patrol=False, yaw=0.0):
    """A humanoid work machine ("labor"), 8 m tall at s = 1, standing at (ox, oy). It faces south (-y) before `yaw`.

    Armour is tapered plate over dark joints: flared lower legs, a narrow waist, a chest that widens to the
    shoulders, big shoulder pads. `patrol` makes it the police machine: a helmet head with a visor and two antennas,
    a cockpit hatch on the chest, a light bar on each shoulder and a riot shield on the left forearm. Without it,
    it is a construction machine: a cab for a head with a roll bar, heavier forearms ending in claws.

    The whole machine carries one label, joints, visor and lights included: it is one object, and the prop pass
    (which paints a part from cameras round it) can then paint it as one."""
    frame = armour
    bm.verts.ensure_lookup_table()
    first = len(bm.verts)

    def P(x0, x1, y0, y1, z0, z1, top=(1.0, 1.0), shift=(0.0, 0.0)):
        prism(bm, ox + x0 * s, ox + x1 * s, oy + y0 * s, oy + y1 * s, z0 * s, z1 * s, top, (shift[0] * s, shift[1] * s))

    def c(x, y, z0, h, r, seg=12, r2=None):
        cyl(bm, ox + x * s, oy + y * s, z0 * s, h * s, r * s, seg=seg, r2=None if r2 is None else r2 * s)

    def axle(x0, x1, y, z, r, seg=10):
        rod(bm, (ox + x0 * s, oy + y * s, z * s), (ox + x1 * s, oy + y * s, z * s), r * s, seg=seg)

    def bar(p, q, r):
        rod(bm, (ox + p[0] * s, oy + p[1] * s, p[2] * s), (ox + q[0] * s, oy + q[1] * s, q[2] * s), r * s, seg=6)

    k = 1.0 if patrol else 1.18            # the construction machine is broader
    with tagged(bm, armour):
        for sx in (-1, 1):
            x = sx * 0.78 * k
            P(x - 0.5, x + 0.5, -1.2, 0.65, 0.0, 0.5, top=(0.85, 0.7), shift=(0, 0.12))       # foot
            P(x - 0.5, x + 0.5, -0.6, 0.64, 0.7, 2.75, top=(0.68, 0.66))                      # lower leg, flared to the foot
            P(x - 0.34, x + 0.34, -0.8, -0.55, 0.95, 2.5, top=(0.78, 1.0), shift=(0, 0.1))    # shin guard
            P(x - 0.3, x + 0.3, -0.64, -0.28, 2.7, 3.25, top=(0.8, 0.7))                      # knee cap
            P(x - 0.34, x + 0.34, -0.4, 0.42, 3.2, 4.55, top=(1.25, 1.15))                    # thigh
            P(x - 0.4, x + 0.4, -0.62, -0.5, 3.45, 4.4, top=(0.9, 1.0))                       # thigh plate
            P(sx * 0.98 * k - 0.1, sx * 0.98 * k + 0.1, -0.45, 0.45, 3.95, 4.95, top=(1, 0.8))   # side skirt
            xs = sx * 1.8 * k
            P(xs - 0.55, xs + 0.55, -0.68, 0.68, 5.95, 7.05, top=(0.75, 0.8), shift=(sx * 0.05, 0))   # shoulder pad
            P(xs - 0.58, xs + 0.58, -0.72, 0.72, 5.83, 5.95)                                  # its lower rim
            P(xs - 0.26, xs + 0.26, -0.3, 0.3, 4.95, 5.9)                                     # upper arm
            w = 0.4 if patrol else 0.5
            P(xs - w, xs + w, -w - 0.08, w + 0.02, 3.25, 4.7, top=(0.72, 0.75))               # forearm
        P(-0.75 * k, 0.75 * k, -0.5, 0.5, 4.45, 5.05, top=(1.2, 1.0))                         # pelvis
        P(-0.32, 0.32, -0.74, -0.5, 4.0, 5.0, top=(1.25, 1.0))                                # front skirt
        P(-0.5, 0.5, 0.5, 0.66, 4.1, 4.95)                                                    # rear skirt
        P(-0.8 * k, 0.8 * k, -0.6, 0.6, 5.45, 6.95, top=(1.5, 1.2))                           # chest, widening to the shoulders
        P(-0.8, 0.8, 0.6, 1.25, 5.5, 6.9, top=(0.85, 0.8), shift=(0, -0.05))                  # backpack
        c(0.0, 0.05, 6.95, 0.22, 0.62)                                                        # collar
        if patrol:
            P(-0.6, 0.6, -1.08, -0.6, 5.7, 6.8, top=(0.9, 0.45), shift=(0, 0.14))             # cockpit hatch, sloping back
            P(-0.36, 0.36, -0.45, 0.42, 7.2, 7.85, top=(0.82, 0.75), shift=(0, 0.04))         # helmet
            P(-0.22, 0.22, -0.6, -0.4, 7.2, 7.42, top=(1.25, 0.8))                            # chin guard
            P(-0.06, 0.06, -0.42, 0.3, 7.85, 7.98)                                            # crest
            for sx in (-1, 1):
                P(sx * 0.43 - 0.07, sx * 0.43 + 0.07, -0.3, 0.32, 7.3, 7.72)                  # ear housings
            xs = 1.8 * k
            P(xs + 0.5, xs + 0.62, -0.95, 0.75, 2.4, 5.3, top=(1.0, 0.72), shift=(0, -0.05))  # riot shield on the left forearm
            P(xs + 0.4, xs + 0.5, -0.2, 0.2, 3.5, 4.3)                                        # its mount
        else:
            P(-0.55, 0.55, -0.7, 0.45, 7.15, 7.95, top=(0.85, 0.7), shift=(0, 0.12))          # cab
            P(-0.62, 0.62, -0.1, 0.5, 7.95, 8.05)                                             # its roof
    with tagged(bm, frame):
        for sx in (-1, 1):
            x = sx * 0.78 * k
            c(x, 0.05, 0.5, 0.2, 0.32)                                                        # ankle
            P(x - 0.25, x + 0.25, 0.55, 0.82, 1.2, 2.3, top=(0.8, 1.0))                       # calf unit
            axle(x - 0.4, x + 0.4, -0.05, 2.97, 0.3)                                          # knee
            axle(x - 0.36, x + 0.36, 0.0, 4.68, 0.3)                                          # hip
            xs = sx * 1.8 * k
            P(sx * 1.1 * k - 0.15, sx * 1.1 * k + 0.15, -0.28, 0.28, 6.15, 6.75)              # shoulder mount
            axle(xs - 0.32, xs + 0.32, 0.0, 4.82, 0.27)                                       # elbow
            P(xs - 0.2, xs + 0.2, -0.28, 0.22, 2.8, 3.25)                                     # hand
            if patrol:
                for dy in (-0.24, -0.08, 0.08):
                    P(xs - 0.17, xs + 0.17, dy - 0.06, dy + 0.06, 2.45, 2.8)                  # fingers
            else:
                for dx in (-0.2, 0.2):
                    P(xs + dx - 0.07, xs + dx + 0.07, -0.34, 0.26, 2.2, 2.8, top=(1.0, 0.6))  # claw jaws
        c(0.0, 0.0, 5.05, 0.4, 0.48)                                                          # waist
        c(0.0, 0.0, 7.05, 0.17, 0.3)                                                          # neck
        for sx in (-1, 1):
            P(sx * 0.32 - 0.16, sx * 0.32 + 0.16, 1.22, 1.38, 5.6, 6.5)                       # exhausts on the backpack
        if patrol:
            bar((0.5, 0.05, 7.6), (0.64, 0.8, 8.9), 0.024)                                    # two antennas, on the left ear
            bar((0.5, -0.05, 7.6), (0.56, 0.5, 8.45), 0.022)
        else:
            for sx in (-1, 1):                                                                # a roll bar over the cab
                bar((sx * 0.6, 0.45, 7.0), (sx * 0.6, 0.45, 8.25), 0.04)
            bar((-0.6, 0.45, 8.25), (0.6, 0.45, 8.25), 0.04)
            c(0.0, 0.45, 8.25, 0.18, 0.12, seg=8)                                             # a beacon on it
    if patrol:
        with tagged(bm, armour):
            P(-0.31, 0.31, -0.5, -0.43, 7.44, 7.66)
        with tagged(bm, armour):
            for sx in (-1, 1):
                xs = sx * 1.8 * k
                P(xs - 0.32, xs + 0.32, -0.82, -0.66, 6.12, 6.48)                             # a light bar on the front of each shoulder
    else:
        with tagged(bm, armour):
            P(-0.45, 0.45, -0.64, -0.56, 7.35, 7.8)                                           # the cab's windscreen
    if yaw:
        bm.verts.ensure_lookup_table()
        bmesh.ops.rotate(bm, verts=bm.verts[first:], cent=(ox, oy, 0), matrix=Matrix.Rotation(yaw, 3, 'Z'))


RX, RY = -1.6, 4.3       # where the white robot stands
TW = ((-6.0, -4.3), (1.1, 2.8))   # the gantry's two towers, x ranges
TY = (3.9, 7.0)       # the towers flank the robot's back; its front stands clear of them
LEVELS = (3.0, 5.6)


def gantry(bm):
    with tagged(bm, 'grey steel gantry frame'):
        for x0, x1 in TW:
            for x in (x0, x1 - 0.14):
                for y in (TY[0], TY[1] - 0.14):
                    box(bm, x, x + 0.14, y, y + 0.14, 0, 6.75)                 # posts
            for z in LEVELS:
                for y in (TY[0], TY[1] - 0.12):
                    box(bm, x0, x1, y, y + 0.12, z - 0.3, z - 0.1)             # beams under each deck
                for x in (x0, x1 - 0.12):
                    box(bm, x, x + 0.12, TY[0], TY[1], z - 0.3, z - 0.1)
            for a, z0, z1 in ((x0 + 0.02, 0.0, 2.7), (x1 - 0.1, 0.0, 2.7), (x0 + 0.02, 3.0, 5.3), (x1 - 0.1, 3.0, 5.3)):
                slanted(bm, (a, TY[0] + 0.14, z0), (0.08, 0, 0), (0, TY[1] - TY[0] - 0.28, z1 - z0), (0, 0, 0.1))   # braces
        for z in LEVELS:                                                       # the bridge behind the robot
            for y in (6.0, TY[1] - 0.12):
                box(bm, TW[0][1], TW[1][0], y, y + 0.12, z - 0.3, z - 0.1)
        box(bm, TW[0][1], RX - 2.5, RY - 0.15, RY + 0.15, 6.05, 6.3)           # service arms reaching the robot's shoulders
        box(bm, RX + 2.5, TW[1][0], RY - 0.15, RY + 0.15, 6.05, 6.3)
    with tagged(bm, 'steel grating walkway'):
        for z in LEVELS:
            for x0, x1 in TW:
                box(bm, x0, x1, TY[0], TY[1], z - 0.1, z)
            box(bm, TW[0][1], TW[1][0], 6.0, TY[1], z - 0.1, z)
    with tagged(bm, 'grey equipment cabinets'):
        box(bm, TW[0][0] + 0.1, TW[0][0] + 0.6, 5.6, 6.8, LEVELS[0], LEVELS[0] + 1.3)       # on the west tower's first deck
        box(bm, TW[1][1] - 0.6, TW[1][1] - 0.1, 5.4, 6.6, LEVELS[1], LEVELS[1] + 1.1)       # on the east tower's second
        box(bm, TW[0][0] + 0.1, TW[0][0] + 0.55, 4.2, 5.1, LEVELS[1], LEVELS[1] + 0.9)
    for z in LEVELS:
        railing(bm, 'y', TY[0], TY[1], TW[0][0] + 0.03, z)                     # outer sides
        railing(bm, 'y', TY[0], TY[1], TW[1][1] - 0.03, z)
        railing(bm, 'x', TW[0][0], TW[1][1], TY[1] - 0.03, z)                  # along the wall
        railing(bm, 'x', TW[0][1], TW[1][0], 6.03, z)                          # the bridge, robot side
        railing(bm, 'y', 5.3, 6.03, TW[0][1] - 0.03, z)                        # towers, robot side: open by the shoulders
        railing(bm, 'y', 5.3, 6.03, TW[1][0] + 0.03, z)
        railing(bm, 'x', TW[1][0], TW[1][1], TY[0] + 0.03, z)                  # east tower, front
    railing(bm, 'x', TW[0][0], TW[0][1], TY[0] + 0.03, LEVELS[1])              # west tower, front, upper level (the stairs land below)
    stairs(bm, 'y', -0.9, TY[0], TW[0][0] + 0.3, TW[0][1] - 0.3, 0.0, LEVELS[0], 16)
    with tagged(bm, 'steel ladder'):                                           # up to the second level, on the east tower
        for x in (1.5, 1.95):
            box(bm, x, x + 0.05, 6.55, 6.6, LEVELS[0], LEVELS[1] + 1.0)
        for k in range(9):
            box(bm, 1.55, 1.95, 6.56, 6.59, LEVELS[0] + 0.3 * (k + 1) - 0.02, LEVELS[0] + 0.3 * (k + 1) + 0.02)
    with tagged(bm, 'black rubber hoses'):
        hose(bm, (RX - 1.3, RY + 1.9, 8.9), (RX - 0.5, RY + 1.25, 6.3), 0.5, 0.15)     # from the roof to the backpack
        hose(bm, (RX + 1.5, RY + 2.0, 8.9), (RX + 0.5, RY + 1.25, 6.0), 0.6, 0.15)
        hose(bm, (RX + 0.1, RY + 2.3, 8.9), (RX + 0.0, RY + 1.3, 5.6), 0.4, 0.1)
        hose(bm, (RX + 3.2, RY - 1.9, 8.9), (RX + 1.9, RY + 0.2, 6.75), 0.9, 0.1)      # to a shoulder
        hose(bm, (RX - 3.2, RY - 1.9, 8.9), (RX - 1.9, RY + 0.2, 6.75), 0.9, 0.1)
        hose(bm, (TW[0][1] - 0.2, RY - 0.6, LEVELS[1] + 0.05), (RX - 0.9, RY - 0.75, 5.5), 0.7, 0.07)   # from the decks to the waist
        hose(bm, (TW[1][0] + 0.2, RY + 0.9, LEVELS[1] + 0.05), (RX + 0.5, RY + 0.4, 4.9), 0.9, 0.07)
        hose(bm, (TW[0][1] - 0.3, RY + 1.2, LEVELS[0] + 0.05), (RX - 0.8, RY + 0.5, 4.3), 0.5, 0.06)
        for y, x1 in ((0.3, 0.7), (0.75, 1.8)):                                # cables across the floor from the generator
            rod(bm, (RX - 0.2, y + 2.2, 0.05), (RX + 0.6, y, 0.05), 0.05, seg=6)
            rod(bm, (RX + 0.6, y, 0.05), (x1, y - 3.6, 0.05), 0.05, seg=6)
            rod(bm, (x1, y - 3.6, 0.05), (x1 + 0.4, -5.3, 0.05), 0.05, seg=6)


def mezzanine(bm):
    with tagged(bm, 'steel mezzanine deck'):
        box(bm, -W, MX, -D, D, MZ - 0.25, MZ)
        box(bm, MX - 0.18, MX, -D, D, MZ - 0.55, MZ - 0.25)                    # edge beam
        for y in (-5.0, -2.5, 0.0, 2.5, 5.0):
            box(bm, -W, MX - 0.18, y - 0.07, y + 0.07, MZ - 0.45, MZ - 0.25)   # joists
        for y in (-5.0, 0.0, 5.0):
            box(bm, MX - 0.18, MX, y - 0.09, y + 0.09, 0, MZ - 0.55)           # posts under the edge
    with tagged(bm, 'office partition wall'):
        wins = [(c - 1.35, c + 1.35, MZ + 0.95, MZ + 2.45) for c in (-3.7, -0.5, 2.7, 5.9)]
        wall(bm, 'y', OY, D, MX - 0.32, MX - 0.2, MZ, MZ + OH, wins)           # the front, glazed onto the hangar
        wall(bm, 'x', -W, MX - 0.2, OY, OY + 0.12, MZ, MZ + OH, [(-9.6, -8.6, MZ, MZ + 2.1)])   # the side with the door
    with tagged(bm, 'steel-framed office windows'):
        for o in wins:
            window_frame(bm, 'y', o[0], o[1], o[2], o[3], MX - 0.26, cols=3, rows=2)
    with tagged(bm, 'office ceiling'):
        box(bm, -W, MX - 0.2, OY, D, MZ + OH, MZ + OH + 0.12)
    railing(bm, 'y', -6.2, OY, MX - 0.05, MZ)                                  # the landing's edge, beside the stair head
    stairs(bm, 'x', -1.5, MX, -D + 0.05, -6.25, 0.0, MZ, 18)
    with tagged(bm, 'grey steel office desks'):
        for x, y in ((-9.6, -3.2), (-9.6, 0.0), (-9.6, 3.2), (-11.6, -1.6), (-11.6, 1.6)):
            box(bm, x - 0.4, x + 0.4, y - 0.75, y + 0.75, MZ + 0.7, MZ + 0.74)         # top
            for s in (-1, 1):
                box(bm, x - 0.36, x + 0.36, y + s * 0.52 - 0.2, y + s * 0.52 + 0.2, MZ, MZ + 0.7)   # drawer pedestals
            box(bm, x - 0.2, x + 0.25, y - 0.22, y + 0.22, MZ + 0.74, MZ + 1.12)       # a boxy computer terminal
    with tagged(bm, 'office swivel chairs'):
        for x, y in ((-8.9, -3.2), (-8.9, 0.0), (-8.9, 3.2), (-10.9, -1.6), (-10.9, 1.6)):
            cyl(bm, x, y, MZ, 0.05, 0.28, seg=10)
            cyl(bm, x, y, MZ + 0.05, 0.38, 0.035, seg=6)
            box(bm, x - 0.23, x + 0.23, y - 0.23, y + 0.23, MZ + 0.43, MZ + 0.51)
            box(bm, x + 0.19, x + 0.25, y - 0.22, y + 0.22, MZ + 0.55, MZ + 1.0)
    with tagged(bm, 'grey steel lockers'):
        for k in range(8):
            y = -5.2 + 0.62 * k
            box(bm, -W, -W + 0.5, y, y + 0.6, MZ, MZ + 1.85)                   # along the office's back wall
        for k in range(6):
            y = 3.4 + 0.62 * k
            box(bm, -W, -W + 0.5, y, y + 0.6, 0, 1.85)                         # and under the mezzanine
    with tagged(bm, 'shelves of binders'):
        box(bm, -12.2, -8.6, D - 0.4, D, MZ, MZ + 2.0)                         # against the office's north wall
        box(bm, -W, -W + 0.4, 0.2, 2.6, MZ, MZ + 2.0)
    with tagged(bm, 'steel filing cabinets'):
        for k in range(4):
            x = -12.4 + 0.5 * k
            box(bm, x, x + 0.48, OY + 0.12, OY + 0.72, MZ, MZ + 1.35)          # by the door, against the side wall
    with tagged(bm, 'air conditioning unit'):
        box(bm, -W, -W + 0.3, -3.6, -2.2, MZ + 2.3, MZ + 2.75)                 # high on the office's back wall
    with tagged(bm, 'fluorescent tube lamps'):
        for x in (-11.6, -9.3):
            for y in (-3.8, -0.4, 3.0, 6.0):
                box(bm, x - 0.09, x + 0.09, y - 0.65, y + 0.65, MZ + OH - 0.08, MZ + OH)       # the office
        for x in (-11.4, -9.0):
            for y in (-5.0, -1.0, 3.0):
                box(bm, x - 0.09, x + 0.09, y - 0.65, y + 0.65, MZ - 0.53, MZ - 0.45)          # under the mezzanine
    with tagged(bm, 'control consoles'):
        for y0, y1 in ((-4.6, -2.3), (-2.2, 0.1), (0.2, 2.5)):
            box(bm, -12.6, -11.5, y0, y1, 0, 0.78)                             # desk
            slanted(bm, (-12.6, y0, 0.78), (0.7, 0, 0), (0, y1 - y0, 0), (-0.25, 0, 0.5))   # the sloped instrument panel
            box(bm, -11.75, -11.5, y0, y1, 0.78, 0.84)                         # keyboard shelf
        for y in (-3.45, -1.05, 1.35):
            cyl(bm, -10.8, y, 0, 0.05, 0.28, seg=10)                           # operators' stools
            cyl(bm, -10.8, y, 0.05, 0.4, 0.035, seg=6)
            cyl(bm, -10.8, y, 0.45, 0.07, 0.22, seg=10)
    with tagged(bm, 'wall monitor panels'):
        for k in range(4):
            y = -4.4 + 1.75 * k
            box(bm, -W, -W + 0.18, y, y + 1.6, 1.75, 2.85)


def truck(bm, x0, y0):
    """A three-axle flatbed transport truck along x, its cab to the east, parked by the south wall."""
    with tagged(bm, 'green transport truck'):
        box(bm, x0, x0 + 6.6, y0 + 0.05, y0 + 2.45, 1.05, 1.3)                 # the bed
        box(bm, x0, x0 + 6.9, y0 + 0.6, y0 + 1.9, 0.7, 1.05)                   # chassis rails
        for y in (y0 + 0.05, y0 + 2.37):
            box(bm, x0, x0 + 4.4, y, y + 0.08, 1.3, 1.75)                      # drop sides
            for x in (x0 + 0.05, x0 + 1.5, x0 + 2.95, x0 + 4.3):
                box(bm, x, x + 0.1, y - 0.02, y + 0.1, 1.05, 1.82)             # their stakes
        box(bm, x0, x0 + 0.08, y0 + 0.05, y0 + 2.45, 1.3, 1.75)                # tailboard
        box(bm, x0 + 4.5, x0 + 4.62, y0 + 0.05, y0 + 2.45, 1.3, 3.0)           # headboard
        box(bm, x0 + 4.85, x0 + 7.0, y0, y0 + 2.5, 1.0, 2.15)                  # cab, lower
        prism(bm, x0 + 4.85, x0 + 7.0, y0 + 0.02, y0 + 2.48, 2.15, 3.1, top=(0.78, 0.94), shift=(-0.2, 0))   # cab, upper: a raked windscreen
        box(bm, x0 + 7.0, x0 + 7.15, y0 + 0.08, y0 + 2.42, 0.65, 1.15)         # bumper
        box(bm, x0 + 5.3, x0 + 6.0, y0 + 0.9, y0 + 1.6, 3.1, 3.25)             # roof hatch
        for x in (x0 + 0.35, x0 + 5.25):                                       # mudguards over the wheels
            for y in (y0 + 0.02, y0 + 1.93):
                box(bm, x, x + (2.2 if x < x0 + 1 else 1.1), y, y + 0.55, 1.02, 1.08)
        rod(bm, (x0 + 3.2, y0 + 0.2, 0.75), (x0 + 4.4, y0 + 0.2, 0.75), 0.28, seg=10)   # fuel tank
    with tagged(bm, 'black truck tyres'):
        for x in (x0 + 0.9, x0 + 2.0, x0 + 5.8):
            for y in (y0 + 0.08, y0 + 1.97):
                rod(bm, (x, y, 0.5), (x, y + 0.45, 0.5), 0.5, seg=14)
    with tagged(bm, 'tarpaulin-covered load'):
        prism(bm, x0 + 0.4, x0 + 3.9, y0 + 0.3, y0 + 2.2, 1.3, 2.35, top=(0.92, 0.85))
        prism(bm, x0 + 0.9, x0 + 3.2, y0 + 0.55, y0 + 1.95, 2.35, 2.7, top=(0.8, 0.7))


def floor_props(bm):
    truck(bm, 3.7, -6.5)
    with tagged(bm, 'generator unit'):                                         # clear of the foot of the mezzanine stairs
        box(bm, 0.3, 2.7, -6.7, -5.3, 0.25, 1.6)
        box(bm, 0.6, 2.4, -6.5, -5.5, 1.6, 1.8)
        for x in (0.6, 2.2):
            box(bm, x, x + 0.2, -6.7, -5.3, 0, 0.25)                           # skids
        cyl(bm, 2.1, -6.0, 1.8, 0.7, 0.07, seg=8)                              # exhaust stack
    with tagged(bm, 'oil drums'):
        for x, y in ((-5.4, -5.7), (-4.7, -5.7), (-5.05, -5.05), (-4.0, -5.6), (11.6, 6.6), (10.9, 6.6), (11.3, 5.95)):
            cyl(bm, x, y, 0, 0.9, 0.3, seg=14)
        cyl(bm, -5.05, -5.55, 0.9, 0.9, 0.3, seg=14)                           # one stacked
    with tagged(bm, 'equipment crates'):
        for x0, x1, y0, y1, z0, z1 in ((9.3, 10.6, -3.0, -1.8, 0.12, 1.0), (10.7, 11.9, -3.2, -2.0, 0.12, 1.2), (9.6, 10.7, -2.9, -1.9, 1.0, 1.9),
                                       (7.6, 9.0, 5.6, 6.9, 0.12, 1.1), (7.9, 8.8, 5.8, 6.7, 1.1, 1.9)):
            box(bm, x0, x1, y0, y1, z0, z1)
        for x0, x1, y0, y1 in ((9.3, 10.6, -3.0, -1.8), (10.7, 11.9, -3.2, -2.0), (7.6, 9.0, 5.6, 6.9)):
            for y in (y0 + 0.05, (y0 + y1) / 2 - 0.05, y1 - 0.15):
                box(bm, x0, x1, y, y + 0.1, 0, 0.12)                           # pallet runners
    with tagged(bm, 'red tool cabinets'):
        for x in (2.9, 3.75):
            box(bm, x, x + 0.8, 1.0, 1.5, 0.12, 1.05)                          # roller cabinets beside the gantry
            for dx in (0.08, 0.66):
                for y in (1.06, 1.38):
                    cyl(bm, x + dx + 0.03, y + 0.03, 0, 0.12, 0.05, seg=6)
        box(bm, 4.7, 6.4, 6.6, 7.2, 0, 0.9)                                    # a workbench against the north wall
        box(bm, 4.7, 6.4, 7.2, 7.26, 0.9, 1.9)                                 # and its tool board
    with tagged(bm, 'striped safety barriers'):
        for x, y in ((8.6, 0.2), (8.6, -1.6)):
            box(bm, x - 0.03, x + 0.03, y - 0.75, y + 0.75, 0.75, 1.0)
            for yy in (y - 0.7, y + 0.64):
                box(bm, x - 0.25, x + 0.25, yy, yy + 0.06, 0, 0.06)
                box(bm, x - 0.03, x + 0.03, yy, yy + 0.06, 0.06, 0.75)
    with tagged(bm, 'power distribution cabinets'):                            # either side of the door, against the east wall
        for k in range(3):
            y = 5.35 + 0.72 * k
            box(bm, W - 0.6, W - 0.12, y, y + 0.7, 0, 2.1)
        box(bm, W - 0.5, W - 0.12, 5.35, 7.5, 2.1, 2.25)                       # the cable duct over them
        box(bm, W - 0.4, W - 0.2, 6.3, 6.6, 2.25, 5.4)                         # and its riser up the wall
    with tagged(bm, 'gas cylinders'):
        for k in range(6):
            cyl(bm, W - 0.4, -6.95 + 0.3 * k, 0, 1.45, 0.12, seg=10)
            cyl(bm, W - 0.4, -6.95 + 0.3 * k, 1.45, 0.12, 0.05, seg=6)
        box(bm, W - 0.6, W - 0.55, -7.15, -5.25, 0.9, 0.95)                    # the rack's bar
    with tagged(bm, 'steel parts shelving'):                                   # under the mezzanine, along the south wall
        x0, x1, y0, y1 = -12.6, -8.3, -D + 0.05, -D + 0.75
        for x in (x0, (x0 + x1) / 2 - 0.03, x1 - 0.06):
            for y in (y0, y1 - 0.06):
                box(bm, x, x + 0.06, y, y + 0.06, 0, 2.8)
        for z in (0.25, 1.05, 1.85, 2.65):
            box(bm, x0, x1, y0, y1, z, z + 0.05)
    with tagged(bm, 'boxed spare parts'):
        for x, z, w, h in ((-12.4, 0.3, 0.9, 0.55), (-11.3, 0.3, 1.2, 0.6), (-9.8, 0.3, 0.8, 0.45), (-12.3, 1.1, 1.3, 0.5),
                           (-10.7, 1.1, 0.7, 0.6), (-9.6, 1.1, 1.0, 0.4), (-12.0, 1.9, 0.8, 0.5), (-10.9, 1.9, 1.5, 0.45), (-9.2, 1.9, 0.7, 0.55)):
            box(bm, x, x + w, -D + 0.12, -D + 0.68, z, z + h)
    with tagged(bm, 'floor work lights'):                                      # floodlights on stands, turned on the robot
        for x, y in ((-3.9, 1.3), (0.9, 1.9)):
            cyl(bm, x, y, 0, 0.06, 0.3, seg=8)
            cyl(bm, x, y, 0.06, 2.0, 0.03, seg=6)
            box(bm, x - 0.3, x + 0.3, y - 0.08, y + 0.1, 2.06, 2.4)
    with tagged(bm, 'steel maintenance stand'):                                # a spare forearm laid on a stand, by the east tower
        for x in (3.25, 4.55):
            box(bm, x - 0.05, x + 0.05, 2.75, 3.65, 0, 0.06)
            box(bm, x - 0.04, x + 0.04, 3.16, 3.24, 0.06, 0.95)
            box(bm, x - 0.05, x + 0.05, 2.9, 3.5, 0.95, 1.0)
        box(bm, 3.2, 4.6, 3.17, 3.23, 0.3, 0.36)
    with tagged(bm, 'white spare robot forearm'):
        prism(bm, 3.1, 4.7, 2.85, 3.55, 1.0, 1.7, top=(1.0, 0.8))
    with tagged(bm, 'black robot joints'):
        rod(bm, (4.7, 3.2, 1.35), (5.0, 3.2, 1.35), 0.24, seg=10)              # its elbow
        box(bm, 2.75, 3.1, 3.0, 3.4, 1.15, 1.55)                               # its hand
    with tagged(bm, 'rolling scaffold tower'):                                 # beside the orange robot
        x0, x1, y0, y1 = 8.9, 10.5, 2.4, 4.0
        for x in (x0, x1 - 0.06):
            for y in (y0, y1 - 0.06):
                box(bm, x, x + 0.06, y, y + 0.06, 0.1, 4.4)
                cyl(bm, x + 0.03, y + 0.03, 0, 0.1, 0.07, seg=6)
        for z in (1.2, 2.3, 3.3):
            for y in (y0, y1 - 0.05):
                box(bm, x0, x1, y, y + 0.05, z, z + 0.05)
            for x in (x0, x1 - 0.05):
                box(bm, x, x + 0.05, y0, y1, z, z + 0.05)
        box(bm, x0, x1, y0, y1, 3.35, 3.42)                                    # its deck
        for y in (y0, y1 - 0.05):
            box(bm, x0, x1, y, y + 0.05, 4.35, 4.4)
        for x in (x0, x1 - 0.05):
            box(bm, x, x + 0.05, y0, y1, 4.35, 4.4)


def block(bm, x0, x1, y0, y1, z0, z1, coping=0.25):
    """A block of cast concrete with a coping course standing a little proud of its top."""
    box(bm, x0, x1, y0, y1, z0, z1 - 0.6)
    box(bm, x0 - coping, x1 + coping, y0 - coping, y1 + coping, z1 - 0.6, z1)


def ribs(bm, along, a0, a1, at, out, z0, z1, every=4.5, wide=0.9, deep=0.55):
    """Buttress ribs up a wall face that runs along x or y at `at`, standing out of it towards `out` (+1 or -1)."""
    n = max(1, round((a1 - a0) / every))
    for k in range(n + 1):
        c = a0 + (a1 - a0) * k / n
        lo, hi = (at, at + deep) if out > 0 else (at - deep, at)
        if along == 'x':
            box(bm, c - wide / 2, c + wide / 2, lo, hi, z0, z1)
        else:
            box(bm, lo, hi, c - wide / 2, c + wide / 2, z0, z1)


def outside(bm):
    with tagged(bm, 'concrete apron deck'):
        box(bm, E0, AX, -AY, AY, -0.2, 0)
    with tagged(bm, 'massive cast concrete blocks'):
        box(bm, -16, AX, -AY, AY, SEA - 1, -0.2)                               # the platform itself, down into the water
        # the hall's front: a pier each side of the door and a lintel over it, rising past the roof as a parapet
        block(bm, E0, E0 + 1.5, 5.0, 8.5, 0, 12.0, coping=0.15)
        block(bm, E0, E0 + 1.5, -9.5, -5.0, 0, 12.0, coping=0.15)
        box(bm, E0, E0 + 1.1, -5.0, 5.0, DOOR[3], 12.0)
        box(bm, E0, E0 + 1.5, -5.0, 5.0, 11.4, 12.0)
        # the north side of the apron: a block in three steps
        block(bm, E0, 25.5, 8.5, AY, 0, 9.0)
        block(bm, E0, 21.0, 10.5, AY, 9.0, 15.0)
        block(bm, 25.5, 30.5, 11.0, AY, 0, 4.5)
        # the south side: a longer block with a tier on it, and a low dock in front
        block(bm, E0, 31.0, -AY, -9.5, 0, 8.5)
        block(bm, E0, 22.5, -AY, -11.5, 8.5, 12.5)
        block(bm, 24.0, 31.0, -9.5, -7.2, 0, 1.3, coping=0.0)
    with tagged(bm, 'concrete buttress ribs'):
        ribs(bm, 'x', 16.6, 25.05, 8.5, -1, 0, 8.4, every=4.2)                 # up the north block, facing the apron
        ribs(bm, 'y', 9.4, AY - 0.6, 25.5, 1, 4.5, 8.4, every=3.0)
        ribs(bm, 'x', 14.2, 20.4, 10.5, -1, 9.0, 14.4, every=3.1)
        ribs(bm, 'x', 16.6, 23.0, -9.5, 1, 0, 7.9, every=3.2)                  # up the south block
        ribs(bm, 'y', -AY + 0.6, -10.2, 31.0, 1, 0, 7.9, every=2.8)
        ribs(bm, 'x', 14.2, 21.9, -11.5, 1, 8.5, 11.9, every=3.85)
        ribs(bm, 'y', -AY + 2.5, AY - 2.5, AX, 1, SEA - 1, -0.2, every=5.4, wide=1.2, deep=0.7)   # down the platform's sea face
    with tagged(bm, 'concrete parapet'):
        box(bm, AX - 0.8, AX, -AY, AY, 0, 1.2)
        box(bm, 30.75, AX - 0.8, AY - 0.8, AY, 0, 1.2)
        box(bm, 31.25, AX - 0.8, -AY, -AY + 0.8, 0, 1.2)
    with tagged(bm, 'concrete barrier blocks'):
        for x0, y0, z0, sz in ((27.6, 3.2, 0, 1.5), (29.3, 3.5, 0, 1.5), (28.4, 3.3, 1.5, 1.5), (27.0, 5.3, 0, 1.5),
                               (16.2, -8.6, 0, 1.2), (17.6, -8.7, 0, 1.2), (19.0, -8.6, 0, 1.2), (16.9, -8.6, 1.2, 1.2)):
            box(bm, x0, x0 + sz, y0, y0 + sz, z0, z0 + sz)
    with tagged(bm, 'concrete number panels'):                                 # a raised panel in each bay, where the numbers go
        for c in (18.7, 22.95):
            box(bm, c - 1.3, c + 1.3, 8.4, 8.5, 3.4, 6.0)
        for c in (18.2, 21.4):
            box(bm, c - 1.0, c + 1.0, -9.5, -9.4, 3.2, 5.6)
        for c in (-13.0, -10.5):
            box(bm, 31.0, 31.1, c - 0.85, c + 0.85, 3.2, 5.6)
    with tagged(bm, 'steel cargo containers'):
        for x0, y0, z0 in ((25.0, -6.7, 0.0), (25.5, -6.6, 2.6)):              # two stacked, by the dock
            box(bm, x0, x0 + 6.0, y0, y0 + 2.4, z0, z0 + 2.6)
            for k in range(1, 8):
                box(bm, x0 + 0.75 * k - 0.04, x0 + 0.75 * k + 0.04, y0 - 0.04, y0 + 2.44, z0 + 0.1, z0 + 2.5)   # their ribs
        box(bm, 15.6, 21.6, 5.3, 7.7, 0, 2.6)                                  # one against the north block
        for k in range(1, 8):
            box(bm, 15.6 + 0.75 * k - 0.04, 15.6 + 0.75 * k + 0.04, 5.26, 7.74, 0.1, 2.5)
    with tagged(bm, 'stacked steel pipes'):
        for z, ys in ((0.37, (0.5, 1.24, 1.98)), (1.01, (0.87, 1.61)), (1.65, (1.24,))):
            for y in ys:
                rod(bm, (24.0, y, z), (31.5, y, z), 0.37, seg=12)
        for x in (25.0, 30.5):
            box(bm, x, x + 0.15, 0.05, 2.45, 0, 0.1)                           # the timbers under them
    with tagged(bm, 'tarpaulin-covered load'):
        prism(bm, 16.5, 19.3, -5.6, -3.4, 0, 1.6, top=(0.8, 0.75))
    with tagged(bm, 'floodlight mast'):
        cyl(bm, AX - 2.2, -13.6, 0, 9.0, 0.14, seg=8, r2=0.09)
        box(bm, AX - 2.9, AX - 1.5, -13.75, -13.45, 9.0, 9.5)
        box(bm, AX - 2.6, AX - 1.8, -14.2, -13.0, 0, 0.5)                      # its concrete foot
    with tagged(bm, 'steel mooring bollards'):
        for y in (-10.5, -3.5, 3.5, 10.5):
            cyl(bm, AX - 1.9, y, 0, 0.75, 0.3, seg=12)
            cyl(bm, AX - 1.9, y, 0.75, 0.16, 0.42, seg=12)
    with tagged(bm, 'sea water'):
        box(bm, -70, 150, -120, 120, SEA - 0.3, SEA)
    with tagged(bm, 'concrete platforms across the water'):
        box(bm, 52, 102, -36, 30, SEA - 1, 0)                                  # east, across a channel
        box(bm, 58, 80, -28, -6, 0, 16)
        box(bm, 62, 76, -23, -11, 16, 24)
        box(bm, 60, 94, 4, 26, 0, 10)
        box(bm, 66, 84, 9, 21, 10, 15)
        box(bm, 86, 100, -32, -14, 0, 7)
        box(bm, 42, 98, 46, 104, SEA - 1, 2)                                   # north-east
        box(bm, 50, 72, 54, 82, 2, 22)
        box(bm, 76, 92, 60, 96, 2, 11)
        box(bm, 44, 92, -104, -52, SEA - 1, -3)                                # south-east, lower
        box(bm, 52, 74, -92, -64, -3, 12)


SPOTS = [Vector((x, y, 1.7)) for x in (16.0, 24.0, 32.0) for y in (-6.0, 0.0, 6.0)]   # where players stand on the apron


def group_of(f):
    """Texture-space share for a face: the hall gets it; the apron's surroundings less; what nobody can see next to none."""
    c, n = f.calc_center_median(), f.normal
    name = LABELS[f.material_index]
    if name in BACKGROUND:
        return 'far' if n.dot(Vector((AX - 4, 0, 2)) - c) > 0 else 'hidden'
    if name in YARD or c.x > E0 + 1.6:
        seen = c.z > -0.25 and any(n.dot(p - c) > 0.05 for p in SPOTS)
        return 'yard' if seen else 'hidden'
    outer = abs(c.x) > W + T - 0.01 or abs(c.y) > D + T - 0.01 or c.z > H + 0.29 or c.z < -0.19
    return 'hidden' if outer else 'room'


SCALE = {'room': 1.0, 'yard': 0.55, 'far': 0.07, 'hidden': 0.03}


def uv_area(f, uv):
    pts = [l[uv].uv for l in f.loops]
    return sum(abs((pts[k].x - pts[0].x) * (pts[k + 1].y - pts[0].y) - (pts[k + 1].x - pts[0].x) * (pts[k].y - pts[0].y)) / 2
               for k in range(1, len(pts) - 1))


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
        # the projection fills the unit square with whatever it is given, so bring each group to the same
        # texels per metre first; then its share is what SCALE says
        ua = sum(uv_area(bm.faces[i], uv) for i in idx)
        sa = sum(bm.faces[i].calc_area() for i in idx)
        k = SCALE[name] * math.sqrt(sa / ua) / 100
        for i in idx:
            for loop in bm.faces[i].loops:
                loop[uv].uv *= k
        bmesh.update_edit_mesh(obj.data)
    for f in bm.faces:
        f.select_set(True)
    bmesh.update_edit_mesh(obj.data)
    bpy.ops.uv.pack_islands(rotate=True, scale=True, margin=0.0007)   # 6 px on the 8192 px texture this level is painted on
    bm = bmesh.from_edit_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    uv = bm.loops.layers.uv.active
    share, area = {}, {}
    for f in bm.faces:
        a = uv_area(f, uv)
        g = group_of(f)
        share[g] = share.get(g, 0.0) + a
        area[g] = area.get(g, 0.0) + f.calc_area()
    bpy.ops.object.mode_set(mode='OBJECT')
    print('UV share by group:', {k: round(v, 3) for k, v in share.items()}, 'surface m2:', {k: round(v) for k, v in area.items()})
    room = math.sqrt(share['room'] / area['room'])
    print(f'the hall gets {room * 8192:.0f} texels per metre on an 8192 px texture, the yard {math.sqrt(share["yard"] / area["yard"]) * 8192:.0f}')


def main():
    out = sys.argv[sys.argv.index('--') + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bm = bmesh.new()
    hall(bm)
    structure(bm)
    mezzanine(bm)
    gantry(bm)
    robot(bm, RX, RY, 0.94, 'white police patrol robot', patrol=True)
    robot(bm, 5.5, 4.4, 0.74, 'orange construction robot')
    robot(bm, 21.5, -2.0, 0.74, 'orange construction robot on the apron', yaw=math.radians(115))   # a second one outside, a part of its own
    floor_props(bm)
    outside(bm)
    # drop faces resting on the floor (and what is under water): never visible, they'd only waste texture space
    bm.faces.ensure_lookup_table()
    drop = [f for f in bm.faces if f.normal.z < -0.99 and (abs(f.calc_center_median().z) < 0.02 or f.calc_center_median().z < -0.1)]
    bmesh.ops.delete(bm, geom=drop, context='FACES')
    for f in bm.faces:
        f.smooth = False
    mesh = bpy.data.meshes.new('hangar')
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new('hangar', mesh)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    for name in LABELS:
        obj.data.materials.append(bpy.data.materials.new(name))
    unwrap(obj)
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True)
    print('DONE', out, len(mesh.polygons), 'faces', round(sum(p.area for p in mesh.polygons)), 'm2', len(LABELS), 'parts')


main()
