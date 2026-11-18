# Potemkin TODO: things to try

Each item says what to try, where it fits, and how we'd know it worked. The order is roughly the order to do them in. See ENGINE.md › "Known limits" for where several of these came from.

Paper references in the source notes have not been checked yet (in particular "Liu et al., arXiv:2610.36098"). Read each paper before building on it.

---

## 1. ~~Automatic UV unwrap stage (xatlas)~~ (done: `src/core/unwrap.ts`, `--unwrap auto|always|off`)

**Why:** "No UV unwrapping" is a known limit. A GLB has to arrive with good UVs, and the importance weighting exists only in the demo level's builder. Object mode (item 5) can't start until this exists.

- Add an optional first stage that runs xatlas (WASM bindings, or the Python layer) when the input has missing, overlapping or degenerate UVs. It generates charts with angle-preserving parameterisation and normal-aware seams.
- Feed the result straight into the existing `seenLayout` / `stripLayout` / `pagedLayout` path in `src/core/layout.ts`, so repacking, island cutting and multi-page atlases stay as they are.
- Add per-part atlasing (group charts by part/material) and a per-region texel-density target (more on high curvature or close-up parts).
- Levels with good UVs keep today's path unchanged.
- Still open: per-region texel-density targets (wait for items 6 and 7, then weight charts before packing). Also seam placement that follows hand-authored seams.

**Done when:** an un-UV'd GLB textures end to end through the CLI, and `measure.mjs` px/m on an unwrapped sample is within ~10% of its hand-unwrapped version. Add a test alongside `layout.test.ts` / `cut.test.ts`.

## 2. Local model provider router

**Why:** "No local models yet" is a known limit, with a ComfyUI provider as the next step. It also makes every experiment below cheaper to iterate on.

- Add a provider interface next to `src/providers/fal.ts`, covering the `EditModel` shape in `models.ts`. Back it with local endpoints: diffusers, ComfyUI workflows (FLUX-based multi-view texturing nodes) and Hunyuan3D-Paint.
- Route per job: local for privacy, cost or offline runs, cloud for higher-capacity models, with fallback. Expose the choice in the CLI/MCP schema (`automation/schema.mjs`).
- Geometry checks, projection, material separation and resume/repair stay unchanged.

**Done when:** a full sample run completes with `--provider local`, without fal (except optional SAM/MoGe), and quotes $0 for paint.

## 3. Consistency: synchronised views + texture-space consolidation

**Why:** sequential painting drifts. `--parallel` leaves visible seams. "Next is an automatic retouch pass for seams and odd patches."

- **Post-process first** (it needs no new model). Back-project each view into atlas space with per-texel confidence `w = cosθ/d × depth-continuity`. Solve a surface tangent flow field to register overlapping views, advect colours along it, then run a confidence-weighted gradient-domain (Poisson) stitch. Do this in the Python layer or a WebGPU compute pass after `atlas.ts`.
- **Then joint generation (TexFusion-style).** Denoise several overlapping views at once and, after every denoising step, aggregate their predicted latents into a shared latent texture (Sequential Interlaced Multiview Sampler). Then decode and bake the RGB (or PBR) atlas.
  - This needs denoiser access, so it means a local model via item 2. Hosted edit endpoints don't expose the steps.
  - Planner and packing stay as they are. Multi-view models are an alternative where a provider has them.
  - Optionally use MRF face-to-view assignment instead of per-texel max quality.
- **Learned back-projection (Im2SurfTex-style).** Replace hard per-texel projection with a small module that attends over nearby projected pixels (depth, normal and confidence-weighted) before writing to the atlas. Start with the confidence-weighted Poisson blend above as the non-learned baseline, then train on the multi-view outputs we already save in `runs/`.
- Keep the fidelity checks (`fidelity.ts`) and material separation in the loop.

**Done when:** seam metric (colour step across view boundaries) drops measurably on Courtyard/Hall with `--parallel 6`, at no extra full-resolution passes.

