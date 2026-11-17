# Sento floor in the main viewer

Open `http://localhost:5178/?sample=sento`, or choose **Sento · painted floor** in the Level menu. The **Fine floor detail · Lit view** checkbox compares the original painting with the material layer. Textured mode remains the original paint inspection view.

The renderer implementation is `src/core/floor-detail.ts`, composed with `Viewer`'s paged-atlas/reveal shader. It uses the part's label, world X/−Z coordinates, a 1 m mirrored sample, 169 tile regions, and a 2 mm inferred height span. Color detail, roughness and height use the same coordinates; normals come from the height gradient. The existing Relief control scales the added normals. The layer fades between 4 and 10 m.

The mask protects all original material channels. Fully protected pixels are unchanged even at a mask boundary. The atlas itself is never modified by the detail renderer. Assignments require an explicit material label and matching UV-layout fingerprint. Repainting, replacing parts, applying ground notes, importing paint or resetting the atlas invalidates the layer. It cannot be re-enabled with an old mask. Loading another level disposes the auxiliary textures.

Saved runs retain a valid layer's settings, toggle state and paint fingerprint. Restoration checks both the UV layout and the exact reconstructed paint; mismatches leave detail off. Same-origin image URLs are saved as portable paths. Custom material images must remain available at their saved URLs. The layer is a runtime shader effect: plain glTF/texture downloads retain the original painting and any baked PBR maps, not this added detail. The Export section states that limitation.

The three detail images require **6,991,529 bytes (6.67 MiB)** of texture payload, including mipmaps. No geometry or draw calls are added. This is not total browser/GPU memory. The prepared scene and its assets load on demand and are included in production builds. Viewing it makes no FAL calls.

## Sources

- `hall.glb` and `paint.jpg` are unchanged copies of `experiments/sento/out/world/hall/hall_textured.glb` and `texture.jpg`.
- `packed.png`, `protect.png` and `statistics.png` are the validated tile fields from `experiments/material-lab/assets/`. The packed field comes from the original Sento mosaic plus the previously approved PATINA prediction; the mask compares the original kit atlas with the painted atlas.
- Original lab provenance, prediction metadata and preparation code remain in `experiments/material-lab/`.

The main preset uses the main viewer's lighting and atlas pipeline. It does not import the experimental viewer's baked lighting or object-space normal maps. Other scenes keep their normal main-viewer behavior.

The prepared scene now also assigns glazed-tile and timber responses to explicitly named surfaces. Change them in **Materials**. Height and roughness respond together, while the paint stays unchanged. The two 1024² atlas material maps add 10.67 MiB of texture payload beyond the floor layer above. See [material maps](../../../docs/material-maps.md) for presets, imports and verification.

## API and verification

```js
await trompe.loadSentoFloor();
trompe.floorDetailEnabled(false); // original material
trompe.floorDetailEnabled(true);  // reviewed detail layer

// Other surfaces require their own reviewed mask and assignment.
await trompe.floorDetail(spec);   // FloorDetailSpec in src/core/floor-detail.ts
await trompe.floorDetail();       // remove and dispose
```

```sh
npm test -- test/floor-detail.test.ts test/pages.test.ts
node scripts/check-floor-detail.mjs
python3 scripts/report-floor-detail.py
npm run build
```

Browser captures and validation results go to `output/playwright/sento-main/`. The regression check verifies stock-renderer equivalence when disabled (within one output byte of shader rounding), unchanged paint, unchanged draw calls, layout/material rejection, repaint invalidation, portable settings, paint-fingerprint restoration and texture disposal. The image check separately requires exact equality on protected pixels in both albedo and lit views.
