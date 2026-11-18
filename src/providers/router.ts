import { runEdit as runFalEdit, runGeometry as runFalGeometry, runMaterial as runFalMaterial, runRetexture as runFalRetexture, runVision as runFalVision, type EditResult } from './fal';
import { probeLocalBackend, runLocalEdit, runLocalRetexture, runLocalVision, type LocalBackend, type ProviderFallback, type ProviderKind, type ProviderOptions } from './local';
import type { EditInput, EditModel, MaterialMap } from './models';

export type { LocalBackend, ProviderFallback, ProviderKind, ProviderOptions };

/** Common provider interface implemented by cloud (`falProvider`) and local (`localProvider`) backends. */
export interface ModelProvider {
  readonly id: 'fal' | 'local';
  runEdit(model: EditModel, input: EditInput, signal?: AbortSignal, opts?: ProviderOptions): Promise<EditResult>;
  runRetexture?(glb: ArrayBuffer, prompt: string, signal?: AbortSignal, imageUrl?: string, opts?: ProviderOptions): Promise<{ glb: ArrayBuffer; seconds: number }>;
  runMaterial?<M extends MaterialMap>(imageUrl: string, maps: M[], seed: number, signal?: AbortSignal, opts?: ProviderOptions): Promise<{ maps: Record<M, ImageBitmap>; seconds: number }>;
  runVision?(prompt: string, imageUrls: string[], signal?: AbortSignal, opts?: ProviderOptions): Promise<{ text: string; cost: number }>;
  runGeometry?(imageUrl: string, fov: number, signal?: AbortSignal, opts?: ProviderOptions): Promise<{ normals: ImageBitmap; valid: ImageBitmap }>;
}

export const falProvider: ModelProvider = {
  id: 'fal',
  runEdit: (model, input, signal) => runFalEdit(model, input, signal),
  runRetexture: (glb, prompt, signal, imageUrl) => runFalRetexture(glb, prompt, signal, imageUrl),
  runMaterial: (imageUrl, maps, seed, signal) => runFalMaterial(imageUrl, maps, seed, signal),
  runVision: (prompt, imageUrls, signal) => runFalVision(prompt, imageUrls, signal),
  runGeometry: (imageUrl, fov, signal) => runFalGeometry(imageUrl, fov, signal),
};

export const localProvider: ModelProvider = {
  id: 'local',
  runEdit: (model, input, signal, opts) => runLocalEdit(model, input, signal, opts),
  runRetexture: (glb, prompt, signal, imageUrl, opts) => runLocalRetexture(glb, prompt, signal, imageUrl, opts),
  runVision: (prompt, imageUrls, signal, opts) => runLocalVision(prompt, imageUrls, signal, opts),
};

let defaults: ProviderOptions = {
  provider: 'fal',
  providerFallback: 'none',
  localBackend: 'auto',
};

export function configureProvider(opts: ProviderOptions = {}): ProviderOptions {
  defaults = { ...defaults, ...opts };
  return { ...defaults };
}

export function getProviderConfig(): ProviderOptions {
  return { ...defaults };
}

export function resetProviderConfig(): void {
  defaults = { provider: 'fal', providerFallback: 'none', localBackend: 'auto' };
}

export function mergeProviderOptions(job?: ProviderOptions): ProviderOptions {
  if (!job) return { ...defaults };
  const defined = Object.fromEntries(Object.entries(job).filter(([, v]) => v !== undefined)) as ProviderOptions;
  return { ...defaults, ...defined };
}

export function isLocalModel(model: Pick<EditModel, 'key' | 'price' | 'localBackend'>): boolean {
  return !!model.localBackend || model.price === 0 || model.key.startsWith('local-') || model.key.startsWith('hunyuan3d');
}

/** Whether a call under `opts` + optional `model` routes strictly to local with `$0` paint price. */
export function isLocalRoute(opts?: ProviderOptions, model?: Pick<EditModel, 'key' | 'price' | 'localBackend'>): boolean {
  const eff = mergeProviderOptions(opts);
  if (eff.provider === 'local') return true;
  if (model && isLocalModel(model) && eff.provider !== 'fal') return true;
  return false;
}

export interface RoutedEditResult extends EditResult {
  providerUsed: 'fal' | 'local';
}

