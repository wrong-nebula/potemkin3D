// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ROOT, AutomationError, inside, readJSON, atomicJSON, inspectGlb } from './files.mjs';
import { object, id, jobId, relativePath, localUrl } from './schema.mjs';
import { startJob, getJob, terminal } from './jobs.mjs';
import { formatAgentSessionMarkdown, renderStandaloneReportHtml, writeRunReportFiles } from './words.mjs';

function writeSessionReportFiles(session, root = ROOT) {
  try {
    const dir = path.join(inside(root, '.potemkin/sessions', { exists: false }), session.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const md = formatAgentSessionMarkdown(session);
    const html = renderStandaloneReportHtml({
      title: `Session ${session.id}`,
      subtitle: `Run ${session.runId} · ${session.status}`,
      markdown: md,
      incomplete: session.status !== 'completed',
    });
    fs.writeFileSync(path.join(dir, 'report.md'), md, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'report.html'), html, { mode: 0o600 });
  } catch {}
}

/**
 * Budgeted Planner → Actor → Critic loop over CLI/MCP (TODO item 10):
 * - Planner (`agentPlan`): inspects the GLB and cross-session memory, writes a look file, `coverageBudget` and (in
 *   object mode) an `objectBrief`, establishes a stated dollar `budgetUsd` + Critic quality thresholds, and stages
 *   Round 1's spend proposal awaiting human approval (`agentApprove`).
 * - Actor (`agentAct`): verifies human spend approval + remaining budget & view ceilings, executes the staged workflow
 *   (`plan → paint → project → consolidate / repair / topUp / uvRefine / pbr / export`), appends episodic traces to
 *   `runs/<runId>/episodes.ndjson`, and runs the multi-metric Critic (`src/core/critic.ts`).
 * - Critic Gate: when metrics fall below threshold (`verdict === 'needs-repair'`), stages a targeted repair proposal
 *   (`consolidate`, `topUp`, `repair` 3D boxes, `parts`, `uvRefine`) gated before extra spend is authorized; once
 *   passed, updates cross-session preset & repair memory (`.potemkin/agent-memory.json`) and emits Blender/Unreal MCP
 *   chaining hooks.
 */

const MODEL_PRICES_1K = {
  'flux3-klein': 0.009,
  h3: 0.023,
  'h3-fast': 0.046,
  fibo2: 0.04,
  'ideogram-4.5': 0.06,
  'nano-banana-2.1': 0.05,
  flux3: 0.048,
  'local-flux': 0,
  'local-comfy-mv': 0,
  'hunyuan3d-paint': 0,
};

function estimateCallPrice(modelKey, viewSize, provider, providerFallback, unitCallCostUsd) {
  if (typeof unitCallCostUsd === 'number') return unitCallCostUsd;
  if (provider === 'local' && providerFallback !== 'fal') return 0;
  if (modelKey.startsWith('local-') || modelKey.startsWith('hunyuan3d')) return 0;
  const base = MODEL_PRICES_1K[modelKey] ?? 0.015;
  if (modelKey === 'flux3-klein') return viewSize <= 1024 ? 0.009 : viewSize <= 2048 ? 0.014 : 0.036;
  if (modelKey === 'h3') return viewSize <= 1024 ? 0.023 : viewSize <= 2048 ? 0.034 : 0.082;
  return viewSize > 1024 ? base * 1.4 : base;
}

const sessionsRoot = (root = ROOT) => inside(root, '.potemkin/sessions', { exists: false });
const sessionDir = (sid, root = ROOT) => { jobId.parse(sid); return inside(root, `.potemkin/sessions/${sid}`, { exists: false }); };
const memoryFile = (root = ROOT) => inside(root, '.potemkin/agent-memory.json', { exists: false });

export function readAgentMemory(root = ROOT) {
  const file = memoryFile(root);
  if (!fs.existsSync(file)) return { version: 1, updatedAt: null, presetsByPart: {}, successfulConfigs: [], repairPatterns: {} };
  try {
    return readJSON(file);
  } catch {
    return { version: 1, updatedAt: null, presetsByPart: {}, successfulConfigs: [], repairPatterns: {} };
  }
}

