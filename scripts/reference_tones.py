"""Bring a set of reference photos to one tone, and closer to albedo, before they are sent to the image model.

Run: python3 scripts/reference_tones.py references/luxor/raw references/luxor [--key 01_hypostyle_columns.jpg]

Photos of one place come in every light: one in hard sun, one in blue shade, one under a floodlight. A model shown
them takes the light along with the stone, and each view leans towards whichever photo it liked. So, per photo:

- the sky is found (blue, or blown white) and left out of every measurement;
- the light is flattened: the slow changes in brightness across the picture (a lit side and a shaded side, a
  shadow lying over half a wall) are taken out, shadows are lifted and highlights brought down, while the fine
  shading that shows the carving stays;
- the colour of the stone is moved to the key photo's: the same mean hue and the same spread, so all of them are
  the one stone. The key is the first file unless --key names another.

Written as fresh JPEGs, so none of the sources' metadata comes along.
"""
import argparse
import os

import numpy as np
from PIL import Image

FLATTEN = 0.9      # share of the slow brightness changes taken out
CONTRAST = 0.85    # what is left of the contrast around the mean
SHADOWS = 0.5      # darker than the mean: this share of the distance to it is kept
LIGHTNESS = 57.0   # the stone's mean lightness afterwards (CIE L*)
SIGMA = 0.07       # the blur that separates light from surface, as a share of the picture's shorter side


def to_lab(rgb):
    c = rgb.astype(np.float64) / 255
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    m = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
    xyz = lin @ m.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def to_rgb(lab):
    fy = (lab[..., 0] + 16) / 116
    f = np.stack([fy + lab[..., 1] / 500, fy, fy - lab[..., 2] / 200], -1)
    xyz = np.where(f > 0.206893, f ** 3, (f - 16 / 116) / 7.787) * np.array([0.95047, 1.0, 1.08883])
    m = np.array([[3.2404542, -1.5371385, -0.4985314], [-0.9692660, 1.8760108, 0.0415560], [0.0556434, -0.2040259, 1.0572252]])
    lin = np.clip(xyz @ m.T, 0, 1)
    c = np.where(lin <= 0.0031308, 12.92 * lin, 1.055 * lin ** (1 / 2.4) - 0.055)
    return np.clip(np.round(255 * c), 0, 255).astype(np.uint8)


def blur(a, weight, sigma):
    """A wide Gaussian blur of `a` that ignores what `weight` leaves out: done small, where it is cheap, and scaled back up."""
    h, w = a.shape
    k = max(1.0, sigma / 6)   # work at a size where the blur is about 6 px
    small = (max(8, round(w / k)), max(8, round(h / k)))

    def low(x):
        im = Image.fromarray(x.astype(np.float32), 'F').resize(small, Image.BOX)
        x = np.asarray(im, dtype=np.float64)
        r = max(1, int(round(3 * sigma / k)))
        g = np.exp(-0.5 * (np.arange(-r, r + 1) / (sigma / k)) ** 2)
        g /= g.sum()
        x = np.apply_along_axis(lambda v: np.convolve(np.pad(v, r, mode='edge'), g, mode='valid'), 1, x)
        x = np.apply_along_axis(lambda v: np.convolve(np.pad(v, r, mode='edge'), g, mode='valid'), 0, x)
        return np.asarray(Image.fromarray(x.astype(np.float32), 'F').resize((w, h), Image.BICUBIC), dtype=np.float64)

    return low(a * weight) / np.maximum(low(weight), 1e-3)


def surface(lab):
    """1 where the picture shows the stone: not sky, not blown white.

    Gray stone in shade is a little blue too, so only a bright, clearly blue pixel counts as sky by itself. Clouds
    and haze are sky as well: whatever is bright and not warm, and joined to deep blue sky."""
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    sky = ((b < -14) & (L > 50)) | ((L > 93) & (np.hypot(a, b) < 10))
    seed = (b < -22) & (L > 55)
    if seed.mean() > 0.02:
        pale = (b < 10) & (L > 55)
        grown = seed.copy()
        for _ in range(2000):
            g = grown.copy()
            g[1:] |= grown[:-1]; g[:-1] |= grown[1:]; g[:, 1:] |= grown[:, :-1]; g[:, :-1] |= grown[:, 1:]
            g &= pale
            g |= grown
            if g.sum() == grown.sum():
                break
            grown = g
        sky |= grown
    return (~sky).astype(np.float64)


def stone_colour(lab, mask):
    """Mean and spread of the stone's colour (a*, b*), over its mid-tones: deep shadow and glare say little of it."""
    L = lab[..., 0]
    lo, hi = np.percentile(L[mask > 0], [25, 90])
    pick = (mask > 0) & (L >= lo) & (L <= hi)
    ab = lab[pick][:, 1:]
    return ab.mean(0), ab.std(0)


def flatten(lab, mask, sigma):
    """Take the light out of the lightness channel; the colour channels lose their slow drift too (blue shade, warm bounce)."""
    out = lab.copy()
    L = lab[..., 0]
    mean = (L * mask).sum() / mask.sum()
    L = L - FLATTEN * (blur(L, mask, sigma) - mean)
    d = L - mean
    L = mean + CONTRAST * np.where(d < 0, SHADOWS * d, d)
    out[..., 0] = np.where(mask > 0, L + (LIGHTNESS - mean), lab[..., 0])
    for ch in (1, 2):
        c = lab[..., ch]
        m = (c * mask).sum() / mask.sum()
        out[..., ch] = np.where(mask > 0, c - 0.6 * (blur(c, mask, sigma) - m), c)
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument('src')
    p.add_argument('out')
    p.add_argument('--key', help='the photo whose stone colour the others take (default: the first)')
    p.add_argument('--strength', type=float, default=1.0, help='how far the colour moves to the key (0 to 1)')
    a = p.parse_args()
    files = sorted(f for f in os.listdir(a.src) if f.lower().endswith(('.jpg', '.jpeg', '.png')))
    key = a.key or files[0]
    done = {}
    for f in [key] + [f for f in files if f != key]:
        lab = to_lab(np.asarray(Image.open(os.path.join(a.src, f)).convert('RGB')))
        mask = surface(lab)
        flat = flatten(lab, mask, SIGMA * min(lab.shape[:2]))
        mean, std = stone_colour(flat, mask)
        if f == key:
            target = (mean, std)
        t_mean, t_std = target
        gain = np.clip(t_std / np.maximum(std, 1e-3), 0.6, 1.8)
        for ch in (1, 2):
            moved = t_mean[ch - 1] + gain[ch - 1] * (flat[..., ch] - mean[ch - 1])
            flat[..., ch] = np.where(mask > 0, (1 - a.strength) * flat[..., ch] + a.strength * moved, flat[..., ch])
        done[f] = flat
        after = stone_colour(flat, mask)[0]
        print(f'{f}: stone a*, b* {mean.round(1)} -> {after.round(1)}; sky or glare {100 * (1 - mask.mean()):.0f}% of it')
    os.makedirs(a.out, exist_ok=True)
    for f, lab in done.items():
        Image.fromarray(to_rgb(lab)).save(os.path.join(a.out, os.path.splitext(f)[0] + '.jpg'), quality=92)


main()
