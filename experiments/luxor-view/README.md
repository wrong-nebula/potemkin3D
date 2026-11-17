# Luxor viewer

Generate height maps once from the saved Luxor textures, build the walk-through, then serve it with the main dev server:

```sh
node experiments/luxor-view/height.mjs --run luxor-02 --quote
node experiments/luxor-view/height.mjs --run luxor-02
node experiments/luxor-view/build.mjs --run luxor-02
npm run dev
```

Open `http://localhost:5178/deploy/luxor/`. Press **5** for a close, oblique view of the carved wall and **P** to compare parallax occlusion mapping on/off. POM is enabled by default, at up to 25 mm of recessed depth. Hold **9 / 0** to decrease/increase depth; **J** toggles shadows inside the carving. **M** disables POM along with the other material effects. `?pom=0` starts without POM; `?depth=0.02` sets the maximum depth in metres (0–0.12); `?pomShadow=0` disables cavity shadows.

POM uses dedicated PATINA height maps for all four texture pages. Height is sampled as linear data, with white highest and black deepest; the shader never derives height from albedo. View tracing, bump slopes and cavity shadows all use the same generated field. This is a surface effect: silhouettes, collision and shadows cast onto other surfaces still use the original mesh.

`height.mjs` sends sixteen overlapping 2048 px inputs to `fal-ai/patina`, requesting only `height` with seed 7. The current estimate is $0.83 for a fresh batch ($0.01 per call plus $0.01 per megapixel for one output map). It reads the existing `FAL_KEY` configuration. Every request ID and returned PNG is cached under `runs/<run>/height/`, so rerunning resumes without repeating completed calls. `--pack-only` reassembles saved predictions for free; changing source textures requires a new `--out` folder.

`height_maps.py` matches offsets between tiles in their overlaps and feathers the joins. It removes broad predicted depth drift independently within each geometry UV island, then normalizes all four pages with one shared range. The output includes lossless grayscale 4096² and 2048² web maps, 16-bit masters of the blended field (the model itself returns 8-bit data), and a `height.json` manifest with source hashes and processing information. The build copies these maps into `hi/` and verifies their source texture hashes; it makes no API calls. Model-predicted heights describe relative relief, not measured physical dimensions; **9 / 0** controls their physical depth in the viewer.

`pom.js` composes with the existing weathering shader. Enlarged height samples use cubic reconstruction to round off texel-sized ridges. It traces 12–40 layers based on the distance travelled through the texture, refines the first intersection five times, then interpolates the final bracket. Bump slopes come from the same height field at the hit, rather than derivatives of the warped screen image. A second, 12-step trace towards each directional light softly shadows recesses; ambient light stays intact.

Colour, normals, roughness, metalness and occlusion use the same shifted coordinates and share the export's untransformed UV0 atlas. Height uploads as single-channel R8 with mipmaps and no colour-space conversion. The 2K height maps load even with `?hi=0`; streamed 4K colour, normal and height maps switch together, and eviction restores all three low-resolution maps. A failed or missing height map disables POM for that page, with its status shown in the HUD.

A 1024² island-ID texture per mesh prevents rays from reading another packed island. Its alpha channel stores a conservative distance to the island boundary, allowing relief to fade smoothly before a ray leaves it; tiny islands fall back to normal mapping. Relief also fades between 8 and 22 metres and at extreme grazing angles. The maximum offset is 12/4096 UV units, independent of streamed resolution.

`npm test -- test/pom.test.js` checks island packing, mirrored UVs, conservative boundary distances, BVH indexing, shader composition, dedicated height uniforms and LOD restoration. `python3 -m unittest discover -s test -p 'height_maps_test.py'` checks tile joins, coverage and height detrending. For GPU checks, serve the built viewer and run:

```sh
node experiments/luxor-view/check-pom.mjs http://localhost:5178/deploy/luxor/
```

It uses the repository's Playwright browser launcher (`TROMPE_CHROME` can point to an installed Chrome). It checks both 2K and streamed 4K height textures, cavity shadows, disabled and distant views, a short camera path, keyboard controls, missing-map fallback, and browser/shader errors. Matched screenshots and the report go to `output/playwright/pom-height/`.

For manual comparisons use a fixed resolution (`?res=1&ratio=1`), turn off depth of field, motion blur, film grain and dust, and capture both states synchronously with `luxorView.snapshot()` so lighting and camera position match. `?hi=0` keeps the 2K textures for testing the initial load.