export function listAgentSessions(root = ROOT) {
  const dir = sessionsRoot(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => jobId.safeParse(n).success && fs.existsSync(path.join(dir, n, 'session.json')))
    .map((n) => {
      const s = readJSON(path.join(dir, n, 'session.json'));
      return { id: s.id, runId: s.runId, status: s.status, mode: s.mode, updatedAt: s.updatedAt, spentUsd: s.spentUsd };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 50);
}

function recordAgentMemory(session, finalCritique, root = ROOT) {
  const mem = readAgentMemory(root);
  mem.updatedAt = new Date().toISOString();
  for (const [part, preset] of Object.entries(session.materialPresets ?? {})) {
    mem.presetsByPart[part.toLowerCase()] = preset;
  }
  for (const ep of session.episodes) {
    if (ep.kind === 'repair' && typeof ep.scoreDelta === 'number') {
      for (const op of ep.ops ?? []) {
        const cur = mem.repairPatterns[op] ?? { uses: 0, meanScoreDelta: 0 };
        cur.meanScoreDelta = +((cur.meanScoreDelta * cur.uses + ep.scoreDelta) / (cur.uses + 1)).toFixed(2);
        cur.uses++;
        mem.repairPatterns[op] = cur;
      }
    }
  }
  mem.successfulConfigs = [
    {
      at: mem.updatedAt,
      mode: session.mode,
      level: session.path,
      runId: session.runId,
      layout: session.look.layout,
      wording: session.look.wording ?? 'photo',
      score: finalCritique.score,
      seenPainted: finalCritique.metrics.seenPainted,
      multiViewConsistency: finalCritique.metrics.multiView?.consistency ?? 1,
      seamRatio: finalCritique.metrics.seam.ratio,
      spentUsd: session.spentUsd,
    },
    ...(mem.successfulConfigs ?? []),
  ].slice(0, 25);
  atomicJSON(memoryFile(root), mem);
  return mem;
}

function appendEpisode(session, entry, root = ROOT) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
  const sDir = sessionDir(session.id, root);
  fs.mkdirSync(sDir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(sDir, 'episodes.ndjson'), line, { mode: 0o600 });
  const rDir = inside(root, `runs/${session.runId}`, { exists: false });
  if (fs.existsSync(rDir)) {
    fs.appendFileSync(path.join(rDir, 'episodes.ndjson'), line, { mode: 0o600 });
  }
}

export function buildExternalMcpHooks(session) {
  const runFolder = `runs/${session.runId}`;
  const glb = `${runFolder}/level_textured.glb`;
  return {
    blenderMcp: {
      server: 'blender-mcp',
      tool: 'import_gltf_asset',
      arguments: {
        filepath: glb,
        collection: `Potemkin_${session.runId}`,
        pbrMaps: {
          normal: `${runFolder}/normal.png`,
          orm: `${runFolder}/orm.png`,
          height: `${runFolder}/pbr_source_height.png`,
          metalness: `${runFolder}/pbr_source_metalness.png`,
          roughness: `${runFolder}/pbr_source_roughness.png`,
        },
        animationReady: session.objectBrief?.animationReady ?? false,
      },
    },
    unrealMcp: {
      server: 'unreal-mcp',
      tool: 'import_static_mesh_pbr',
      arguments: {
        sourceGlb: glb,
        destinationPath: `/Game/Potemkin/${session.runId}`,
        materialWorkflow: 'ORM_POM',
        maps: {
          normal: `${runFolder}/normal.png`,
          orm: `${runFolder}/orm.png`,
          heightPom: `${runFolder}/pbr_source_height.png`,
        },
        targetTexelDensityPxPerM: session.objectBrief?.targetTexelDensityPxPerM ?? session.thresholds.minHighRankPxPerM,
      },
    },
  };
}

function suggestPresetsFromMaterials(materials, mem) {
  const out = {};
  for (const m of materials) {
    const raw = m.name ?? '';
    if (!raw) continue;
    const low = raw.toLowerCase();
    if (mem.presetsByPart[low]) { out[raw] = mem.presetsByPart[low]; continue; }
    if (/\b(bare|brushed|forged|stainless|chrome|brass|bronze|steel|iron|blade|barrel)\b/i.test(raw) && !/\bpainted\b/i.test(raw)) out[raw] = 'metal';
    else if (/\b(metal|hull|chassis|locker|beam|pipe|rail|turret|rover)\b/i.test(raw)) out[raw] = 'painted-metal';
    else if (/\b(stone|sandstone|limestone|masonry|brick|plaster|wall|pylon|arch)\b/i.test(raw)) out[raw] = 'limestone';
    else if (/\b(wood|timber|plank|beam|door)\b/i.test(raw)) out[raw] = 'timber';
    else if (/\b(cloth|fabric|canvas|tarp|leather)\b/i.test(raw)) out[raw] = 'fabric';
    else if (/\b(skin|face|bark|foliage|organic)\b/i.test(raw)) out[raw] = 'organic';
  }
  return out;
}

