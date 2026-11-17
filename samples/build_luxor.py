"""Build the Luxor blockout: an Egyptian temple of the New Kingdom, after Luxor Temple, at about half its size.

Run: blender -b --factory-startup -P samples/build_luxor.py -- samples/luxor.glb

From south to north, along the processional way: the end of the avenue of sphinxes, an obelisk and two seated
colossi before the pylon, the pylon with its flagpole niches and its gateway, a court with a portico of
papyrus-bundle columns down each side, an offering altar and a standing king either side of the gate, and the
great colonnade: two rows of tall columns with open papyrus capitals under their architraves, a lower row of
bundle columns in the aisle on either side, and steps up to the doorway of the sanctuary in the end wall. As at
Luxor today the nave has lost its roof, so most of it stands under the sky; only the porticoes and the aisles keep
their roof slabs, and blocks fallen from the walls lie where they fell.

Untextured, in metres, Blender's axes (x east, y north, z up). Every part is labelled; labels become glTF
materials, which the texturing prompts read. Faces nobody can see (the outside of the enclosure, the tops of
walls, roofs and capitals) get next to no texture space.
"""
import math
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

HW = 13.0                  # half width inside the walls
Y_FRONT = -42.0            # south end of the forecourt
Y_PYLON = (-24.0, -20.0)   # the pylon, south and north face at the top
Y_HALL = 0.0               # the court ends and the colonnade begins
Y_END = 24.0               # inner face of the end wall
WALL_H, WALL_T = 9.0, 1.0
PYLON_H = 13.0
GATE = 2.5                 # half width of the gateway
LABELS = []


def box(bm, x0, x1, y0, y1, z0, z1):
    c = Vector(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))
    bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation(c) @ Matrix.Diagonal((x1 - x0, y1 - y0, z1 - z0, 1)))


def frustum(bm, x0, x1, y0, y1, z0, z1, dx=0.0, dy=0.0, dx0=None, dx1=None):
    """A box whose sides lean in towards the top: by dx on the west and east faces, dy on the south and north ones.

    dx0, dx1 give the west and the east face a lean of their own (a pylon tower leans on its outer side only)."""
    a, b = (dx if dx0 is None else dx0), (dx if dx1 is None else dx1)
    lo = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0)]
    hi = [(x0 + a, y0 + dy, z1), (x1 - b, y0 + dy, z1), (x1 - b, y1 - dy, z1), (x0 + a, y1 - dy, z1)]
    v = [bm.verts.new(p) for p in lo + hi]
    for f in ((3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        bm.faces.new([v[i] for i in f])


def lathe(bm, x, y, profile, seg=24, sx=1.0, sy=1.0, lobes=0, depth=0.0):
    """A solid of revolution about the vertical through (x, y): `profile` is (radius, z) from the bottom up.

    sx, sy squash the round section to an oval (a torso, a sphinx's body). With `lobes` the section is a bundle of
    so many stems: round lobes with a groove between each two, `depth` of the radius deep."""
    rings = []
    for r, z in profile:
        ring = []
        for k in range(seg):
            t = 2 * math.pi * k / seg
            rr = r * (1 - depth * (1 - abs(math.cos(lobes * t / 2)))) if lobes else r
            ring.append(bm.verts.new((x + sx * rr * math.cos(t), y + sy * rr * math.sin(t), z)))
        rings.append(ring)
    for a, b in zip(rings, rings[1:]):
        for k in range(seg):
            bm.faces.new([a[k], a[(k + 1) % seg], b[(k + 1) % seg], b[k]]).smooth = True
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])


