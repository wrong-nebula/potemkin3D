import { describe, expect, it } from 'vitest';
import { benchmarkTexFusionVsConsolidate } from '../src/core/texfusion';
import { buildComfyStepWorkflow, runLocalLatentStep } from '../src/providers/local';

describe('TexFusion-style Synchronised Multi-View Latent Aggregation (SIMS)', () => {
  it('reduces raw multi-view latent discrepancy and pre-stitch seam step compared to independent parallel denoising', async () => {
    const bench = await benchmarkTexFusionVsConsolidate({ atlasSize: 48, steps: 10 });
    // SIMS locks global colour temperature and mortar phase across overlapping views during denoising
    expect(bench.texFusionSims.crossViewDiscrepancy).toBeLessThan(bench.independent.crossViewDiscrepancy * 0.5);
    expect(bench.texFusionSims.rawSeam.step).toBeLessThan(bench.independent.rawSeam.step * 0.65);
    expect(bench.texFusionSims.rawSeam.ratio).toBeLessThan(1.35);
    expect(bench.texFusionSims.denoiserCalls).toBe(30); // 3 views × 10 steps
  });

  it('builds a ComfyUI KSamplerAdvanced partial-step graph and executes local /texfusion/step tensor calls', async () => {
    const graph = buildComfyStepWorkflow(
      'weathered limestone blocks',
      { image: 'view0.png', mask: 'mask0.png', ref: 'ref0.png' },
      { seed: 77, totalSteps: 16, startStep: 4, endStep: 5 },
    );
    const ksampler = graph['15'] as { class_type: string; inputs: Record<string, unknown> };
    expect(ksampler.class_type).toBe('KSamplerAdvanced');
    expect(ksampler.inputs.start_at_step).toBe(4);
    expect(ksampler.inputs.end_at_step).toBe(5);
    expect(ksampler.inputs.return_with_leftover_noise).toBe('disable');

    const inputLatent = new Float32Array(4 * 4 * 4).fill(0.25);
    const x0 = await runLocalLatentStep(
      '/texfusion/step',
      { latent: inputLatent, channels: 4, height: 4, width: 4, sigma: 0.5, sigmaNext: 0.4, prompt: 'stone', seed: 1 },
      {
        localUrl: 'http://127.0.0.1:8000',
        fetchImpl: async () =>
          new Response(JSON.stringify({ x0: Array.from(inputLatent, (v) => v * 0.8) }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      },
    );
    expect(x0.length).toBe(inputLatent.length);
    expect(x0[0]).toBeCloseTo(0.2, 5);
  });
});
