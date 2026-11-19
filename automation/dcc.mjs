// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ROOT, AutomationError, inside, readJSON, atomicJSON } from './files.mjs';
import { object, id, jobId, relativePath, localUrl } from './schema.mjs';
import { agentStatus } from './agent.mjs';

/**
 * Live DCC round-trip runner (`potemkin dcc-sync` / `potemkin_dcc_sync`):
 * Resolves the exported PBR GLB + detached linear ORM / Normal / Height / Roughness / Metalness maps from a completed
 * agent session, saved run (`runs/<id>`), or explicit project GLB path, and pushes them directly into a running
 * `blender-mcp` or `unreal-mcp` server over stdio or localhost HTTP MCP transport.
 *
 * Negotiates both high-level asset tools (`import_gltf_asset`, `import_static_mesh_pbr`) and standard DCC scripting
 * tools (`execute_blender_code` in `blender-mcp`, `execute_python` / `run_python_script` in `unreal-mcp`).
 */

export const dccSyncInput = object({
  target: z.enum(['blender', 'unreal', 'both']).default('blender'),
  sessionId: jobId.optional(),
  runId: id.optional(),
  glb: relativePath.optional(),
  normal: relativePath.optional(),
  orm: relativePath.optional(),
  height: relativePath.optional(),
  roughness: relativePath.optional(),
  metalness: relativePath.optional(),
  collection: id.optional(),
  destinationPath: z.string().regex(/^\/Game\/[a-zA-Z0-9/_.-]{1,120}$/).optional(),
  transport: z.enum(['auto', 'stdio', 'http']).default('auto'),
  url: localUrl.optional(),
  preset: z.enum(['uvx-blender-mcp', 'uvx-unreal-mcp']).optional(),
  dryRun: z.boolean().default(false),
  timeoutMs: z.number().int().min(1000).max(120000).default(20000),
});

function pickExisting(root, candidates) {
  for (const rel of candidates) {
    if (!rel) continue;
    const abs = inside(root, rel, { exists: false });
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return { relative: rel, absolute: abs };
  }
  return null;
}

export function resolveDccBundle(input, { root = ROOT } = {}) {
  let session = null;
  let runId = input.runId ?? null;
  if (input.sessionId) {
    session = agentStatus({ sessionId: input.sessionId }, { root });
    runId ??= session.runId;
  }
  if (!runId && !input.glb) {
    throw new AutomationError('INVALID_INPUT', 'Specify sessionId, runId, or glb to sync into Blender/Unreal');
  }

  const runFolder = runId ? `runs/${runId}` : null;
  const glbFile = pickExisting(root, [
    input.glb,
    session?.externalHooks?.blenderMcp?.arguments?.filepath,
    ...(session?.exportArtifacts ?? []).filter((p) => String(p).endsWith('.glb')),
    runFolder ? `${runFolder}/level_textured.glb` : null,
    runFolder ? `${runFolder}/level.glb` : null,
    runFolder ? `${runFolder}/${runId}.glb` : null,
  ]);
  if (!glbFile) {
    throw new AutomationError(
      'NOT_FOUND',
      runFolder
        ? `No exported .glb found in ${runFolder} (expected level_textured.glb or --glb <path>)`
        : `Exported .glb not found: ${input.glb}`,
    );
  }

  const baseDir = runFolder ?? path.posix.dirname(glbFile.relative);
  const maps = {};
  const mapSpecs = [
    ['normal', [input.normal, `${baseDir}/normal.png`]],
    ['orm', [input.orm, `${baseDir}/orm.png`]],
    ['height', [input.height, `${baseDir}/pbr_source_height.png`, `${baseDir}/height.png`]],
    ['roughness', [input.roughness, `${baseDir}/pbr_source_roughness.png`, `${baseDir}/roughness.png`]],
    ['metalness', [input.metalness, `${baseDir}/pbr_source_metalness.png`, `${baseDir}/metalness.png`]],
    ['ao', [`${baseDir}/ao.png`]],
  ];
  for (const [key, list] of mapSpecs) {
    const found = pickExisting(root, list);
    if (found) maps[key] = found;
  }

  const slug = (runId ?? path.basename(glbFile.relative, '.glb')).replace(/[^a-zA-Z0-9_-]/g, '_');
  const collection = input.collection ?? `Potemkin_${slug}`;
  const destinationPath = input.destinationPath ?? `/Game/Potemkin/${slug}`;
  const animationReady = session?.objectBrief?.animationReady ?? false;
  const targetTexelDensityPxPerM =
    session?.objectBrief?.targetTexelDensityPxPerM ?? session?.thresholds?.minHighRankPxPerM ?? 96;

  return {
    runId,
    sessionId: input.sessionId ?? null,
    glb: glbFile,
    maps,
    collection,
    destinationPath,
    animationReady,
    targetTexelDensityPxPerM,
  };
}

