# Material responses and aligned maps

Open `http://127.0.0.1:5178/?sample=sento` and use **Materials → Material surface → Material response**. The prepared Sento scene starts with tile and timber assignments from its explicit surface names. Other scenes keep their original response until a preset is assigned. **Use presets from surface names** makes editable suggestions; ambiguous names stay unassigned.

| Preset | Base roughness | Height span | Existing-normal gain |
| --- | ---: | ---: | ---: |
| Limestone | 0.82 | 1.20 mm | 0.30 |
| Glazed tile | 0.32 | 2.00 mm | 0.18 |
| Painted metal | 0.42 | 0.25 mm | 0.15 |
| Timber | 0.62 | 0.70 mm | 0.25 |

These are artist-selected starting points, not measured physical properties. Height span means the difference between black and white in the source height field. Presets also cap slopes and scale roughness variation. All four surfaces are dielectric: painted metal models the paint coating, and would need a separate exposed-metal mask for metallic chips. Presets change lighting response; they do not generate a stone pattern, wood grain or new painted details.

## Shared source fields

The practical inspiration is [MeshNCA's joint PBR texture synthesis](https://meshnca.github.io/), where related channels share one synthesis process. Trompe uses the alignment principle; it does not train or run MeshNCA.

The prediction path requests height and roughness together for each crop. Both fields use the same dimensions, overlap blending and UV layout. Broad prediction drift is removed conservatively. Normals are derived from that height in world units, with each material's height span and slope limit. A supplied height channel takes priority over an unrelated normal map. Surface boundaries and differently oriented UV islands do not contribute to derivatives across their edges.

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