## 4. UV-space refinement (Paint3D-style coarse-to-fine)

**Why:** the projected atlas is a good coarse texture with holes, baked-in light and soft patches. The finishing fill (`finish.ts`) and the hole pass only partly fix that.

- After projection, run a UV-space inpainting model on the atlas to fill unpainted texels. Condition it on the position/normal atlases so it knows what is next to what across seams.
- Then run a high-definition UV pass that removes residual baked lighting and sharpens detail. The texture stays lighting-free and relights cleanly. Gate it by importance (items 6 and 7) so it only spends where players look.
- It works the same for levels and objects. It needs a UV-space model, local (item 2) or hosted.

**Done when:** the unpainted share after views drops to ~0 without the finishing fill, and relit stills show less baked shading than the current output on the same run.

## 5. Object mode (props, weapons, characters, vehicles)

**Why:** the planner is built for levels: walkable ground, eye height, roofs, rings and holes. Discrete assets need different cameras.

- Add a planner mode with a Fibonacci-sphere sampler enclosing the bounding box, plus close-up probes on high curvature, silhouette edges and user-tagged parts (a barrel, a face, wheel wells). Reuse `probeCells` / `selectViews`.
- Depends on item 1 for weak or missing UVs and per-part atlasing.
- Add material presets for hard-surface, metal, fabric and organic in `material-presets.ts`. POM relief and edge wear remain available for close-ups.

**Done when:** a prop GLB with no level context textures with full-surface coverage and no hole pass needed.

## 6. Player-path importance map (navmesh + bots)

**Why:** today "seen" is binary per triangle (`seenTriangles`) plus nearest-eye distance (`seenDistance`), taken from a grid of standing spots (`samplePlayerPoints`). Where players actually walk and look should decide where the paint and texel budget goes.

- Optional pre-pass before planning. Bake a navmesh from the level (Recast via `recast-navigation-js`, or pure-JS `navcat`; `three-pathfinding` if the file ships a navmesh). Walk a few bots along plausible paths: random exploration, routes between entry points, or a short crowd sim.
- From each bot pose and look direction, accumulate hits on the original triangles. Cast rays against the existing BVH or use GPU occlusion. Score = hits × 1/distance × view-angle quality (prefer frontal).
- Store a per-triangle weight array and feed it to:
  - the layout scale in `nearScaled` / `seenLayout` (instead of the 0/1 seen flag)
  - the planner's cell weights in `selectViews` (item 8)
  - hole/repair priority, and where to spend material detail
- Low-rank faces get coarser coverage or are deferred. For objects use spherical "bots" or turntable sampling instead of a navmesh (item 5).
- Runs client-side on the existing Three.js scene. Levels that already have good coverage skip it.

**Done when:** on Courtyard/Hall, replaying the same views into an importance-weighted layout raises `measure.mjs` px/m on high-rank faces over `--layout near`, and the planner reaches the same weighted coverage with fewer views.

## 7. Geometry prepasses: per-face weights (AO, curvature, class, light)

**Why:** these are cheap facts about the mesh that make good weights for the planner, packer and material pipeline, alongside item 6's player-visibility rank. None of them changes the paint-and-project loop.

All of them run client-side (or as a short local pre-process) and write a per-triangle weight attribute that rides along with `label`:

