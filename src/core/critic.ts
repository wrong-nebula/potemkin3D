import * as THREE from 'three';
import { PAINTED } from './atlas';
import { sunDirection } from './clay';
import { backProjectView, seamMetric, surfaceLinks, type ProjectedAtlasView, type SeamScore } from './consolidate';
import { defectMap, fullDetail } from './defects';
import type { Engine } from './engine';
import { fitSurfaceGaussianField } from './gaussian-field';
import { floatTarget } from './gpu';
import { seenCells } from './layout';
import type { RunMetrics } from './metrics';
import { objectEyes } from './object-plan';
import type { RunRecord } from './pipeline';
import { DEFAULT_PLAN, cellDensity, holeTargets, pixelsPerMetre, samplePlayerPoints } from './planner';
import { playerImportance } from './player-paths';
import { surfaceWeights } from './surface-weights';
import { bakedShadingScore, type BakedShadingScore } from './uv-refine';
import { lookAt, makeCamera, type ViewSpec } from './views';

/**
 * Multi-metric Critic for the Planner → Actor → Critic loop (TODO item 10):
 * Combines coverage & high-rank sightline px/m (items 6, 7, 8), multi-view consistency & cross-view seam ratio (item 3),
 * SAM/MoGe blockout replacement residuals, diagnostic screenshot artifact checks, and baked directional shading (item 4)
 * to emit a quantitative score (0..100), diagnostic camera viewpoints aimed at top defect clusters, and minimal targeted
 * repair actions (`consolidate`, `topUp`, `repair` 3D boxes, `parts`, `uvRefine`) gated before extra spend is authorized.
 */

export interface CriticThresholds {
  /** Minimum share of player-visible texture painted (`0..1`, default `0.88`). */
  minSeenPainted?: number;
  /** Minimum median detail (px/m) on high-rank sightlines (`default 42`). */
  minHighRankPxPerM?: number;
  /** Maximum acceptable cross-view boundary step / interior grain ratio (`default 1.35`). */
  maxSeamRatio?: number;
  /** Minimum multi-view RGB consistency (`1 - RMSE`, `0..1`, default `0.86`). */
  minMultiViewConsistency?: number;
  /** Maximum acceptable mean SAM replaced-face residual across views (`default 0.08`). */
  maxIgnoredShare?: number;
  /** Maximum acceptable within-part baked directional shading correlation (`default 0.28`). */
  maxBakedShading?: number;
}

export interface MultiViewScore {
  /** `1 - rmse` across texels observed by `>= 2` views (`1` when `< 2` views overlap). */
  consistency: number;
  /** Weighted cross-view RGB root-mean-square deviation in `[0, 1]`. */
  rmse: number;
  /** Share of covered texels observed by `>= 2` views (`0..1`). */
  overlapShare: number;
  /** Indices of recorded views flagged as appearance outliers (`> 1.75×` median SH-disentangled residual) by `fitSurfaceGaussianField`. */
  outlierViews?: number[];
}

export interface ScreenshotArtifactScore {
  /** Mean share of non-sky pixels still reading as neutral unpainted clay. */
  clayShare: number;
  /** Mean share of non-sky pixels clipped (`< 3` or `> 252` across channels). */
  clippedShare: number;
  /** Mean share of 8×8 interior blocks with near-zero local luminance variance (smeared/blurry projection). */
  flatBlockShare: number;
}

export interface DefectRegion {
  min: [number, number, number];
  max: [number, number, number];
  center: [number, number, number];
  part: string;
  cells: number;
  reason: 'unpainted' | 'low-detail' | 'blockout-residual';
  diagnosticCamera?: { position: [number, number, number]; target: [number, number, number]; fov: number };
}

export interface RepairAction {
  op: 'consolidate' | 'topUp' | 'repair' | 'parts' | 'uvRefine';
  reason: string;
  /** Estimated extra paid model calls (`0` for free post-processes like `consolidate` and intrinsic `uvRefine`). */
  estimatedCalls: number;
  params: Record<string, unknown>;
}

