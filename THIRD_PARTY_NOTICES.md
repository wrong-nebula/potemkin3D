# Third-party notices

- **Trompe:** made by [Patch](https://github.com/Patch-gg/trompe), Apache-2.0; full license in [LICENSE](LICENSE), attribution in [NOTICE](NOTICE). Patch branding and trademarks are not relicensed.
- **Three.js:** MIT, copyright the Three.js authors. Bundled in the walkthroughs; [license](licenses/THREE-LICENSE.txt).
- **three-mesh-bvh:** MIT, copyright Garrett Johnson. Bundled in the walkthroughs; [license](licenses/THREE-MESH-BVH-LICENSE.txt).
- **Cormorant Garamond:** copyright 2015 the Cormorant Project Authors, SIL Open Font License 1.1. Used in the scene menu; [license](licenses/CORMORANT-GARAMOND-OFL.txt), [source](https://github.com/CatharsisFonts/Cormorant).
- **Funnel Sans and Red Hat Mono:** retained upstream video fonts under SIL OFL 1.1; notices remain in `video/fonts/`.
- **Luxor photographs:** Alberto-g-rovi (CC BY-SA 3.0) and Holger Uwe Schmitt (CC BY-SA 4.0). Individual source links and modifications are listed in [reference credits](references/luxor/CREDITS.md). Photographs are not Apache-licensed.
- **Material-lab stone exemplar:** cropped from Holger Uwe Schmitt's `05_relief_detail.jpg`, resized and processed into material fields. Related stone images in `experiments/material-lab/assets/` retain CC BY-SA 4.0 attribution to that source.
- **xatlas:** MIT, copyright 2018-2020 Jonathan Young, through the [xatlasjs](https://github.com/repalash/xatlas.js) WebAssembly build (MIT, Palash Bansal). Bundled in the authoring tool for UV unwrapping; [license](licenses/XATLAS-LICENSE.txt), [source](https://github.com/jpcy/xatlas).
- **Comlink:** Apache-2.0, copyright 2019 Google LLC; bundled in the authoring tool to talk to the xatlas worker, [source](https://github.com/GoogleChromeLabs/comlink).
- **MCP TypeScript SDK:** Apache-2.0, Model Context Protocol contributors; installed through npm, [source](https://github.com/modelcontextprotocol/typescript-sdk).
- **Zod:** MIT, Colin McDonnell and contributors; installed through npm, [source](https://github.com/colinhacks/zod).
- **Fast-SDF-AO:** adapted in `src/core/fast-sdf-ao.ts` from [wrong-nebula/Fast-SDF-AO](https://github.com/wrong-nebula/Fast-SDF-AO) (MIT, wrong-nebula) for hybrid Contact-BVH + 1-Lipschitz `R16F` SDF ambient occlusion baking.
- **JointBilateralUpsample (Three.js PR #35602):** adapted in `src/core/jbu.ts` and `src/core/atlas.ts` from [mrdoob/three.js#35602](https://github.com/mrdoob/three.js/pull/35602) (`JointBilateralUpsample.js`, MIT, Ben Houston / Three.js authors; after Sloan et al. 2007 and Kopf et al. 2007).
- **Other dependencies:** installed through npm under their own licenses. `package-lock.json` records the dependency versions. Model services and downloadable weights retain their providers' terms; their availability is not granted by this repository's license.

See [ASSET_LICENSES.md](ASSET_LICENSES.md) for the distinction between source code and scene media.
