/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const FAL_HOST = /(^|\.)fal\.(ai|run|media)$/;
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|::1|\[::1\])$/;

function allowedLocalTarget(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (LOOPBACK_HOST.test(u.hostname)) return u;
    if (process.env.LOCAL_MODEL_URL) {
      const cfg = new URL(process.env.LOCAL_MODEL_URL);
      if (u.hostname === cfg.hostname && u.port === cfg.port) return u;
    }
    return null;
  } catch {
    return null;
  }
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function fail(res: ServerResponse, status: number, msg: string) {
  res.statusCode = status;
  res.end(msg);
}

/**
 * fal proxy for local use: the browser never sees the key. Implements fal's proxy protocol
 * (`x-fal-target-url`) plus a media passthrough for result images. The key comes from FAL_KEY (the environment, or
 * a .env / .env.local file next to this config).
 */
function falProxy(): Plugin {
  return {
    name: 'trompe-fal-proxy',
    configureServer(server) {
      server.middlewares.use('/api/fal/proxy', async (req, res) => {
        const key = process.env.FAL_KEY;
        const target = req.headers['x-fal-target-url'];
        if (!key) return fail(res, 500, 'FAL_KEY is not set where the dev server runs');
        if (typeof target !== 'string') return fail(res, 400, 'missing x-fal-target-url');
        if (!FAL_HOST.test(new URL(target).hostname)) return fail(res, 403, 'target host not allowed');
        const headers: Record<string, string> = { authorization: `Key ${key}`, accept: 'application/json' };
        for (const [k, v] of Object.entries(req.headers)) {
          if (k.startsWith('x-fal-') && k !== 'x-fal-target-url' && typeof v === 'string') headers[k] = v;
        }
        if (typeof req.headers['content-type'] === 'string') headers['content-type'] = req.headers['content-type'];
        const method = req.method ?? 'GET';
        try {
          const r = await fetch(target, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(await body(req)) });
          res.statusCode = r.status;
          const ct = r.headers.get('content-type');
          if (ct) res.setHeader('content-type', ct);
          res.end(Buffer.from(await r.arrayBuffer()));
        } catch (e) {
          fail(res, 502, `proxy error: ${(e as Error).message}`);
        }
      });
      // Saves run artefacts under ./runs/<id>/<file> (dev server only; names are restricted to [\w.-]); GET lists the runs.
      server.middlewares.use('/api/runs', async (req, res) => {
        if (req.method === 'GET' && /^\/?(\?.*)?$/.test(req.url ?? '')) {
          // saved runs, newest first: [{ id, level, views, cost, partial }]
          const root = path.resolve(server.config.root, 'runs');
          const runs: { id: string; level: string; views: number; cost: number; partial: boolean; at: number }[] = [];
          for (const id of await fs.readdir(root).catch(() => [] as string[])) {
            try {
              const file = path.join(root, id, 'run.json');
              const m = JSON.parse(await fs.readFile(file, 'utf8'));
              runs.push({ id, level: m.level, views: m.views.length, cost: m.cost, partial: !!m.partial, at: (await fs.stat(file)).mtimeMs });
            } catch { /* not a run */ }
          }
          res.setHeader('content-type', 'application/json');
          return res.end(JSON.stringify(runs.sort((a, b) => b.at - a.at)));
        }
        if (req.method !== 'POST') return fail(res, 405, 'POST only');
        const parts = decodeURIComponent((req.url ?? '').replace(/^\/+/, '').split('?')[0]).split('/');
        const safe = /^[\w.-]+$/;
        if (parts.length !== 2 || !parts.every((p) => safe.test(p) && p !== '..' && p !== '.')) return fail(res, 400, 'bad path');
        const root = path.resolve(server.config.root, 'runs');
        const dir = path.join(root, parts[0]);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, parts[1]), await body(req));
        res.statusCode = 204;
        res.end();
      });
      // Read-through cache for the blockout check's model (src/providers/sam.ts): files of that one Hugging Face
      // repo, fetched once and kept under node_modules/.cache.
      server.middlewares.use('/api/hf', async (req, res) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
        if (!/^onnx-community\/sam2\.1-hiera-tiny-ONNX\/resolve\/main\/[\w./-]+$/.test(rel) || rel.includes('..')) return fail(res, 403, 'not a cached model file');
        const file = path.join(server.config.root, 'node_modules/.cache/trompe-models', rel);
        try {
          let data = await fs.readFile(file).catch(() => null);
          if (!data) {
            const r = await fetch(`https://huggingface.co/${rel}`);
            if (!r.ok) return fail(res, r.status, `Hugging Face answered ${r.status}`);
            data = Buffer.from(await r.arrayBuffer());
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, data);
          }
          res.setHeader('content-type', rel.endsWith('.json') ? 'application/json' : 'application/octet-stream');
          res.setHeader('content-length', data.length);
          res.end(data);
        } catch (e) {
          fail(res, 502, `model fetch error: ${(e as Error).message}`);
        }
      });
      server.middlewares.use('/api/fal/media', async (req, res) => {
        const url = new URL(req.url ?? '', 'http://x').searchParams.get('url');
        if (!url || !FAL_HOST.test(new URL(url).hostname)) return fail(res, 400, 'bad media url');
        try {
          const r = await fetch(url);
          res.statusCode = r.status;
          res.setHeader('content-type', r.headers.get('content-type') ?? 'application/octet-stream');
          res.end(Buffer.from(await r.arrayBuffer()));
        } catch (e) {
          fail(res, 502, `media fetch error: ${(e as Error).message}`);
        }
      });
      // CORS-free passthrough for local inference servers (ComfyUI :8188, diffusers :8000, Hunyuan3D-Paint :8081).
      // Strictly restricted to loopback or an explicit server-configured LOCAL_MODEL_URL host.
      server.middlewares.use('/api/local/proxy', async (req, res) => {
        const raw = new URL(req.url ?? '', 'http://x').searchParams.get('url');
        const target = raw ? allowedLocalTarget(raw) : null;
        if (!target) return fail(res, 403, 'local proxy only allows loopback or LOCAL_MODEL_URL');
        const headers: Record<string, string> = {};
        for (const k of ['content-type', 'accept', 'authorization'] as const) {
          if (typeof req.headers[k] === 'string') headers[k] = req.headers[k];
        }
        const method = req.method ?? 'GET';
        try {
          const r = await fetch(target, {
            method,
            headers,
            body: method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(await body(req)),
          });
          res.statusCode = r.status;
          const ct = r.headers.get('content-type');
          if (ct) res.setHeader('content-type', ct);
          res.end(Buffer.from(await r.arrayBuffer()));
        } catch (e) {
          fail(res, 502, `local proxy error: ${(e as Error).message}`);
        }
      });
      // Safe read-only documentation endpoint for the Studio progressive Markdown viewer (@pierre/words).
      const DOCS: Record<string, { title: string; path: string; summary: string }> = {
        engine: { title: 'Engine Architecture', path: 'ENGINE.md', summary: 'Geometry prepasses, camera planning, projection, stitching, UV refinement and PBR baking.' },
        readme: { title: 'Overview & Quickstart', path: 'README.md', summary: 'Setup, studio authoring workflow, CLI flags and sample scenes.' },
        potemkin: { title: 'Potemkin Scenes & Film Camera', path: 'POTEMKIN.md', summary: 'Scene-referred HDR walkthroughs, lens flare, DOF, POM relief and progressive 4K LOD.' },
        'material-maps': { title: 'Material Maps & Presets', path: 'docs/material-maps.md', summary: 'Intrinsic and PATINA height, roughness, metallic, normal and glTF ORM channels.' },
        automation: { title: 'Automation & MCP Reference', path: 'docs/AUTOMATION.md', summary: 'Persistent jobs, CLI commands, MCP server tools/resources and spend guards.' },
        tutorial: { title: 'Free Walkthrough Tutorial', path: 'docs/TUTORIAL.md', summary: 'Zero-cost end-to-end tour of planning, clay self-test and scene screenshots.' },
        provenance: { title: 'Provenance & Licensing', path: 'PROVENANCE.md', summary: 'Attribution, upstream lineage and Apache-2.0 licensing details.' },
        todo: { title: 'Research & Roadmap', path: 'TODO.md', summary: 'Measured benchmarks across UV unwrap, local providers, Critic loop and research spikes.' },
      };
      server.middlewares.use('/api/docs', async (req, res) => {
        if (req.method !== 'GET') return fail(res, 405, 'GET only');
        const u = new URL(req.url ?? '', 'http://x');
        const topic = u.searchParams.get('topic');
        res.setHeader('content-type', 'application/json');
        if (!topic) {
          return res.end(JSON.stringify(Object.entries(DOCS).map(([id, meta]) => ({ id, ...meta }))));
        }
        const entry = DOCS[topic.toLowerCase()];
        if (!entry) return fail(res, 404, 'unknown doc topic');
        try {
          const markdown = await fs.readFile(path.join(server.config.root, entry.path), 'utf8');
          res.end(JSON.stringify({ id: topic.toLowerCase(), ...entry, markdown }));
        } catch (e) {
          fail(res, 500, `doc read error: ${(e as Error).message}`);
        }
      });
      server.middlewares.use('/api/dcc-sync', async (req, res) => {
        if (req.method !== 'POST') return fail(res, 405, 'POST only');
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
          const raw = Buffer.concat(chunks).toString('utf8');
          const body = raw ? JSON.parse(raw) : {};
          const { dccSync } = (await import('./automation/dcc.mjs' as string)) as {
            dccSync: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
          };
          res.setHeader('content-type', 'application/json');
          try {
            const data = await dccSync(body);
            res.end(JSON.stringify({ ok: true, data }));
          } catch (liveErr) {
            if (!body.dryRun) {
              const staged = await dccSync({ ...body, dryRun: true });
              res.end(JSON.stringify({ ok: true, fallbackDryRun: true, liveError: (liveErr as Error)?.message, data: staged }));
              return;
            }
            throw liveErr;
          }
        } catch (e) {
          fail(res, 400, (e as Error)?.message ?? 'dcc-sync failed');
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // FAL_KEY may live in .env.local (gitignored) instead of the shell; it stays on the server either way.
  process.env.FAL_KEY ??= loadEnv(mode, import.meta.dirname, 'FAL_').FAL_KEY;
  return {
    plugins: [falProxy()],
    server: { port: 5178, strictPort: false },
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 850,
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              { name: 'three', test: /node_modules[\\/](three|three-mesh-bvh)/, priority: 30 },
              { name: 'ui-sdk', test: /node_modules[\\/]@ui-sdk/, priority: 25 },
              { name: 'words-core', test: /node_modules[\\/]@pierre[\\/]words[\\/]dist[\\/](index|html|mermaid|wasm)/, priority: 20 },
            ],
          },
        },
      },
    },
  };
});
