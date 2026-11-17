# Shared-scene comparison

Open `/experiments/benchmark/` on the existing Vite server (`npm run dev`). The tool compares matched camera images, coverage overlays, raw-target fusion holdouts, and synchronized 3D views. The report downloads as JSON.

## What was ported into Trompe

- `src/core/validation.ts`: geometry-reprojected cross-view agreement, separate low-frequency color and high-frequency detail errors, explicit support counts, and observed/inferred/missing visualization. Unlike a blur across a UV atlas, the image filters stay within semantic part boundaries.
- `src/core/validation-engine.ts`: isolated raw-target replay and fusion leave-one-view-out. The loaded painting is not mutated. Saved composites are never used as independent targets.
- `trompe.validate(runId, options)` / `npm run validate -- --run ID --level samples/LEVEL.glb`: evaluate saved Trompe runs without paid calls. Default: at most 12 views through the CLI, a 256² evaluation image, and a 2048² validation atlas. Report resolution and layout remain explicit.
- Coverage capture in the production view renderer distinguishes real projected observations from the finishing fill. Validation engines now release their GPU resources.

The protocol is inspired by [multiview-to-real](https://github.com/gokayfem/multiview-to-real), pinned at `4885e248aa58f425eba88309b14176524a4ec3ef`. The external implementation is run unmodified. Its MIT notice is retained in `UPSTREAM_LICENSE`.

## Scene and experiments

`samples/build_tatooine.py` produces an original Tatooine-inspired courtyard, 25,408 triangles and 19 semantic groups, plus six calibrated source cameras. Three novel cameras are stored only in JSON. Both exports describe the same geometry in metres. The `.blend` uses Z-up and GLB uses Y-up; the camera JSON includes both conventions.

The first measured run used FLUX 3 Klein for both methods and a user-approved $5 cap. It made **17** requests: six independent images, six sequential images, one joint grid and four refinements. Upstream skipped two rejected grid cells and rejected all four refinements, retaining the original cells. Listed-rate estimated cost is **$0.20**, including a conservative 4K charge for the grid; the reserved ceiling was $0.684. This is a price estimate, not an invoice.

Three comparisons are kept separate:

1. **Shared AI targets:** both methods receive the exact same six independently generated images, resized once to 512². Upstream retains its strict acceptance rules and accepts four; Trompe’s controlled raw projection uses all six. This is a projection/fusion ablation, without Trompe’s SAM/plane rejection, automatic repair, ground synthesis or PBR passes.
2. **Synthetic calibration:** camera-independent, procedural emission materials provide known reference colors. Both projectors receive the same six images. These images are not AI results.
3. **Sequential vs joint grid:** the same geometry and cameras, different generation/compositing strategies. Appearance and coverage are comparable; error against either method’s own generated target is not an unbiased quality ranking. The sequential adapter uses production compositing/projection with no SAM/plane passes.

Trompe uses one 2048² atlas (4.19M texels). Upstream uses nineteen 512² maps (4.98M texels) and its own per-object UV repacking. Texture budgets are reported, not claimed equal. Evaluation uses unlit color in the same Three.js renderer, no post-processing. This initial run does not benchmark full game framerate or relighting quality.

Coverage has a fixed geometry-pixel denominator with a two-pixel boundary erosion. Paired image errors use the **exact same intersection of confidently observed pixels** for both methods. Missing surfaces cannot improve an error without lowering the separately reported support. Upstream’s soft/grazing observations count with inferred fill in this strict comparison. All error values are sRGB code-value MAE (0–255), not Delta E or physical accuracy. The report also retains full-surface errors and per-part support.

Fusion holdout excludes a raw target from projection. It does not remove information that jointly or sequentially generated images might already share. Rejected upstream cameras have no paired holdout; the UI shows no evidence rather than recycling another image. Novel-view error is available only for synthetic truth.

## Reproduce

Install Python 3.10+, Blender 4.2+, Node dependencies and Chrome/Playwright. Keep the external dependency outside this checkout:

```sh
git clone https://github.com/gokayfem/multiview-to-real /tmp/trompe-multiview-to-real
git -C /tmp/trompe-multiview-to-real checkout 4885e248aa58f425eba88309b14176524a4ec3ef
python3 -m venv /tmp/trompe-benchmark-venv
/tmp/trompe-benchmark-venv/bin/pip install -r /tmp/trompe-multiview-to-real/requirements.txt
export BLENDER=/Applications/Blender.app/Contents/MacOS/Blender
export MVB2R_PYTHON=/tmp/trompe-benchmark-venv/bin/python
export MVB2R_ROOT=/tmp/trompe-multiview-to-real
export TROMPE_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
```

Set `FAL_KEY` in the process environment for generation; never put it in tracked files. Existing output replay makes no model calls:

```sh
npm run benchmark:compare
# First common-target comparison, six paid calls, only when requested:
npm run benchmark:compare -- --generate --budget 5
```

Build the scene again if necessary:

```sh
"$BLENDER" -b --factory-startup --disable-autoexec --python samples/build_tatooine.py -- samples/tatooine.glb
"$BLENDER" -b --factory-startup --disable-autoexec --python samples/render_tatooine_truth.py
```

The lower-level adapter supports `--stage independent`, `trompe`, `sequential`, or `render-upstream`; `--dataset common|truth` selects the replay. Sequential generation is an explicit six-call operation and refuses ambiguous retries. Each independent request reserves the highest listed Klein price before submission, saves the request ID immediately, and resumes the same request after an interruption. The native upstream case uses `max_calls: 7`; its artifacts and logs are retained under `upstream-grid`. Never relax its acceptance thresholds after seeing results.

To run the native upstream generation on a fresh case with the six scene cameras, **omit `--views`** when calling its `new` stage, or it will replace those cameras. Run `scripts/benchmark-upstream.py configure CASE`, then upstream `probe CASE`, configure once more to set the matched seed, then `grid`, `generate`, `refine`, `targets`, `project`. Use the checked-out upstream CLI, not a substitute implementation. `scripts/benchmark-export.py` exports its actual textures and raises on missing maps.

## Verification

```sh
npm test
npm run build
node scripts/check-benchmark.mjs http://127.0.0.1:5179/experiments/benchmark/
```

Numerical tests cover exact reprojection, known color offsets, occlusion/object rejection, part-isolated filtering, no-evidence behavior, and support denominators. The synthetic scene is an independent geometric calibration. UI checks exercise all datasets, source/novel cameras, coverage, holdout availability, wipe controls, 3D mode, keyboard operation, missing-report handling and narrow screens. Screenshots and the check report are written to `output/playwright/benchmark/`.

Large local run artifacts live under `output/benchmark/tatooine/`. The portable comparison files are `results.json`, each dataset’s `renders/` and `heldout/`, and the appearance GLBs referenced by the UI. No API key is present in them.
