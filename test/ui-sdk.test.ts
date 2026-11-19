import { chromium, type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

function srgbToLinear(c: number) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function relLuminance([r, g, b]: [number, number, number]) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]) {
  const l1 = relLuminance(a);
  const l2 = relLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

describe('Potemkin Studio ui-sdk interface & agent bridge', () => {
  let server: ViteDevServer;
  let baseUrl = '';
  let browser: Browser;

  beforeAll(async () => {
    server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
    await server.listen();
    const addr = server.httpServer?.address();
    const port = typeof addr === 'object' && addr ? addr.port : 5178;
    baseUrl = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({
      headless: true,
      args: ['--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
    });
  }, 30000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it('names every component in agent.snapshot(), supports query/act, gates confirm actions, and meets contrast', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${baseUrl}/?nosave=1`);
      await page.waitForFunction(
        () => Boolean((window as unknown as { trompe?: { session: { level: unknown } } }).trompe?.session.level),
        null,
        { timeout: 20000 },
      );

      const snapshot = await page.evaluate(() => {
        const ag = (window as unknown as { agent: { snapshot: () => { ref: string; component: string; label?: string; offPage?: boolean }[] } }).agent;
        return ag.snapshot().filter((e) => !e.offPage && e.component !== 'more');
      });

      expect(snapshot.length).toBeGreaterThan(20);
      for (const entry of snapshot) {
        expect(entry.label, `${entry.component} (${entry.ref}) is missing an accessible label`).toBeTruthy();
      }

      const labels = snapshot.map((e) => e.label);
      for (const expected of [
        'Workspace panels',
        'Scene',
        'Shading',
        'Viewport overlay',
        'Frustums',
        'Walkthrough',
        'Plan cameras',
        'Paint textures',
        'Export GLB',
        'Inspector sections',
        'Surface prompt',
        'Roof material',
        'Ground material',
        'Sky preset',
        'Sun azimuth',
        'Sun elevation',
      ]) {
        expect(labels, `${expected} missing from initial agent snapshot`).toContain(expected);
      }

      for (const [tabName, tabExpected] of [
        ['Plan', ['Camera budget', 'Inference provider', 'Atlas resolution', 'UV packing']],
        ['Critic', ['Evaluate quality', 'Stitch seams', 'Refine UVs']],
        ['Material', ['PBR pipeline', 'Build PBR', 'Bake occlusion', 'Relief depth']],
      ] as const) {
        const switchRes = await page.evaluate(
          async (t: string) => {
            const ag = (window as unknown as { agent: { act: (p: object) => Promise<{ ok: boolean; error?: { message: string } }>; snapshot: () => { ref: string; component: string; label?: string; offPage?: boolean }[] } }).agent;
            const r = await ag.act({ steps: [{ ref: 'Inspector sections', action: 'setValue', args: [t] }] });
            const snap = ag.snapshot().filter((e) => !e.offPage && e.component !== 'more');
            return { r, snap };
          },
          tabName,
        );
        expect(switchRes.r.ok, switchRes.r.error?.message).toBe(true);
        for (const entry of switchRes.snap) {
          expect(entry.label, `${entry.component} (${entry.ref}) on ${tabName} tab has no label`).toBeTruthy();
        }
        const tabLabels = switchRes.snap.map((e) => e.label);
        for (const exp of tabExpected) {
          expect(tabLabels, `${exp} missing from ${tabName} tab snapshot`).toContain(exp);
        }
      }

      const sceneQuery = await page.evaluate(() => {
        const ag = (window as unknown as { agent: { query: (q: object) => Promise<unknown> } }).agent;
        return ag.query({ within: 'Scene', text: 'Loft' });
      });
      expect(Array.isArray(sceneQuery)).toBe(true);
      expect((sceneQuery as { items: { label: string }[] }[])[0].items.map((i) => i.label)).toContain('Loft');

      const actRes = await page.evaluate(async () => {
        const ag = (window as unknown as { agent: { act: (p: object) => Promise<{ ok: boolean; error?: { message: string } }> } }).agent;
        return ag.act({
          steps: [
            { ref: 'Inspector sections', action: 'setValue', args: ['Plan'] },
            { ref: 'Atlas resolution', action: 'setValue', args: ['2K'] },
            { ref: 'View resolution', action: 'setValue', args: ['1K'] },
            { ref: 'Inference provider', action: 'setValue', args: ['Local · $0'] },
            { ref: 'Scene', action: 'setValue', args: ['Courtyard'] },
          ],
        });
      });
      expect(actRes.ok, actRes.error?.message).toBe(true);

      await page.waitForFunction(
        () => (window as unknown as { trompe: { session: { level: { name: string } | null } } }).trompe.session.level?.name === 'Courtyard',
        null,
        { timeout: 15000 },
      );

      const planRes = await page.evaluate(async () => {
        const ag = (window as unknown as { agent: { act: (p: object) => Promise<{ ok: boolean; error?: { message: string } }> } }).agent;
        return ag.act({
          steps: [
            { ref: 'Local backend', action: 'setValue', args: ['Procedural (CPU)'] },
            { ref: 'Camera budget', action: 'setValue', args: [6] },
            { ref: 'Plan cameras', action: 'press' },
          ],
        });
      });
      expect(planRes.ok, planRes.error?.message).toBe(true);

      const plannedCount = await page.evaluate(() => {
        return (window as unknown as { trompe: { session: { plan: { views: unknown[] } | null } } }).trompe.session.plan?.views.length ?? 0;
      });
      expect(plannedCount).toBeGreaterThan(0);

      const confirmDenied = await page.evaluate(async () => {
        (window as unknown as { __potemkinAgentConfirm?: () => boolean }).__potemkinAgentConfirm = () => false;
        const ag = (window as unknown as { agent: { act: (p: object) => Promise<{ ok: boolean }> } }).agent;
        return ag.act({ steps: [{ ref: 'Paint textures', action: 'press' }] });
      });
      expect(confirmDenied.ok).toBe(false);

      const confirmApproved = await page.evaluate(async () => {
        (window as unknown as { __potemkinAgentConfirm?: () => boolean }).__potemkinAgentConfirm = () => true;
        const ag = (window as unknown as { agent: { act: (p: object) => Promise<{ ok: boolean; error?: { message: string } }> } }).agent;
        return ag.act({
          steps: [
            { ref: 'Target geometry', action: 'setValue', args: ['Object (sphere + probes)'] },
            { ref: 'SAM blockout check', action: 'setChecked', args: [false] },
            { ref: 'MoGe normal check', action: 'setChecked', args: [false] },
            { ref: 'Camera budget', action: 'setValue', args: [6] },
            { ref: 'Paint textures', action: 'press' },
          ],
        });
      });
      expect(confirmApproved.ok, confirmApproved.error?.message).toBe(true);

      await page.waitForFunction(
        () => Boolean((window as unknown as { trompe: { session: { record: unknown } } }).trompe.session.record),
        null,
        { timeout: 20000 },
      );

      await page.locator('ui-checkbox').first().focus();
      await page.keyboard.press('Space');
      const adaptiveChecked = await page.evaluate(() => (document.querySelector('ui-checkbox') as unknown as { checked: boolean }).checked);
      expect(adaptiveChecked).toBe(true);

      const beforeSplit = await page.evaluate(() => (document.getElementById('workspace-split') as unknown as { api: { getLayout: () => number[] } }).api.getLayout()[0]);
      await page.locator('#workspace-split > [data-slot="resizable-handle"]').first().focus();
      await page.keyboard.press('ArrowRight');
      const afterSplit = await page.evaluate(() => (document.getElementById('workspace-split') as unknown as { api: { getLayout: () => number[] } }).api.getLayout()[0]);
      expect(afterSplit).toBeGreaterThan(beforeSplit);

      await page.locator('[data-slot="tabs-tab"]').first().focus();
      await page.keyboard.press('ArrowRight');
      const selectedTab = await page.evaluate(() => (document.querySelector('ui-tabs') as unknown as { value: string })?.value);
      expect(selectedTab).toBe('plan');

      const colors = await page.evaluate(() => {
        const parseRgb = (s: string): [number, number, number] => {
          const c = document.createElement('canvas');
          c.width = c.height = 1;
          const ctx = c.getContext('2d')!;
          ctx.fillStyle = s;
          ctx.fillRect(0, 0, 1, 1);
          const d = ctx.getImageData(0, 0, 1, 1).data;
          return [d[0], d[1], d[2]];
        };
        const btn = document.querySelector('[data-slot="button"]') as HTMLElement;
        const solid = document.querySelector('[data-slot="button"][data-variant="solid"]') as HTMLElement;
        const muted = document.querySelector('.pane-title') as HTMLElement;
        const header = document.querySelector('.pane-head') as HTMLElement;
        const bs = getComputedStyle(btn);
        const ss = getComputedStyle(solid);
        const ms = getComputedStyle(muted);
        const hs = getComputedStyle(header);
        return {
          btnFg: parseRgb(bs.color),
          btnBg: parseRgb(bs.backgroundColor),
          btnBorder: parseRgb(bs.borderTopColor),
          solidFg: parseRgb(ss.color),
          solidBg: parseRgb(ss.backgroundColor),
          mutedFg: parseRgb(ms.color),
          headerBg: parseRgb(hs.backgroundColor),
        };
      });

      expect(contrastRatio(colors.btnFg, colors.btnBg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.btnBorder, colors.btnBg)).toBeGreaterThanOrEqual(3.0);
      expect(contrastRatio(colors.solidFg, colors.solidBg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.mutedFg, colors.headerBg)).toBeGreaterThanOrEqual(4.5);
    } finally {
      await page.close();
    }
  }, 45000);

  it('registers snapshot, query, and act via WebMCP when document.modelContext is present', async () => {
    const page = await browser.newPage();
    try {
      await page.addInitScript(() => {
        const reg: Record<string, { execute: (input: object) => unknown }> = {};
        Object.assign(document, {
          modelContext: {
            registerTool: async (tool: { name: string; execute: (input: object) => unknown }) => {
              reg[tool.name] = tool;
            },
          },
        });
        Object.assign(window, { __webMcpTools: reg });
      });
      await page.goto(`${baseUrl}/?nosave=1`);
      await page.waitForFunction(
        () => Boolean((window as unknown as { trompe?: { session: { level: unknown } } }).trompe?.session.level),
        null,
        { timeout: 20000 },
      );
      const res = await page.evaluate(async () => {
        const tools = (window as unknown as { __webMcpTools: Record<string, { execute: (input: object) => Promise<unknown> }> }).__webMcpTools;
        const names = Object.keys(tools).sort();
        const snap = await tools.snapshot.execute({});
        return { names, isArray: Array.isArray(snap), count: Array.isArray(snap) ? snap.length : 0 };
      });
      expect(res.names).toEqual(['act', 'query', 'snapshot']);
      expect(res.isArray).toBe(true);
      expect(res.count).toBeGreaterThan(15);
    } finally {
      await page.close();
    }
  }, 30000);

  it('adapts side docks into slide-over drawers on mobile viewports without horizontal overflow', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.goto(`${baseUrl}/?nosave=1`);
      await page.waitForFunction(
        () => Boolean((window as unknown as { trompe?: { session: { level: unknown } } }).trompe?.session.level),
        null,
        { timeout: 20000 },
      );
      const res = await page.evaluate(async () => {
        const ag = (window as unknown as { agent: { act: (p: object) => Promise<{ ok: boolean }> } }).agent;
        const toggleRes = await ag.act({ steps: [{ ref: 'Right dock', action: 'setPressed', args: [true] }] });
        return {
          ok: toggleRes.ok,
          hasRight: document.body.classList.contains('show-right'),
          scrollW: document.documentElement.scrollWidth,
          innerW: window.innerWidth,
        };
      });
      expect(res.ok).toBe(true);
      expect(res.hasRight).toBe(true);
      expect(res.scrollW).toBeLessThanOrEqual(res.innerW);
    } finally {
      await page.close();
    }
  }, 30000);
});
