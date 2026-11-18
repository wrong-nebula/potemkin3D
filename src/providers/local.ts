import { prompts, type EditInput, type EditModel } from './models';
import type { EditResult } from './fal';

export type ProviderKind = 'fal' | 'local' | 'auto';
export type ProviderFallback = 'none' | 'fal' | 'local';
export type LocalBackend = 'auto' | 'comfyui' | 'diffusers' | 'hunyuan3d' | 'procedural';

export interface ProviderOptions {
  /** Primary inference route: 'fal' (cloud default), 'local' ($0 local endpoint), or 'auto' (local when reachable, else fal). */
  provider?: ProviderKind;
  /** Fallback route when the primary provider fails or is unreachable ('none' by default so local runs stay offline/free). */
  providerFallback?: ProviderFallback;
  /** Local wire protocol: 'auto' probes ComfyUI (:8188), diffusers (:8000) and Hunyuan3D-Paint (:8081). */
  localBackend?: LocalBackend;
  /** Base URL of the local inference endpoint (e.g. 'http://127.0.0.1:8188'). */
  localUrl?: string;
  /** Optional local checkpoint / model identifier override. */
  localModel?: string;
  /** Optional custom ComfyUI API prompt graph JSON with {{prompt}}, {{image}}, {{mask}}, {{ref_image}}, {{seed}}, {{width}}, {{height}}, {{denoise}} placeholders. */
  localWorkflow?: Record<string, unknown>;
  /** Route diminishing-return tail views (`plan.budget.localModelTailViews`) to local while keeping hero views on cloud. */
  localTail?: boolean;
  /** Custom fetch implementation (for Node tests without browser proxy). */
  fetchImpl?: typeof fetch;
}

export const DEFAULT_LOCAL_URLS: Record<Exclude<LocalBackend, 'auto' | 'procedural'>, string> = {
  comfyui: 'http://127.0.0.1:8188',
  diffusers: 'http://127.0.0.1:8000',
  hunyuan3d: 'http://127.0.0.1:8081',
};

function useBrowserProxy(targetUrl: string, customFetch?: typeof fetch): boolean {
  if (customFetch) return false;
  if (typeof window === 'undefined' || !window.location?.origin) return false;
  try {
    const u = new URL(targetUrl);
    return u.origin !== window.location.origin;
  } catch {
    return false;
  }
}

async function localFetch(targetUrl: string, init: RequestInit = {}, customFetch?: typeof fetch): Promise<Response> {
  const fn = customFetch ?? fetch;
  if (useBrowserProxy(targetUrl, customFetch)) {
    return fn(`/api/local/proxy?url=${encodeURIComponent(targetUrl)}`, init);
  }
  return fn(targetUrl, init);
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function promptForModel(model: EditModel, input: EditInput): string {
  return model.text?.(input.prompt) ?? (model.mask === null ? prompts.caption(input.prompt) : prompts.instruction(input.prompt));
}

async function dataUrlToBlob(dataUrl: string, signal?: AbortSignal, customFetch?: typeof fetch): Promise<{ blob: Blob; ext: string }> {
  const m = /^data:image\/([a-zA-Z0-9+.-]+);base64,([\s\S]+)$/.exec(dataUrl);
  if (m) {
    const mime = `image/${m[1]}`;
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { blob: new Blob([bytes], { type: mime }), ext };
  }
  const res = await localFetch(dataUrl, { signal }, customFetch);
  if (!res.ok) throw new Error(`loading input image failed: ${res.status}`);
  const blob = await res.blob();
  const ext = blob.type.includes('png') ? 'png' : 'jpg';
  return { blob, ext };
}

async function decodeImageBlob(blob: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  throw new Error('createImageBitmap is unavailable in this runtime');
}

async function decodeBase64OrUrl(value: string, baseUrl: string, signal?: AbortSignal, customFetch?: typeof fetch): Promise<ImageBitmap> {
  if (value.startsWith('data:image/')) {
    const { blob } = await dataUrlToBlob(value, signal, customFetch);
    return decodeImageBlob(blob);
  }
  if (/^https?:\/\//.test(value) || value.startsWith('/')) {
    const full = value.startsWith('/') ? `${trimSlash(baseUrl)}${value}` : value;
    const res = await localFetch(full, { signal }, customFetch);
    if (!res.ok) throw new Error(`fetching local output image failed: ${res.status}`);
    return decodeImageBlob(await res.blob());
  }
  const bin = atob(value);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  return decodeImageBlob(new Blob([bytes], { type: isPng ? 'image/png' : 'image/jpeg' }));
}

function defaultCheckpointFor(modelKey: string): string {
  if (modelKey.includes('klein')) return 'flux1-klein-edit.safetensors';
  if (modelKey.includes('flux')) return 'flux1-dev-fp8.safetensors';
  return 'flux1-kontext-dev.safetensors';
}

function substituteWorkflow(node: unknown, vars: Record<string, string | number>): unknown {
  if (typeof node === 'string') {
    const exact = /^\{\{(\w+)\}\}$/.exec(node);
    if (exact && exact[1] in vars) return vars[exact[1]];
    return node.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : `{{${k}}}`));
  }
  if (Array.isArray(node)) return node.map((x) => substituteWorkflow(x, vars));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = substituteWorkflow(v, vars);
    return out;
  }
  return node;
}