export function buildBlenderImportPython(bundle) {
  const payload = JSON.stringify({
    glb: bundle.glb.absolute,
    collection: bundle.collection,
    maps: Object.fromEntries(Object.entries(bundle.maps).map(([k, v]) => [k, v.absolute])),
    animationReady: bundle.animationReady,
  });
  return [
    'import bpy, json, os',
    `cfg = json.loads(${JSON.stringify(payload)})`,
    'before = set(bpy.data.objects)',
    'bpy.ops.import_scene.gltf(filepath=cfg["glb"])',
    'imported = [o for o in bpy.data.objects if o not in before]',
    'col = bpy.data.collections.get(cfg["collection"]) or bpy.data.collections.new(cfg["collection"])',
    'if col.name not in bpy.context.scene.collection.children:',
    '    bpy.context.scene.collection.children.link(col)',
    'for obj in imported:',
    '    if obj.name not in col.objects:',
    '        col.objects.link(obj)',
    'wired = 0',
    'maps = cfg.get("maps", {})',
    'def load_nc(p):',
    '    img = bpy.data.images.load(p, check_existing=True)',
    '    img.colorspace_settings.name = "Non-Color"',
    '    return img',
    'seen_mats = set()',
    'for obj in imported:',
    '    for slot in getattr(obj, "material_slots", []):',
    '        mat = slot.material',
    '        if not mat or not mat.use_nodes or mat.name in seen_mats:',
    '            continue',
    '        seen_mats.add(mat.name)',
    '        nt = mat.node_tree',
    '        bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)',
    '        if not bsdf:',
    '            continue',
    '        if "orm" in maps and os.path.exists(maps["orm"]):',
    '            tex = nt.nodes.new("ShaderNodeTexImage"); tex.image = load_nc(maps["orm"]); tex.label = "Potemkin_ORM"',
    '            sep = nt.nodes.new("ShaderNodeSeparateColor")',
    '            nt.links.new(tex.outputs["Color"], sep.inputs["Color"])',
    '            nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])',
    '            nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])',
    '        if "normal" in maps and os.path.exists(maps["normal"]):',
    '            ntex = nt.nodes.new("ShaderNodeTexImage"); ntex.image = load_nc(maps["normal"]); ntex.label = "Potemkin_Normal"',
    '            nmap = nt.nodes.new("ShaderNodeNormalMap")',
    '            nt.links.new(ntex.outputs["Color"], nmap.inputs["Color"])',
    '            nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])',
    '        if "height" in maps and os.path.exists(maps["height"]):',
    '            htex = nt.nodes.new("ShaderNodeTexImage"); htex.image = load_nc(maps["height"]); htex.label = "Potemkin_Height"',
    '            bump = nt.nodes.new("ShaderNodeBump"); bump.inputs["Distance"].default_value = 0.02',
    '            nt.links.new(htex.outputs["Color"], bump.inputs["Height"])',
    '            if "Normal" in bsdf.inputs and bsdf.inputs["Normal"].is_linked:',
    '                nt.links.new(bsdf.inputs["Normal"].links[0].from_socket, bump.inputs["Normal"])',
    '            nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])',
    '        wired += 1',
    'print(json.dumps({"ok": True, "collection": col.name, "importedObjects": len(imported), "wiredMaterials": wired}))',
  ].join('\n');
}

