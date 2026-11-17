# Tutorial: Luxor from the terminal or an MCP client

This walkthrough first inspects and renders the included project without a paid model call. The last section shows optional texture generation. The baked Luxor scene already contains generated textures; the free engine test uses clay renders and does not recreate that finished artwork.

## 1. Install

Use Node **22.12 or newer**, npm, and a machine that can run Chromium with WebGL2.

```sh
git clone https://github.com/wrong-nebula/potemkin3D.git
cd potemkin3D
npm ci
npx playwright install chromium
node automation/cli.mjs doctor --json
```

On Linux, Playwright may also need system libraries (`npx playwright install --with-deps chromium`). Alternatively, set `TROMPE_CHROME` to your installed Chrome executable. `doctor` checks installation and configuration; a successful screenshot or workflow confirms that rendering actually works.

You can run every command as `node automation/cli.mjs …`. For a shorter executable, optionally run `npm link`, then use `potemkin …` and `potemkin-mcp`. Absolute script paths work from another working directory. Project asset paths always resolve inside the checkout; `--input @file.json` resolves from your current shell directory.

## 2. Discover and inspect

```sh
node automation/cli.mjs catalog --json
node automation/cli.mjs inspect --path samples/luxor.glb --json
node automation/cli.mjs help job-start
node automation/cli.mjs schema --name workflow --json
```

`catalog` lists the bundled GLBs and look files. `inspect` reports meshes, materials and UV availability without launching a browser. Look files combine a model path, lighting, style description, reference images and generation settings.

## 3. Capture the finished Luxor scene

```sh
node automation/cli.mjs screenshot --scene luxor --preset 1 --wait --json
```

Progress goes to stderr; stdout contains a single JSON result. On success, `data.artifacts` includes a PNG path such as `output/automation/<job-id>/luxor.png`. Open that file to see the baked scene. Presets 1–5 select viewpoints; use `--width 1920 --height 1080` for a larger image or `--hud true` to include the controls. This is a browser capture, so rendering can vary slightly with GPU and animation timing.

## 4. Exercise the authoring pipeline for free

```sh
node automation/cli.mjs workflow-check --input @examples/automation/free-luxor.json --json
node automation/cli.mjs job-start --input @examples/automation/free-luxor.json --wait --json
```

The example:

1. Loads Luxor at a modest 1024-pixel atlas and 512-pixel view size.
2. Reports its bounds and plans four camera views.
3. Estimates generation cost using the bundled model price table, without generating anything.
4. Runs two GPU painting passes using the renderer's own clay images.
5. Exports `luxor-clay-test.glb` and the self-test's camera image as job artifacts.

The GLB tests projection and export. It is **not** the finished textured temple. A quote is an estimate, not a spending limit; it excludes some auxiliary calls and can become stale as provider prices change.

For only camera planning:

```sh
node automation/cli.mjs plan --sample luxor --views 4 --wait --json
```

For a custom scene, put a UV-mapped `.glb` inside the checkout (for example `samples/my-scene.glb`), copy the free example and change its `load.path`. Start with a small atlas and a few views before increasing quality.

## 5. Let jobs run independently

Omit `--wait` to receive a job ID immediately:

```sh
node automation/cli.mjs job-start --input @examples/automation/free-luxor.json --json
node automation/cli.mjs jobs --json
node automation/cli.mjs job-status --id JOB_ID --json
node automation/cli.mjs job-cancel --id JOB_ID --json
```

Replace `JOB_ID` with the returned UUID. Jobs survive CLI exit or MCP disconnection. Poll using the previous response's `nextCursor` as `--cursor` to avoid repeated events. `--wait-timeout 60` stops waiting after a minute while the worker continues. Ctrl-C in the waiting CLI also leaves the worker running; use `job-cancel` to stop it.

Only one automation job runs per checkout. A `BUSY` response identifies the active job. Wait for a terminal status before starting another. Cancellation closes local browser/build work; it cannot undo a remote request already accepted by a provider. Saved run files remain available after a failure or cancellation.

## 6. Connect an MCP client

Add an entry like this to your client's MCP configuration, replacing the example paths with absolute paths on your machine:

```json
{
  "mcpServers": {
    "potemkin3d": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/potemkin3D/automation/mcp.mjs"]
    }
  }
}
```

If you use a custom browser, add `"env": { "TROMPE_CHROME": "/absolute/path/to/chrome" }` inside the server entry. Use the Node entry point directly; npm's startup banner must not enter the MCP protocol stream. Restart or reconnect the client after changing its configuration.

Ask your agent:

> Read `potemkin://tutorial`, run `potemkin_doctor` and `potemkin_catalog`, read `potemkin://examples/free-luxor`, then execute that JSON with `potemkin_job_start`. Poll until it finishes. Capture Luxor with `potemkin_screenshot` and read the image artifact. Keep `allowPaid` false.

MCP inputs are JSON objects, not shell strings. For example, `potemkin_screenshot` accepts `{"scene":"luxor","preset":1}`. It returns a job ID; call `potemkin_job_status` with `{"id":"<returned UUID>"}` until it reaches a terminal status. Read the returned artifact URI through the client's resources interface. Images up to 8 MiB are available inline; larger exports are local files listed in the manifest.

The server also offers a `free-luxor-tour` prompt, `potemkin://schema/workflow`, `potemkin://automation-reference`, and `potemkin://jobs/<job-id>` resources. Clients that do not support prompts or resources can still use the tools and local artifact paths.

## 7. Optional: generate textures and resume a run

This section makes paid provider calls. Put `FAL_KEY=…` in an ignored `.env.local` at the project root, or set `FAL_KEY` in the worker's environment. Keep keys out of workflows, command arguments and MCP messages. No key is required for the earlier steps.

Review `examples/automation/texture-luxor.json`. Its `allowPaid` field is deliberately false. It loads Luxor's look file, paints up to four planned views, finishes missing slivers, saves a resumable run and exports a textured GLB. This is a small experiment, not the process needed to match the included finished scene.

```sh
node automation/cli.mjs workflow-check --input @examples/automation/texture-luxor.json --json
# Explicitly opt in after reviewing the workflow and provider prices:
node automation/cli.mjs job-start --input @examples/automation/texture-luxor.json --allow-paid true --wait --json
node automation/cli.mjs run-info --id luxor-first-run --json
```

Choose a new `saveAs`/`save.id` for each new run. An existing run ID is rejected for `run`. Run images and metadata live in `runs/<id>/`; job artifacts live separately in `output/automation/<job-id>/`.

To add a small number of views to that run:

```sh
node automation/cli.mjs job-start --input @examples/automation/resume-luxor.json --allow-paid true --wait --json
```

`loadRun` restores the saved painting; `topUp` adds views; `finish` and `save` update the run. For custom geometry, add an explicit `load` of the matching GLB before `loadRun`. The two baked walkthrough bundles are not generation run archives and cannot be resumed using `loadRun`.

See [the automation reference](AUTOMATION.md) for every command, operation, job status and error contract. See [ENGINE.md](../ENGINE.md) and [POTEMKIN.md](../POTEMKIN.md) for the rendering techniques and project structure.