async function resolvePrimary(opts: ProviderOptions, model?: EditModel, signal?: AbortSignal): Promise<'fal' | 'local'> {
  if (opts.provider === 'local') return 'local';
  if (opts.provider === 'fal') return model && isLocalModel(model) ? 'local' : 'fal';
  if (model && isLocalModel(model)) return 'local';
  // 'auto': prefer a reachable local server, otherwise cloud fal.
  const local = await probeLocalBackend(opts, signal);
  return local ? 'local' : 'fal';
}

/** Route an image-edit call across local and cloud providers with per-job overrides and optional fallback. */
export async function routeEdit(model: EditModel, input: EditInput, signal?: AbortSignal, jobOpts?: ProviderOptions): Promise<RoutedEditResult> {
  const eff = mergeProviderOptions(jobOpts);
  const primary = await resolvePrimary(eff, model, signal);
  const primaryImpl = primary === 'local' ? localProvider : falProvider;
  const fallbackKind = eff.providerFallback && eff.providerFallback !== 'none' && eff.providerFallback !== primary
    ? eff.providerFallback
    : eff.provider === 'auto' && primary === 'local'
      ? 'fal'
      : undefined;

  try {
    const res = await primaryImpl.runEdit(model, input, signal, eff);
    return { ...res, providerUsed: primary };
  } catch (err) {
    if (signal?.aborted || !fallbackKind) throw err;
    console.warn(`provider '${primary}' failed (${(err as Error)?.message ?? err}); falling back to '${fallbackKind}'`);
    const fbImpl = fallbackKind === 'local' ? localProvider : falProvider;
    const res = await fbImpl.runEdit(model, input, signal, eff);
    return { ...res, providerUsed: fallbackKind };
  }
}

/** Route a part/object mesh retexture call across Hunyuan3D-Paint (local) and Meshy (fal), reporting `providerUsed`. */
export async function routeRetexture(glb: ArrayBuffer, prompt: string, signal?: AbortSignal, imageUrl?: string, jobOpts?: ProviderOptions):
  Promise<{ glb: ArrayBuffer; seconds: number; providerUsed: 'fal' | 'local' }> {
  const eff = mergeProviderOptions(jobOpts);
  const primary = await resolvePrimary(eff, undefined, signal);
  const fallbackKind = eff.providerFallback && eff.providerFallback !== 'none' && eff.providerFallback !== primary
    ? eff.providerFallback
    : eff.provider === 'auto' && primary === 'local'
      ? 'fal'
      : undefined;

  try {
    if (primary === 'local') {
      const r = await localProvider.runRetexture!(glb, prompt, signal, imageUrl, eff);
      return { ...r, providerUsed: 'local' };
    }
    const r = await falProvider.runRetexture!(glb, prompt, signal, imageUrl, eff);
    return { ...r, providerUsed: 'fal' };
  } catch (err) {
    if (signal?.aborted || !fallbackKind) throw err;
    console.warn(`retexture on '${primary}' failed (${(err as Error)?.message ?? err}); falling back to '${fallbackKind}'`);
    const r = fallbackKind === 'local'
      ? await localProvider.runRetexture!(glb, prompt, signal, imageUrl, eff)
      : await falProvider.runRetexture!(glb, prompt, signal, imageUrl, eff);
    return { ...r, providerUsed: fallbackKind };
  }
}

/** Route a vision-language naming call across local VLM (`/v1/chat/completions`, $0) and fal OpenRouter. */
export async function routeVision(prompt: string, imageUrls: string[], signal?: AbortSignal, jobOpts?: ProviderOptions):
  Promise<{ text: string; cost: number; providerUsed: 'fal' | 'local' }> {
  const eff = mergeProviderOptions(jobOpts);
  const primary = await resolvePrimary(eff, undefined, signal);
  const fallbackKind = eff.providerFallback && eff.providerFallback !== 'none' && eff.providerFallback !== primary
    ? eff.providerFallback
    : eff.provider === 'auto' && primary === 'local'
      ? 'fal'
      : undefined;

  try {
    if (primary === 'local') {
      const r = await localProvider.runVision!(prompt, imageUrls, signal, eff);
      return { ...r, providerUsed: 'local' };
    }
    const r = await falProvider.runVision!(prompt, imageUrls, signal, eff);
    return { ...r, providerUsed: 'fal' };
  } catch (err) {
    if (signal?.aborted || !fallbackKind) throw err;
    const r = fallbackKind === 'local'
      ? await localProvider.runVision!(prompt, imageUrls, signal, eff)
      : await falProvider.runVision!(prompt, imageUrls, signal, eff);
    return { ...r, providerUsed: fallbackKind };
  }
}

export { probeLocalBackend };