export function buildUnrealImportPython(bundle) {
  const payload = JSON.stringify({
    glb: bundle.glb.absolute,
    destinationPath: bundle.destinationPath,
    maps: Object.fromEntries(Object.entries(bundle.maps).map(([k, v]) => [k, v.absolute])),
    targetTexelDensityPxPerM: bundle.targetTexelDensityPxPerM,
  });
  return [
    'import unreal, json, os',
    `cfg = json.loads(${JSON.stringify(payload)})`,
    'tasks = []',
    'mesh_task = unreal.AssetImportTask()',
    'mesh_task.filename = cfg["glb"]',
    'mesh_task.destination_path = cfg["destinationPath"]',
    'mesh_task.automated = True',
    'mesh_task.replace_existing = True',
    'mesh_task.save = True',
    'tasks.append(mesh_task)',
    'for key, tex_path in cfg.get("maps", {}).items():',
    '    if not os.path.exists(tex_path): continue',
    '    t = unreal.AssetImportTask()',
    '    t.filename = tex_path',
    '    t.destination_path = cfg["destinationPath"] + "/Textures"',
    '    t.destination_name = f"T_{key.upper()}"',
    '    t.automated = True; t.replace_existing = True; t.save = True',
    '    tasks.append(t)',
    'unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks(tasks)',
    'for key in ("orm", "height", "roughness", "metalness", "ao"):',
    '    asset_path = f"{cfg[\'destinationPath\']}/Textures/T_{key.upper()}"',
    '    if unreal.EditorAssetLibrary.does_asset_exist(asset_path):',
    '        tex = unreal.EditorAssetLibrary.load_asset(asset_path)',
    '        if hasattr(tex, "srgb"): tex.set_editor_property("srgb", False)',
    'print(json.dumps({"ok": True, "destinationPath": cfg["destinationPath"], "tasksRun": len(tasks)}))',
  ].join('\n');
}

