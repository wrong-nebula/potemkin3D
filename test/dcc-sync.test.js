import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { dccSync } from '../automation/dcc.mjs';
import { formatCommandMarkdown, markdownToAnsi, markdownToHtmlFragment } from '../automation/words.mjs';

const MOCK_DCC_SERVER_CODE = `
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const mode = process.argv[2];
const logFile = process.argv[3];
const server = new McpServer({ name: mode, version: '1.0.0' });

if (mode === 'blender-mcp') {
  server.registerTool('execute_blender_code', {
    description: 'Execute Python code inside Blender',
    inputSchema: z.object({ code: z.string() }),
  }, async ({ code }) => {
    fs.writeFileSync(logFile, JSON.stringify({ tool: 'execute_blender_code', code }));
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, collection: 'Potemkin_courtyard-pbr', importedObjects: 4, wiredMaterials: 2 }) }] };
  });
} else {
  server.registerTool('import_static_mesh_pbr', {
    description: 'Import static mesh + ORM/POM maps into Unreal',
    inputSchema: z.object({
      sourceGlb: z.string(),
      relativeSourceGlb: z.string().optional(),
      destinationPath: z.string(),
      materialWorkflow: z.string(),
      maps: z.record(z.string(), z.string()),
      targetTexelDensityPxPerM: z.number(),
    }),
  }, async (args) => {
    fs.writeFileSync(logFile, JSON.stringify({ tool: 'import_static_mesh_pbr', args }));
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, asset: args.destinationPath }) }] };
  });
}

serveStdio(() => server);
`;

describe('Live DCC round-trip runner (potemkin dcc-sync -> blender-mcp & unreal-mcp)', () => {
  it('connects to live stdio blender-mcp and unreal-mcp servers, negotiates tools, and delivers PBR GLB + ORM/Normal/Height maps', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'potemkin-dcc-'));
    try {
      const serverScript = path.join(process.cwd(), '.potemkin', `mock-dcc-server-${process.pid}.mjs`);
      fs.mkdirSync(path.dirname(serverScript), { recursive: true });
      fs.writeFileSync(serverScript, MOCK_DCC_SERVER_CODE);

      const runDir = path.join(tmp, 'runs', 'courtyard-pbr');
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'level_textured.glb'), 'glTF-mock');
      fs.writeFileSync(path.join(runDir, 'orm.png'), 'orm');
      fs.writeFileSync(path.join(runDir, 'normal.png'), 'normal');
      fs.writeFileSync(path.join(runDir, 'pbr_source_height.png'), 'height');

      const blenderLog = path.join(tmp, 'blender-call.json');
      const unrealLog = path.join(tmp, 'unreal-call.json');

      try {
        const res = await dccSync(
          { target: 'both', runId: 'courtyard-pbr' },
          {
            root: tmp,
            transportFactory: (targetName) =>
              new StdioClientTransport({
                command: process.execPath,
                args: [serverScript, `${targetName}-mcp`, targetName === 'blender' ? blenderLog : unrealLog],
                cwd: process.cwd(),
                stderr: 'pipe',
              }),
          },
        );

        expect(res.targets).toHaveLength(2);
        expect(res.targets[0].status).toBe('synced');
        expect(res.targets[0].tool).toBe('execute_blender_code');
        expect(res.targets[0].response.wiredMaterials).toBe(2);

        expect(res.targets[1].status).toBe('synced');
        expect(res.targets[1].tool).toBe('import_static_mesh_pbr');
        expect(res.targets[1].response.asset).toBe('/Game/Potemkin/courtyard-pbr');

        // Verify Blender received real Principled BSDF ORM/Normal/Height wiring code
        const blenderReceived = JSON.parse(fs.readFileSync(blenderLog, 'utf8'));
        expect(blenderReceived.code).toContain('bpy.ops.import_scene.gltf');
        expect(blenderReceived.code).toContain('Potemkin_ORM');
        expect(blenderReceived.code).toContain('Potemkin_Normal');
        expect(blenderReceived.code).toContain('Potemkin_Height');
        expect(blenderReceived.code).toContain('Potemkin_courtyard-pbr');

        // Verify Unreal received exact ORM_POM maps
        const unrealReceived = JSON.parse(fs.readFileSync(unrealLog, 'utf8'));
        expect(unrealReceived.args.materialWorkflow).toBe('ORM_POM');
        expect(unrealReceived.args.maps.orm).toContain(path.join('runs', 'courtyard-pbr', 'orm.png'));
        expect(unrealReceived.args.maps.heightPom).toContain(path.join('runs', 'courtyard-pbr', 'pbr_source_height.png'));

        // Verify receipt file written to runs/<id>/dcc-sync.json
        expect(res.receiptPath).toBe('runs/courtyard-pbr/dcc-sync.json');
        expect(fs.existsSync(path.join(tmp, res.receiptPath))).toBe(true);

        // Verify @pierre/words Markdown + Mermaid + ANSI formatting
        const md = formatCommandMarkdown('dcc-sync', res);
        expect(markdownToHtmlFragment(md)).toContain('<svg');
        expect(markdownToAnsi(md, { width: 88 })).toContain('blender-mcp');
      } finally {
        fs.rmSync(serverScript, { force: true });
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('stages offline Blender & Unreal Python/MCP payloads in dry-run mode without a running DCC server', async () => {
    const dry = await dccSync({
      target: 'both',
      glb: 'samples/courtyard.glb',
      dryRun: true,
    });
    expect(dry.dryRun).toBe(true);
    expect(dry.targets[0].status).toBe('dry-run');
    expect(dry.targets[0].script).toContain('bpy.ops.import_scene.gltf');
    expect(dry.targets[1].script).toContain('unreal.AssetImportTask');
  });
});