export interface CritiqueReport {
  score: number;
  verdict: 'pass' | 'needs-repair';
  metrics: {
    atlasCoverage: number;
    seenPainted: number;
    unpaintedSeenShare: number;
    poorSeenShare: number;
    highRankPxPerM: number;
    surfacePxPerM: number;
    multiView: MultiViewScore;
    seam: SeamScore;
    bakedShading: BakedShadingScore;
    samIgnoredMean: number;
    samMergedMean: number;
    untouchedMean: number;
    highArtifactViews: number[];
    screenshotArtifacts?: ScreenshotArtifactScore;
  };
  thresholds: Required<CriticThresholds>;
  defectRegions: DefectRegion[];
  unfinishedParts: string[];
  actions: RepairAction[];
  diagnosticCameras: { position: [number, number, number]; target: [number, number, number]; fov: number }[];
  seconds: number;
}

export const DEFAULT_CRITIC_THRESHOLDS: Required<CriticThresholds> = {
  minSeenPainted: 0.88,
  minHighRankPxPerM: 42,
  maxSeamRatio: 1.35,
  minMultiViewConsistency: 0.86,
  maxIgnoredShare: 0.08,
  maxBakedShading: 0.28,
};

/** Inspect RGBA diagnostic screenshot frames for neutral unpainted clay, clipping, and smeared zero-grain patches. */
export function scoreDiagnosticFrames(frames: { data: Uint8ClampedArray | Uint8Array; width: number; height: number }[]): ScreenshotArtifactScore {
  if (!frames.length) return { clayShare: 0, clippedShare: 0, flatBlockShare: 0 };
  let clayPx = 0, clipPx = 0, surfacePx = 0;
  let flatBlocks = 0, totalBlocks = 0;

  for (const { data, width, height } of frames) {
    for (let i = 0; i < width * height; i++) {
      const r = data[4 * i], g = data[4 * i + 1], b = data[4 * i + 2], a = data[4 * i + 3];
      if (a < 16) continue;
      // Skip clear/background sky band near top if virtually uniform cool sky
      const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
      surfacePx++;
      if (maxC > 252 || maxC < 3) clipPx++;
      // Default unpainted atlas base [128, 128, 128] under textured/clay view reads near-achromatic mid-grey
      const sat = maxC > 0 ? (maxC - minC) / maxC : 0;
      if (sat < 0.025 && r >= 118 && r <= 138 && g >= 118 && g <= 138 && b >= 118 && b <= 138) clayPx++;
    }

    const bw = Math.floor(width / 8), bh = Math.floor(height / 8);
    for (let by = 1; by < bh - 1; by++) {
      for (let bx = 1; bx < bw - 1; bx++) {
        let sum = 0, sum2 = 0, satSum = 0;
        for (let dy = 0; dy < 8; dy++) {
          for (let dx = 0; dx < 8; dx++) {
            const p = 4 * ((by * 8 + dy) * width + (bx * 8 + dx));
            const r = data[p] / 255, g = data[p + 1] / 255, b = data[p + 2] / 255;
            const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            sum += y; sum2 += y * y;
            satSum += Math.max(r, g, b) - Math.min(r, g, b);
          }
        }
        const mean = sum / 64;
        const variance = Math.max(0, sum2 / 64 - mean * mean);
        totalBlocks++;
        if (variance < 1.2e-5 && satSum / 64 < 0.02) flatBlocks++;
      }
    }
  }

  const denom = Math.max(1, surfacePx);
  return {
    clayShare: +(clayPx / denom).toFixed(4),
    clippedShare: +(clipPx / denom).toFixed(4),
    flatBlockShare: totalBlocks ? +(flatBlocks / totalBlocks).toFixed(4) : 0,
  };
}