function parseEnvArgs(raw) {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed;
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

function readTrustedDccConfig(targetName, root) {
  for (const rel of ['.potemkin/dcc-servers.json', '.mcp.json']) {
    const file = inside(root, rel, { exists: false });
    if (!fs.existsSync(file)) continue;
    try {
      const cfg = readJSON(file);
      const servers = cfg.mcpServers ?? cfg.servers ?? cfg;
      const entry = servers[`${targetName}-mcp`] ?? servers[targetName];
      if (entry && typeof entry === 'object') return entry;
    } catch {}
  }
  return null;
}

function resolveTargetTransport(targetName, input, { root, env }) {
  const serverKey = `${targetName}-mcp`;
  const upper = targetName.toUpperCase();
  const singleTarget = input.target !== 'both';
  const explicitUrl = singleTarget ? input.url : undefined;
  const envUrl = env[`${upper}_MCP_URL`];
  const cfg = readTrustedDccConfig(targetName, root);

  if (input.transport === 'http' || explicitUrl || (input.transport === 'auto' && (envUrl || cfg?.url))) {
    const endpoint = explicitUrl ?? envUrl ?? cfg?.url;
    if (!endpoint) {
      throw new AutomationError('PRECONDITION_FAILED', `No localhost HTTP URL configured for ${serverKey} (pass --url or set ${upper}_MCP_URL)`);
    }
    localUrl.parse(endpoint);
    return {
      mode: 'http',
      endpoint,
      create: () => new StreamableHTTPClientTransport(new URL(endpoint)),
    };
  }

  const envCmd = env[`${upper}_MCP_COMMAND`];
  if (envCmd) {
    const args = parseEnvArgs(env[`${upper}_MCP_ARGS`]);
    return {
      mode: 'stdio',
      endpoint: `${envCmd} ${args.join(' ')}`.trim(),
      create: () => new StdioClientTransport({ command: envCmd, args, cwd: root, stderr: 'pipe' }),
    };
  }

  if (cfg?.command && typeof cfg.command === 'string') {
    const args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
    return {
      mode: 'stdio',
      endpoint: `${cfg.command} ${args.join(' ')}`.trim(),
      create: () => new StdioClientTransport({ command: cfg.command, args, cwd: root, stderr: 'pipe' }),
    };
  }

  const presetCmd = input.preset === 'uvx-unreal-mcp' || targetName === 'unreal' ? 'unreal-mcp' : 'blender-mcp';
  return {
    mode: 'stdio',
    endpoint: `uvx ${presetCmd}`,
    create: () => new StdioClientTransport({ command: 'uvx', args: [presetCmd], cwd: root, stderr: 'pipe' }),
  };
}

function buildTargetPayloads(targetName, bundle) {
  const absMaps = Object.fromEntries(Object.entries(bundle.maps).map(([k, v]) => [k, v.absolute]));
  const relMaps = Object.fromEntries(Object.entries(bundle.maps).map(([k, v]) => [k, v.relative]));
  if (targetName === 'blender') {
    return {
      server: 'blender-mcp',
      preferredTool: 'import_gltf_asset',
      preferredArgs: {
        filepath: bundle.glb.absolute,
        relativeFilepath: bundle.glb.relative,
        collection: bundle.collection,
        pbrMaps: absMaps,
        relativeMaps: relMaps,
        animationReady: bundle.animationReady,
      },
      scriptTools: ['execute_blender_code', 'execute_python'],
      script: buildBlenderImportPython(bundle),
    };
  }
  return {
    server: 'unreal-mcp',
    preferredTool: 'import_static_mesh_pbr',
    preferredArgs: {
      sourceGlb: bundle.glb.absolute,
      relativeSourceGlb: bundle.glb.relative,
      destinationPath: bundle.destinationPath,
      materialWorkflow: 'ORM_POM',
      maps: {
        ...(absMaps.normal ? { normal: absMaps.normal } : {}),
        ...(absMaps.orm ? { orm: absMaps.orm } : {}),
        ...(absMaps.height ? { heightPom: absMaps.height } : {}),
        ...(absMaps.roughness ? { roughness: absMaps.roughness } : {}),
        ...(absMaps.metalness ? { metalness: absMaps.metalness } : {}),
      },
      targetTexelDensityPxPerM: bundle.targetTexelDensityPxPerM,
    },
    scriptTools: ['execute_python', 'run_python_script'],
    script: buildUnrealImportPython(bundle),
  };
}

async function dispatchToTarget(targetName, bundle, input, opts) {
  const spec = buildTargetPayloads(targetName, bundle);
  if (input.dryRun) {
    return {
      target: targetName,
      server: spec.server,
      status: 'dry-run',
      tool: spec.preferredTool,
      arguments: spec.preferredArgs,
      fallbackScriptTool: spec.scriptTools[0],
      scriptPreviewLines: spec.script.split('\n').length,
      script: spec.script,
    };
  }

  const transportDesc = opts.transportFactory
    ? { mode: 'custom', endpoint: spec.server, create: () => opts.transportFactory(targetName, spec) }
    : resolveTargetTransport(targetName, input, opts);

  const transport = await transportDesc.create();
  const client = new Client({ name: 'potemkin-dcc-sync', version: '0.2.0' });
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`Timed out connecting to ${spec.server} (${input.timeoutMs}ms)`)), input.timeoutMs)),
    ]);
    const listed = await client.listTools();
    const names = new Set((listed.tools ?? []).map((t) => t.name));

    let chosenTool = null;
    let callArgs = null;
    if (names.has(spec.preferredTool)) {
      chosenTool = spec.preferredTool;
      callArgs = spec.preferredArgs;
    } else {
      const scriptTool = spec.scriptTools.find((n) => names.has(n));
      if (scriptTool) {
        chosenTool = scriptTool;
        const toolDef = (listed.tools ?? []).find((t) => t.name === scriptTool);
        const props = toolDef?.inputSchema?.properties ?? {};
        const paramKey = 'code' in props ? 'code' : 'script' in props ? 'script' : 'code';
        callArgs = { [paramKey]: spec.script };
      }
    }

    if (!chosenTool) {
      throw new AutomationError(
        'UNSUPPORTED_DCC_SERVER',
        `${spec.server} connected (${[...names].join(', ') || 'no tools'}), but exposes neither ${spec.preferredTool} nor ${spec.scriptTools.join('/')}`,
      );
    }

    const res = await client.callTool({ name: chosenTool, arguments: callArgs });
    const textOut = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    let parsedResponse = res.structuredContent ?? null;
    if (!parsedResponse && textOut) {
      try {
        parsedResponse = JSON.parse(textOut);
      } catch {
        parsedResponse = textOut;
      }
    }
    if (res.isError) {
      throw new AutomationError('DCC_TOOL_ERROR', `${spec.server}.${chosenTool} reported error: ${textOut || JSON.stringify(parsedResponse)}`);
    }
    return {
      target: targetName,
      server: spec.server,
      status: 'synced',
      transport: transportDesc.mode,
      endpoint: transportDesc.endpoint,
      tool: chosenTool,
      availableTools: [...names],
      response: parsedResponse,
    };
  } catch (e) {
    if (e instanceof AutomationError) throw e;
    throw new AutomationError(
      'DCC_UNREACHABLE',
      `Could not sync to ${spec.server} (${transportDesc.endpoint}): ${e?.message ?? e}. Pass --dry-run true to stage scripts/payloads offline or configure ${targetName.toUpperCase()}_MCP_URL / ${targetName.toUpperCase()}_MCP_COMMAND.`,
    );
  } finally {
    try {
      await client.close();
    } catch {}
  }
}

