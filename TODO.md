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
- Still open: seam placement that follows hand-authored seams (per-region texel-density chart weighting before packing is now handled by `--weights` and `--paths` from items 6 and 7).

**Done when:** an un-UV'd GLB textures end to end through the CLI, and `measure.mjs` px/m on an unwrapped sample is within ~10% of its hand-unwrapped version. Add a test alongside `layout.test.ts` / `cut.test.ts`.

## 2. ~~Local model provider router~~ (done: `src/providers/local.ts`, `src/providers/router.ts`, `--provider local|fal|auto`)

**Why:** "No local models yet" is a known limit, with a ComfyUI provider as the next step. It also makes every experiment below cheaper to iterate on.

- **Provider interface & local backends (`src/providers/router.ts`, `src/providers/local.ts`, `/api/local/proxy`).** Added `ModelProvider` (`falProvider` + `localProvider`) covering `EditModel`, part/object GLB retexturing and optional VLM naming across:
  - **ComfyUI (`:8188`):** `/upload/image` + FLUX multi-view `ReferenceLatent` / `InpaintModelConditioning` graph builder (`buildComfyWorkflow`, plus custom workflow JSON templates) + `/prompt` / `/history` / `/view`, plus `local-comfy-mv` and `local-flux` model entries.
  - **Diffusers / OpenAI-Images / SD-WebUI (`:8000`):** `/v1/images/edits`, `/edit` and `/sdapi/v1/img2img` with multi-reference images and masks.
  - **Hunyuan3D-Paint (`:8081`):** `/paint_view` view editing plus `/retexture` / `/generate` 3D mesh retexturing (`partPass`), plus `hunyuan3d-paint` model entry and an offline `procedural` deterministic painter for zero-daemon pipeline tests.