/** Fold rendered diagnostic screenshot artifact scores into an existing CritiqueReport without re-running GPU passes. */
export function applyScreenshotArtifacts(report: CritiqueReport, screenshotArtifacts: ScreenshotArtifactScore): CritiqueReport {
  const actions = [...report.actions];
  if (screenshotArtifacts.clayShare > 0.12 && !actions.some((a) => a.op === 'topUp')) {
    actions.unshift({
      op: 'topUp',
      reason: `diagnostic screenshot shows ${(100 * screenshotArtifacts.clayShare).toFixed(1)}% unpainted clay patches`,
      estimatedCalls: 3,
      params: { plan: { maxViews: 2, adaptive: true, holes: 1, floors: 0, roofs: 0, aerial: 0 } },
    });
  }
  const penalty = 20 * (screenshotArtifacts.clayShare * 1.2 + screenshotArtifacts.clippedShare * 0.8);
  const score = +Math.max(0, Math.min(100, report.score - penalty)).toFixed(1);
  const verdict = report.verdict === 'needs-repair' || screenshotArtifacts.clayShare > 0.12 ? 'needs-repair' : 'pass';
  return {
    ...report,
    score,
    verdict,
    actions,
    metrics: { ...report.metrics, screenshotArtifacts },
  };
}

/** Compute cross-view RGB consistency and boundary seam score on the current atlas (`size` grid). */
export function evaluateMultiViewAndSeams(
  engine: Engine,
  record: RunRecord,
  size = 512,
): { seam: SeamScore; multiView: MultiViewScore } {
  const s = Math.min(size, engine.atlas.size);
  const { pos, nrm } = engine.atlas.texelGeometry(s);
  const links = surfaceLinks(pos, nrm, s);
  const N = s * s;
  const coveredIdx: number[] = [];
  for (let i = 0; i < N; i++) if (links.covered[i]) coveredIdx.push(i);

  const viewsWithComp = record.views.filter((v) => v.comp?.length);
  if (viewsWithComp.length < 2 || coveredIdx.length === 0) {
    return {
      seam: record.consolidated?.after ?? { step: 0, interiorStep: 0, ratio: 1, boundaryEdges: 0 },
      multiView: { consistency: 1, rmse: 0, overlapShare: 0 },
    };
  }

  const dSize = 256;
  const depthRt = floatTarget(dSize, dSize, { count: 3, depth: true });
  const owner = new Int16Array(N).fill(-1);
  const bestW = new Float32Array(N);
  const viewCount = new Uint16Array(N);
  const sumW = new Float32Array(N);
  const sumR = new Float32Array(N), sumG = new Float32Array(N), sumB = new Float32Array(N);
  const sumR2 = new Float32Array(N), sumG2 = new Float32Array(N), sumB2 = new Float32Array(N);
  const projectedViews: ProjectedAtlasView[] = [];
  const projectedSpecs: ViewSpec[] = [];
  const projectedRecordIndices: number[] = [];

  try {
    record.views.forEach((v, k) => {
      if (!v.comp?.length) return;
      engine.views.renderGeometry(makeCamera(v.spec), depthRt);
      const gPos = engine.gpu.readF32(depthRt, 0, true);
      const proj = backProjectView(pos, nrm, s, coveredIdx, v.spec, gPos, dSize, v.comp, engine.size, {
        detail: v.detail ?? 1, minCos: engine.options.minCos, frameMargin: engine.options.frameMargin,
      });
      projectedViews.push(proj);
      projectedSpecs.push(v.spec);
      projectedRecordIndices.push(k);
      for (const i of coveredIdx) {
        const w = proj.weight[i];
        if (w <= 0 || proj.rgba[4 * i + 3] === 0) continue;
        const r = proj.rgba[4 * i] / 255, g = proj.rgba[4 * i + 1] / 255, b = proj.rgba[4 * i + 2] / 255;
        viewCount[i]++;
        sumW[i] += w;
        sumR[i] += w * r; sumG[i] += w * g; sumB[i] += w * b;
        sumR2[i] += w * r * r; sumG2[i] += w * g * g; sumB2[i] += w * b * b;
        if (bestW[i] === 0 || w > bestW[i] / engine.options.qualityRatio) {
          bestW[i] = w;
          owner[i] = k;
        }
      }
    });
  } finally {
    depthRt.dispose();
  }

  let outlierViews: number[] = [];
  if (projectedViews.length >= 3) {
    const gf = fitSurfaceGaussianField(projectedViews, projectedSpecs, pos, nrm, s, {
      stride: Math.max(2, Math.round(s / 64)),
    });
    outlierViews = gf.consistency.outlierViews.map((j) => projectedRecordIndices[j]);
  }

  let overlap = 0, varAcc = 0, wAcc = 0;
  for (const i of coveredIdx) {
    if (viewCount[i] < 2 || sumW[i] <= 1e-6) continue;
    overlap++;
    const inv = 1 / sumW[i];
    const mr = sumR[i] * inv, mg = sumG[i] * inv, mb = sumB[i] * inv;
    const vr = Math.max(0, sumR2[i] * inv - mr * mr);
    const vg = Math.max(0, sumG2[i] * inv - mg * mg);
    const vb = Math.max(0, sumB2[i] * inv - mb * mb);
    varAcc += sumW[i] * ((vr + vg + vb) / 3);
    wAcc += sumW[i];
  }
  const rmse = wAcc > 0 ? Math.sqrt(varAcc / wAcc) : 0;
  const multiView: MultiViewScore = {
    consistency: +Math.max(0, Math.min(1, 1 - rmse)).toFixed(4),
    rmse: +rmse.toFixed(4),
    overlapShare: +(overlap / coveredIdx.length).toFixed(4),
    ...(outlierViews.length ? { outlierViews } : {}),
  };

  const current = engine.atlas.readBytes([0.5, 0.5, 0.5], s, true).data;
  const seam = record.consolidated?.after ?? seamMetric(current, owner, links, s);
  return { seam, multiView };
}

