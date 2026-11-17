/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
/**
 * SAM 2.1 (tiny) in the page, for the blockout check (core/fidelity.ts). It runs on the visitor's GPU through
 * WebGPU (or on the CPU where there is none), so the check costs nothing per view. The library and the weights
 * (about 80 MB at half precision) are fetched on first use and cached by the browser.
 */
export const SEGMENT_MODEL = { key: 'sam2.1-tiny', label: 'SAM 2.1 tiny', repo: 'onnx-community/sam2.1-hiera-tiny-ONNX' };

export interface Segmenter {
  /** Where it runs: 'webgpu' or 'wasm'. */
  device: string;
  /**
   * Click each point (image pixels) on its own and return, per point, the candidate masks the model proposes
   * (part, object, whole), each `grid` x `grid`, row-major, top-down, 1 = inside.
   * @param image top-down RGBA, size x size
   */
  segment(image: Uint8ClampedArray, size: number, points: [number, number][]): Promise<{ grid: number; masks: Uint8Array[][] }>;
}

let loading: Promise<Segmenter> | undefined;

/** The segmenter, loaded once. Rejects where the model can't be fetched or run; the caller paints without the check. */
export function loadSegmenter(onProgress?: (message: string) => void): Promise<Segmenter> {
  return (loading ??= load(onProgress).catch((e) => { loading = undefined; throw e; }));
}

async function load(onProgress?: (message: string) => void): Promise<Segmenter> {
  const { Sam2Model, AutoProcessor, RawImage, Tensor, env } = await import('@huggingface/transformers');
  // The dev server keeps a copy of the weights on disk (vite.config.ts), so a fresh browser profile, which every
  // headless run is, doesn't fetch them from Hugging Face again.
  if (import.meta.env.DEV) env.remoteHost = `${location.origin}/api/hf/`;
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
  const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null;
  const device = adapter ? 'webgpu' : 'wasm';
  const dtype = adapter ? (adapter.features.has('shader-f16') ? 'fp16' : 'fp32') : 'q8';
  let last = '';
  const model = await (Sam2Model.from_pretrained as (id: string, o: object) => Promise<InstanceType<typeof Sam2Model>>)(SEGMENT_MODEL.repo, {
    device, dtype,
    progress_callback: (p: { status?: string; file?: string; progress?: number }) => {
      if (p.status !== 'progress' || !p.file?.includes('vision_encoder') || p.progress === undefined) return;
      const msg = `fetching ${SEGMENT_MODEL.label}: ${Math.floor(p.progress / 10) * 10}%`;
      if (msg !== last) onProgress?.((last = msg));
    },
  });
  const processor = await AutoProcessor.from_pretrained(SEGMENT_MODEL.repo);
  return {
    device,
    async segment(image, size, points) {
      if (!points.length) return { grid: 0, masks: [] };
      // the image goes through the encoder once; the decoder then takes one click at a time (this export's limit)
      const inputs = await processor(new RawImage(image, size, size, 4));
      const embeddings = await model.get_image_embeddings({ pixel_values: inputs.pixel_values });
      const [rh, rw] = inputs.reshaped_input_sizes[0];
      const masks: Uint8Array[][] = [];
      let w = 0;
      for (const [x, y] of points) {
        const out = await model({ ...embeddings, input_points: new Tensor('float32', [(x * rw) / size, (y * rh) / size], [1, 1, 1, 2]) });
        // logits, [1, 1, candidates, grid, grid]; a half-precision model may hand them back as raw 16-bit floats
        const { data, dims } = out.pred_masks as { data: ArrayLike<number>; dims: number[] };
        const per = dims[2], h = dims[3];
        w = dims[4];
        const inside = data instanceof Uint16Array ? (v: number) => v !== 0 && v < 0x8000 : (v: number) => v > 0;
        masks.push(Array.from({ length: per }, (_, c) => {
          const m = new Uint8Array(h * w), at = c * h * w;
          for (let i = 0; i < m.length; i++) m[i] = inside(data[at + i]) ? 1 : 0;
          return m;
        }));
      }
      return { grid: w, masks };
    },
  };
}
