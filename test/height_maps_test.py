import importlib.util
from pathlib import Path
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location('height_maps', Path(__file__).resolve().parents[1] / 'experiments/luxor-view/height_maps.py')
maps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maps)


class HeightMapsTest(unittest.TestCase):
    def test_offset_tiles_reconstruct_the_same_field_without_seams(self):
        y, x = np.mgrid[:48, :48]
        field = (0.25 + x * .002 + y * .001 + np.sin(x * .7) * .05).astype(np.float32)
        tiles, raw = [], []
        for row, yy in enumerate([0, 16]):
            for col, xx in enumerate([0, 16]):
                tiles.append(dict(id=f'{row}-{col}', x=xx, y=yy, row=row, col=col, region=32))
                raw.append(field[yy:yy+32, xx:xx+32] + .11 * (row * 2 + col))
        result, _ = maps.blend_page(tiles, raw, 48)
        np.testing.assert_allclose(result, field, atol=2e-7)

    def test_incomplete_coverage_is_an_error(self):
        with self.assertRaisesRegex(ValueError, 'cover'):
            maps.blend_page([dict(id='a', x=0, y=0, row=0, col=0, region=8)], [np.ones((8, 8), np.float32)], 16)

    def test_float_baseline_preserves_flat_surfaces(self):
        values = np.full((80, 80), .413578, np.float32)
        np.testing.assert_allclose(maps.broad_height(values, 8), values, atol=1e-7)

    def test_detrending_removes_tilt_but_keeps_small_relief(self):
        y, x = np.mgrid[:128, :128]
        tilt = (.3 + x * .001 + y * .0007).astype(np.float32)
        detail = np.sin(x * np.pi / 4).astype(np.float32) * .03
        field = tilt + detail
        filtered = field - maps.broad_height(field, 8)
        np.testing.assert_allclose(filtered[32:-32, 32:-32], detail[32:-32, 32:-32], atol=5e-5)

    def test_packed_neighbours_cannot_create_a_height_ridge(self):
        values = np.full((32, 32), .2, np.float32)
        values[:, 16:] = .9
        islands = np.ones((32, 32), np.int32)
        islands[:, 16:] = 2
        detail = maps.surface_detail(values, islands, {1: [0, 0, 16, 32], 2: [16, 0, 32, 32]}, 4)
        np.testing.assert_allclose(detail, 0, atol=1e-7)


if __name__ == '__main__':
    unittest.main()