/**
 * Build a ComfyUI API workflow graph for FLUX-based multi-view texturing & masked inpainting, or instantiate a
 * user-supplied workflow template.
 */
export function buildComfyWorkflow(model: EditModel, input: EditInput, files: {
  image: string;
  mask?: string;
  ref?: string;
}, opts: ProviderOptions = {}): Record<string, unknown> {
  const prompt = promptForModel(model, input);
  const denoise = files.mask && input.prompt.mode !== 'first' ? 1.0 : input.prompt.mode === 'first' ? 0.90 : 0.78;
  if (opts.localWorkflow) {
    return substituteWorkflow(opts.localWorkflow, {
      prompt,
      image: files.image,
      mask: files.mask ?? files.image,
      ref_image: files.ref ?? files.image,
      seed: input.seed,
      width: input.size,
      height: input.size,
      denoise,
      checkpoint: opts.localModel ?? defaultCheckpointFor(model.key),
    }) as Record<string, unknown>;
  }

  const ckpt = opts.localModel ?? defaultCheckpointFor(model.key);
  const graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    '2': { class_type: 'LoadImage', inputs: { image: files.image } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: 'text, watermark, labels, blurry, distorted perspective', clip: ['1', 1] } },
  };

  let positiveLink: [string, number] = ['3', 0];
  let negativeLink: [string, number] = ['4', 0];
  let latentLink: [string, number];

  if (files.ref) {
    // Multi-view context conditioning: pair reference frame alongside current view latent (FLUX multi-view / Kontext style).
    graph['5'] = { class_type: 'LoadImage', inputs: { image: files.ref } };
    graph['6'] = { class_type: 'VAEEncode', inputs: { pixels: ['5', 0], vae: ['1', 2] } };
    graph['7'] = { class_type: 'ReferenceLatent', inputs: { conditioning: ['3', 0], latent: ['6', 0] } };
    positiveLink = ['7', 0];
  }

  if (files.mask && input.prompt.mode !== 'first') {
    graph['11'] = { class_type: 'LoadImageMask', inputs: { image: files.mask, channel: 'red' } };
    graph['12'] = { class_type: 'InpaintModelConditioning', inputs: {
      positive: positiveLink, negative: negativeLink, vae: ['1', 2], pixels: ['2', 0], mask: ['11', 0], noise_mask: true,
    } };
    positiveLink = ['12', 0];
    negativeLink = ['12', 1];
    latentLink = ['12', 2];
  } else {
    graph['12'] = { class_type: 'VAEEncode', inputs: { pixels: ['2', 0], vae: ['1', 2] } };
    latentLink = ['12', 0];
  }

  graph['15'] = {
    class_type: 'KSampler',
    inputs: {
      model: ['1', 0],
      seed: input.seed,
      steps: 20,
      cfg: 3.5,
      sampler_name: 'euler',
      scheduler: 'simple',
      positive: positiveLink,
      negative: negativeLink,
      latent_image: latentLink,
      denoise,
    },
  };
  graph['16'] = { class_type: 'VAEDecode', inputs: { samples: ['15', 0], vae: ['1', 2] } };
  graph['17'] = { class_type: 'SaveImage', inputs: { images: ['16', 0], filename_prefix: 'potemkin' } };
  return graph;
}

