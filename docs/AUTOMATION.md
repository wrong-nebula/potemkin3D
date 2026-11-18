# CLI and MCP reference

Potemkin's CLI and stdio MCP server share validated command schemas and one execution layer. No arbitrary JavaScript execution tool is exposed. Start with [the tutorial](TUTORIAL.md).

## Entry points and discovery

- CLI: `node automation/cli.mjs <command> [options]` or `potemkin` after `npm link`.
- MCP: `node /absolute/path/to/potemkin3D/automation/mcp.mjs` or `potemkin-mcp` after `npm link`.
- Runtime: Node >=22.12, installed npm dependencies, and Chromium/WebGL2 for rendering jobs.
- `help`, `help <command>` and `schema --name workflow` expose the actual input contract. Unknown fields are rejected.

| CLI command | MCP tool | Purpose |
| --- | --- | --- |
| `doctor` | `potemkin_doctor` | Check Node, browser installation, baked scenes and whether a key is configured. No credentials are returned. |
| `catalog` | `potemkin_catalog` | List bundled geometry, look files and baked scenes. |
| `inspect` | `potemkin_inspect` | Read a project GLB's mesh/material/UV summary. |
| `schema` | `potemkin_schema` | Discover a command or workflow JSON Schema. |
| `workflow-check` | `potemkin_workflow_check` | Check the schema, input files and basic operation ordering, and list paid operations. Does not simulate the engine or guarantee runtime success. |
| `job-start` | `potemkin_job_start` | Start an ordered workflow in a persistent worker. |
| `plan` | `potemkin_plan` | Plan cameras for a bundled sample. |
| `screenshot` | `potemkin_screenshot` | Capture the baked Luxor or loft walkthrough. |
| `build` | `potemkin_build` | Build `scenes` or `author` into `dist-potemkin/` or `dist/`. The author job runs Vite; run `npm run build` separately for TypeScript checking too. |
| `jobs` | `potemkin_jobs` | List the latest 50 jobs. |
| `job-status` | `potemkin_job_status` | Get state, results, artifacts and paginated progress. |
| `job-cancel` | `potemkin_job_cancel` | Request cancellation. |
| `runs` | `potemkin_runs` | List generation runs in `runs/`. |
| `run-info` | `potemkin_run_info` | Summarize one run and its saved files. |

## Inputs and outputs

CLI flags use kebab case (`--view-size 512`); JSON/MCP fields use camel case (`"viewSize":512`). Pass booleans as `true` or `false`. Nested options can be supplied as JSON. `--input '{…}'`, `--input @file.json` and `--input -` (stdin) accept a complete object. Later flags override earlier input fields.

```sh
node automation/cli.mjs plan --input '{"sample":"luxor","views":4}' --wait --json
node automation/cli.mjs schema --name screenshot --json
```

Stdout is one envelope, compact with `--json` and pretty-printed otherwise:

```json
{"version":1,"ok":true,"data":{"id":"…","status":"queued","kind":"workflow"}}
```

Failures use `{"version":1,"ok":false,"error":{"code":"…","message":"…"}}`. A failed job observed through CLI `--wait` instead returns `ok:false` with the complete job under `data`, including `data.error`. `job-status` itself succeeds when it can read a failed job: inspect `data.status` and `data.error`.

CLI exit codes: **0** successful command/completed job; **2** invalid input, unknown command, unsafe path or missing paid opt-in; **1** other failures; **130** a cancelled job observed by `--wait`. Waiting progress is stderr NDJSON. MCP tool results include both `structuredContent` and JSON text, with `isError` on command failure. The MCP process writes no non-protocol messages to stdout.

Common error codes include `INVALID_INPUT`, `INVALID_WORKFLOW`, `INVALID_PATH`, `NOT_FOUND`, `PAID_OPT_IN_REQUIRED`, `RUN_EXISTS`, `BUSY`, `TIMEOUT`, `WAIT_TIMEOUT`, `WORKER_LOST`, `BUILD_FAILED` and `VIEWER_ERROR`. Engine errors may use `FAILED` with their message. Home/project paths and known environment credentials are redacted from tool output and progress; this is not a substitute for keeping secrets out of user-authored workflow text or assets.

## Workflows

A workflow has `version:1`, `steps` (1–100), `allowPaid:false` by default, and `timeoutSeconds` (10–86400; default 1800). Steps share one in-memory scene within that job. Jobs do not share live browser state: use `loadRun` to continue saved generation work in another job.

| Operations | Use |
| --- | --- |
| `provider` | Select or probe the model provider router (`fal`, `local` on loopback ComfyUI/diffusers/Hunyuan3D-Paint, or `auto` with fallback). |
| `load`, `loadRun`, `loadSentoFloor` | Start a scene, restore a saved run, or load the prepared Sento floor. |
| `bounds`, `weights`, `paths`, `plan`, `quote`, `projection` | Inspect geometry, surface weights, player-path bot gaze ranks, choose cameras, estimate model cost, control projection thresholds. `quote` requires a plan. |
| `run`, `topUp` | Paint a new run or continue one; `saveAs` is required. |
| `parts`, `ground`, `repair`, `groundNotes`, `props` | Target parts, floor tiles, regions, pinned notes or individual props. |
| `consolidate`, `uvRefine`, `finish`, `save`, `export` | Stitch view seams, run position/normal-conditioned UV inpainting & delighting, fill unpainted slivers, persist a generation record, export the current GLB. `save` needs a real run; `export` also works after a clay self-test. |
| `ao`, `pbr`, `nameParts` | Bake AO, generate PBR maps, or name shapes. |
| `materialPresets`, `materialMaps`, `floorDetail`, `floorDetailEnabled` | Assign presets, import aligned material maps and manage protected floor detail. `floorDetail.options:null` removes the detail layer. |
| `walk`, `pick`, `snapshot` | Position a walking camera, ray-pick a surface point, or capture a specified camera. `walk.options:null` stops walking. |
| `selfTest`, `measure`, `validate`, `checkRun`, `promptTest` | Exercise GPU passes, measure sampling, evaluate saved views, check geometry fidelity, compare prompts. Some need a real saved generation record. |

