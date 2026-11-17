/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import { fal } from '@fal-ai/client';
import { GEOMETRY_MODEL, MATERIAL_MODEL, PART_MODEL, VISION_MODEL, type EditInput, type EditModel, type MaterialMap } from './models';

/**
 * fal access. Without a key the client talks to the dev server's proxy (/api/fal/proxy), which adds the key
 * from FAL_KEY server-side; with a key (bring your own) it calls fal directly from the browser.
 */
let direct = false;

export function configureFal(key?: string) {
  direct = !!key;
  if (key) fal.config({ credentials: key });
  else fal.config({ proxyUrl: '/api/fal/proxy' });
}

function mediaUrl(url: string) {
  return direct ? url : `/api/fal/media?url=${encodeURIComponent(url)}`;
}

export interface EditResult {
  image: ImageBitmap;
  seconds: number;
  requestId: string;
  /** What the model says it ran (Fibo: the expanded VGL), for debugging prompts. */
  expanded?: unknown;
}

export async function runEdit(model: EditModel, input: EditInput, signal?: AbortSignal): Promise<EditResult> {
  const t0 = performance.now();
  const r = await fal.subscribe(model.endpoint, { input: model.input(input), logs: false, abortSignal: signal });
  const data = r.data as { images?: { url: string }[]; image?: { url: string }; vgl?: unknown; usage?: unknown; actual_prompt?: string };
  const url = data.images?.[0]?.url ?? data.image?.url;
  if (!url) throw new Error(`${model.label} returned no image`);
  const res = await fetch(mediaUrl(url), { signal });
  if (!res.ok) throw new Error(`fetching ${model.label} output failed: ${res.status}`);
  const image = await createImageBitmap(await res.blob());
  return { image, seconds: (performance.now() - t0) / 1000, requestId: r.requestId,
    expanded: data.vgl ?? (data.usage ? { usage: data.usage, prompt: data.actual_prompt } : undefined) };
}

/** Predict material maps for one image (a data URL of at most 2048 px a side). */
export async function runMaterial<M extends MaterialMap>(imageUrl: string, maps: M[], seed: number, signal?: AbortSignal):
  Promise<{ maps: Record<M, ImageBitmap>; seconds: number }> {
  const t0 = performance.now();
  const r = await fal.subscribe(MATERIAL_MODEL.endpoint, { input: { image_url: imageUrl, maps, seed, output_format: 'png' },
    logs: false, abortSignal: signal });
  const images = (r.data as { images?: { url: string; map_type: string }[] }).images ?? [];
  const out = {} as Record<M, ImageBitmap>;
  for (const m of maps) {
    const url = images.find((i) => i.map_type === m)?.url;
    if (!url) throw new Error(`${MATERIAL_MODEL.label} returned no ${m} map`);
    const res = await fetch(mediaUrl(url), { signal });
    if (!res.ok) throw new Error(`fetching the ${m} map failed: ${res.status}`);
    // as stored: these are data, not colours, so no colour-space conversion on decode
    out[m] = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  }
  return { maps: out, seconds: (performance.now() - t0) / 1000 };
}

/** Ask the vision model one question about some images (data URLs). Returns its answer and what the call cost. */
export async function runVision(prompt: string, imageUrls: string[], signal?: AbortSignal): Promise<{ text: string; cost: number }> {
  // this model only runs with reasoning on; the answer is whatever it says last
  const r = await fal.subscribe(VISION_MODEL.endpoint, { input: { model: VISION_MODEL.model, prompt, image_urls: imageUrls,
    temperature: 0.2, max_tokens: 2000, reasoning: true }, logs: false, abortSignal: signal });
  const data = r.data as { output?: string; usage?: { cost?: number } };
  return { text: data.output ?? '', cost: data.usage?.cost ?? VISION_MODEL.price };
}

/**
 * Surface normals predicted from one image, as the model's colour-coded map, with its validity mask (0 where it
 * sees sky or nothing certain). `fov` is the camera's horizontal field of view in degrees.
 */
export async function runGeometry(imageUrl: string, fov: number, signal?: AbortSignal): Promise<{ normals: ImageBitmap; valid: ImageBitmap }> {
  const r = await fal.subscribe(GEOMETRY_MODEL.endpoint, { input: { image_url: imageUrl, model: GEOMETRY_MODEL.variant, fov_x: fov,
    export_glb: false, export_ply: false, apply_mask: true }, logs: false, abortSignal: signal });
  const data = r.data as { normal_map?: { url: string }; mask?: { url: string } };
  if (!data.normal_map?.url || !data.mask?.url) throw new Error(`${GEOMETRY_MODEL.label} returned no normal map`);
  const load = async (url: string) => {
    const res = await fetch(mediaUrl(url), { signal });
    if (!res.ok) throw new Error(`fetching the ${GEOMETRY_MODEL.label} output failed: ${res.status}`);
    return createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  };
  return { normals: await load(data.normal_map.url), valid: await load(data.mask.url) };
}

/**
 * One part textured as a mesh of its own, to a description and (when given) an image of the look to match: `glb` in (a triangle soup, see core/partpass.ts), a textured GLB out
 * with the same triangles and UVs of the model's making.
 */
export async function runRetexture(glb: ArrayBuffer, prompt: string, signal?: AbortSignal, imageUrl?: string): Promise<{ glb: ArrayBuffer; seconds: number }> {
  const t0 = performance.now();
  let binary = '';
  const bytes = new Uint8Array(glb);
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  const r = await fal.subscribe(PART_MODEL.endpoint, { input: { model_url: `data:model/gltf-binary;base64,${btoa(binary)}`, text_style_prompt: prompt.slice(0, 800),
    ...(imageUrl ? { image_style_url: imageUrl } : {}), texture_resolution: '4k', enable_original_uv: false, enable_pbr: false }, logs: false, abortSignal: signal });
  const data = r.data as { model_glb?: { url: string }; model_urls?: { glb?: { url: string } } };
  const url = data.model_glb?.url ?? data.model_urls?.glb?.url;
  if (!url) throw new Error(`${PART_MODEL.label} returned no mesh`);
  const res = await fetch(mediaUrl(url), { signal });
  if (!res.ok) throw new Error(`fetching the ${PART_MODEL.label} output failed: ${res.status}`);
  return { glb: await res.arrayBuffer(), seconds: (performance.now() - t0) / 1000 };
}