async function uploadComfyImage(baseUrl: string, dataUrl: string, tag: string, signal?: AbortSignal, customFetch?: typeof fetch): Promise<string> {
  const { blob, ext } = await dataUrlToBlob(dataUrl, signal, customFetch);
  const form = new FormData();
  const filename = `potemkin_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`;
  form.append('image', blob, filename);
  form.append('overwrite', 'true');
  const res = await localFetch(`${baseUrl}/upload/image`, { method: 'POST', body: form, signal }, customFetch);
  if (!res.ok) throw new Error(`ComfyUI /upload/image failed: ${res.status}`);
  const data = (await res.json()) as { name?: string };
  return data.name ?? filename;
}

async function runComfyUiEdit(model: EditModel, input: EditInput, signal?: AbortSignal, opts: ProviderOptions = {}): Promise<EditResult> {
  const t0 = performance.now();
  const baseUrl = trimSlash(opts.localUrl ?? DEFAULT_LOCAL_URLS.comfyui);
  const fn = opts.fetchImpl;
  const image = await uploadComfyImage(baseUrl, input.imageUrl, 'view', signal, fn);
  const mask = input.maskUrl && input.prompt.mode !== 'first'
    ? await uploadComfyImage(baseUrl, input.maskUrl, 'mask', signal, fn)
    : undefined;
  const refSource = input.styleUrls?.[0] ?? input.refUrls?.[0] ?? input.swatchUrl;
  const ref = refSource ? await uploadComfyImage(baseUrl, refSource, 'ref', signal, fn) : undefined;

  const workflow = buildComfyWorkflow(model, input, { image, mask, ref }, opts);
  const qRes = await localFetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: 'potemkin3d' }),
    signal,
  }, fn);
  if (!qRes.ok) throw new Error(`ComfyUI /prompt failed: ${qRes.status} ${await qRes.text().catch(() => '')}`);
  const { prompt_id: promptId } = (await qRes.json()) as { prompt_id?: string };
  if (!promptId) throw new Error('ComfyUI /prompt returned no prompt_id');

  // Poll /history/{prompt_id} until SaveImage finishes or ComfyUI reports an execution error.
  for (let poll = 0; poll < 600; poll++) {
    signal?.throwIfAborted();
    const hRes = await localFetch(`${baseUrl}/history/${encodeURIComponent(promptId)}`, { signal }, fn);
    if (hRes.ok) {
      const hist = (await hRes.json()) as Record<string, {
        status?: { status_str?: string; messages?: unknown[] };
        outputs?: Record<string, { images?: { filename: string; subfolder?: string; type?: string }[] }>;
      }>;
      const entry = hist[promptId];
      if (entry?.status?.status_str === 'error') {
        throw new Error(`ComfyUI workflow failed: ${JSON.stringify(entry.status.messages ?? 'error')}`);
      }
      if (entry?.outputs) {
        for (const out of Object.values(entry.outputs)) {
          const img = out.images?.[0];
          if (img?.filename) {
            const qs = new URLSearchParams({
              filename: img.filename,
              subfolder: img.subfolder ?? '',
              type: img.type ?? 'output',
            });
            const vRes = await localFetch(`${baseUrl}/view?${qs}`, { signal }, fn);
            if (!vRes.ok) throw new Error(`ComfyUI /view failed: ${vRes.status}`);
            const bitmap = await decodeImageBlob(await vRes.blob());
            return { image: bitmap, seconds: (performance.now() - t0) / 1000, requestId: `comfyui:${promptId}` };
          }
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 150);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('Aborted')); }, { once: true });
    });
  }
  throw new Error(`ComfyUI prompt ${promptId} timed out waiting for output`);
}