Obtain each operation's exact fields from `schema --name workflow` or the `potemkin://schema/workflow` resource. Schemas track the engine API in `src/api.ts`. Interactive demo editing and raw access to `session` remain browser APIs; automation exposes their concrete scene operations instead.

`load.path`, look-file paths and run IDs are project-relative. Paths cannot traverse outside the checkout or escape through a symlink. Artifact output names are basenames, confined to the current job directory. A new `run` cannot overwrite an existing run; use `loadRun` then `topUp` to update that run. Do not manually edit job/run files while an automation job is writing them. The worker is a trusted local process, not a sandbox for untrusted repositories or hostile scene assets.

`loadRun` can automatically locate `samples/<saved-level>.glb`. For another location, explicitly load the same geometry with the same layout before `loadRun`. New runs persist their atlas resolution. Legacy runs without resolution metadata default to 4096; specify the original load options explicitly when needed. Views and atlases must use a compatible layout.

## Paid work and connectivity

The following require `allowPaid:true` when routed to cloud models (`provider:'fal'`, `provider:'auto'`, or `providerFallback:'fal'`): `run`, `topUp`, `parts`, `groundNotes`, `pbr`, `nameParts`, `promptTest`, `ground` without `reuse:true`, `props` without `dry:true`, `repair` without `dry:true`, and `checkRun` with `planes:true`. Strict local paint/retexture steps (`provider:'local'` with `providerFallback:'none'`) quote `$0` for paint and run without `allowPaid:true` (`localUrl` is restricted to loopback). The worker blocks browser requests to the fal proxy/provider whenever `allowPaid` is `false`.

`FAL_KEY` stays in the local environment or ignored `.env.local`. The local Vite proxy supplies the credential; it is not an MCP argument or workflow field. `allowPaid:true` is an opt-in, **not a budget cap**. `quote` uses bundled prices and excludes some auxiliary calls. Provider billing may continue for a request already accepted when you cancel.

Free means no paid model call, not necessarily offline: fidelity checks can download SAM weights on first use; referenced assets can also need network access. The included free tutorial uses only bundled scene assets and local GPU passes after installation.

## Persistent jobs and artifacts

Job state lives in ignored `.potemkin/jobs/<UUID>/`. A detached worker transitions from `queued` to `running`, then `succeeded`, `failed` or `cancelled`. A missing worker is marked `interrupted` on polling. Heartbeats update state; `stale:true` means no recent heartbeat, not proof that the process died. A stale-but-live worker still holds the checkout's job lock.

One job runs at a time to protect GPU memory and shared run/build outputs. Disconnecting an MCP client or closing a waiting CLI leaves the worker running. `job-cancel` writes a cooperative request; browser/build shutdown may take a few seconds. Job `timeoutSeconds` terminates local work; CLI `--wait-timeout` only limits waiting. Sleeping or restarting the machine is not a supported continuation mechanism; resume a saved run afterward if available.

Poll `job-status` with `id`, `cursor` and `limit` (up to 100). Feed `nextCursor` into the next request; `hasMore` signals more events. Events are capped at 10,000 per job. Step results are persisted as they complete. Binary data and large JSON results become files under `output/automation/<UUID>/`. Their manifest includes relative `path`, `mimeType`, `bytes` and an MCP `uri`.

MCP resources:

- `potemkin://tutorial`
- `potemkin://automation-reference`
- `potemkin://schema/workflow`
- `potemkin://examples/free-luxor`, `potemkin://examples/texture-luxor`, `potemkin://examples/resume-luxor`
- `potemkin://jobs/<UUID>`
- `potemkin://jobs/<UUID>/artifacts/<name>`

Only manifest-listed artifacts can be read through MCP. Inline resources are limited to 8 MiB; larger GLBs remain available at their local paths. The `free-luxor-tour` prompt guides clients through discovery and the free workflow. The server uses the official [TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) and [stdio transport](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html).

## Verification and troubleshooting

```sh
npm test
npm run build
npm run check:automation
```

`check:automation` exercises real stdio MCP discovery, schemas, a free Luxor GPU workflow, reconnection, artifacts, cancellation and screenshots. It requires an installed browser and writes only ignored local job/artifact files; it never opts into paid generation. Set `TROMPE_CHROME` if using a browser outside Playwright's cache.

For browser failures, run `doctor`, install Chromium, then try a small `plan --sample courtyard --atlas 512 --view-size 256 --views 2 --wait`. A software WebGL backend may be much slower than a real GPU. For `BUSY`, inspect `jobs` and wait or cancel the active job. For a failed generation, inspect `run-info` and its partial files before starting a top-up. Build jobs do not deploy or publish anything.