async function waitForJob(id, { root = ROOT, timeoutMs = 600000 } = {}) {
  const start = Date.now();
  for (;;) {
    const state = getJob(id, { root, limit: 50 });
    if (terminal.has(state.status)) return state;
    if (Date.now() - start > timeoutMs) throw new AutomationError('WAIT_TIMEOUT', `Timed out waiting for job ${id}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export const agentPlanInput = object({
  path: relativePath.default('samples/courtyard.glb'),
  look: relativePath.optional(),
  runId: id.optional(),
  mode: z.enum(['auto', 'level', 'object']).default('auto'),
  style: z.string().min(1).max(4000).optional(),
  floorStyle: z.string().min(1).max(2000).optional(),
  roofStyle: z.string().min(1).max(2000).optional(),
  wording: z.enum(['photo', 'aaa', 'scout', 'retro', 'remaster', 'survey', 'cel', 'transfer', 'production']).optional(),
  atlasSize: z.number().int().min(256).max(8192).default(2048),
  viewSize: z.number().int().min(256).max(4096).default(1024),
  initialViews: z.number().int().min(1).max(200).default(10),
  maxTotalViews: z.number().int().min(1).max(400).optional(),
  maxRepairRounds: z.number().int().min(0).max(6).default(2),
  budgetUsd: z.number().min(0).max(1000).default(1.0),
  unitCallCostUsd: z.number().min(0).max(50).optional(),
  requireApproval: z.boolean().default(true),
  targetSeenPainted: z.number().min(0.1).max(1).default(0.88),
  targetHighRankPxPerM: z.number().positive().default(42),
  maxSeamRatio: z.number().positive().default(1.35),
  minMultiViewConsistency: z.number().min(0.1).max(1).default(0.86),
  firstModel: z.string().min(1).max(120).default('flux3-klein'),
  fillModel: z.string().min(1).max(120).default('flux3-klein'),
  provider: z.enum(['fal', 'local', 'auto']).default('fal'),
  providerFallback: z.enum(['none', 'fal', 'local']).default('none'),
  localBackend: z.enum(['auto', 'comfyui', 'diffusers', 'hunyuan3d', 'procedural']).default('auto'),
  localUrl: localUrl.optional(),
  check: z.boolean().default(true),
  checkPlanes: z.boolean().default(false),
  pbr: z.boolean().default(true),
  // Object-mode brief fields
  targetTexelDensityPxPerM: z.number().positive().optional(),
  styleReferences: z.array(z.string().max(500)).optional(),
  animationReady: z.boolean().default(false),
  focusParts: z.array(z.string().min(1).max(120)).optional(),
});

export function agentPlan(input, { root = ROOT } = {}) {
  const glbFile = inside(root, input.path);
  const glbInfo = inspectGlb(glbFile);
  const lookFromDisk = input.look ? readJSON(inside(root, input.look)) : {};
  const mem = readAgentMemory(root);

  const baseName = path.basename(input.path, '.glb').replace(/[^a-zA-Z0-9._-]+/g, '-');
  const runId = input.runId ?? `${baseName}-agent-${Date.now().toString(36)}`;
  if (fs.existsSync(inside(root, `runs/${runId}`, { exists: false }))) {
    throw new AutomationError('RUN_EXISTS', `Run '${runId}' already exists; choose a fresh runId`);
  }

  const resolvedMode = input.mode === 'auto'
    ? (/prop|weapon|char|rover|vehicle|helmet|sword|crate/i.test(baseName) ? 'object' : 'level')
    : input.mode;

  const sessionId = randomUUID();
  const sDir = sessionDir(sessionId, root);
  fs.mkdirSync(sDir, { recursive: true, mode: 0o700 });

  const defaultStyle = resolvedMode === 'object'
    ? 'weathered industrial prop: painted steel casing with worn bare metal edges, matte polymer grips and fine surface wear'
    : 'a Mediterranean stone courtyard: weathered limestone and warm ochre plaster walls, timber doors and worn cobblestone paving';

  const lookFileObj = {
    level: input.path,
    lighting: lookFromDisk.lighting ?? 'overcast',
    atlas: input.atlasSize,
    viewSize: input.viewSize,
    layout: 'near',
    weights: true,
    paths: true,
    mode: resolvedMode,
    style: input.style ?? lookFromDisk.style ?? defaultStyle,
    floorStyle: input.floorStyle ?? lookFromDisk.floorStyle ?? 'worn cobblestone paving in warm beige and grey stone',
    roofStyle: input.roofStyle ?? lookFromDisk.roofStyle ?? 'weathered terracotta roof tiles',
    ...(input.wording ?? lookFromDisk.wording ? { wording: input.wording ?? lookFromDisk.wording } : {}),
    ...(lookFromDisk.setting ? { setting: lookFromDisk.setting } : {}),
    ...(input.styleReferences ?? lookFromDisk.styleImages ? { styleImages: input.styleReferences ?? lookFromDisk.styleImages } : {}),
  };

  const lookRelPath = `.potemkin/sessions/${sessionId}/look.json`;
  atomicJSON(path.join(sDir, 'look.json'), lookFileObj);

  const suggestedPresets = suggestPresetsFromMaterials(glbInfo.materials, mem);
  const thresholds = {
    minSeenPainted: input.targetSeenPainted,
    minHighRankPxPerM: resolvedMode === 'object' ? (input.targetTexelDensityPxPerM ?? 140) : input.targetHighRankPxPerM,
    maxSeamRatio: input.maxSeamRatio,
    minMultiViewConsistency: input.minMultiViewConsistency,
    maxIgnoredShare: 0.08,
    maxBakedShading: 0.28,
  };

  const floors = resolvedMode === 'object' ? 0 : Math.min(2, Math.floor(input.initialViews / 4));
  const totalInitialViews = input.initialViews + floors;
  const maxTotalViews = input.maxTotalViews ?? (totalInitialViews + Math.max(1, input.maxRepairRounds) * 8);
  if (totalInitialViews > maxTotalViews) {
    throw new AutomationError('BUDGET_EXCEEDED', `Initial views (${totalInitialViews}) exceed maxTotalViews (${maxTotalViews})`);
  }

  const coverageBudget = {
    targetSeenPainted: thresholds.minSeenPainted,
    targetHighRankPxPerM: thresholds.minHighRankPxPerM,
    initialViews: totalInitialViews,
    maxTotalViews,
    viewsUsed: 0,
    budgetUsd: input.budgetUsd,
  };

  const objectBrief = resolvedMode === 'object' ? {
    targetTexelDensityPxPerM: input.targetTexelDensityPxPerM ?? 240,
    styleReferences: lookFileObj.styleImages ?? [],
    animationReady: input.animationReady,
    focusParts: input.focusParts ?? [],
    suggestedPresets,
    unwrapRequired: glbInfo.primitivesWithUVs < glbInfo.primitives,
    budgetUsd: input.budgetUsd,
  } : null;

  // Estimate initial spend ceiling before authorizing a single view
  const perView = Math.max(
    estimateCallPrice(input.firstModel, input.viewSize, input.provider, input.providerFallback, input.unitCallCostUsd),
    estimateCallPrice(input.fillModel, input.viewSize, input.provider, input.providerFallback, input.unitCallCostUsd),
  );
  const strictLocal = input.provider === 'local' && input.providerFallback !== 'fal';
  const retriesFactor = input.check && !strictLocal ? 1.25 : 1.0;
  const estimatedCostUsd = +(totalInitialViews * perView * retriesFactor).toFixed(4);
  if (estimatedCostUsd > input.budgetUsd + 1e-6) {
    throw new AutomationError('BUDGET_EXCEEDED', `Initial plan estimated at $${estimatedCostUsd.toFixed(3)} exceeds stated budget $${input.budgetUsd.toFixed(3)}`);
  }

  const proposalId = `prop_${randomUUID().slice(0, 8)}`;
  const initialSteps = [
    {
      op: 'provider',
      options: {
        provider: input.provider,
        providerFallback: input.providerFallback,
        localBackend: input.localBackend,
        ...(input.localUrl ? { localUrl: input.localUrl } : {}),
      },
    },
    {
      op: 'load',
      path: input.path,
      options: {
        lighting: lookFileObj.lighting,
        atlasSize: input.atlasSize,
        viewSize: input.viewSize,
        layout: 'near',
        weights: true,
        paths: true,
        mode: resolvedMode,
        unwrap: 'auto',
      },
    },
    ...(Object.keys(suggestedPresets).length ? [{ op: 'materialPresets', assignments: suggestedPresets }] : []),
    {
      op: 'plan',
      options: {
        maxViews: input.initialViews,
        floors,
        roofs: 0,
        aerial: 0,
        holes: 0,
        adaptive: true,
        mode: resolvedMode,
        ...(input.focusParts?.length ? { focusParts: input.focusParts } : {}),
      },
    },
    {
      op: 'quote',
      options: {
        firstModel: input.firstModel,
        fillModel: input.fillModel,
        provider: input.provider,
        providerFallback: input.providerFallback,
      },
    },
    {
      op: 'run',
      saveAs: runId,
      options: {
        style: lookFileObj.style,
        floorStyle: lookFileObj.floorStyle,
        roofStyle: lookFileObj.roofStyle,
        ...(lookFileObj.wording ? { wording: lookFileObj.wording } : {}),
        ...(lookFileObj.setting ? { setting: lookFileObj.setting } : {}),
        ...(lookFileObj.styleImages ? { styleImages: lookFileObj.styleImages } : {}),
        firstModel: input.firstModel,
        fillModel: input.fillModel,
        check: input.check && !strictLocal,
        checkPlanes: input.checkPlanes && !strictLocal,
        nameParts: !strictLocal,
        provider: input.provider,
        providerFallback: input.providerFallback,
        localBackend: input.localBackend,
        ...(input.localUrl ? { localUrl: input.localUrl } : {}),
        plan: {
          maxViews: input.initialViews,
          floors,
          roofs: 0,
          aerial: 0,
          holes: 0,
          adaptive: true,
          mode: resolvedMode,
          ...(input.focusParts?.length ? { focusParts: input.focusParts } : {}),
        },
      },
    },
    { op: 'critique', options: { ...thresholds, screenshots: 1 } },
  ];

  const pendingProposal = {
    id: proposalId,
    round: 1,
    kind: 'initial',
    summary: `Paint ${totalInitialViews} initial adaptive views on '${input.path}' (${resolvedMode} mode) and run Critic`,
    estimatedViews: totalInitialViews,
    estimatedCostUsd,
    allowPaid: !strictLocal,
    approved: !input.requireApproval,
    approvedAt: !input.requireApproval ? new Date().toISOString() : null,
    steps: initialSteps,
    ops: ['plan', 'run', 'critique'],
  };

  const session = {
    version: 1,
    id: sessionId,
    status: pendingProposal.approved ? 'ready' : 'awaiting-approval',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    path: input.path,
    runId,
    mode: resolvedMode,
    lookPath: lookRelPath,
    look: lookFileObj,
    coverageBudget,
    objectBrief,
    materialPresets: suggestedPresets,
    provider: {
      provider: input.provider,
      providerFallback: input.providerFallback,
      localBackend: input.localBackend,
      ...(input.localUrl ? { localUrl: input.localUrl } : {}),
    },
    models: {
      firstModel: input.firstModel,
      fillModel: input.fillModel,
      check: input.check,
      checkPlanes: input.checkPlanes,
      pbr: input.pbr,
      ...(input.unitCallCostUsd !== undefined ? { unitCallCostUsd: input.unitCallCostUsd } : {}),
    },
    budget: {
      statedUsd: input.budgetUsd,
      spentUsd: 0,
      remainingUsd: input.budgetUsd,
      requireApproval: input.requireApproval,
    },
    spentUsd: 0,
    maxRepairRounds: input.maxRepairRounds,
    repairRoundsUsed: 0,
    thresholds,
    memoryApplied: {
      matchedPresets: Object.keys(suggestedPresets).length,
      knownRepairPatterns: mem.repairPatterns,
    },
    pendingProposal,
    episodes: [],
    latestCritique: null,
    externalHooks: null,
  };

  atomicJSON(path.join(sDir, 'session.json'), session);
  appendEpisode(session, {
    event: 'planned',
    proposalId,
    round: 1,
    estimatedViews: totalInitialViews,
    estimatedCostUsd,
    budgetUsd: input.budgetUsd,
    coverageBudget,
    mode: resolvedMode,
    objectBrief,
  }, root);
  writeSessionReportFiles(session, root);

  return {
    sessionId,
    status: session.status,
    runId,
    mode: resolvedMode,
    lookPath: lookRelPath,
    look: lookFileObj,
    coverageBudget,
    ...(objectBrief ? { objectBrief } : {}),
    budget: session.budget,
    thresholds,
    memoryApplied: session.memoryApplied,
    pendingProposal: {
      id: pendingProposal.id,
      round: pendingProposal.round,
      kind: pendingProposal.kind,
      summary: pendingProposal.summary,
      estimatedViews: pendingProposal.estimatedViews,
      estimatedCostUsd: pendingProposal.estimatedCostUsd,
      approved: pendingProposal.approved,
    },
    next: pendingProposal.approved
      ? `Call agent-act with sessionId=${sessionId}`
      : `Human spend gate: review pendingProposal ($${estimatedCostUsd.toFixed(3)} of $${input.budgetUsd.toFixed(2)} budget) and call agent-approve with sessionId=${sessionId}, proposalId=${proposalId}`,
  };
}

function loadSession(sessionId, root = ROOT) {
  const file = path.join(sessionDir(sessionId, root), 'session.json');
  if (!fs.existsSync(file)) throw new AutomationError('NOT_FOUND', `Unknown agent session: ${sessionId}`);
  return { session: readJSON(file), file };
}

export const agentApproveInput = object({
  sessionId: jobId,
  proposalId: z.string().min(1).max(80),
  approvedBy: z.string().min(1).max(120).default('human'),
  maxSpendUsd: z.number().min(0).max(1000).optional(),
});

export function agentApprove(input, { root = ROOT } = {}) {
  const { session, file } = loadSession(input.sessionId, root);
  const prop = session.pendingProposal;
  if (!prop) throw new AutomationError('INVALID_WORKFLOW', 'Session has no pending spend proposal to approve');
  if (prop.id !== input.proposalId) {
    throw new AutomationError('INVALID_INPUT', `Proposal ID mismatch: pending is ${prop.id}, received ${input.proposalId}`);
  }
  const cap = input.maxSpendUsd !== undefined ? Math.min(session.budget.remainingUsd, input.maxSpendUsd) : session.budget.remainingUsd;
  if (prop.estimatedCostUsd > cap + 1e-6) {
    throw new AutomationError('BUDGET_EXCEEDED', `Proposal estimated at $${prop.estimatedCostUsd.toFixed(3)} exceeds authorized cap $${cap.toFixed(3)}`);
  }
  prop.approved = true;
  prop.approvedAt = new Date().toISOString();
  prop.approvedBy = input.approvedBy;
  session.status = 'ready';
  session.updatedAt = prop.approvedAt;
  atomicJSON(file, session);
  appendEpisode(session, {
    event: 'approved',
    proposalId: prop.id,
    round: prop.round,
    approvedBy: input.approvedBy,
    estimatedViews: prop.estimatedViews,
    estimatedCostUsd: prop.estimatedCostUsd,
  }, root);
  return {
    sessionId: session.id,
    status: session.status,
    approvedProposal: {
      id: prop.id,
      round: prop.round,
      kind: prop.kind,
      estimatedViews: prop.estimatedViews,
      estimatedCostUsd: prop.estimatedCostUsd,
      approvedBy: input.approvedBy,
    },
    remainingBudgetUsd: session.budget.remainingUsd,
    next: `Call agent-act with sessionId=${session.id}`,
  };
}

function buildFinalizeSteps(session) {
  const strictLocal = session.provider.provider === 'local' && session.provider.providerFallback !== 'fal';
  return [
    { op: 'provider', options: session.provider },
    {
      op: 'load',
      path: session.path,
      options: {
        lighting: session.look.lighting,
        atlasSize: session.look.atlas,
        viewSize: session.look.viewSize,
        layout: 'near',
        weights: true,
        paths: true,
        mode: session.mode,
        unwrap: 'auto',
      },
    },
    { op: 'loadRun', id: session.runId },
    ...(!session.uvRefined ? [{ op: 'uvRefine', options: { size: Math.min(1024, session.look.atlas), delight: 0.85, sharpen: 0.45 } }] : []),
    ...(session.models.pbr ? [{ op: 'pbr', options: { size: Math.min(1024, session.look.atlas), mode: strictLocal ? 'intrinsic' : 'auto' } }] : []),
    { op: 'save', id: session.runId },
    { op: 'export', output: `${session.runId}.glb` },
    ...(session.models.pbr ? [{ op: 'exportPbr', output: `${session.runId}-pbr`, options: { format: 'both' } }] : []),
  ];
}

function buildRepairProposal(session, critique) {
  const strictLocal = session.provider.provider === 'local' && session.provider.providerFallback !== 'fal';
  const perCall = estimateCallPrice(
    session.models.fillModel,
    session.look.viewSize,
    session.provider.provider,
    session.provider.providerFallback,
    session.models.unitCallCostUsd,
  );
  const remainingViews = Math.max(0, (session.coverageBudget?.maxTotalViews ?? 400) - (session.coverageBudget?.viewsUsed ?? 0));
  const affordableCalls = perCall > 0 ? Math.floor((session.budget.remainingUsd + 1e-6) / perCall) : Infinity;
  let callHeadroom = Math.min(remainingViews, affordableCalls);
  const steps = [
    { op: 'provider', options: session.provider },
    {
      op: 'load',
      path: session.path,
      options: {
        lighting: session.look.lighting,
        atlasSize: session.look.atlas,
        viewSize: session.look.viewSize,
        layout: 'near',
        weights: true,
        paths: true,
        mode: session.mode,
        unwrap: 'auto',
      },
    },
    { op: 'loadRun', id: session.runId },
  ];

  let estCalls = 0;
  const ops = [];
  for (const act of critique.actions) {
    if (act.op === 'consolidate') {
      steps.push({ op: 'consolidate', options: act.params });
      ops.push('consolidate');
    } else if (act.op === 'topUp') {
      if (callHeadroom <= 0) continue;
      const totalWanted = Math.min(act.estimatedCalls, callHeadroom);
      const holes = Math.min(act.params.plan?.holes ?? 0, Math.floor(totalWanted / 3));
      const mainViews = Math.max(1, totalWanted - holes);
      const used = mainViews + holes;
      steps.push({
        op: 'topUp',
        saveAs: session.runId,
        options: {
          firstModel: session.models.firstModel,
          fillModel: session.models.fillModel,
          check: session.models.check && !strictLocal,
          checkPlanes: session.models.checkPlanes && !strictLocal,
          nameParts: false,
          ...session.provider,
          plan: { ...act.params.plan, maxViews: mainViews, holes, floors: 0, roofs: 0, aerial: 0 },
        },
      });
      estCalls += used;
      callHeadroom -= used;
      ops.push('topUp');
    } else if (act.op === 'repair') {
      if (callHeadroom <= 0) continue;
      const regions = act.params.regions.slice(0, callHeadroom);
      steps.push({ op: 'repair', saveAs: session.runId, regions });
      estCalls += regions.length;
      callHeadroom -= regions.length;
      ops.push('repair');
    } else if (act.op === 'parts') {
      if (callHeadroom <= 0) continue;
      const maxParts = Math.min(act.estimatedCalls, callHeadroom);
      const only = Array.isArray(act.params.only) ? act.params.only.slice(0, maxParts) : undefined;
      steps.push({ op: 'parts', saveAs: session.runId, options: { ...act.params, ...(only ? { only } : {}), max: maxParts } });
      estCalls += maxParts;
      callHeadroom -= maxParts;
      ops.push('parts');
    } else if (act.op === 'uvRefine') {
      steps.push({ op: 'uvRefine', options: act.params });
      ops.push('uvRefine');
    }
  }

  if (!ops.includes('consolidate')) {
    steps.push({ op: 'consolidate', options: { size: Math.min(1024, session.look.atlas), flow: true, lambda: 0.02 } });
    ops.push('consolidate');
  }
  if (!ops.includes('uvRefine')) {
    steps.push({ op: 'uvRefine', options: { size: Math.min(1024, session.look.atlas), delight: 0.85, sharpen: 0.45 } });
    ops.push('uvRefine');
  }
  steps.push({ op: 'save', id: session.runId });
  steps.push({ op: 'critique', options: { ...session.thresholds, screenshots: 1 } });

  const estimatedCostUsd = +(estCalls * perCall).toFixed(4);
  const nextRound = session.repairRoundsUsed + 2;
  return {
    id: `prop_${randomUUID().slice(0, 8)}`,
    round: nextRound,
    kind: 'repair',
    summary: `Critic-gated repair round ${session.repairRoundsUsed + 1}: ${critique.actions.map((a) => `${a.op} (${a.reason})`).join('; ')}`,
    estimatedViews: estCalls,
    estimatedCostUsd,
    allowPaid: !strictLocal && estCalls > 0,
    approved: !session.budget.requireApproval,
    approvedAt: !session.budget.requireApproval ? new Date().toISOString() : null,
    steps,
    ops,
  };
}

export const agentActInput = object({
  sessionId: jobId,
  finalizeOnPass: z.boolean().default(true),
  timeoutSeconds: z.number().int().min(10).max(3600).default(900),
});

export async function agentAct(input, { root = ROOT } = {}) {
  const { session, file } = loadSession(input.sessionId, root);
  const prop = session.pendingProposal;
  if (!prop) throw new AutomationError('INVALID_WORKFLOW', `Session is already '${session.status}' with no pending step`);
  if (!prop.approved) {
    throw new AutomationError('APPROVAL_REQUIRED', `Spend proposal '${prop.id}' ($${prop.estimatedCostUsd.toFixed(3)}) requires human approval via agent-approve first`);
  }
  if (session.spentUsd + prop.estimatedCostUsd > session.budget.statedUsd + 1e-6) {
    throw new AutomationError('BUDGET_EXCEEDED', `Executing '${prop.id}' ($${prop.estimatedCostUsd.toFixed(3)}) would exceed stated budget $${session.budget.statedUsd.toFixed(3)}`);
  }

  const prevScore = session.latestCritique?.score ?? null;
  const prevViewsUsed = session.coverageBudget?.viewsUsed ?? 0;
  const started = startJob('workflow', {
    steps: prop.steps,
    allowPaid: prop.allowPaid,
    timeoutSeconds: input.timeoutSeconds,
  }, { root });
  const job = await waitForJob(started.id, { root, timeoutMs: input.timeoutSeconds * 1000 });
  if (job.status !== 'succeeded') {
    session.status = 'failed';
    session.updatedAt = new Date().toISOString();
    atomicJSON(file, session);
    throw new AutomationError(job.error?.code ?? 'WORKFLOW_FAILED', job.error?.message ?? `Actor job ${started.id} ended in ${job.status}`);
  }

  const rDir = inside(root, `runs/${session.runId}`, { exists: false });
  if (fs.existsSync(rDir)) {
    atomicJSON(path.join(rDir, 'look.plan.json'), {
      look: session.look,
      coverageBudget: session.coverageBudget,
      objectBrief: session.objectBrief,
      budget: session.budget,
    });
    const sEp = path.join(sessionDir(session.id, root), 'episodes.ndjson');
    const rEp = path.join(rDir, 'episodes.ndjson');
    if (fs.existsSync(sEp) && !fs.existsSync(rEp)) fs.copyFileSync(sEp, rEp);
  }

  const runJsonPath = path.join(rDir, 'run.json');
  const runMeta = fs.existsSync(runJsonPath) ? readJSON(runJsonPath) : { cost: session.spentUsd, views: [] };
  const totalViewsNow = runMeta.views?.length ?? prevViewsUsed;
  const viewsAdded = Math.max(0, totalViewsNow - prevViewsUsed);
  if (session.coverageBudget) session.coverageBudget.viewsUsed = totalViewsNow;

  const unitCost = session.models?.unitCallCostUsd;
  const accountedRoundCost = typeof unitCost === 'number'
    ? +(viewsAdded * unitCost).toFixed(4)
    : +Math.max(0, (runMeta.cost ?? session.spentUsd) - session.spentUsd).toFixed(4);
  const newCumulativeCost = +(session.spentUsd + accountedRoundCost).toFixed(4);
  session.spentUsd = newCumulativeCost;
  session.budget.spentUsd = newCumulativeCost;
  session.budget.remainingUsd = +Math.max(0, session.budget.statedUsd - newCumulativeCost).toFixed(4);

  const critiqueStep = [...(job.results ?? [])].reverse().find((r) => r.op === 'critique');
  let critique = critiqueStep?.result ?? null;
  if (critique?.summary && critique?.path) critique = readJSON(inside(root, critique.path));
  if (critique && fs.existsSync(rDir)) {
    atomicJSON(path.join(rDir, `critique_round_${prop.round}.json`), critique);
  }
  if (prop.ops?.includes('uvRefine')) session.uvRefined = true;
  if (prop.kind === 'repair') session.repairRoundsUsed++;

  const episode = {
    event: 'acted',
    round: prop.round,
    kind: prop.kind,
    proposalId: prop.id,
    jobId: started.id,
    ops: prop.ops,
    viewsAdded,
    totalViews: totalViewsNow,
    roundSpendUsd: accountedRoundCost,
    cumulativeSpendUsd: session.spentUsd,
    scoreBefore: prevScore,
    scoreAfter: critique?.score ?? null,
    scoreDelta: prevScore !== null && critique?.score !== undefined ? +(critique.score - prevScore).toFixed(1) : null,
    verdict: critique?.verdict ?? 'completed',
    seenPainted: critique?.metrics?.seenPainted ?? null,
    multiViewConsistency: critique?.metrics?.multiView?.consistency ?? null,
    seamRatio: critique?.metrics?.seam?.ratio ?? null,
    artifacts: job.artifacts ?? [],
  };
  session.episodes.push(episode);
  session.latestCritique = critique;
  session.pendingProposal = null;
  appendEpisode(session, episode, root);

  let exportArtifacts = [];
  const canRepairMore = critique &&
    critique.verdict === 'needs-repair' &&
    session.repairRoundsUsed < session.maxRepairRounds &&
    (session.coverageBudget?.viewsUsed ?? 0) < (session.coverageBudget?.maxTotalViews ?? Infinity);

  if (canRepairMore) {
    const nextProp = buildRepairProposal(session, critique);
    if (session.spentUsd + nextProp.estimatedCostUsd <= session.budget.statedUsd + 1e-6) {
      session.pendingProposal = nextProp;
      session.status = nextProp.approved ? 'ready' : 'awaiting-approval';
      appendEpisode(session, {
        event: 'critic-gated-repair',
        round: nextProp.round,
        proposalId: nextProp.id,
        estimatedViews: nextProp.estimatedViews,
        estimatedCostUsd: nextProp.estimatedCostUsd,
        actions: critique.actions,
      }, root);
    } else {
      session.status = 'budget-exhausted';
      appendEpisode(session, {
        event: 'budget-exhausted',
        neededUsd: nextProp.estimatedCostUsd,
        remainingUsd: session.budget.remainingUsd,
      }, root);
    }
  } else {
    const strictLocal = session.provider.provider === 'local' && session.provider.providerFallback !== 'fal';
    if (input.finalizeOnPass && (strictLocal || !session.models.pbr)) {
      const finSteps = buildFinalizeSteps(session);
      const finStart = startJob('workflow', {
        steps: finSteps,
        allowPaid: false,
        timeoutSeconds: input.timeoutSeconds,
      }, { root });
      const finJob = await waitForJob(finStart.id, { root, timeoutMs: input.timeoutSeconds * 1000 });
      if (finJob.status === 'succeeded') {
        exportArtifacts = finJob.artifacts ?? [];
        appendEpisode(session, { event: 'finalized', jobId: finStart.id, artifacts: exportArtifacts }, root);
      }
    }
    session.status = 'completed';
    session.externalHooks = buildExternalMcpHooks(session);
    if (critique) recordAgentMemory(session, critique, root);
  }

  session.updatedAt = new Date().toISOString();
  atomicJSON(file, session);
  writeSessionReportFiles(session, root);
  const runReport = writeRunReportFiles(session.runId, { root, critique });

  return {
    sessionId: session.id,
    status: session.status,
    runId: session.runId,
    roundExecuted: prop.round,
    roundKind: prop.kind,
    coverageBudget: session.coverageBudget,
    budget: session.budget,
    critique,
    ...(runReport ? { reportPath: runReport.htmlPath, reportMarkdownPath: runReport.markdownPath } : {}),
    ...(session.pendingProposal ? {
      pendingProposal: {
        id: session.pendingProposal.id,
        round: session.pendingProposal.round,
        kind: session.pendingProposal.kind,
        summary: session.pendingProposal.summary,
        estimatedViews: session.pendingProposal.estimatedViews,
        estimatedCostUsd: session.pendingProposal.estimatedCostUsd,
        approved: session.pendingProposal.approved,
      },
    } : {}),
    ...(exportArtifacts.length ? { exportArtifacts } : {}),
    ...(session.externalHooks ? { externalHooks: session.externalHooks } : {}),
  };
}

export const agentCritiqueInput = object({
  runId: id,
  minSeenPainted: z.number().min(0.1).max(1).optional(),
  minHighRankPxPerM: z.number().positive().optional(),
  maxSeamRatio: z.number().positive().optional(),
  minMultiViewConsistency: z.number().min(0.1).max(1).optional(),
  screenshots: z.number().int().min(0).max(4).default(1),
});

export async function agentCritique(input, { root = ROOT } = {}) {
  const runJson = inside(root, `runs/${input.runId}/run.json`);
  const meta = readJSON(runJson);
  const planPath = inside(root, `runs/${input.runId}/look.plan.json`, { exists: false });
  const planMeta = fs.existsSync(planPath) ? readJSON(planPath) : null;
  const { runId, ...opts } = input;
  const steps = [];
  if (planMeta?.look?.level) {
    steps.push({
      op: 'load',
      path: planMeta.look.level,
      options: {
        lighting: planMeta.look.lighting ?? meta.lighting?.name ?? 'overcast',
        atlasSize: planMeta.look.atlas ?? meta.atlasSize ?? 1024,
        viewSize: planMeta.look.viewSize ?? meta.viewSize ?? 512,
        layout: planMeta.look.layout ?? meta.layout?.kind ?? 'near',
        weights: !!(planMeta.look.weights ?? meta.weights),
        paths: !!(planMeta.look.paths ?? meta.paths),
        mode: planMeta.look.mode ?? meta.mode ?? 'auto',
      },
    });
  }
  steps.push({ op: 'loadRun', id: runId });
  steps.push({ op: 'critique', options: opts });
  const started = startJob('workflow', { steps, allowPaid: false }, { root });
  const job = await waitForJob(started.id, { root });
  if (job.status !== 'succeeded') {
    throw new AutomationError(job.error?.code ?? 'CRITIQUE_FAILED', job.error?.message ?? 'Critique job failed');
  }
  let critique = job.results?.find((r) => r.op === 'critique')?.result;
  if (critique?.summary && critique?.path) critique = readJSON(inside(root, critique.path));
  const runReport = writeRunReportFiles(runId, { root, critique });
  return {
    runId,
    jobId: started.id,
    critique,
    artifacts: job.artifacts ?? [],
    ...(runReport ? { reportPath: runReport.htmlPath, reportMarkdownPath: runReport.markdownPath } : {}),
  };
}

export function agentStatus({ sessionId }, { root = ROOT } = {}) {
  const { session } = loadSession(sessionId, root);
  return session;
}