async function runDiffusersEdit(model: EditModel, input: EditInput, signal?: AbortSignal, opts: ProviderOptions = {}): Promise<EditResult> {
  const t0 = performance.now();
  const baseUrl = trimSlash(opts.localUrl ?? DEFAULT_LOCAL_URLS.diffusers);
  const fn = opts.fetchImpl;
  const prompt = promptForModel(model, input);
  const refs = [...(input.styleUrls ?? []), ...(input.refUrls ?? []), ...(input.swatchUrl ? [input.swatchUrl] : [])];
  const payload = {
    model: opts.localModel ?? model.key,
    prompt,
    image: input.imageUrl,
    ...(input.maskUrl && input.prompt.mode !== 'first' ? { mask_image: input.maskUrl, mask: input.maskUrl } : {}),
    ...(refs.length ? { reference_images: refs } : {}),
    width: input.size,
    height: input.size,
    seed: input.seed,
    strength: input.prompt.mode === 'first' ? 0.90 : 0.80,
    denoising_strength: input.prompt.mode === 'first' ? 0.90 : 0.80,
    init_images: [input.imageUrl],
  };

  let res: Response | undefined;
  for (const endpoint of ['/v1/images/edits', '/edit', '/sdapi/v1/img2img']) {
    const r = await localFetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    }, fn);
    if (r.status === 404) continue;
    res = r;
    break;
  }
  if (!res) throw new Error(`diffusers server at ${baseUrl} has none of /v1/images/edits, /edit or /sdapi/v1/img2img`);
  if (!res.ok) throw new Error(`local diffusers edit failed: ${res.status} ${await res.text().catch(() => '')}`);

  const ct = res.headers.get('content-type') ?? '';
  if (ct.startsWith('image/')) {
    const image = await decodeImageBlob(await res.blob());
    return { image, seconds: (performance.now() - t0) / 1000, requestId: `diffusers:${Date.now()}` };
  }
  const data = (await res.json()) as {
    id?: string;
    data?: { b64_json?: string; url?: string }[];
    images?: (string | { url?: string; b64_json?: string })[];
    image?: string | { url?: string; b64_json?: string };
  };
  const pick = data.data?.[0]?.b64_json ?? data.data?.[0]?.url
    ?? (typeof data.images?.[0] === 'string' ? data.images[0] : data.images?.[0]?.b64_json ?? data.images?.[0]?.url)
    ?? (typeof data.image === 'string' ? data.image : data.image?.b64_json ?? data.image?.url);
  if (!pick) throw new Error(`local diffusers endpoint at ${baseUrl} returned no image`);
  const image = await decodeBase64OrUrl(pick, baseUrl, signal, fn);
  return { image, seconds: (performance.now() - t0) / 1000, requestId: data.id ?? `diffusers:${Date.now()}` };
}

async function runHunyuanEdit(model: EditModel, input: EditInput, signal?: AbortSignal, opts: ProviderOptions = {}): Promise<EditResult> {
  const t0 = performance.now();
  const baseUrl = trimSlash(opts.localUrl ?? DEFAULT_LOCAL_URLS.hunyuan3d);
  const fn = opts.fetchImpl;
  const prompt = promptForModel(model, input);
  const refs = [...(input.styleUrls ?? []), ...(input.refUrls ?? []), ...(input.swatchUrl ? [input.swatchUrl] : [])];
  const payload = {
    model: opts.localModel ?? 'hunyuan3d-paint-v2',
    prompt,
    text: prompt,
    image: input.imageUrl,
    ...(input.maskUrl && input.prompt.mode !== 'first' ? { mask: input.maskUrl } : {}),
    ...(refs.length ? { reference_images: refs } : {}),
    width: input.size,
    height: input.size,
    seed: input.seed,
  };
  let res: Response | undefined;
  for (const endpoint of ['/paint_view', '/v1/images/edits', '/edit']) {
    const r = await localFetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    }, fn);
    if (r.status === 404) continue;
    res = r;
    break;
  }
  if (!res) throw new Error(`Hunyuan3D-Paint server at ${baseUrl} has no /paint_view or /edit endpoint`);
  if (!res.ok) throw new Error(`Hunyuan3D-Paint view failed: ${res.status} ${await res.text().catch(() => '')}`);
  const ct = res.headers.get('content-type') ?? '';
  if (ct.startsWith('image/')) {
    return { image: await decodeImageBlob(await res.blob()), seconds: (performance.now() - t0) / 1000, requestId: `hunyuan3d:${Date.now()}` };
  }
  const data = (await res.json()) as { image?: string; images?: string[]; b64_json?: string; url?: string };
  const pick = data.image ?? data.images?.[0] ?? data.b64_json ?? data.url;
  if (!pick) throw new Error(`Hunyuan3D-Paint server at ${baseUrl} returned no image`);
  return { image: await decodeBase64OrUrl(pick, baseUrl, signal, fn), seconds: (performance.now() - t0) / 1000, requestId: `hunyuan3d:${Date.now()}` };
}

