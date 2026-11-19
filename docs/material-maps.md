# Material responses and aligned maps

Open `http://127.0.0.1:5178/?sample=sento` and use **Materials → Material surface → Material response**. The prepared Sento scene starts with tile and timber assignments from its explicit surface names. Other scenes keep their original response until a preset is assigned. **Use presets from surface names** makes editable suggestions; ambiguous names stay unassigned.

| Preset | Base roughness | Metalness | Height span | Existing-normal gain |
| --- | ---: | ---: | ---: | ---: |
| Limestone | 0.82 | 0.00 | 1.20 mm | 0.30 |
| Glazed tile | 0.32 | 0.00 | 2.00 mm | 0.18 |
| Painted metal | 0.42 | 0.00 | 0.25 mm | 0.15 |
| Timber | 0.62 | 0.00 | 0.70 mm | 0.25 |
| Hard surface | 0.38 | 0.00 | 0.35 mm | 0.20 |
| Bare / forged metal (`metal`) | 0.28 | 0.88 | 0.30 mm | 0.22 |
| Woven fabric (`fabric`) | 0.88 | 0.00 | 0.55 mm | 0.28 |
| Organic / skin (`organic`) | 0.68 | 0.00 | 0.45 mm | 0.20 |

These are artist-selected starting points, not measured physical properties. Height span means the difference between black and white in the source height field. Presets also cap slopes and scale roughness variation. `Bare / forged metal` (`metal`) is a conductor (`metalness 0.88`, writing ORM's B channel and exporting `metallicFactor: 1`); `Painted metal` models a dielectric paint coating whose exposed ridges gain metallic wear when `edgeWear` is supplied. Presets change lighting response; they do not generate a stone pattern, wood grain or new painted details.

## Shared source fields and intrinsic PBR

The practical inspiration is [MeshNCA's joint PBR texture synthesis](https://meshnca.github.io/), where related channels share one synthesis process. Trompe uses the alignment principle; it does not train or run MeshNCA.

Two source paths feed `buildAlignedMaps` (`src/core/aligned-maps.ts`):
- **Intrinsic albedo + geometry decomposition (`kind: 'intrinsic-pbr'`, `--pbr-mode intrinsic`, or automatic under `--provider local`):** `estimateIntrinsicPbr` (`src/core/pbr.ts`) decomposes the consolidated/refined albedo together with 3D world position/normal buffers and geometry prepasses (`openness`, signed convex `curvature`, `faceClass`, part labels and `materialPresets`) into aligned `height` (preserving POM), `roughness`, `metalness` (demetallizing warm oxide rust and cavity grime while exposing metallic convex ridges), `refinedNormal` and `edgeWear` in ~0.2 s at $0.
- **Hosted PATINA prediction (`kind: 'predicted-height'`, `--pbr-mode patina` or cloud `auto`):** requests height and roughness together per crop, removes broad low-frequency drift conservatively, and fuses intrinsic `metalness`, `refinedNormal` and `edgeWear` onto the same UV grid.

Normals are derived from physical height in world units (with each material's height span and slope limit); for `dedicated-height` imports, height strictly governs the derived normal, whereas `intrinsic-pbr` and `predicted-height` fuse `refinedNormal` micro-detail atop the height slope. Surface boundaries and differently oriented UV islands never contribute derivatives across their edges. Ambient occlusion (`src/core/ao.ts`, `src/core/fast-sdf-ao.ts`) defaults to hybrid `Fast-SDF-AO` (Contact BVH + 1-Lipschitz `R16F` SDF), saving both `ao.png` and world-space `bent_normal.png` (used by `Viewer` for directional sky/ground irradiance and Jimenez cone specular occlusion). When `ao.size < pbr.size`, `withOcclusion` uses Geometry-Guided Joint Bilateral Upsampling (`src/core/jbu.ts`, adapted from `mrdoob/three.js#35602`) so reduced-resolution AO never leaks across 90° creases or UV gutters. Packed glTF `orm.png` stores occlusion (R), roughness (G) and metalness (B), while `trompe.exportPbr({ format: 'both' })` (and CLI/MCP `exportPbr`) also unpacks separate linear `roughness`, `metalness`, `occlusion`, `height` and `normal` PNGs. `exportGlb` emits lit glTF 2.0 `pbrMetallicRoughness` materials in standard PNG or UASTC + Zstandard KTX2 (`format: 'ktx2'`, `KHR_texture_basisu` + `KHR_SUPERCOMPRESSION_ZSTD`, 4× lower GPU VRAM and >3× smaller disk size).

Where only existing normals are available, presets reduce their relief. Where neither height nor normals exists, the normal remains flat. The painted atlas is never rewritten, and paint brightness is never directly treated as height. Aligned coordinates cannot guarantee that a model inferred the real physical surface correctly; predicted fields still warrant visual review.

The Sento floor keeps its reviewed world-space detail field and paint-protection mask. Its height, roughness and color detail share coordinates; the chosen preset now controls the response of that field too. The floor's high-resolution shader layer remains a runtime effect and is not baked into a plain glTF export. Atlas normal/roughness maps are exported normally.

## Local imports and persistence

```js
// Preserve other assignments while changing one named surface.
trompe.materialPresets({
  ...trompe.session.engine.materialPresets,
  'tiled bathhouse floor': 'glazed-tile',
});

// Import a reviewed set already registered to the current paint atlas.
// Obtain the UV fingerprint from layoutHash(level.geometry.getAttribute('uv').array),
// exported by src/core/layout.ts; it is also retained in saved source metadata.
await trompe.materialMaps({
  size: 1024,
  layoutHash: 'the-reviewed-UV-fingerprint',
  heightUrl: '/materials/height.png',
  roughnessUrl: '/materials/roughness.png',
});
```

Imports must be square, exactly the declared dimensions and registered to the declared UV layout; they are not silently resized. Use linear grayscale height/roughness PNGs and glTF-convention tangent normals. Height is read from R, alpha marks valid height samples; roughness is read from R and packed into ORM's G. Absolute roughness preserves variation around each material's median; set `roughnessBase` only for a relative field with a known baseline. A matching fingerprint validates the declared layout, not the visual registration of arbitrary imported pixels.

Source fields remain separate from the derived maps. Changing a preset rebuilds from those fields without another model call or cumulative filtering. Saved runs include assignments, processed maps and lossless source PNGs. Legacy runs still load. The source layout is checked again on restoration.

## Cost and verification

Local preset changes make no paid model calls and add no draws or geometry. A scene with no existing PBR maps gets two 1024² RGBA textures: **10.67 MiB** including mipmaps. Sento's three existing floor-detail textures use another **6.67 MiB**. These are texture payload estimates, not total browser/GPU memory. Repeated changes replace and dispose the two PBR textures. Source PNG pixels stay in CPU memory when supplied; a height-plus-roughness pair uses 8 MiB at 1024². Building maps also temporarily reads geometry fields at the map resolution, so peak working memory scales with resolution.

```sh
npm test
npm run build
node scripts/check-material-presets.mjs
python3 scripts/report-material-presets.py
node scripts/check-floor-detail.mjs
python3 scripts/report-floor-detail.py
```

Browser results and matched-camera captures are in `output/playwright/material-presets/`. Checks cover full paint-atlas identity, color-only identity across all four responses, height precedence, dimension/layout rejection, stable draw/texture counts, source/map/preset save-load and glTF map export. Timings are local 1280×720 Chrome measurements, after warmup; GPU values use timer queries when available. The tests use local synthetic imports and the existing approved Sento assets, with no new FAL requests. The changed cloud prediction request has not been exercised against FAL in this implementation pass.
