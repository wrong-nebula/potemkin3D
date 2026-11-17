# Material study: Luxor wall and Sento floor

Open `http://localhost:5178/experiments/material-lab/` after `npm run dev -- --host 127.0.0.1 --port 5178`.

The page has a wipe comparison, three camera presets, orbit/zoom controls, a moving light, and albedo, roughness and preservation-mask views. All original scene assets remain unchanged. New work is contained in this directory and `output/playwright/material-lab/`.

## What is being compared

Before is the original exported PBR material under fixed evaluation lighting. After adds a reusable material layer to the selected wall/floor. Both use the same geometry, atlas UVs, camera, exposure, environment, lights, shadow map and resolution. There is no post-processing, sharpening, blur, grain or dynamic resolution. This is a material benchmark, not the complete Luxor film/weather/POM renderer.

Luxor keeps the original atlas and macro normals. A 512² stone exemplar supplies high-frequency colour, calibrated roughness, and inferred height. Three overlapping, deterministic samples share their coordinates across all fields. The sample is 0.22 m wide; the inferred height span is limited to 1.2 mm. Original glyph strokes, strong edges and red pigment are conservatively masked. The new layer improves stone grain; it cannot recover blurred inscriptions.

Sento reuses the original 1024² mosaic sample at its existing 1 m world scale, including its mirrored placement. The original atlas's broad colour and added stains remain. The shader restores sample frequencies beyond the atlas's sampling density. It identifies 169 tile interiors, keeps the grout layout, and performs a small deterministic local-mean exchange between sample regions. Roughness varies around 0.32 for glaze and 0.88 for grout. The inferred height span is 2 mm. Original paint added after the material kit is masked.

Added normals are differentiated from the same height field used by the material. The height is inferred by PATINA, not measured; amplitude and roughness are artist-selected. Both surfaces are dielectrics. Runtime relief affects lighting only; it does not change silhouettes, collision or shadow geometry.

This is an adaptation of the exemplar/material-layer approach. It is not a full implementation of MeshNCA or Lutz and Gilet's region-filtering algorithm. Stone uses correlated sample blending; Sento uses the existing sample layout and a restrained mean exchange. The region lookup is nearest-neighbour, with colour/height/roughness mip-filtered and the layer fading at distance.

## Reproduce

The prepared assets are already saved. No API key is needed to view, benchmark or rebuild the packed fields.

```sh
python3 experiments/material-lab/prepare.py
TROMPE_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node experiments/material-lab/benchmark.mjs
python3 experiments/material-lab/report.py
```

`benchmark.mjs` creates its own temporary Vite server. It compares before/after in adjacent animation frames, alternating AB/BA order, with two fresh browser contexts per scene. Each of the three poses gets 24 warmup frames and 96 pairs of GPU timer-query samples in each run. GPU completion is synchronized outside each timed query to isolate deferred work on tile-based GPUs. Both materials share the base textures in the timing context. The report shows the range of the two run medians and the per-run median paired delta. Absolute times varied substantially on this machine; these are provisional measurements, and should be repeated on an idle target device before setting a performance budget. Background GPU work and clock changes can affect absolute times. Static shadows are cached. Disjoint/expired queries and shader errors fail validation. CPU measurements are submission time, not total frame time. GPU values are not whole-game FPS.

`report.py` checks original asset SHA-256 hashes, verifies zero albedo changes on protected visible pixels, and builds:

- `output/playwright/material-lab/comparisons.html`: all comparisons and measurements.
- `luxor-comparison.png`, `sento-comparison.png`: labelled before/after boards.
- `*-detail-comparison.png`: crops at native pixel size.
- `*-preservation-overlay.png`, `*-relit-*.png`: masks and changed-light comparisons.
- `benchmark.json`, `summary.json`: raw results and validation.

Required texture payload is estimated from actual texture dimensions, formats and mip chains. Both variants are resident during paired timing; the baseline payload excludes the unused detail assets. It includes the environment and colour shadow texture, but excludes driver overhead, depth renderbuffers, browser/compositor buffers and CPU image copies. It is not a measured VRAM counter. The extra texture payload is 2.67 MiB for stone and 6.67 MiB for tile.

## Assets and optional prediction

`inputs.py` extracts a plain 186² sandstone patch from the existing Luxor reference image and reuses the original Sento mosaic sample. The stone crop is resized for inference; this does not create new photographic detail. The two exact image uploads were approved by the user and processed once each by `fal-ai/patina`, seed 1701. The raw maps and request metadata are saved in `assets/`.

`predict.mjs` is an optional one-time regeneration tool. It reads a credential from `FAL_KEY` or stdin and never writes the credential into an asset or metadata file. Cached predictions are reused. Do not call it simply to rerun the benchmark.

The automatic preservation masks need visual review before generalizing to other scenes. Plain glTF export of the new runtime effect would require baking or custom shader support. The next useful comparison is a larger floor atlas versus this reusable detail layer at equal texture-memory budgets.
