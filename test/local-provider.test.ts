import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { quote } from '../src/core/pipeline';
import { buildComfyWorkflow, probeLocalBackend, runLocalEdit } from '../src/providers/local';
import { MODELS, type EditInput } from '../src/providers/models';
import { configureProvider, isLocalModel, isLocalRoute, resetProviderConfig, routeEdit, routeRetexture } from '../src/providers/router';

// Minimal 1x1 PNG in base64 for HTTP wire tests in Node.
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const TINY_DATA_URL = `data:image/png;base64,${TINY_PNG_B64}`;

function sampleInput(mode: 'first' | 'fill' = 'first'): EditInput {
  return {
    imageUrl: TINY_DATA_URL,
    maskUrl: mode === 'fill' ? TINY_DATA_URL : undefined,
    refUrls: mode === 'fill' ? [TINY_DATA_URL] : undefined,
    prompt: { look: 'weathered sandstone courtyard walls', roofLook: 'clay tiles', parts: 'wall (center)', mode, floor: false },
    seed: 42,
    size: 512,
  };
}

const servers: http.Server[] = [];
async function startMockServer(handler: http.RequestListener): Promise<string> {
  const srv = http.createServer(handler);
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  servers.push(srv);
  const addr = srv.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

beforeEach(() => {
  resetProviderConfig();
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => ({
    width: 512,
    height: 512,
    byteLength: blob.size,
    close() {},
  }));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  resetProviderConfig();
  while (servers.length) {
    const srv = servers.pop()!;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

describe('ComfyUI workflow builder and wire protocol', () => {
  it('builds FLUX multi-view ReferenceLatent and InpaintModelConditioning graphs and supports custom templates', () => {
    const mvGraph = buildComfyWorkflow(MODELS['local-comfy-mv'], sampleInput('fill'), {
      image: 'view.png',
      mask: 'mask.png',
      ref: 'ref.png',
    }) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    expect(mvGraph['7']?.class_type).toBe('ReferenceLatent');
    expect(mvGraph['12']?.class_type).toBe('InpaintModelConditioning');
    expect(mvGraph['15']?.inputs.seed).toBe(42);
    expect(mvGraph['15']?.inputs.denoise).toBe(1.0);

    const custom = buildComfyWorkflow(MODELS['flux3-klein'], sampleInput('first'), { image: 'in.png' }, {
      localModel: 'flux-custom.safetensors',
      localWorkflow: {
        a: { class_type: 'CustomFlux', inputs: { prompt: '{{prompt}}', img: '{{image}}', seed: '{{seed}}', ckpt: '{{checkpoint}}' } },
      },
    }) as { a: { inputs: Record<string, unknown> } };
    expect(custom.a.inputs.img).toBe('in.png');
    expect(custom.a.inputs.seed).toBe(42);
    expect(custom.a.inputs.ckpt).toBe('flux-custom.safetensors');
    expect(String(custom.a.inputs.prompt)).toContain('weathered sandstone courtyard walls');
  });

  it('uploads view/mask/ref images, queues /prompt, polls /history and fetches /view on ComfyUI', async () => {
    const uploads: number[] = [];
    let submittedGraph: Record<string, unknown> | undefined;
    const url = await startMockServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u.pathname === '/system_stats') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ system: { comfyui_version: '0.3.0' } }));
      } else if (u.pathname === '/upload/image') {
        uploads.push(body.length);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ name: `up_${uploads.length}.png` }));
      } else if (u.pathname === '/prompt') {
        submittedGraph = JSON.parse(body.toString('utf8')).prompt;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ prompt_id: 'pid-123' }));
      } else if (u.pathname === '/history/pid-123') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          'pid-123': { outputs: { '17': { images: [{ filename: 'out_0001.png', subfolder: '', type: 'output' }] } } },
        }));
      } else if (u.pathname === '/view') {
        res.setHeader('content-type', 'image/png');
        res.end(Buffer.from(TINY_PNG_B64, 'base64'));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });

    const detected = await probeLocalBackend({ localUrl: url, fetchImpl: fetch });
    expect(detected).toEqual({ backend: 'comfyui', url });

    const r = await runLocalEdit(MODELS['local-comfy-mv'], sampleInput('fill'), undefined, { localUrl: url, fetchImpl: fetch });
    expect(uploads.length).toBe(3);   // view + mask + reference image
    expect(submittedGraph).toBeDefined();
    expect(r.requestId).toBe('comfyui:pid-123');
    expect(r.image.width).toBe(512);
  });
});