def prism(bm, lo, hi):
    """A six-sided solid from its four bottom corners and the four above them, each given counter-clockwise from above."""
    v = [bm.verts.new(p) for p in list(lo) + list(hi)]
    for f in ((3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        bm.faces.new([v[i] for i in f])


class turned:
    """Turn everything built inside the block about the vertical through (x, y): statues are built facing south."""

    def __init__(self, bm, x, y, degrees):
        self.bm, self.at, self.angle = bm, (x, y, 0), math.radians(degrees)

    def __enter__(self):
        self.start = len(self.bm.verts)
        return self

    def __exit__(self, *exc):
        self.bm.verts.ensure_lookup_table()
        bmesh.ops.rotate(self.bm, verts=self.bm.verts[self.start:], cent=self.at, matrix=Matrix.Rotation(self.angle, 3, 'Z'))


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


def cavetto(bm, x0, x1, y0, y1, z, h=0.7, out=0.35):
    """The cornice every Egyptian gateway and wall top carries: a roll, then a hollow flaring outwards."""
    box(bm, x0 - 0.08, x1 + 0.08, y0 - 0.08, y1 + 0.08, z, z + 0.16)
    frustum(bm, x0, x1, y0, y1, z + 0.16, z + h, dx=-out, dy=-out)


def papyrus_column(bm, x, y, top, r):
    """A column with an open papyrus capital (a bell flaring to twice the shaft), as in the great colonnade.

    `top` is the underside of the architrave; `r` the shaft's radius at its widest, a little above the base."""
    cap = 2.2 * r   # height of the bell
    with tagged(bm, 'column base'):
        lathe(bm, x, y, [(1.45 * r, 0), (1.5 * r, 0.3), (1.38 * r, 0.5)])
    with tagged(bm, 'papyrus column shaft'):
        lathe(bm, x, y, [(0.9 * r, 0.5), (r, 1.6), (r, 3.0), (0.86 * r, top - 0.6 - cap - 0.5), (0.84 * r, top - 0.6 - cap)])
    with tagged(bm, 'open papyrus capital'):
        z = top - 0.6 - cap
        lathe(bm, x, y, [(0.84 * r, z), (0.9 * r, z + 0.3 * cap), (1.2 * r, z + 0.65 * cap), (1.75 * r, z + 0.93 * cap), (1.85 * r, z + cap)])
    with tagged(bm, 'abacus block'):
        box(bm, x - 0.8 * r, x + 0.8 * r, y - 0.8 * r, y + 0.8 * r, top - 0.6, top)


def bud_column(bm, x, y, top, r):
    """A papyrus-bundle column: eight stems bound together, drawn in a little at the foot, tied with five bands
    under a capital of closed buds no wider than the shaft, which narrows to the abacus."""
    cap = 2.7 * r
    z = top - 0.45 - cap
    with tagged(bm, 'column base'):
        lathe(bm, x, y, [(1.5 * r, 0), (1.55 * r, 0.25), (1.42 * r, 0.4)])
    with tagged(bm, 'bundle column shaft'):
        lathe(bm, x, y, [(0.9 * r, 0.4), (r, 1.3), (0.98 * r, 2.4), (0.84 * r, z - 0.5)], seg=48, lobes=8, depth=0.09)
        lathe(bm, x, y, [(0.87 * r, z - 0.5), (0.87 * r, z)])                       # the bands that tie the stems
    with tagged(bm, 'papyrus bud capital'):
        lathe(bm, x, y, [(0.84 * r, z), (0.98 * r, z + 0.12 * cap), (0.95 * r, z + 0.32 * cap), (0.64 * r, z + cap)], seg=48, lobes=8, depth=0.09)
    with tagged(bm, 'abacus block'):
        box(bm, x - 0.7 * r, x + 0.7 * r, y - 0.7 * r, y + 0.7 * r, top - 0.45, top)


def ground(bm):
    with tagged(bm, 'sandstone paving'):
        box(bm, -(HW + WALL_T), HW + WALL_T, Y_FRONT - WALL_T, Y_END + WALL_T, -0.3, 0)


def enclosure(bm):
    with tagged(bm, 'temple wall'):
        for s in (-1, 1):
            x0, x1 = sorted((s * HW, s * (HW + WALL_T)))
            box(bm, x0, x1, Y_PYLON[1], Y_END + WALL_T, 0, WALL_H)
        # the end wall, with the sanctuary doorway cut into it
        box(bm, -HW, -2.0, Y_END, Y_END + WALL_T, 0, WALL_H)
        box(bm, 2.0, HW, Y_END, Y_END + WALL_T, 0, WALL_H)
        box(bm, -2.0, 2.0, Y_END, Y_END + WALL_T, 5.4, WALL_H)
    with tagged(bm, 'doorway jamb'):
        for s in (-1, 1):
            x0, x1 = sorted((s * 1.4, s * 2.3))
            box(bm, x0, x1, Y_END - 0.35, Y_END + 0.2, 0, 5.4)
        box(bm, -2.3, 2.3, Y_END - 0.35, Y_END + 0.2, 5.4, 6.2)
    with tagged(bm, 'cavetto cornice'):
        cavetto(bm, -2.3, 2.3, Y_END - 0.35, Y_END + 0.2, 6.2)
    with tagged(bm, 'doorway jamb'):
        # a second, smaller frame inside the first: Egyptian doorways step in towards the dark
        for s in (-1, 1):
            x0, x1 = sorted((s * 1.0, s * 1.4))
            box(bm, x0, x1, Y_END + 0.2, Y_END + 0.6, 0, 4.7)
        box(bm, -1.4, 1.4, Y_END + 0.2, Y_END + 0.6, 4.7, 5.4)
    with tagged(bm, 'sanctuary doorway'):
        box(bm, -1.0, 1.0, Y_END + 0.75, Y_END + 0.95, 0, 4.7)       # the dark of the room behind, set back
    with tagged(bm, 'stone steps'):
        box(bm, -3.6, 3.6, Y_END - 2.3, Y_END + 0.75, 0, 0.18)
        box(bm, -2.9, 2.9, Y_END - 1.5, Y_END + 0.75, 0.18, 0.36)
    with tagged(bm, 'cavetto cornice'):
        for s in (-1, 1):
            x0, x1 = sorted((s * HW, s * (HW + WALL_T)))
            cavetto(bm, x0, x1, Y_PYLON[1] + 0.7, Y_END + WALL_T, WALL_H, h=0.7, out=0.3)
        cavetto(bm, -HW, HW, Y_END, Y_END + WALL_T, WALL_H, h=0.7, out=0.3)
    with tagged(bm, 'low forecourt wall'):
        for s in (-1, 1):
            x0, x1 = sorted((s * HW, s * (HW + WALL_T)))
            box(bm, x0, x1, Y_FRONT, Y_PYLON[0] - 0.6, 0, 2.6)
        box(bm, -(HW + WALL_T), HW + WALL_T, Y_FRONT - WALL_T, Y_FRONT, 0, 2.6)


def pylon(bm):
    y0, y1 = Y_PYLON
    lean = 0.6   # how far each face leans in over the pylon's height
    with tagged(bm, 'pylon tower'):
        for s in (-1, 1):
            x0, x1 = sorted((s * GATE, s * (HW + WALL_T)))
            outer = dict(dx0=lean, dx1=0.0) if s < 0 else dict(dx0=0.0, dx1=lean)
            frustum(bm, x0, x1, y0 - lean, y1 + lean, 0, PYLON_H, dy=lean, **outer)
        # The front of each tower stands proud in three panels; the two gaps between them are the niches the
        # flagpoles stood in. The panels lean with the face, and the outermost with the tower's outer side.
        proud, niche = 0.5, 0.55   # how far the panels stand out, and half the width of a niche
        front = lambda z: y0 - lean + lean * z / PYLON_H
        for s in (-1, 1):
            outer = HW + WALL_T
            for xa, xb in ((GATE, 5.4 - niche), (5.4 + niche, 9.8 - niche), (9.8 + niche, outer)):
                top_b = xb - lean if xb == outer else xb
                lo = [(s * xa, front(0) - proud, 0), (s * xb, front(0) - proud, 0), (s * xb, front(0), 0), (s * xa, front(0), 0)]
                hi = [(s * xa, y0 - proud, PYLON_H), (s * top_b, y0 - proud, PYLON_H), (s * top_b, y0, PYLON_H), (s * xa, y0, PYLON_H)]
                prism(bm, lo, hi)
    with tagged(bm, 'cavetto cornice'):
        for s in (-1, 1):
            x0, x1 = sorted((s * GATE, s * (HW + WALL_T - lean)))
            cavetto(bm, x0, x1, y0 - 0.5, y1, PYLON_H, h=0.9, out=0.4)
    with tagged(bm, 'gateway lintel'):
        box(bm, -GATE, GATE, y0 - 0.9, y1 + 0.2, 7.0, 9.2)
    with tagged(bm, 'cavetto cornice'):
        cavetto(bm, -GATE, GATE, y0 - 0.9, y1 + 0.2, 9.2, h=0.8, out=0.4)
    with tagged(bm, 'gateway jamb'):
        for s in (-1, 1):
            x0, x1 = sorted((s * (GATE - 0.45), s * GATE))
            box(bm, x0, x1, y0 - 1.3, y1 + 0.75, 0, 7.0)


def forecourt(bm):
    # one obelisk, as at Luxor since its twin went to Paris; it stands before the western colossus, a little outside it
    x, y, s, h = -8.7, -28.8, 0.85, 10.5
    with tagged(bm, 'obelisk pedestal'):
        box(bm, x - 1.25, x + 1.25, y - 1.25, y + 1.25, 0, 1.1)
    with tagged(bm, 'red granite obelisk'):
        frustum(bm, x - s, x + s, y - s, y + s, 1.1, 1.1 + h, dx=0.3, dy=0.3)
        frustum(bm, x - s + 0.3, x + s - 0.3, y - s + 0.3, y + s - 0.3, 1.1 + h, 1.1 + h + 1.0, dx=s - 0.32, dy=s - 0.32)
    for cx in (-4.9, 4.9):
        colossus(bm, cx, -26.3)
    # the last of the avenue of sphinxes, facing each other across the way to the gate
    for y in (-32.0, -35.6, -39.2):
        sphinx(bm, -4.5, y, 90)
        sphinx(bm, 4.5, y, -90)
    fallen(bm, 10.2, -37.0, 11)
    fallen(bm, -10.6, -33.5, 12)


def head(bm, x, y, z, k=1.0, crown=False):
    """A king's head on a neck at height z, facing south: the face, and the striped headcloth that falls to the shoulders."""
    lathe(bm, x, y - 0.1 * k, [(0.24 * k, z - 0.05), (0.34 * k, z + 0.25 * k), (0.36 * k, z + 0.55 * k), (0.3 * k, z + 0.8 * k), (0.16 * k, z + 0.9 * k)], seg=12, sy=1.1)
    frustum(bm, x - 0.62 * k, x + 0.62 * k, y - 0.08 * k, y + 0.42 * k, z - 0.12 * k, z + 0.95 * k, dx=0.16 * k, dy=0.04 * k)
    if crown:
        lathe(bm, x, y + 0.05 * k, [(0.3 * k, z + 0.9 * k), (0.34 * k, z + 1.3 * k), (0.26 * k, z + 1.85 * k), (0.14 * k, z + 2.0 * k)], seg=12)


def colossus(bm, x, y, facing=0):
    """A seated king, facing south unless turned: plinth, throne, and a figure with a body, limbs and a head of its own."""
    with turned(bm, x, y, facing):
        with tagged(bm, 'statue plinth'):
            box(bm, x - 1.25, x + 1.25, y - 2.1, y + 1.5, 0, 0.9)
        with tagged(bm, 'seated colossus statue'):
            box(bm, x - 0.95, x + 0.95, y - 0.35, y + 1.2, 0.9, 2.7)                       # the throne
            box(bm, x - 0.9, x + 0.9, y + 0.75, y + 1.2, 2.7, 3.6)                         # its low back
            for s in (-1, 1):
                lathe(bm, x + s * 0.42, y - 1.05, [(0.26, 0.9), (0.3, 1.5), (0.36, 2.5), (0.34, 2.75)], seg=12)   # a lower leg
                box(bm, x + s * 0.42 - 0.24, x + s * 0.42 + 0.24, y - 1.75, y - 1.0, 0.9, 1.14)                  # its foot
                box(bm, x + s * 0.42 - 0.36, x + s * 0.42 + 0.36, y - 1.35, y + 0.3, 2.62, 3.22)                 # the thigh, under the kilt
                lathe(bm, x + s * 0.98, y + 0.2, [(0.19, 3.45), (0.23, 4.1), (0.26, 4.7), (0.18, 4.86)], seg=12)   # an upper arm
                box(bm, x + s * 0.98 - 0.19, x + s * 0.98 + 0.19, y - 1.1, y + 0.25, 3.22, 3.56)                 # the forearm, on the thigh
            lathe(bm, x, y + 0.25, [(0.62, 3.2), (0.7, 3.7), (0.88, 4.3), (0.92, 4.7), (0.5, 4.98)], seg=16, sy=0.6)  # the body
            head(bm, x, y + 0.22, 5.0, 1.1)


def standing_colossus(bm, x, y, facing=0):
    """A striding king against his back pillar, the left foot forward, the double crown on his head."""
    with turned(bm, x, y, facing):
        with tagged(bm, 'statue plinth'):
            box(bm, x - 0.75, x + 0.75, y - 1.0, y + 0.6, 0, 0.5)
        with tagged(bm, 'standing colossus statue'):
            box(bm, x - 0.45, x + 0.45, y + 0.22, y + 0.55, 0.5, 5.0)                      # the back pillar
            lathe(bm, x - 0.26, y - 0.4, [(0.2, 0.5), (0.25, 1.4), (0.3, 2.35)], seg=12)   # the left leg, striding
            lathe(bm, x + 0.26, y + 0.0, [(0.2, 0.5), (0.25, 1.4), (0.3, 2.35)], seg=12)
            frustum(bm, x - 0.58, x + 0.58, y - 0.62, y + 0.25, 2.25, 3.05, dx=0.1, dy=0.06)    # the kilt
            lathe(bm, x, y - 0.05, [(0.42, 3.0), (0.48, 3.45), (0.6, 3.95), (0.63, 4.25), (0.34, 4.5)], seg=16, sy=0.62)
            for s in (-1, 1):
                lathe(bm, x + s * 0.68, y - 0.02, [(0.13, 2.85), (0.16, 3.6), (0.19, 4.25), (0.13, 4.38)], seg=12)   # an arm at the side
            head(bm, x, y + 0.0, 4.5, 0.8, crown=True)


def sphinx(bm, x, y, facing=0):
    """A sphinx on its pedestal, facing south unless turned: a lion lying down with a king's head."""
    with turned(bm, x, y, facing):
        with tagged(bm, 'sphinx pedestal'):
            box(bm, x - 0.62, x + 0.62, y - 1.75, y + 1.5, 0, 0.6)
        with tagged(bm, 'sphinx statue'):
            lathe(bm, x, y + 0.25, [(0.8, 0.6), (1.0, 0.85), (1.0, 1.15), (0.82, 1.4), (0.4, 1.5)], seg=16, sx=0.46, sy=1.12)   # the body
            for s in (-1, 1):
                lathe(bm, x + s * 0.36, y + 0.85, [(0.3, 0.6), (0.4, 0.9), (0.36, 1.25), (0.16, 1.42)], seg=12, sx=0.62, sy=1.2)   # a haunch
                box(bm, x + s * 0.33 - 0.14, x + s * 0.33 + 0.14, y - 1.65, y - 0.6, 0.6, 0.86)                         # a foreleg
            frustum(bm, x - 0.42, x + 0.42, y - 1.0, y - 0.45, 0.6, 1.55, dx=0.08, dy=0.05)                             # the chest
            head(bm, x, y - 0.72, 1.5, 0.78)


def fallen(bm, x, y, seed):
    """A few blocks fallen from a wall, lying as they fell."""
    with tagged(bm, 'fallen stone blocks'):
        for k in range(4):
            a = seed * 12.9898 + k * 78.233
            rnd = lambda j: (math.sin(a + j * 37.719) * 43758.5453) % 1
            w, d, h = 0.8 + 0.7 * rnd(1), 0.6 + 0.4 * rnd(2), 0.45 + 0.3 * rnd(3)
            cx, cy = x + 2.4 * (rnd(4) - 0.5), y + 2.4 * (rnd(5) - 0.5)
            z = 0.0 if k < 3 else 0.45
            with turned(bm, cx, cy, 360 * rnd(6)):
                box(bm, cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2, z, z + h)


def court(bm):
    """The court behind the pylon: a portico of bud columns down each side."""
    top, r, cx = 6.8, 0.85, 9.4
    ys = [Y_PYLON[1] + 3.2 + 3.1 * k for k in range(6)]
    for s in (-1, 1):
        for y in ys:
            bud_column(bm, s * cx, y, top, r)
        with tagged(bm, 'architrave'):
            box(bm, s * cx - 0.55, s * cx + 0.55, Y_PYLON[1] + 0.6, Y_HALL, top, top + 1.0)
        with tagged(bm, 'portico roof slabs'):
            x0, x1 = sorted((s * (cx + 0.55), s * HW))
            box(bm, x0, x1, Y_PYLON[1] + 0.6, Y_HALL, top + 0.55, top + 1.0)
        standing_colossus(bm, s * 5.0, Y_PYLON[1] + 1.4, 180)       # a striding king either side of the gate, facing the court
    with tagged(bm, 'offering altar'):
        box(bm, -1.0, 1.0, -11.2, -9.2, 0, 0.25)
        box(bm, -0.8, 0.8, -11.0, -9.4, 0.25, 1.05)
    with tagged(bm, 'cavetto cornice'):
        cavetto(bm, -0.8, 0.8, -11.0, -9.4, 1.05, h=0.35, out=0.16)
    fallen(bm, 4.6, -17.2, 21)


def colonnade(bm):
    """The great colonnade: tall open papyrus columns down the nave, a lower row of bud columns in each aisle."""
    top, r, nx = 12.4, 1.3, 3.7
    side_top, side_r, sx = 8.0, 0.9, 8.6
    ys = [Y_HALL + 2.2 + 3.95 * k for k in range(6)]
    for s in (-1, 1):
        for y in ys:
            papyrus_column(bm, s * nx, y, top, r)
            bud_column(bm, s * sx, y, side_top, side_r)
        with tagged(bm, 'architrave'):
            box(bm, s * nx - 0.9, s * nx + 0.9, Y_HALL + 0.4, Y_END, top, top + 1.5)
            box(bm, s * sx - 0.65, s * sx + 0.65, Y_HALL + 0.4, Y_END, side_top, side_top + 1.0)
        with tagged(bm, 'aisle roof slabs'):
            x0, x1 = sorted((s * (sx + 0.65), s * HW))
            box(bm, x0, x1, Y_HALL + 0.4, Y_END, side_top + 0.5, side_top + 1.0)
        # what is left of the clerestory: stone window grilles standing on the aisle architrave, over three bays
        for k in (1, 2, 3):
            y0, y1 = ys[k] + 0.2, ys[k + 1] - 0.2
            with tagged(bm, 'clerestory window grille'):
                x0, x1 = s * sx - 0.3, s * sx + 0.3
                box(bm, x0, x1, y0, y0 + 0.45, side_top + 1.0, top + 0.6)
                box(bm, x0, x1, y1 - 0.45, y1, side_top + 1.0, top + 0.6)
                box(bm, x0, x1, y0 + 0.45, y1 - 0.45, side_top + 1.0, side_top + 1.5)
                box(bm, x0, x1, y0 + 0.45, y1 - 0.45, top + 0.1, top + 0.6)
                n = 6
                for j in range(n):
                    c = y0 + 0.45 + (y1 - y0 - 0.9) * (j + 0.5) / n
                    box(bm, x0 + 0.08, x1 - 0.08, c - 0.11, c + 0.11, side_top + 1.5, top + 0.1)
    fallen(bm, -11.3, 21.0, 31)
    # the wall between court and colonnade, open at the nave; a seated king either side of the way in, facing the court
    for cx in (-7.0, 7.0):
        colossus(bm, cx, Y_HALL - 1.95)
    with tagged(bm, 'temple wall'):
        for s in (-1, 1):
            x0, x1 = sorted((s * 5.6, s * HW))
            box(bm, x0, x1, Y_HALL - 0.45, Y_HALL + 0.45, 0, WALL_H)
    with tagged(bm, 'cavetto cornice'):
        for s in (-1, 1):
            x0, x1 = sorted((s * 5.6, s * HW))
            cavetto(bm, x0, x1, Y_HALL - 0.45, Y_HALL + 0.45, WALL_H, h=0.7, out=0.3)


def group_of(f):
    """Texture-space share for a face: what players see gets it; what they cannot, next to none."""
    c, n = f.calc_center_median(), f.normal
    name = LABELS[f.material_index]
    if n.z < -0.99 and c.z < 0.05:
        return 'hidden'                                   # resting on the ground
    if abs(c.x) > HW + WALL_T - 0.05 and abs(n.x) > 0.7:
        return 'hidden'                                   # the outside of the enclosure
    if (c.y > Y_END + WALL_T - 0.05 and n.y > 0.7) or (c.y < Y_FRONT - WALL_T + 0.05 and n.y < -0.7):
        return 'hidden'
    if name == 'sanctuary doorway':
        return 'seen' if n.y < -0.7 else 'hidden'
    if n.z > 0.9 and c.z > 2.7 and 'statue' not in name:
        return 'hidden'                                   # tops of walls, roofs, architraves, capitals, the pylon
    if name == 'sandstone paving':
        return 'seen' if n.z > 0.9 else 'hidden'
    if c.z > 9.5:
        return 'high'                                     # far above the eye: capitals, architraves, the pylon's top
    return 'seen'


WEIGHT = {'seen': 1.0, 'high': 0.5, 'hidden': 0.002}   # texels per square metre, relative to what players see


def uv_area(f, uv):
    pts = [l[uv].uv for l in f.loops]
    a = 0.0
    for k in range(1, len(pts) - 1):
        a += abs((pts[k].x - pts[0].x) * (pts[k + 1].y - pts[0].y) - (pts[k + 1].x - pts[0].x) * (pts[k].y - pts[0].y)) / 2
    return a


def unwrap(obj):
    """Smart UV project each group on its own, bring each to its share of texels per square metre, then pack together."""
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
        # smart project fits each group to the unit square, whatever its size in the world: undo that
        density = sum(uv_area(bm.faces[i], uv) for i in idx) / sum(bm.faces[i].calc_area() for i in idx)
        k = math.sqrt(WEIGHT[name] / density)
        for i in idx:
            for loop in bm.faces[i].loops:
                loop[uv].uv *= k
        bmesh.update_edit_mesh(obj.data)
    for f in bm.faces:
        f.select_set(True)
    bmesh.update_edit_mesh(obj.data)
    bpy.ops.uv.pack_islands(rotate=True, scale=True, margin=0.001, shape_method=PACK)
    bm = bmesh.from_edit_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    uv = bm.loops.layers.uv.active
    share, area = {}, {}
    for f in bm.faces:
        g = group_of(f)
        share[g] = share.get(g, 0.0) + uv_area(f, uv)
        area[g] = area.get(g, 0.0) + f.calc_area()
    bpy.ops.object.mode_set(mode='OBJECT')
    print('UV share by group:', {k: round(v, 3) for k, v in share.items()}, 'surface m2:', {k: round(v) for k, v in area.items()})
    seen = math.sqrt(share['seen'] / area['seen'])
    print(f'what players see gets {seen * 8192:.0f} texels per metre on an 8192 px texture')


PACK = 'CONCAVE'


def main():
    out = sys.argv[sys.argv.index('--') + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bm = bmesh.new()
    ground(bm)
    enclosure(bm)
    pylon(bm)
    forecourt(bm)
    court(bm)
    colonnade(bm)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    # drop faces resting on or under the ground: never visible, they'd only waste texture space
    bm.faces.ensure_lookup_table()
    drop = [f for f in bm.faces if f.normal.z < -0.99 and f.calc_center_median().z < 0.02]
    bmesh.ops.delete(bm, geom=drop, context='FACES')
    mesh = bpy.data.meshes.new('luxor')
    bm.to_mesh(mesh)
    bm.free()
    mesh.set_sharp_from_angle(angle=math.radians(40))     # columns are round; everything else keeps its edges
    obj = bpy.data.objects.new('luxor', mesh)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    for name in LABELS:
        obj.data.materials.append(bpy.data.materials.new(name))
    unwrap(obj)
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True)
    print('DONE', out, len(mesh.polygons), 'faces', round(sum(p.area for p in mesh.polygons)), 'm2', len(LABELS), 'parts')


main()