- **Per-job routing, fallback & CLI/MCP schema (`automation/schema.mjs`, `scripts/texture.mjs`).** Supports `--provider local|fal|auto`, `--provider-fallback none|fal|local`, `--local-backend`, `--local-url` (loopback-validated against SSRF) and `--local-tail` (routing item 8's `localModelTailViews` locally), plus `provider` workflow steps. Strict `--provider local` quotes `$0` (`paint: 0, cost: 0`), needs no `FAL_KEY`, and runs under `allowPaid: false` with `/api/fal/*` blocked at the browser boundary while keeping in-browser SAM checks, projection, consolidation, resume/repair and GLB export unchanged.

## 3. Consistency: synchronised views + texture-space consolidation (post-process baseline done: `src/core/consolidate.ts`, `--consolidate`)

**Why:** sequential painting drifts. `--parallel` leaves visible seams. "Next is an automatic retouch pass for seams and odd patches."

- **~~Post-process first~~** (done: `src/core/consolidate.ts`, `--consolidate`, `trompe.consolidate()`, MCP `consolidate` step; zero model calls). Back-projects each view into atlas space with per-texel confidence `w = (lens × cosθ / d) × depthContinuity × rimFade`, solves a damped Lucas-Kanade surface-tangent flow field on high-pass structural luminance (invariant to parallel exposure/colour drift) and advects overlapping colours along it, then solves a 3-level multigrid Screened-Poisson stitch within each UV island / part boundary (`Atlas.updatePaint` / `Atlas.applyConsolidation`, preserving native 4K/8K detail, per-texel capture quality, `fidelity.ts` masks and downstream ground/part/finish passes).
  - **Measured (`--parallel 6`, 18 views, 0 extra passes):** on **Courtyard** (`16,305` boundary edges, 2.4 s), seam step drops **15.8 → 5.4 RGB (-66%)** and seam ratio drops **2.74 → 1.02**; on **Hall** (`31,163` boundary edges, 2.5 s), seam step drops **14.7 → 4.1 RGB (-72%)** and seam ratio drops **3.34 → 1.00** while retaining >91% of interior grain contrast.
- **Still open — joint generation (TexFusion-style).** Denoise several overlapping views at once and, after every denoising step, aggregate their predicted latents into a shared latent texture (Sequential Interlaced Multiview Sampler). Then decode and bake the RGB (or PBR) atlas.
  - This needs denoiser access, so it means a local model via item 2. Hosted edit endpoints don't expose the steps.
  - Planner and packing stay as they are. Multi-view models are an alternative where a provider has them.
  - Optionally use MRF face-to-view assignment instead of per-texel max quality.
- **Still open — learned back-projection (Im2SurfTex-style).** Replace hard per-texel projection with a small module that attends over nearby projected pixels (depth, normal and confidence-weighted) before writing to the atlas, trained on multi-view outputs in `runs/` against the Screened-Poisson baseline above.

## 4. ~~UV-space refinement (Paint3D-style coarse-to-fine)~~ (done: `src/core/uv-refine.ts`, `--uv-refine`, MCP `uvRefine`)

**Why:** the projected atlas is a good coarse texture with holes, baked-in light and soft patches. The finishing fill (`finish.ts`) and the hole pass only partly fix that.

- **Position/normal-conditioned 3D-seam-aware UV inpainting (`buildUvSeamGraph`, `uvInpaint`, `Atlas.applyUvRefinement`).** Bridges disjoint UV chart perimeter texels that meet in 3D world space across cuts (`~10k` cross-seam links on Courtyard/Hall), relaxes harmonic albedo weighted by 3D distance and normal agreement, transfers world-anchored exemplar micro-grain per `(part, normal-octant)`, and optionally runs UV-tile model inpainting via item 2's `routeEdit` (`local` or `fal`) gated by importance.
- **Importance-gated intrinsic delighting & HD sharpening (`bakedShadingScore`, `uvDelightAndSharpen`).** Regresses per-part low-frequency log-luminance against the 3D normal/position directional sun + sky irradiance basis to strip baked lighting while preserving intrinsic grain, and applies bilateral normal-preserving sharpening gated by combined surface & player-path importance (items 6 & 7). Works identically for `--mode level` and `--mode object`.
- **Measured (`--layout near --weights --paths`, 1.9 s, without `finish.ts`):**
  - **Courtyard** (`9,956` 3D seam links): unpainted share drops **46.0% → 0.00%** (`atlas.coverage()` **53.8% → 99.99%**), baked shading correlation drops **0.644 → 0.035 (-95%)** and sunlit-vs-shaded spread drops **0.400 → 0.017 (-96%)**.
  - **Hall** (`10,065` 3D seam links): unpainted share drops **37.1% → 0.00%** (`atlas.coverage()` **62.2% → 99.99%**), baked shading correlation drops **0.430 → 0.040 (-91%)**, directional spread drops **0.391 → 0.028 (-93%)**, and opposing-sun relit still asymmetry drops **27.7 → 20.0 RGB (-28%)**.

## 5. ~~Object mode (props, weapons, characters, vehicles)~~ (done: `src/core/object-plan.ts`, `--mode auto|level|object`, `--focus`, object presets)

**Why:** the planner is built for levels: walkable ground, eye height, roofs, rings and holes. Discrete assets need different cameras.

- **Enclosing sphere + feature & pocket probes (`src/core/object-plan.ts`).** Places an enclosing Fibonacci-sphere camera shell plus a closer oblique turntable ring (`fibonacciSphereViews`), adds unobstructed close-up probes on high convex curvature (`faceCurvature`), exposed silhouette ridges and user-tagged parts (`objectFeatureViews`, `--focus barrel,face,wheel` / `focusParts`), and runs a pocket-refinement round over remaining uncovered UV patches through `probeCells` + weighted `selectViews`.
- **Automatic detection & visibility layouts (`Session.load`, `objectEyes`).** `--mode auto` switches to `object` automatically when a mesh has no walkable floor or is under 4.5 m across, using `objectEyes` for `seen` / `near` UV layouts and `measure.mjs` so buried internal geometry yields texels to the visible shell, and switching `models.ts` prompts to clean discrete-object silhouette wording.
- **Material presets (`src/core/material-presets.ts`, `aligned-maps.ts`, `viewer.ts`, `export.ts`).** Added `hard-surface`, `metal` (writing glTF ORM metallic B and enabling metallic response in `Viewer` and GLB export), `fabric` and `organic`, wired into `suggestPresetsFromWeights` and the CLI/MCP schema.
- **Verified end to end:** an un-UV'd 8-part rover/weapon/character prop GLB unwraps via xatlas (48 charts), maps parts to `hard-surface`, `metal`, `organic` and `fabric`, and reaches **97.5% visible-surface paint coverage (312 px/m)** in 20 views with `holes = 0`.

## 6. ~~Player-path importance map (navmesh + bots)~~ (done: `src/core/player-paths.ts`, `--paths`, viewer `paths` overlay)

**Why:** today "seen" is binary per triangle (`seenTriangles`) plus nearest-eye distance (`seenDistance`), taken from a grid of standing spots (`samplePlayerPoints`). Where players actually walk and look should decide where the paint and texel budget goes.

- **Walkable nav-graph + simulated bots (`bakeNavGraph`, `navShortestPath`, `walkBots`, `playerImportance`).** Bakes a capsule-cleared multi-storey 2.5D navigation graph directly on `level.bvh` (0.05–0.15 s client-side, zero external WASM dependencies), selects perimeter entry & landmark nodes, and walks simulated bots along shortest landmark routes plus self-avoiding curiosity paths (or turntable + spherical inspection shells in `--mode object`).
- **Frustum gaze accumulation & UV tiering (`rankTier`, `splitUvByRank`, `pathLayoutScale`).** Casts a 9-ray frustum fan from every bot pose against `level.bvh` (mapping permuted BVH indices back to mesh triangles), scoring `hits × cos^1.35(θ) / (distance × area)` into a continuous `[0, 1]` rank. Groups strips by exposure tier, splits hollow welded ring remnants so inner voids don't waste atlas space, scales islands continuously in `seenLayout` / `nearScaled`, weights `selectViews` / `combinedPlanWeights` / `holeTargets` / `unfinishedParts`, exposes `highRank` px/m in `measure.mjs`, and adds a `'paths'` false-colour viewer overlay.
- **Measured (`--layout near` vs `--layout near --paths`, 4096 px atlas, 2048 px views):**
  - **Fixed-view replay (`18` views):** on **Courtyard** (`203` nav nodes, `1,712` poses, 0.10 s), high-rank sightlines jump **56.3 → 86.1 px/m median (+53%)**, **54.0 → 78.5 px/m mean (+45%)** and **56.3 → 88.1 texels/m (+57%)**; on **Hall** (`58` nav nodes, `1,404` poses, 0.05 s), high-rank sightlines jump **89.8 → 108.1 px/m median (+20%)**, **81.9 → 109.5 px/m mean (+34%)**, **89.8 → 147.4 px/m p75 (+64%)** and **89.8 → 156.2 texels/m (+74%)**.
  - **Planner efficiency (same layout):** reaches unweighted 22-view sharp/Fisher path-weighted coverage in **18 views (-18%)** on Courtyard, **16–18 views (-18% to -27%; 14 views / -36% with `--paths --adaptive`)** on Hall, **12–18 views (-18% to -33%)** on Loft, and **14–18 views (-18% to -36%)** on Hangar.

## 7. ~~Geometry prepasses: per-face weights (AO, curvature, class, light)~~ (done: `src/core/surface-weights.ts`, `--cavity`, `--weights`, viewer weights overlay)

**Why:** these are cheap facts about the mesh that make good weights for the planner, packer and material pipeline, alongside item 6's player-visibility rank. None of them changes the paint-and-project loop.

All of them run client-side in 0.02–1.70 s combined across the bundled samples (up to 40k triangles on Luxor), write a per-triangle `weight` attribute that rides along with `label` through island cutting, feed `seenLayout` / `nearScaled` / `pagedLayout` and `planner.ts` (`selectViews` + `holeTargets`), and can be inspected as false-colour overlays (`openness`, `curvature`, `light`, `class`, `importance`) in the viewer and `snapshot`:

- **AO / enclosure (`faceOpenness`, `cavityScale`).** Cosine-weighted openness within 1.12 m from 4 rotated short rays per sample point against the BVH (0.01–0.62 s; 0.018–0.025 MAE against 256 rays; [Fast-SDF-AO](https://github.com/wrong-nebula/Fast-SDF-AO)'s four-tap formula with a normal-ray sign guard errs by 0.07–0.15 on unclosed blockouts because thin bars beside a face read as walls). Against `ao.ts`'s 24-ray distance-faded `openness` at the same face points (`compareAoPrepass`), `faceOpenness` runs 5.8–7.2× faster per face (and 30–100× faster than texel-space `bakeAo`) with $r = 0.92\text{–}0.98$ and MAE 0.05–0.12.
- **Concave curvature / creases.** Covered for packing and planning by the openness cavity weight above: recesses, slots and tight inside corners shrink so open surfaces gain texels.
- **Convex curvature / silhouettes (`faceCurvature`).** Signed dihedral normal-cycle mean curvature across shared interior edges (1–49 ms; recovers $1/R$ on cylinders regardless of tessellation), boosting exposed ridges, columns and curved props in island packing and look-at target ranking.
- **Semantic / material class (`faceClass`, `CLASS_PROFILES`, `suggestPresetsFromWeights`).** Tags faces as `floor`, `wall`, `ceiling`, `roof`, `organic` or `hard-surface` from normal, floor height, component size, curvature smoothness and `semantics.ts` / part names; seeds material presets and groups same-class islands together across atlas pages.
- **Static light importance (`faceLight`).** Accumulates direct sun shadow rays plus sky and room-bounce hemisphere visibility under the scene's `Lighting` (`clay.ts`), down-weighting deep permanent shadow.
- Still open for follow-up passes: high-AO dirt/wear tinting in prompts and `finish.ts`, and evaluating a WebGPU baked SDF if texel-space `ao.ts` needs replacing.

## 8. ~~Adaptive, importance-driven camera planning~~ (done: `src/core/adaptive-plan.ts`, `--adaptive`, `--objective fisher`)

**Why:** "sharpness is limited by layout and view budget, not camera choice". That argues for spending the view budget where it matters, rather than for better picking.

- **Iterative probe-and-select (`adaptiveGroundViews`, `deficitTargets`, `adaptiveLookViews`).** Starts with a coarse wide sweep, clusters remaining weighted resolution deficits (`w × (1 - fisherUtility(r))`) around under-covered important, convex and named-part regions, spawns targeted cameras with adaptive lenses (`62°–86°`) matched to local atlas texel density (alongside lens-aware projection quality in `Engine.paint`, `STATE_FRAG` and `measure()`), and runs a joint final selection.
- **Geodesic + Fisher weighting (`geodesicDistance`, `geodesicWeight`, `fisherUtility`, `selectFisherViews`).** Multi-source surface geodesic propagation from player spots (bridging resting blockout props) multiplies item 7's surface weights. Concave log-precision Fisher utility with live painted-context `paintability` pulls wide framing context first and unlocks focused probes once `>= 30%` of their frame is painted.
- **Spend & bottleneck report (`budgetAdvice`, `plan.budget`).** Reports the diminishing-returns `recommendedViews` knee, whether `views` or `layout` is the active bottleneck, `localModelTailViews` suited to a cheap/local model (item 2), and `sparseHeightTiles` for skipping low-importance PATINA PBR tiles.
- **Measured (`--layout near --weights`, 2048 px views):** matches or beats static `coverage` surface detail in 21–33% fewer views — Luxor in **46 views vs 64** (important-surface mean 32.6 vs 32.4 px/m; knee at 33 views), Hangar in **32 vs 44** (whole-level median 31.3 vs 23.4 px/m, important mean 36.6 vs 31.7 px/m), Loft in **16 vs 24** (mean 26.0 vs 24.6 px/m, p75 41.6 vs 13.7), Post Hall in **20 vs 28** (mean 48.2 vs 48.1 px/m, med 47.8), Village in **22 vs 28**, and Courtyard in **19 vs 24**.

## 9. ~~Full PBR channel set~~ (done: `src/core/pbr.ts`, `src/core/aligned-maps.ts`, `src/core/export.ts`, `--pbr-mode intrinsic|patina|auto`, `exportPbr`)

**Why:** normals and roughness currently come from PATINA plus presets. Metallic is mostly missing, and height is derived.

- **Albedo + geometry-conditioned intrinsic PBR estimator (`estimateIntrinsicPbr`, `makePbr`).** Decomposes consolidated/refined albedo together with the 3D position/normal buffers and geometry prepasses (`openness`, signed convex `curvature`, `faceClass`, part labels and `materialPresets`) into aligned `height` (preserving POM), `roughness`, `metalness` (suppressing dielectric rust/cavity grime while boosting exposed metallic ridges), `refinedNormal` (fused atop physical height slopes) and `edgeWear` in ~0.18 s at $0 (`--pbr-mode intrinsic` or automatic under `--provider local`), or fuses with cloud PATINA tiles under `--pbr-mode patina`.
- **Aligned ORM & separate linear maps (`buildAlignedMaps`, `unpackLinearPbrChannels`, `exportPbr`, `exportGlb`).** Packs occlusion (R), roughness (G) and metalness (B) into aligned atlas pages (`orm.png`) and unpacks separate linear `roughness`, `metalness`, `occlusion`, `height` and `normal` PNG channels while preserving baked AO, POM height and convex-edge wear. `exportGlb` writes lit glTF 2.0 `pbrMetallicRoughness` (`metallicFactor: 1`, `roughnessFactor: 1`, shared ORM + `normalTexture` + `occlusionTexture`) whenever PBR/AO is present.

## 10. ~~Agentic Planner → Actor → Critic loop over CLI/MCP~~ (done: `src/core/critic.ts`, `automation/agent.mjs`, `agent-plan`/`agent-approve`/`agent-act`/`agent-critique`)

**Why:** this turns one-shot jobs into a controllable, budgeted session.

- **Planner (`agentPlan`, `potemkin_agent_plan`):** inspects the GLB and cross-session memory, emits `.potemkin/sessions/<id>/look.json` (and `runs/<id>/look.plan.json`) plus an explicit `coverageBudget` (`targetSeenPainted`, `targetHighRankPxPerM`, `initialViews`, `maxTotalViews`, `budgetUsd`) and, in `--mode object`, an `objectBrief` (`targetTexelDensityPxPerM`, `styleReferences`, `animationReady`, `focusParts`, `suggestedPresets`), and stages Round 1 awaiting human approval (`agentApprove`).
- **Actor (`agentAct`, `potemkin_agent_act`):** enforces human spend approval (`APPROVAL_REQUIRED`) and per-round dollar & view caps (`BUDGET_EXCEEDED`), executes `plan → paint → project → consolidate / topUp / repair / parts / uvRefine → pbr → export`, and appends episodic traces to `runs/<id>/episodes.ndjson`.
- **Critic (`critiqueRun`, `scoreDiagnosticFrames`, `potemkin_agent_critique`):** combines player-visible `seenPainted` & high-rank `px/m` (items 6, 7, 8), multi-view RGB consistency & boundary `seam.ratio` (item 3), SAM/MoGe `ignored` & `untouched` residuals, diagnostic screenshot clay/clipping artifact checks, and `bakedShading` correlation (item 4) into a `0..100` score and targeted repair proposal gated before extra spend is authorized.
- **Cross-session memory & external MCP hooks:** persists successful presets, layouts and repair score gains in `.potemkin/agent-memory.json` (`potemkin://agent/memory`), exposes session state at `potemkin://agent/sessions/<id>`, and emits `externalHooks.blenderMcp` (`blender-mcp`) and `externalHooks.unrealMcp` (`unreal-mcp`) on completion.
- **Verified end-to-end (`scripts/check-automation.mjs`):** a stdio MCP client drives `samples/courtyard.glb` from blockout to lit PBR GLB export under a `$0.25` stated budget — rejecting unapproved `agent_act`, running 2 initial views (`seenPainted` **28.7%**, Critic score **55.8**, `verdict: 'needs-repair'`), gating and human-approving a targeted repair round, raising `seenPainted` **28.7% → 100.0%** and Critic score **55.8 → 82.1** at **$0.20 / $0.25** spent, and exporting `<runId>.glb` + ORM/linear PBR maps + Blender/Unreal MCP hooks.

## 11. Research spikes (try small, keep only if they win)

- **3D Gaussian Splatting as an intermediate.** Fit a sparse 3DGS to the painted views (or a few seed views) as a view-consistent appearance field. Use it to render clean novel views for extra projection passes, and as a free consistency check before baking. Texture-GS-style disentangling keeps geometry fixed and optimises a 2D texture on the Gaussians. Measure it against item 3's stitching.
- **Hybrid SDS polish.** Once the atlas is mostly filled, run a short Score Distillation Sampling pass (a few hundred steps): render the textured mesh from the same cameras and steer the diffusion model toward higher fidelity. Limit it to high-importance faces (items 6 and 7). It's most promising for objects with dense spherical coverage (item 5). It needs gradient access to a local model (item 2).