/** Backwards-compatible helper returning only the seam score. */
export function evaluateAtlasSeams(engine: Engine, record: RunRecord, size = 512): SeamScore {
  return evaluateMultiViewAndSeams(engine, record, size).seam;
}

/**
 * Evaluate a run across coverage, sightline sharpness, multi-view consistency, cross-view seam ratio, SAM/MoGe
 * blockout residuals, screenshot artifacts and baked shading, emitting targeted repair actions before any extra spend.
 */
export function critiqueRun(
  engine: Engine,
  record: RunRecord,
  measured: RunMetrics,
  thresholds: CriticThresholds = {},
  screenshotArtifacts?: ScreenshotArtifactScore,
): CritiqueReport {
  const t0 = performance.now();
  const th: Required<CriticThresholds> = { ...DEFAULT_CRITIC_THRESHOLDS, ...thresholds };
  const level = engine.level;

  // 1. Ensure surface & player-path importance maps exist (items 6 & 7) so defect priority follows where players look.
  const sw = level.surfaceWeights && level.surfaceWeights.importance.length === level.triangles
    ? level.surfaceWeights
    : surfaceWeights(level, engine.clay.lighting);
  level.surfaceWeights = sw;
  const pp = level.playerPaths && level.playerPaths.rank.length === level.triangles
    ? level.playerPaths
    : playerImportance(level);
  level.playerPaths = pp;

  // 2. SAM/MoGe blockout residuals & untouched clay from recorded views.
  let sumIgn = 0, nIgn = 0, sumMerged = 0, sumLeft = 0;
  const highArtifactViews: number[] = [];
  for (const v of record.views) {
    if (v.ignored !== undefined) {
      sumIgn += v.ignored;
      nIgn++;
      if (v.ignored > Math.max(0.14, th.maxIgnoredShare * 1.75)) highArtifactViews.push(v.index);
    }
    if (v.merged !== undefined) sumMerged += v.merged;
    if (v.left !== undefined) sumLeft += v.left;
  }
  const samIgnoredMean = nIgn ? +(sumIgn / nIgn).toFixed(4) : 0;
  const samMergedMean = nIgn ? +(sumMerged / nIgn).toFixed(4) : 0;
  const untouchedMean = record.views.length ? +(sumLeft / record.views.length).toFixed(4) : 0;

  // 3. Multi-view consistency, cross-view seam score (item 3), and baked directional shading score (item 4).
  const G = 256;
  const cells = engine.atlas.texelGeometry(G);
  const quality = engine.atlas.cellQuality(G);
  const atlasBytes = engine.atlas.readBytes([0.5, 0.5, 0.5], G, true).data;
  const covered = new Uint8Array(G * G);
  for (let i = 0; i < covered.length; i++) if (cells.nrm[4 * i + 3] > 0.5) covered[i] = 1;
  const { seam, multiView } = evaluateMultiViewAndSeams(engine, record, Math.min(512, engine.atlas.size));
  const toSun = sunDirection(engine.clay.lighting).negate();
  const bakedShading = bakedShadingScore(atlasBytes, covered, cells.pos, cells.nrm, G, [toSun.x, toSun.y, toSun.z]);

  // 4. Spatial defect map & 3D repair boxes weighted by importance.
  const eyes = level.mode === 'object'
    ? objectEyes(level, 40)
    : samplePlayerPoints(level, { ...DEFAULT_PLAN, spacing: 1.6 });
  const detail = fullDetail(cellDensity({ ...cells, texelsPerCell: engine.atlas.size / G }, G), pixelsPerMetre(engine.size, 75));
  const defects = defectMap(cells.pos, cells.nrm, quality, level.bvh, eyes, engine.options.qualityRatio, 60, detail.cells);
  const seenShare = Math.max(1, defects.seen);
  const unpaintedSeenShare = +(defects.unpainted / seenShare).toFixed(4);
  const poorSeenShare = +(defects.poor / seenShare).toFixed(4);
  const seenPainted = +(measured.seen?.painted ?? (1 - unpaintedSeenShare)).toFixed(4);
  const highRankPxPerM = +(measured.highRank?.surface ?? measured.sampling.surface).toFixed(1);
  const surfacePxPerM = +measured.sampling.surface.toFixed(1);

  // Per-part unpainted seen share to spot isolated props/shapes needing `parts`.
  const visible = seenCells(cells.pos, cells.nrm, level.bvh, eyes);
  const partSeen = new Int32Array(level.labels.length);
  const partUnp = new Int32Array(level.labels.length);
  for (let i = 0; i < G * G; i++) {
    if (!covered[i] || !visible[i]) continue;
    const l = Math.round(cells.pos[4 * i + 3]) - 1;
    if (l < 0 || l >= level.labels.length) continue;
    partSeen[l]++;
    if (!(quality[i] > PAINTED)) partUnp[l]++;
  }
  const unfinishedParts = level.labels
    .map((name, l) => ({ name, seen: partSeen[l], ratio: partSeen[l] > 24 ? partUnp[l] / partSeen[l] : 0 }))
    .filter((p) => p.name && p.ratio >= 0.35 && p.seen < 0.25 * seenShare)
    .sort((a, b) => b.ratio * b.seen - a.ratio * a.seen)
    .slice(0, 3)
    .map((p) => p.name);

  // Cluster spatial 3D defect targets into compact repair boxes and aim diagnostic cameras at them.
  const defectQuality = Float32Array.from(defects.cls, (c) => (c ? 0 : 1));
  const targets = holeTargets(cells.pos, cells.nrm, defectQuality, 2.8, 16).slice(0, 4);
  const defectRegions: DefectRegion[] = [];
  const diagnosticCameras: { position: [number, number, number]; target: [number, number, number]; fov: number }[] = [];

  for (const tgt of targets) {
    const half = 1.6;
    const min: [number, number, number] = [+(tgt.center.x - half).toFixed(2), +(tgt.center.y - half).toFixed(2), +(tgt.center.z - half).toFixed(2)];
    const max: [number, number, number] = [+(tgt.center.x + half).toFixed(2), +(tgt.center.y + half).toFixed(2), +(tgt.center.z + half).toFixed(2)];
    const center: [number, number, number] = [+tgt.center.x.toFixed(2), +tgt.center.y.toFixed(2), +tgt.center.z.toFixed(2)];

    let bestEye: THREE.Vector3 | undefined;
    let bestScore = -Infinity;
    const ray = new THREE.Ray();
    for (const eye of eyes) {
      const d = eye.distanceTo(tgt.center);
      if (d < 1.0 || d > 18) continue;
      ray.origin.copy(eye);
      ray.direction.subVectors(tgt.center, eye).divideScalar(d);
      const hit = level.bvh.raycastFirst(ray, THREE.DoubleSide, 0.05, d);
      if (hit && hit.distance < d - 0.25) continue;
      const cos = Math.max(0, -ray.direction.dot(tgt.normal));
      const sc = (cos + 0.2) / (1 + 0.18 * Math.abs(d - 3.5));
      if (sc > bestScore) { bestScore = sc; bestEye = eye; }
    }
    let diagCam: { position: [number, number, number]; target: [number, number, number]; fov: number } | undefined;
    if (bestEye) {
      const spec: ViewSpec = lookAt(bestEye, tgt.center, 68);
      diagCam = {
        position: bestEye.toArray().map((v) => +v.toFixed(2)) as [number, number, number],
        target: center,
        fov: spec.fov,
      };
      if (diagnosticCameras.length < 3) diagnosticCameras.push(diagCam);
    }

    let domPart = level.labels[0] || 'surface';
    let bestD = Infinity;
    for (let i = 0; i < G * G; i++) {
      if (!defects.cls[i]) continue;
      const d2 = (cells.pos[4 * i] - tgt.center.x) ** 2 + (cells.pos[4 * i + 1] - tgt.center.y) ** 2 + (cells.pos[4 * i + 2] - tgt.center.z) ** 2;
      if (d2 < bestD) {
        bestD = d2;
        const l = Math.round(cells.pos[4 * i + 3]) - 1;
        if (level.labels[l]) domPart = level.labels[l];
      }
    }

    defectRegions.push({
      min,
      max,
      center,
      part: domPart,
      cells: tgt.cells,
      reason: unpaintedSeenShare >= poorSeenShare ? 'unpainted' : 'low-detail',
      ...(diagCam ? { diagnosticCamera: diagCam } : {}),
    });
  }

  if (!diagnosticCameras.length) {
    const c = level.bounds.getCenter(new THREE.Vector3());
    const sz = level.bounds.getSize(new THREE.Vector3());
    const eye = eyes[0] ?? new THREE.Vector3(c.x + sz.x * 0.45, c.y + sz.y * 0.35, c.z + sz.z * 0.45);
    diagnosticCameras.push({
      position: eye.toArray().map((v) => +v.toFixed(2)) as [number, number, number],
      target: c.toArray().map((v) => +v.toFixed(2)) as [number, number, number],
      fov: 68,
    });
  }

  // 5. Prescribe minimal targeted repair actions ONLY for metrics failing thresholds.
  const actions: RepairAction[] = [];

  if (((seam.boundaryEdges > 20 && seam.ratio > th.maxSeamRatio) ||
       (multiView.overlapShare > 0.05 && multiView.consistency < th.minMultiViewConsistency) ||
       (multiView.outlierViews?.length ?? 0) > 0) && !record.consolidated) {
    const outlierNote = multiView.outlierViews?.length ? `; outlier views [${multiView.outlierViews.join(', ')}] attenuated` : '';
    actions.push({
      op: 'consolidate',
      reason: (seam.ratio > th.maxSeamRatio
        ? `cross-view seam ratio ${seam.ratio.toFixed(2)} exceeds ${th.maxSeamRatio.toFixed(2)} across ${seam.boundaryEdges} boundary edges`
        : multiView.outlierViews?.length
          ? `3DGS consistency check flagged outlier views [${multiView.outlierViews.join(', ')}]`
          : `multi-view consistency ${multiView.consistency.toFixed(3)} below ${th.minMultiViewConsistency.toFixed(2)}`) + outlierNote,
      estimatedCalls: 0,
      params: {
        size: Math.min(1024, engine.atlas.size),
        flow: true,
        lambda: 0.02,
        ...(multiView.outlierViews?.length ? { dropViews: multiView.outlierViews } : {}),
      },
    });
  }

  const clayArtifactFail = (screenshotArtifacts?.clayShare ?? 0) > 0.12;
  if (seenPainted < th.minSeenPainted || clayArtifactFail || (highRankPxPerM > 0 && highRankPxPerM < th.minHighRankPxPerM && poorSeenShare > 0.06)) {
    const deficit = Math.max(0, th.minSeenPainted - seenPainted);
    const extraViews = Math.max(2, Math.min(12, Math.ceil(deficit * 16) + (highRankPxPerM < th.minHighRankPxPerM ? 2 : 0)));
    const holes = Math.min(2, Math.floor(extraViews / 3));
    const mainViews = Math.max(1, extraViews - holes);
    actions.push({
      op: 'topUp',
      reason: `player-visible painted share ${(100 * seenPainted).toFixed(1)}% < ${(100 * th.minSeenPainted).toFixed(0)}% target (high-rank ${highRankPxPerM} px/m)`,
      estimatedCalls: mainViews + holes,
      params: { plan: { maxViews: mainViews, adaptive: true, holes, floors: 0, roofs: 0, aerial: 0 } },
    });
  } else if ((samIgnoredMean > th.maxIgnoredShare || highArtifactViews.length > 0) && defectRegions.length > 0) {
    const regions = defectRegions.slice(0, 2).map((r) => ({ min: r.min, max: r.max, text: r.part }));
    actions.push({
      op: 'repair',
      reason: `SAM/blockout held-back residual ${(100 * samIgnoredMean).toFixed(1)}% (${highArtifactViews.length} high-artifact views)`,
      estimatedCalls: regions.length,
      params: { regions },
    });
  }

  if (unfinishedParts.length > 0 && seenPainted < th.minSeenPainted) {
    actions.push({
      op: 'parts',
      reason: `isolated parts still >35% unpainted: ${unfinishedParts.join(', ')}`,
      estimatedCalls: unfinishedParts.length,
      params: { only: unfinishedParts, max: unfinishedParts.length },
    });
  }

  const atlasCov = +engine.atlas.coverage().toFixed(4);
  if ((atlasCov < 0.985 || bakedShading.correlation > th.maxBakedShading) && !record.uvRefined) {
    actions.push({
      op: 'uvRefine',
      reason: atlasCov < 0.985
        ? `atlas coverage ${(100 * atlasCov).toFixed(1)}% leaves unpainted UV pockets/slivers`
        : `baked directional shading correlation ${bakedShading.correlation.toFixed(2)} > ${th.maxBakedShading.toFixed(2)}`,
      estimatedCalls: 0,
      params: { size: Math.min(1024, engine.atlas.size), delight: 0.85, sharpen: 0.45 },
    });
  }

  // Quantitative 0..100 score combining coverage (35), sightline sharpness (20), multi-view & seam consistency (25), fidelity & delighting (20).
  const covScore = 35 * Math.min(1, seenPainted / Math.max(0.01, th.minSeenPainted));
  const sharpScore = 20 * Math.min(1, highRankPxPerM / Math.max(1, th.minHighRankPxPerM));
  const seamPart = Math.max(0, Math.min(1, 1 - Math.max(0, seam.ratio - 1.05) / 1.5));
  const mvPart = Math.max(0, Math.min(1, multiView.consistency / Math.max(0.1, th.minMultiViewConsistency)));
  const seamScore = 25 * (0.55 * seamPart + 0.45 * mvPart);
  const shotPenalty = screenshotArtifacts ? (screenshotArtifacts.clayShare * 1.2 + screenshotArtifacts.clippedShare * 0.8) : 0;
  const fidScore = 20 * Math.max(0, 1 - samIgnoredMean * 2.5 - Math.max(0, bakedShading.correlation - 0.15) * 0.8 - shotPenalty);
  const score = +Math.max(0, Math.min(100, covScore + sharpScore + seamScore + fidScore)).toFixed(1);

  const paidOrCoverageFail = actions.some((a) => a.op === 'topUp' || a.op === 'repair') ||
    seenPainted < th.minSeenPainted ||
    (seam.boundaryEdges > 20 && seam.ratio > th.maxSeamRatio) ||
    (multiView.overlapShare > 0.05 && multiView.consistency < th.minMultiViewConsistency && !record.consolidated) ||
    bakedShading.correlation > th.maxBakedShading;

  return {
    score,
    verdict: paidOrCoverageFail ? 'needs-repair' : 'pass',
    metrics: {
      atlasCoverage: atlasCov,
      seenPainted,
      unpaintedSeenShare,
      poorSeenShare,
      highRankPxPerM,
      surfacePxPerM,
      multiView,
      seam,
      bakedShading,
      samIgnoredMean,
      samMergedMean,
      untouchedMean,
      highArtifactViews,
      ...(screenshotArtifacts ? { screenshotArtifacts } : {}),
    },
    thresholds: th,
    defectRegions,
    unfinishedParts,
    actions,
    diagnosticCameras,
    seconds: +((performance.now() - t0) / 1000).toFixed(3),
  };
}