/** Retexture an isolated part/object GLB via a local Hunyuan3D-Paint server (`POST /retexture` or `/generate`). */
export async function runLocalRetexture(glb: ArrayBuffer, prompt: string, signal?: AbortSignal, imageUrl?: string, opts: ProviderOptions = {}): Promise<{ glb: ArrayBuffer; seconds: number }> {
  const t0 = performance.now();
  const baseUrl = trimSlash(opts.localUrl ?? DEFAULT_LOCAL_URLS.hunyuan3d);
  const fn = opts.fetchImpl;
  let binary = '';
  const bytes = new Uint8Array(glb);
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  const payload = {
    mesh: btoa(binary),
    model_url: `data:model/gltf-binary;base64,${btoa(binary)}`,
    text: prompt.slice(0, 800),
    prompt: prompt.slice(0, 800),
    ...(imageUrl ? { image: imageUrl, image_style_url: imageUrl } : {}),
    texture: true,
    type: 'glb',
  };
  let res: Response | undefined;
  for (const endpoint of ['/retexture', '/generate']) {
    const r = await localFetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    }, fn);
    if (r.status === 404) continue;
    res = r;
    break;
  }
  if (!res) throw new Error(`Hunyuan3D-Paint server at ${baseUrl} has no /retexture or /generate endpoint`);
  if (!res.ok) throw new Error(`Hunyuan3D-Paint retexture failed: ${res.status}`);
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('gltf') || ct.includes('octet-stream')) {
    return { glb: await res.arrayBuffer(), seconds: (performance.now() - t0) / 1000 };
  }
  const data = (await res.json()) as { glb_base64?: string; model_glb?: string | { url?: string }; url?: string };
  const b64 = data.glb_base64 ?? (typeof data.model_glb === 'string' && !data.model_glb.startsWith('http') ? data.model_glb : undefined);
  if (b64) {
    const raw = atob(b64.replace(/^data:[^,]+,/, ''));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return { glb: out.buffer, seconds: (performance.now() - t0) / 1000 };
  }
  const url = (typeof data.model_glb === 'object' ? data.model_glb?.url : data.model_glb) ?? data.url;
  if (!url) throw new Error('Hunyuan3D-Paint returned no textured GLB');
  const dl = await localFetch(url.startsWith('/') ? `${baseUrl}${url}` : url, { signal }, fn);
  if (!dl.ok) throw new Error(`downloading Hunyuan3D-Paint GLB failed: ${dl.status}`);
  return { glb: await dl.arrayBuffer(), seconds: (performance.now() - t0) / 1000 };
}

