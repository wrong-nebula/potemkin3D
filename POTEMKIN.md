# Potemkin project guide

Start with [README.md](README.md) for the techniques, comparison with Patch Trompe, included scenes and build commands. [ENGINE.md](ENGINE.md) retains detailed historical engine notes. [PROVENANCE.md](PROVENANCE.md) records the source lineage and recovery of the Luxor viewer code.

The complete baked site is in `deploy/potemkin3d/`. Run `npm run build:scenes` to rebuild both viewer applications from source into `dist-potemkin/`, reusing those GLBs and textures. This requires no image-generation key. `npm run dev` starts the authoring tool; `npm run build` builds that tool into `dist/`.

The original full generation runs are absent. The scene bundles retain finished geometry, textures and reduced viewer metadata. For new runs, use the CLI workflows in ENGINE.md and your own FAL_KEY. Do not run the older single-run `scripts/build-site.mjs` with its default output over the assembled multi-scene site: it clears its output directory. Use a separate output folder when building a new run.