export async function dccSync(rawInput, { root = ROOT, env = process.env, transportFactory } = {}) {
  const input = dccSyncInput.parse(rawInput);
  const bundle = resolveDccBundle(input, { root });
  const targets = input.target === 'both' ? ['blender', 'unreal'] : [input.target];

  const results = [];
  for (const t of targets) {
    results.push(await dispatchToTarget(t, bundle, input, { root, env, transportFactory }));
  }

  const receipt = {
    at: new Date().toISOString(),
    dryRun: input.dryRun,
    runId: bundle.runId,
    sessionId: bundle.sessionId,
    glb: bundle.glb.relative,
    maps: Object.fromEntries(Object.entries(bundle.maps).map(([k, v]) => [k, v.relative])),
    collection: bundle.collection,
    destinationPath: bundle.destinationPath,
    targets: results,
  };

  if (bundle.runId) {
    const runDir = inside(root, `runs/${bundle.runId}`, { exists: false });
    if (fs.existsSync(runDir)) {
      const receiptRel = `runs/${bundle.runId}/dcc-sync.json`;
      atomicJSON(path.join(root, receiptRel), receipt);
      receipt.receiptPath = receiptRel;
    }
  }

  if (bundle.sessionId) {
    const epLine = JSON.stringify({
      at: receipt.at,
      event: 'dcc-sync',
      dryRun: input.dryRun,
      targets: results.map((r) => ({ target: r.target, status: r.status, tool: r.tool })),
    }) + '\n';
    const sEp = path.join(inside(root, `.potemkin/sessions/${bundle.sessionId}`, { exists: false }), 'episodes.ndjson');
    if (fs.existsSync(path.dirname(sEp))) fs.appendFileSync(sEp, epLine, { mode: 0o600 });
    if (bundle.runId) {
      const rEp = path.join(inside(root, `runs/${bundle.runId}`, { exists: false }), 'episodes.ndjson');
      if (fs.existsSync(path.dirname(rEp))) fs.appendFileSync(rEp, epLine, { mode: 0o600 });
    }
  }

  return receipt;
}