describe('diffusers, Hunyuan3D-Paint, provider router and $0 quoting', () => {
  it('speaks diffusers /v1/images/edits (and /sdapi/v1/img2img fallback) plus Hunyuan3D-Paint mesh retexture', async () => {
    let lastDiffusersBody: Record<string, unknown> | undefined;
    const diffUrl = await startMockServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      if (req.url === '/v1/images/edits') {
        res.statusCode = 404;   // exercise automatic fallback to /edit / /sdapi/v1/img2img
        res.end();
        return;
      }
      if (req.url === '/sdapi/v1/img2img' || req.url === '/edit') {
        lastDiffusersBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ images: [TINY_PNG_B64] }));
        return;
      }
      res.statusCode = 200;
      res.end('ok');
    });

    const editRes = await routeEdit(MODELS['flux3-klein'], sampleInput('fill'), undefined, {
      provider: 'local',
      localBackend: 'diffusers',
      localUrl: diffUrl,
      fetchImpl: fetch,
    });
    expect(editRes.providerUsed).toBe('local');
    expect(Array.isArray(lastDiffusersBody?.reference_images)).toBe(true);

    // Hunyuan3D-Paint GLB retexture round-trip
    const fakeGlb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]).buffer;
    const hyUrl = await startMockServer(async (req, res) => {
      for await (const _ of req) { /* drain */ }
      if (req.url === '/retexture') {
        res.setHeader('content-type', 'model/gltf-binary');
        res.end(Buffer.from(fakeGlb));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    const retRes = await routeRetexture(fakeGlb, 'rusted iron crate', undefined, TINY_DATA_URL, {
      provider: 'local',
      localBackend: 'hunyuan3d',
      localUrl: hyUrl,
      fetchImpl: fetch,
    });
    expect(retRes.providerUsed).toBe('local');
    expect(retRes.glb.byteLength).toBe(8);
  });

  it('quotes $0 for paint under --provider local or local models, and enforces strict vs fallback routing', async () => {
    const plan = {
      views: [
        { id: 0, position: [0, 1.6, 0] as [number, number, number], yaw: 0, pitch: 0, fov: 90 },
        { id: 1, position: [2, 1.6, 0] as [number, number, number], yaw: 1, pitch: 0, fov: 90 },
      ],
      waves: [[0], [1]],
    };
    const strictQuote = quote(plan, {
      firstModel: 'flux3-klein', fillModel: 'fibo2', holes: 4, secondGoes: 1, planes: true, viewSize: 2048, provider: 'local',
    });
    expect(strictQuote.paint).toBe(0);
    expect(strictQuote.again).toBe(0);
    expect(strictQuote.planes).toBe(0);
    expect(strictQuote.cost).toBe(0);
    expect(strictQuote.provider).toBe('local');

    // With optional cloud MoGe fallback (`providerFallback: 'fal'`), paint STILL quotes $0 while planes shows optional MoGe cap
    const hybridQuote = quote(plan, {
      firstModel: 'flux3-klein', fillModel: 'fibo2', holes: 2, secondGoes: 1, planes: true, viewSize: 2048,
      provider: 'local', providerFallback: 'fal',
    });
    expect(hybridQuote.paint).toBe(0);
    expect(hybridQuote.planes).toBeGreaterThan(0);

    // Local model entries quote $0 automatically
    expect(isLocalModel(MODELS['local-flux'])).toBe(true);
    expect(isLocalRoute({ provider: 'auto' }, MODELS['hunyuan3d-paint'])).toBe(true);
    expect(quote(plan, { firstModel: 'local-flux', fillModel: 'local-comfy-mv' }).paint).toBe(0);

    // Strict local failure never leaks to cloud when providerFallback is 'none'
    configureProvider({ provider: 'local', providerFallback: 'none', localBackend: 'diffusers', localUrl: 'http://127.0.0.1:1' });
    await expect(routeEdit(MODELS['flux3-klein'], sampleInput('first'), undefined, { fetchImpl: fetch }))
      .rejects.toThrow();
  });
});