- **AO / enclosure.** Use [Fast-SDF-AO](https://github.com/wrong-nebula/Fast-SDF-AO): its exact BVH-based SDF baker for meshes, plus the SDF-march visibility estimator (with `contact-bvh.js` for the near segment). Compute this per face or per texel instead of the 24-ray hemisphere in `src/core/ao.ts`, and check speed and accuracy against it.
  - High-AO faces get dirt, wear or darker variants in the prompt and finish passes.
  - Open faces get cleaner base looks and more weight in the planner and packer.
  - It could also replace `ao.ts` for the exported occlusion map if it wins on speed.
- **Curvature / features.** Use discrete curvature or the normal variation across neighbouring faces. Sharp edges, high curvature and silhouettes get close-up cameras, denser texels and detailed normal/height maps. Flat areas get fewer views.
- **Semantic / material class.** Tag faces as floor, wall, ceiling, organic or hard-surface, using heuristics on normal, height and connectivity (and `semantics.ts` / part names), or a light classifier.
  - Each class pulls a look preset, roughness range and repair strategy before painting.
  - The atlas splitter keeps same-class islands together.
- **Static light importance.** From sky and key-light probes, accumulate how much light each face receives and whether it's shadowed. Well-lit, visible faces get more paint budget. Deep shadow gets lower resolution or simpler materials. Combined with item 6, this gives a "player will see this under normal lighting" score without needing pathfinding.

**Done when:** each weight is computed in under a few seconds on the samples, is viewable as a debug overlay, and is consumed by at least the packer (`nearScaled`) and the planner. Measure the AO prepass against `ao.ts` for time and agreement.

## 8. Adaptive, importance-driven camera planning

**Why:** "sharpness is limited by layout and view budget, not camera choice". That argues for spending the view budget where it matters, rather than for better picking.

- Turn the greedy probe-and-select into iterative refinement. Add probes only around currently under-covered *important* regions: high combined importance from items 6 and 7, high curvature, named parts. Optionally weight importance by geodesic distance (heat method) from player spots.
- Optionally treat it as coverage maximisation (at-least-once or a Fisher-style metric) over surface cells.
- Use the same budget to decide when local models, sparse height baking or extra views are worth paying for.

**Done when:** matching or better `measure.mjs` detail on the samples with fewer views (target: well under 64 fal views for a mid-size level).

## 9. Full PBR channel set

**Why:** normals and roughness currently come from PATINA plus presets. Metallic is mostly missing, and height is derived.

- After the consolidated albedo, run a pass that produces roughness, metallic and a refined normal, conditioned on albedo and the geometry buffers. Use a multi-view PBR model or a lightweight intrinsic-decomposition estimator.
- Pack into the same atlas pages with aligned islands (`aligned-maps.ts`). Export ORM or separate linear maps. Keep AO, POM and edge wear.

**Done when:** exported GLB relights correctly in an engine viewer; metal parts read as metal under a moving light.

## 10. Agentic Planner → Actor → Critic loop over CLI/MCP

**Why:** this turns one-shot jobs into a controllable, budgeted session.

- **Planner:** emits a look file plus a coverage budget (and, for objects, an "object brief": target texel density, style references, animation-ready, budget).
- **Actor:** runs plan → paint → project → repair and stores episodic traces in the run folder.
- **Critic:** scores multi-view consistency, coverage %, seam metric and artefacts from screenshots and SAM/MoGe residuals. It writes a critique that triggers targeted repaint or extra views only where needed, before more spend is authorised.
- Keep a memory of successful presets and repair patterns across sessions. Leave hooks to chain with Blender/Unreal MCP servers. A human approves each spend step.
- Builds on the metrics from items 3, 6, 7 and 8, so do it after them.

**Done when:** an MCP client drives a sample from blockout to export with the critic gating at least one repair round, under a stated budget.

## 11. Research spikes (try small, keep only if they win)

- **3D Gaussian Splatting as an intermediate.** Fit a sparse 3DGS to the painted views (or a few seed views) as a view-consistent appearance field. Use it to render clean novel views for extra projection passes, and as a free consistency check before baking. Texture-GS-style disentangling keeps geometry fixed and optimises a 2D texture on the Gaussians. Measure it against item 3's stitching.
- **Hybrid SDS polish.** Once the atlas is mostly filled, run a short Score Distillation Sampling pass (a few hundred steps): render the textured mesh from the same cameras and steer the diffusion model toward higher fidelity. Limit it to high-importance faces (items 6 and 7). It's most promising for objects with dense spherical coverage (item 5). It needs gradient access to a local model (item 2).