/** Optional local OpenAI-compatible VLM (`POST /v1/chat/completions`, e.g. Ollama / vLLM / LM Studio) for $0 part naming. */
export async function runLocalVision(prompt: string, imageUrls: string[], signal?: AbortSignal, opts: ProviderOptions = {}): Promise<{ text: string; cost: number }> {
  const baseUrl = trimSlash(opts.localUrl ?? DEFAULT_LOCAL_URLS.diffusers);
  const res = await localFetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: opts.localModel ?? 'llava',
      temperature: 0.2,
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      }],
    }),
    signal,
  }, opts.fetchImpl);
  if (!res.ok) throw new Error(`local vision endpoint at ${baseUrl}/v1/chat/completions answered ${res.status}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return { text: data.choices?.[0]?.message?.content ?? '', cost: 0 };
}

function hashText(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

/**
 * Deterministic zero-daemon procedural material painter (`localBackend: 'procedural'`), for offline $0 runs and CI tests
 * when no Python GPU server is running. Preserves already-painted context pixels and synthesizes stone/brick/plaster
 * material colour and grain modulated by the clay lighting.
 */
async function runProceduralEdit(model: EditModel, input: EditInput, signal?: AbortSignal): Promise<EditResult> {
  const t0 = performance.now();
  signal?.throwIfAborted();
  const { blob } = await dataUrlToBlob(input.imageUrl, signal);
  const srcBmp = await decodeImageBlob(blob);
  const S = input.size;
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(S, S)
    : Object.assign(document.createElement('canvas'), { width: S, height: S });
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  ctx.drawImage(srcBmp, 0, 0, S, S);
  srcBmp.close?.();
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;

  let maskData: Uint8ClampedArray | null = null;
  if (input.maskUrl && input.prompt.mode !== 'first') {
    const { blob: mb } = await dataUrlToBlob(input.maskUrl, signal);
    const mBmp = await decodeImageBlob(mb);
    const mCanvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(S, S)
      : Object.assign(document.createElement('canvas'), { width: S, height: S });
    const mCtx = mCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
    mCtx.drawImage(mBmp, 0, 0, S, S);
    mBmp.close?.();
    maskData = mCtx.getImageData(0, 0, S, S).data;
  }

  // Derive a warm material palette deterministically from the style prompt so every view shares consistent tones.
  const styleSeed = hashText(`${input.prompt.look}|${input.prompt.floorLook ?? ''}|${input.prompt.roofLook}`);
  const baseR = 168 + ((styleSeed & 0x3f) - 24);
  const baseG = 146 + (((styleSeed >>> 6) & 0x3f) - 24);
  const baseB = 116 + (((styleSeed >>> 12) & 0x3f) - 24);
  const invertMask = model.mask === 'black';

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x, p = 4 * i;
      if (maskData) {
        const mv = maskData[p];
        const editable = invertMask ? mv < 128 : mv >= 128;
        if (!editable) continue;
      }
      const r = d[p], g = d[p + 1], b = d[p + 2];
      // Leave sky (bright blueish background) and already chromatic painted context intact when no mask was supplied.
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (!maskData && chroma > 18) continue;
      if (b > r + 14 && b > 175) continue;

      const shade = Math.max(0.28, Math.min(1.25, (0.299 * r + 0.587 * g + 0.114 * b) / 168));
      // Multi-scale procedural masonry / mortar / grain so `untouched()` sees genuine texture & palette shift.
      const course = ((y + ((Math.floor(y / 28) & 1) * 19)) % 28 === 0 || (x + ((Math.floor(y / 28) & 1) * 23)) % 46 === 0) ? 0.86 : 1.0;
      const n1 = Math.sin((x * 0.17 + input.seed * 1.3)) * Math.cos((y * 0.19 - input.seed * 0.7));
      const n2 = (((Math.imul(x * 73856093 ^ y * 19349663 ^ input.seed * 83492791, 2654435761) >>> 24) & 0xff) / 255 - 0.5) * 0.16;
      const mod = shade * course * (1 + 0.08 * n1 + n2);
      const warmShift = (input.prompt.mode === 'roof' ? 1.12 : input.prompt.mode === 'floor' ? 0.92 : 1.0);
      d[p] = Math.max(0, Math.min(255, Math.round(baseR * warmShift * mod)));
      d[p + 1] = Math.max(0, Math.min(255, Math.round(baseG * mod)));
      d[p + 2] = Math.max(0, Math.min(255, Math.round(baseB * (2 - warmShift) * mod)));
      d[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const outBlob = 'convertToBlob' in canvas
    ? await canvas.convertToBlob({ type: 'image/png' })
    : await new Promise<Blob>((resolve, reject) => (canvas as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'));
  return { image: await decodeImageBlob(outBlob), seconds: (performance.now() - t0) / 1000, requestId: `local-procedural:${input.seed}` };
}

/** Probe which local inference backend is reachable, returning its resolved backend type and base URL (`null` when none). */
export async function probeLocalBackend(opts: ProviderOptions = {}, signal?: AbortSignal): Promise<{ backend: Exclude<LocalBackend, 'auto'>; url: string } | null> {
  if (opts.localBackend === 'procedural') return { backend: 'procedural', url: 'builtin://procedural' };
  const fn = opts.fetchImpl;
  const tryCheck = async (url: string, path: string): Promise<boolean> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1200);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const r = await localFetch(`${trimSlash(url)}${path}`, { signal: ctrl.signal }, fn);
      return r.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };

  if (opts.localBackend && opts.localBackend !== 'auto') {
    const url = trimSlash(opts.localUrl ?? DEFAULT_LOCAL_URLS[opts.localBackend]);
    const paths = opts.localBackend === 'comfyui' ? ['/system_stats', '/'] : ['/health', '/v1/models', '/'];
    for (const p of paths) if (await tryCheck(url, p)) return { backend: opts.localBackend, url };
    return null;
  }

  if (opts.localUrl) {
    const u = trimSlash(opts.localUrl);
    if (await tryCheck(u, '/system_stats')) return { backend: 'comfyui', url: u };
    if (await tryCheck(u, '/v1/models') || await tryCheck(u, '/health')) return { backend: 'diffusers', url: u };
    if (await tryCheck(u, '/paint_view')) return { backend: 'hunyuan3d', url: u };
    return null;
  }

  if (await tryCheck(DEFAULT_LOCAL_URLS.comfyui, '/system_stats')) return { backend: 'comfyui', url: DEFAULT_LOCAL_URLS.comfyui };
  if (await tryCheck(DEFAULT_LOCAL_URLS.diffusers, '/health') || await tryCheck(DEFAULT_LOCAL_URLS.diffusers, '/v1/models')) {
    return { backend: 'diffusers', url: DEFAULT_LOCAL_URLS.diffusers };
  }
  if (await tryCheck(DEFAULT_LOCAL_URLS.hunyuan3d, '/health')) return { backend: 'hunyuan3d', url: DEFAULT_LOCAL_URLS.hunyuan3d };
  return null;
}

/** Run one `EditModel` image edit against a local endpoint (ComfyUI, diffusers, Hunyuan3D-Paint, or procedural). */
export async function runLocalEdit(model: EditModel, input: EditInput, signal?: AbortSignal, opts: ProviderOptions = {}): Promise<EditResult> {
  const explicit = opts.localBackend && opts.localBackend !== 'auto'
    ? opts.localBackend
    : model.localBackend && model.localBackend !== 'auto'
      ? model.localBackend
      : undefined;

  if (explicit === 'procedural') return runProceduralEdit(model, input, signal);
  if (explicit === 'comfyui') return runComfyUiEdit(model, input, signal, opts);
  if (explicit === 'diffusers') return runDiffusersEdit(model, input, signal, opts);
  if (explicit === 'hunyuan3d') return runHunyuanEdit(model, input, signal, opts);

  const found = await probeLocalBackend(opts, signal);
  if (!found) {
    const tried = opts.localUrl
      ? opts.localUrl
      : `${DEFAULT_LOCAL_URLS.comfyui} (ComfyUI), ${DEFAULT_LOCAL_URLS.diffusers} (diffusers), ${DEFAULT_LOCAL_URLS.hunyuan3d} (Hunyuan3D-Paint)`;
    throw new Error(`No local model server responded at ${tried}. Start ComfyUI, diffusers or Hunyuan3D-Paint, pass --local-url, or use --local-backend procedural.`);
  }
  const resolved: ProviderOptions = { ...opts, localBackend: found.backend, localUrl: found.url };
  if (found.backend === 'procedural') return runProceduralEdit(model, input, signal);
  if (found.backend === 'comfyui') return runComfyUiEdit(model, input, signal, resolved);
  if (found.backend === 'hunyuan3d') return runHunyuanEdit(model, input, signal, resolved);
  return runDiffusersEdit(model, input, signal, resolved);
}
