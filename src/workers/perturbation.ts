import { buildSeriesPlan, evaluateSeries, type Complex } from "../math/series";
import type { FailureKind, ReferenceSnapshot, RenderTileMessage, TileDoneMessage, UnresolvedCluster } from "../types";

interface PixelResult {
  iter: number;
  mag2: number;
  glitch: boolean;
  unresolved: boolean;
  failureKind: FailureKind;
  survivedIter: number;
  periodicInterior: boolean;
  rebaseCount: number;
  rebaseLimit: boolean;
  blaSkipCount: number;
  blaStepCount: number;
}

interface PixelSelection {
  result: PixelResult;
  referenceIndex: number;
  skip: number;
}

interface ReferenceContext {
  reference: ReferenceSnapshot;
  screenX: number;
  screenY: number;
  orbitRe: Float64Array;
  orbitIm: Float64Array;
  radius: number;
  probes: Complex[];
  series: ReturnType<typeof buildSeriesPlan> | undefined;
}

interface PeriodicScratch {
  checkpointRe: Float64Array;
  checkpointIm: Float64Array;
  checkpointIter: Int32Array;
  pixelResult: PixelResult;
  bestResult: PixelResult;
  selection: PixelSelection;
}

interface ClusterAccumulator {
  binX: number;
  binY: number;
  bounds: { x: number; y: number; width: number; height: number };
  count: number;
  sumX: number;
  sumY: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  bestX: number;
  bestY: number;
  bestSurvivedIter: number;
}

interface Color {
  r: number;
  g: number;
  b: number;
}

interface BoundaryCandidate {
  index: number;
  edgeStrength: number;
  classificationChange: boolean;
}

interface BoundaryStats {
  boundaryDampenedCount: number;
  aaPixelCount: number;
  aaSampleCount: number;
  aaFallbackCount: number;
}

interface EdgeInfo {
  edgeStrength: number;
  classificationChange: boolean;
}

const MIN_PIXEL_SPAN_FOR_PERIODIC_INTERIOR = 1e-18;
const REBASE_G = 1e-8;
const MAX_REBASES_PER_PIXEL = 64;
const SERIES_MAX_SKIP = 8192;
const SMOOTH_DELTA_LOW = 6;
const SMOOTH_DELTA_HIGH = 24;
const CLASSIFICATION_EDGE_BOOST = 0.35;
const AA_EDGE_THRESHOLD = 0.45;
const AA_PIXEL_CAP = 512;
const AA_PIXEL_FRACTION = 0.04;
const AA_FOUR_SAMPLE_CAP = 128;
const AA_FOUR_SAMPLE_FRACTION = 0.01;
const MIN_EDGE_CHROMA_SCALE = 0.35;
const PALETTE_SIZE = 2048;
const COSINE_PALETTE = createCosinePalette(PALETTE_SIZE);
const INV_LN2 = 1 / Math.LN2;
const SMOOTH_LOG_SCALE = 0.5 * INV_LN2;
const TWO_SAMPLE_OFFSETS = [
  [-0.25, -0.25],
  [0.25, 0.25]
] as const;
const FOUR_SAMPLE_OFFSETS = [
  [-0.375, -0.125],
  [0.125, -0.375],
  [-0.125, 0.375],
  [0.375, 0.125]
] as const;

export function renderPerturbationTile(message: RenderTileMessage): TileDoneMessage {
  const started = performance.now();
  const { tile, pixelSpan, maxIter, seriesDegree } = message;
  const sampleStep = message.renderMode === "preview" ? Math.max(1, Math.floor(message.sampleStep)) : 1;
  const width = Math.max(1, Math.ceil(tile.rect.width / sampleStep));
  const height = Math.max(1, Math.ceil(tile.rect.height / sampleStep));
  const rgba = new Uint8ClampedArray(width * height * 4);
  const contexts = message.references.map((reference) => {
    const orbitRe = asFloat64(reference.orbitRe);
    const orbitIm = asFloat64(reference.orbitIm);
    const radius = tileRadius(tile.rect, reference, pixelSpan);
    const probes = tileProbeOffsets(tile.rect, reference, pixelSpan);
    return {
      reference,
      screenX: reference.screenX,
      screenY: reference.screenY,
      orbitRe,
      orbitIm,
      radius,
      probes,
      series: undefined
    } satisfies ReferenceContext;
  });
  const scratch: PeriodicScratch = {
    checkpointRe: new Float64Array(32),
    checkpointIm: new Float64Array(32),
    checkpointIter: new Int32Array(32),
    pixelResult: createPixelResult(),
    bestResult: createPixelResult(),
    selection: { result: createPixelResult(), referenceIndex: -1, skip: 0 }
  };

  let glitchCount = 0;
  let unresolvedCount = 0;
  let escapedPixels = 0;
  let periodicInteriorCount = 0;
  let rebaseCount = 0;
  let rebaseLimitCount = 0;
  let blaSkipCount = 0;
  let blaStepCount = 0;
  let unresolvedScreenXSum = 0;
  let unresolvedScreenYSum = 0;
  let seriesSkip = 0;
  const usedReferenceIndices = new Uint8Array(contexts.length);
  const clusters = createClusterAccumulators(tile.rect);
  const unresolvedMask = new Uint8Array(width * height);
  const escapedMask = message.renderMode === "final" ? new Uint8Array(width * height) : undefined;
  const smoothValues = message.renderMode === "final" ? new Float32Array(width * height) : undefined;
  const screenXs = new Float64Array(width);
  const screenYs = new Float64Array(height);
  for (let px = 0; px < width; px += 1) {
    screenXs[px] = Math.min(tile.rect.x + tile.rect.width - 0.5, tile.rect.x + (px + 0.5) * sampleStep);
  }
  for (let py = 0; py < height; py += 1) {
    screenYs[py] = Math.min(tile.rect.y + tile.rect.height - 0.5, tile.rect.y + (py + 0.5) * sampleStep);
  }
  const allowPeriodicInterior = pixelSpan >= MIN_PIXEL_SPAN_FOR_PERIODIC_INTERIOR;

  for (let py = 0; py < height; py += 1) {
    const screenY = screenYs[py];
    for (let px = 0; px < width; px += 1) {
      const pixelIndex = py * width + px;
      const screenX = screenXs[px];
      const { result, referenceIndex, skip } = renderPixelWithReferences(
        screenX,
        screenY,
        pixelSpan,
        maxIter,
        seriesDegree,
        contexts,
        scratch,
        allowPeriodicInterior
      );
      const offset = pixelIndex * 4;
      if (result.iter < maxIter) escapedPixels += 1;
      if (result.periodicInterior) periodicInteriorCount += 1;
      rebaseCount += result.rebaseCount;
      if (result.rebaseLimit) rebaseLimitCount += 1;
      blaSkipCount += result.blaSkipCount;
      blaStepCount += result.blaStepCount;
      if (result.glitch) glitchCount += 1;
      if (referenceIndex >= 0) usedReferenceIndices[referenceIndex] = 1;
      seriesSkip = Math.max(seriesSkip, skip);
      if (result.unresolved) {
        unresolvedCount += 1;
        unresolvedScreenXSum += screenX;
        unresolvedScreenYSum += screenY;
        unresolvedMask[pixelIndex] = 1;
        recordUnresolvedCluster(clusters, tile.rect, screenX, screenY, result.survivedIter);
      } else if (result.iter < maxIter) {
        if (escapedMask) escapedMask[pixelIndex] = 1;
      }
      const smooth = smoothIteration(result.iter, maxIter, result.mag2);
      if (smoothValues) smoothValues[pixelIndex] = smooth;
      writeColorForSmooth(rgba, offset, result.iter >= maxIter, smooth);
    }
  }

  const boundaryStats = message.renderMode === "final" && unresolvedCount === 0
    ? applyBoundarySmoothing(
        rgba,
        smoothValues!,
        escapedMask!,
        unresolvedMask,
        width,
        height,
        tile.rect,
        pixelSpan,
        maxIter,
        seriesDegree,
        contexts,
        scratch,
        allowPeriodicInterior
      )
    : emptyBoundaryStats();

  const unresolvedMaskOutput =
    message.renderMode === "final" && unresolvedCount > 0 ? unresolvedMask.slice().buffer : undefined;
  if (unresolvedCount > 0) fillUnresolvedPreview(rgba, unresolvedMask, width, height);

  const unresolvedScreenX = unresolvedCount > 0 ? unresolvedScreenXSum / unresolvedCount : undefined;
  const unresolvedScreenY = unresolvedCount > 0 ? unresolvedScreenYSum / unresolvedCount : undefined;
  const unresolvedClusters = buildUnresolvedClusters(clusters, tile.rect);
  const referenceIdsUsed: string[] = [];
  for (let index = 0; index < usedReferenceIndices.length; index += 1) {
    if (usedReferenceIndices[index] !== 0) referenceIdsUsed.push(contexts[index].reference.id);
  }

  return {
    type: "tileDone",
    tileId: tile.id,
    revision: tile.revision,
    rect: tile.rect,
    width,
    height,
    rgba: rgba.buffer,
    unresolvedMask: unresolvedMaskOutput,
    needsReference: unresolvedClusters.length > 0,
    stats: {
      elapsedMs: performance.now() - started,
      glitchCount,
      unresolvedCount,
      escapedPixels,
      periodicInteriorCount,
      maxEscapedIter: 0,
      p95EscapedIter: 0,
      nearCapEscapedCount: 0,
      capHitUnknownCount: 0,
      capHitBoundaryCount: 0,
      rebaseCount,
      rebaseLimitCount,
      blaSkipCount,
      blaStepCount,
      referenceCacheMissCount: 0,
      seriesSkip,
      boundaryDampenedCount: boundaryStats.boundaryDampenedCount,
      aaPixelCount: boundaryStats.aaPixelCount,
      aaSampleCount: boundaryStats.aaSampleCount,
      aaFallbackCount: boundaryStats.aaFallbackCount,
      referenceId: referenceIdsUsed[0] ?? contexts[0]?.reference.id ?? "",
      referenceIdsUsed,
      unresolvedScreenX,
      unresolvedScreenY,
      unresolvedClusters,
      preview: message.renderMode === "preview",
      renderMode: message.renderMode,
      exactFallbackPixels: 0
    }
  };
}

function renderPixelWithReferences(
  screenX: number,
  screenY: number,
  pixelSpan: number,
  maxIter: number,
  seriesDegree: number,
  contexts: ReferenceContext[],
  scratch: PeriodicScratch,
  allowPeriodicInterior: boolean
): PixelSelection {
  const selection = scratch.selection;
  selection.referenceIndex = -1;
  selection.skip = 0;
  selection.result = scratch.pixelResult;
  let hasBestUnresolved = false;
  let bestUnresolvedReferenceIndex = -1;
  let maxSkip = 0;
  for (let index = 0; index < contexts.length; index += 1) {
    const context = contexts[index];
    const cRe = (screenX - context.screenX) * pixelSpan;
    const cIm = (screenY - context.screenY) * pixelSpan;
    const series = seriesForContext(context, seriesDegree);
    const result = perturb(
      cRe,
      cIm,
      context.orbitRe,
      context.orbitIm,
      maxIter,
      series,
      allowPeriodicInterior,
      scratch,
      scratch.pixelResult
    );
    maxSkip = Math.max(maxSkip, series.skip);
    if (!result.unresolved) {
      selection.result = result;
      selection.referenceIndex = index;
      selection.skip = maxSkip;
      return selection;
    }
    if (!hasBestUnresolved || result.survivedIter > scratch.bestResult.survivedIter) {
      copyPixelResult(result, scratch.bestResult);
      hasBestUnresolved = true;
      bestUnresolvedReferenceIndex = index;
    }
  }

  if (!hasBestUnresolved) failureResult(scratch.bestResult, maxIter, 0, true, 0, 0, false, 0, 0);
  selection.result = scratch.bestResult;
  selection.referenceIndex = bestUnresolvedReferenceIndex;
  selection.skip = maxSkip;
  return selection;
}

function createPixelResult(): PixelResult {
  return {
    iter: 0,
    mag2: 0,
    glitch: false,
    unresolved: false,
    failureKind: "earlyReferenceEscape",
    survivedIter: 0,
    periodicInterior: false,
    rebaseCount: 0,
    rebaseLimit: false,
    blaSkipCount: 0,
    blaStepCount: 0
  };
}

function copyPixelResult(source: PixelResult, target: PixelResult): void {
  target.iter = source.iter;
  target.mag2 = source.mag2;
  target.glitch = source.glitch;
  target.unresolved = source.unresolved;
  target.failureKind = source.failureKind;
  target.survivedIter = source.survivedIter;
  target.periodicInterior = source.periodicInterior;
  target.rebaseCount = source.rebaseCount;
  target.rebaseLimit = source.rebaseLimit;
  target.blaSkipCount = source.blaSkipCount;
  target.blaStepCount = source.blaStepCount;
}

function seriesForContext(context: ReferenceContext, seriesDegree: number): ReturnType<typeof buildSeriesPlan> {
  if (!context.series) {
    context.series = buildSeriesPlan(context.orbitRe, context.orbitIm, seriesDegree, SERIES_MAX_SKIP, context.radius, context.probes);
  }
  return context.series;
}

function perturb(
  cRe: number,
  cIm: number,
  orbitRe: Float64Array,
  orbitIm: Float64Array,
  maxIter: number,
  series: ReturnType<typeof buildSeriesPlan>,
  allowPeriodicInterior: boolean,
  scratch: PeriodicScratch,
  output: PixelResult
): PixelResult {
  let dzRe = 0;
  let dzIm = 0;
  let iter = 0;
  let refIndex = 0;
  let mag2 = 0;
  let glitch = false;
  let rebaseCount = 0;
  let rebaseLimit = false;
  let blaSkipCount = 0;
  let blaStepCount = 0;
  const checkpointRe = allowPeriodicInterior ? scratch.checkpointRe : undefined;
  const checkpointIm = allowPeriodicInterior ? scratch.checkpointIm : undefined;
  const checkpointIter = allowPeriodicInterior ? scratch.checkpointIter : undefined;
  let checkpointCount = 0;
  let checkpointIndex = 0;

  if (series.skip > 0) {
    const dz = evaluateSeries(series, cRe, cIm);
    dzRe = dz.re;
    dzIm = dz.im;
    iter = series.skip;
    refIndex = series.skip;
  }

  const limit = Math.min(maxIter, orbitRe.length - 1);
  if (limit < 0 || refIndex > limit) {
    return failureResult(output, maxIter, mag2, true, Math.max(0, limit), rebaseCount, rebaseLimit, blaSkipCount, blaStepCount);
  }

  while (iter <= maxIter && refIndex <= limit) {
    const refRe = orbitRe[refIndex];
    const refIm = orbitIm[refIndex];

    const zRe = refRe + dzRe;
    const zIm = refIm + dzIm;
    mag2 = zRe * zRe + zIm * zIm;
    if (!Number.isFinite(mag2)) {
      glitch = true;
      break;
    }
    if (mag2 > 4) return successResult(output, iter, mag2, glitch, false, rebaseCount, rebaseLimit, blaSkipCount, blaStepCount);
    if (iter >= maxIter) return successResult(output, maxIter, mag2, false, false, rebaseCount, rebaseLimit, blaSkipCount, blaStepCount);

    if (checkpointRe && checkpointIm && checkpointIter && iter > 32 && iter % 8 === 0) {
      const cycleTolerance = 1e-20 * Math.max(1, mag2);
      for (let checkpoint = 0; checkpoint < checkpointCount; checkpoint += 1) {
        if (iter - checkpointIter[checkpoint] < 32) continue;
        const cycleDeltaRe = zRe - checkpointRe[checkpoint];
        const cycleDeltaIm = zIm - checkpointIm[checkpoint];
        const cycleDelta2 = cycleDeltaRe * cycleDeltaRe + cycleDeltaIm * cycleDeltaIm;
        if (Number.isFinite(cycleDelta2) && cycleDelta2 < cycleTolerance) {
          return successResult(output, maxIter, mag2, false, true, rebaseCount, rebaseLimit, blaSkipCount, blaStepCount);
        }
      }
      checkpointRe[checkpointIndex] = zRe;
      checkpointIm[checkpointIndex] = zIm;
      checkpointIter[checkpointIndex] = iter;
      checkpointIndex = (checkpointIndex + 1) % checkpointRe.length;
      checkpointCount = Math.min(checkpointCount + 1, checkpointRe.length);
    }

    const refMag2 = refRe * refRe + refIm * refIm;
    const dzMag2BeforeStep = dzRe * dzRe + dzIm * dzIm;
    let stepRefRe = refRe;
    let stepRefIm = refIm;
    let stepRefMag2 = refMag2;
    if (
      refIndex > 0 &&
      Number.isFinite(refMag2) &&
      refMag2 > 1e-30 &&
      mag2 < refMag2 * REBASE_G
    ) {
      if (rebaseCount >= MAX_REBASES_PER_PIXEL) {
        glitch = true;
        rebaseLimit = true;
        break;
      }
      dzRe = zRe;
      dzIm = zIm;
      refIndex = 0;
      stepRefRe = orbitRe[0] ?? 0;
      stepRefIm = orbitIm[0] ?? 0;
      stepRefMag2 = stepRefRe * stepRefRe + stepRefIm * stepRefIm;
      rebaseCount += 1;
    } else if (
      !Number.isFinite(refMag2) ||
      !Number.isFinite(dzMag2BeforeStep) ||
      (refMag2 > 1e-30 && dzMag2BeforeStep > 1e-30 && dzMag2BeforeStep > refMag2 * 1e-4 && mag2 < refMag2 * 1e-20)
    ) {
      glitch = true;
      break;
    }

    if (refIndex === limit) break;

    const dz2Re = dzRe * dzRe - dzIm * dzIm;
    const dz2Im = 2 * dzRe * dzIm;
    const twoRefDzRe = 2 * (stepRefRe * dzRe - stepRefIm * dzIm);
    const twoRefDzIm = 2 * (stepRefRe * dzIm + stepRefIm * dzRe);
    dzRe = twoRefDzRe + dz2Re + cRe;
    dzIm = twoRefDzIm + dz2Im + cIm;
    iter += 1;
    refIndex += 1;

    const dzMag2 = dzRe * dzRe + dzIm * dzIm;
    if (!Number.isFinite(dzMag2) || (stepRefMag2 > 1e-24 && dzMag2 > stepRefMag2 * 1e8)) {
      glitch = true;
      break;
    }
  }

  if (glitch || iter < maxIter) {
    return failureResult(output, maxIter, mag2, true, Math.min(iter, maxIter), rebaseCount, rebaseLimit, blaSkipCount, blaStepCount);
  }
  return successResult(output, maxIter, mag2, false, false, rebaseCount, rebaseLimit, blaSkipCount, blaStepCount);
}

function successResult(
  output: PixelResult,
  iter: number,
  mag2: number,
  glitch: boolean,
  periodicInterior: boolean,
  rebaseCount: number,
  rebaseLimit: boolean,
  blaSkipCount: number,
  blaStepCount: number
): PixelResult {
  output.iter = iter;
  output.mag2 = mag2;
  output.glitch = glitch;
  output.unresolved = false;
  output.failureKind = "earlyReferenceEscape";
  output.survivedIter = iter;
  output.periodicInterior = periodicInterior;
  output.rebaseCount = rebaseCount;
  output.rebaseLimit = rebaseLimit;
  output.blaSkipCount = blaSkipCount;
  output.blaStepCount = blaStepCount;
  return output;
}

function failureResult(
  output: PixelResult,
  iter: number,
  mag2: number,
  glitch: boolean,
  survivedIter: number,
  rebaseCount: number,
  rebaseLimit: boolean,
  blaSkipCount: number,
  blaStepCount: number
): PixelResult {
  output.iter = iter;
  output.mag2 = mag2;
  output.glitch = glitch;
  output.unresolved = true;
  output.failureKind = "earlyReferenceEscape";
  output.survivedIter = survivedIter;
  output.periodicInterior = false;
  output.rebaseCount = rebaseCount;
  output.rebaseLimit = rebaseLimit;
  output.blaSkipCount = blaSkipCount;
  output.blaStepCount = blaStepCount;
  return output;
}

function createClusterAccumulators(rect: { x: number; y: number; width: number; height: number }): ClusterAccumulator[] {
  const cols = rect.width >= rect.height * 1.5 ? 8 : 4;
  const rows = 4;
  const clusters: ClusterAccumulator[] = [];
  for (let binY = 0; binY < rows; binY += 1) {
    for (let binX = 0; binX < cols; binX += 1) {
      clusters.push({
        binX,
        binY,
        bounds: {
          x: rect.x + (rect.width * binX) / cols,
          y: rect.y + (rect.height * binY) / rows,
          width: rect.width / cols,
          height: rect.height / rows
        },
        count: 0,
        sumX: 0,
        sumY: 0,
        minX: Number.POSITIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
        bestX: 0,
        bestY: 0,
        bestSurvivedIter: -1
      });
    }
  }
  return clusters;
}

function recordUnresolvedCluster(
  clusters: ClusterAccumulator[],
  rect: { x: number; y: number; width: number; height: number },
  screenX: number,
  screenY: number,
  survivedIter: number
): void {
  const cols = rect.width >= rect.height * 1.5 ? 8 : 4;
  const rows = 4;
  const binX = Math.max(0, Math.min(cols - 1, Math.floor(((screenX - rect.x) / Math.max(1, rect.width)) * cols)));
  const binY = Math.max(0, Math.min(rows - 1, Math.floor(((screenY - rect.y) / Math.max(1, rect.height)) * rows)));
  const index = binY * cols + binX;
  const cluster = clusters[index];
  cluster.count += 1;
  cluster.sumX += screenX;
  cluster.sumY += screenY;
  cluster.minX = Math.min(cluster.minX, screenX);
  cluster.minY = Math.min(cluster.minY, screenY);
  cluster.maxX = Math.max(cluster.maxX, screenX);
  cluster.maxY = Math.max(cluster.maxY, screenY);
  if (survivedIter > cluster.bestSurvivedIter) {
    cluster.bestSurvivedIter = survivedIter;
    cluster.bestX = screenX;
    cluster.bestY = screenY;
  }
}

function buildUnresolvedClusters(
  clusters: ClusterAccumulator[],
  rect: { x: number; y: number; width: number; height: number }
): UnresolvedCluster[] {
  const radiusPx = Math.max(0.5, Math.hypot(rect.width, rect.height) * 0.25);
  return clusters
    .filter((cluster) => cluster.count > 0)
    .map((cluster) => ({
      screenX: cluster.bestX || cluster.sumX / cluster.count,
      screenY: cluster.bestY || cluster.sumY / cluster.count,
      pixelCount: cluster.count,
      survivedIter: Math.max(0, cluster.bestSurvivedIter),
      radiusPx,
      binX: cluster.binX,
      binY: cluster.binY,
      bounds: clusterBounds(cluster)
    }))
    .sort((a, b) => b.pixelCount - a.pixelCount || b.survivedIter - a.survivedIter)
    .slice(0, 16);
}

function clusterBounds(cluster: ClusterAccumulator): { x: number; y: number; width: number; height: number } {
  if (
    !Number.isFinite(cluster.minX) ||
    !Number.isFinite(cluster.minY) ||
    !Number.isFinite(cluster.maxX) ||
    !Number.isFinite(cluster.maxY)
  ) {
    return cluster.bounds;
  }
  const left = Math.floor(cluster.minX);
  const top = Math.floor(cluster.minY);
  const right = Math.max(left + 1, Math.ceil(cluster.maxX));
  const bottom = Math.max(top + 1, Math.ceil(cluster.maxY));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function applyBoundarySmoothing(
  buffer: Uint8ClampedArray,
  smoothValues: Float32Array,
  escapedMask: Uint8Array,
  unresolvedMask: Uint8Array,
  width: number,
  height: number,
  rect: { x: number; y: number; width: number; height: number },
  pixelSpan: number,
  maxIter: number,
  seriesDegree: number,
  contexts: ReferenceContext[],
  scratch: PeriodicScratch,
  allowPeriodicInterior: boolean
): BoundaryStats {
  if (width <= 1 || height <= 1) return emptyBoundaryStats();
  const edgeStrengths = new Float32Array(width * height);
  const classificationChanges = new Uint8Array(width * height);
  const candidates: BoundaryCandidate[] = [];
  let boundaryDampenedCount = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (unresolvedMask[index] !== 0) continue;
      const edge = edgeStrengthAt(index, x, y, width, height, smoothValues, escapedMask, unresolvedMask);
      edgeStrengths[index] = edge.edgeStrength;
      if (edge.classificationChange) classificationChanges[index] = 1;
      if (edge.edgeStrength <= 0) continue;
      if (edge.edgeStrength >= AA_EDGE_THRESHOLD) {
        candidates.push({
          index,
          edgeStrength: edge.edgeStrength,
          classificationChange: edge.classificationChange
        });
      }
    }
  }

  candidates.sort(
    (a, b) => Number(b.classificationChange) - Number(a.classificationChange) || b.edgeStrength - a.edgeStrength || a.index - b.index
  );
  const aaLimit = Math.min(candidates.length, AA_PIXEL_CAP, Math.ceil(width * height * AA_PIXEL_FRACTION));
  const fourSampleLimit = Math.min(aaLimit, AA_FOUR_SAMPLE_CAP, Math.ceil(width * height * AA_FOUR_SAMPLE_FRACTION));
  let aaPixelCount = 0;
  let aaSampleCount = 0;
  let aaFallbackCount = 0;
  const supersampledMask = new Uint8Array(width * height);

  if (contexts.length > 0) {
    const pixelStepX = rect.width / width;
    const pixelStepY = rect.height / height;
    for (let candidateIndex = 0; candidateIndex < aaLimit; candidateIndex += 1) {
      const candidate = candidates[candidateIndex];
      const x = candidate.index % width;
      const y = Math.floor(candidate.index / width);
      const screenX = Math.min(rect.x + rect.width - 0.5 * pixelStepX, rect.x + (x + 0.5) * pixelStepX);
      const screenY = Math.min(rect.y + rect.height - 0.5 * pixelStepY, rect.y + (y + 0.5) * pixelStepY);
      const offsets = candidateIndex < fourSampleLimit ? FOUR_SAMPLE_OFFSETS : TWO_SAMPLE_OFFSETS;
      const sampleStats = supersamplePixel(
        buffer,
        candidate.index,
        screenX,
        screenY,
        pixelStepX,
        pixelStepY,
        offsets,
        pixelSpan,
        maxIter,
        seriesDegree,
        contexts,
        scratch,
        allowPeriodicInterior
      );
      aaPixelCount += 1;
      aaSampleCount += offsets.length;
      aaFallbackCount += sampleStats.fallbacks;
      supersampledMask[candidate.index] = 1;
    }
  }

  for (let index = 0; index < edgeStrengths.length; index += 1) {
    const edgeStrength = edgeStrengths[index];
    if (edgeStrength <= 0 || unresolvedMask[index] !== 0 || supersampledMask[index] !== 0) continue;
    const offset = index * 4;
    if (escapedMask[index] === 0) {
      if (classificationChanges[index] === 0) continue;
      if (blendInteriorBoundaryFromNeighbors(buffer, index, width, height, escapedMask, unresolvedMask)) {
        boundaryDampenedCount += 1;
      }
      continue;
    }
    const color = {
      r: buffer[offset],
      g: buffer[offset + 1],
      b: buffer[offset + 2]
    };
    writeColor(buffer, offset, dampenChroma(color, edgeStrength));
    boundaryDampenedCount += 1;
  }

  return { boundaryDampenedCount, aaPixelCount, aaSampleCount, aaFallbackCount };
}

function emptyBoundaryStats(): BoundaryStats {
  return { boundaryDampenedCount: 0, aaPixelCount: 0, aaSampleCount: 0, aaFallbackCount: 0 };
}

function edgeStrengthAt(
  index: number,
  x: number,
  y: number,
  width: number,
  height: number,
  smoothValues: Float32Array,
  escapedMask: Uint8Array,
  unresolvedMask: Uint8Array
): EdgeInfo {
  const escaped = escapedMask[index] !== 0;
  const smooth = smoothValues[index];
  let maxSmoothDelta = 0;
  let classificationChange = false;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
    const neighborIndex = ny * width + nx;
    if (unresolvedMask[neighborIndex] !== 0) continue;
    const neighborEscaped = escapedMask[neighborIndex] !== 0;
    if (neighborEscaped !== escaped) classificationChange = true;
    if (neighborEscaped && escaped) {
      maxSmoothDelta = Math.max(maxSmoothDelta, Math.abs(smooth - smoothValues[neighborIndex]));
    } else if (neighborEscaped || escaped) {
      maxSmoothDelta = Math.max(maxSmoothDelta, SMOOTH_DELTA_HIGH);
    }
  }
  const smoothEdge = clamp01((maxSmoothDelta - SMOOTH_DELTA_LOW) / (SMOOTH_DELTA_HIGH - SMOOTH_DELTA_LOW));
  return {
    edgeStrength: clamp01(smoothEdge + (classificationChange ? CLASSIFICATION_EDGE_BOOST : 0)),
    classificationChange
  };
}

function supersamplePixel(
  buffer: Uint8ClampedArray,
  pixelIndex: number,
  screenX: number,
  screenY: number,
  pixelStepX: number,
  pixelStepY: number,
  offsets: readonly (readonly [number, number])[],
  pixelSpan: number,
  maxIter: number,
  seriesDegree: number,
  contexts: ReferenceContext[],
  scratch: PeriodicScratch,
  allowPeriodicInterior: boolean
): { fallbacks: number } {
  const baseOffset = pixelIndex * 4;
  let linearR = srgbToLinear(buffer[baseOffset] / 255);
  let linearG = srgbToLinear(buffer[baseOffset + 1] / 255);
  let linearB = srgbToLinear(buffer[baseOffset + 2] / 255);
  let fallbacks = 0;

  for (const [offsetX, offsetY] of offsets) {
    const { result } = renderPixelWithReferences(
      screenX + offsetX * pixelStepX,
      screenY + offsetY * pixelStepY,
      pixelSpan,
      maxIter,
      seriesDegree,
      contexts,
      scratch,
      allowPeriodicInterior
    );
    const color = result.unresolved
      ? {
          r: buffer[baseOffset],
          g: buffer[baseOffset + 1],
          b: buffer[baseOffset + 2]
        }
      : colorForResult(result.iter, maxIter, result.mag2);
    if (result.unresolved) fallbacks += 1;
    linearR += srgbToLinear(color.r / 255);
    linearG += srgbToLinear(color.g / 255);
    linearB += srgbToLinear(color.b / 255);
  }

  const divisor = offsets.length + 1;
  writeColor(buffer, baseOffset, {
    r: Math.round(linearToSrgb(linearR / divisor) * 255),
    g: Math.round(linearToSrgb(linearG / divisor) * 255),
    b: Math.round(linearToSrgb(linearB / divisor) * 255)
  });
  return { fallbacks };
}

function blendInteriorBoundaryFromNeighbors(
  buffer: Uint8ClampedArray,
  pixelIndex: number,
  width: number,
  height: number,
  escapedMask: Uint8Array,
  unresolvedMask: Uint8Array
): boolean {
  const x = pixelIndex % width;
  const y = Math.floor(pixelIndex / width);
  const baseOffset = pixelIndex * 4;
  let linearR = srgbToLinear(buffer[baseOffset] / 255);
  let linearG = srgbToLinear(buffer[baseOffset + 1] / 255);
  let linearB = srgbToLinear(buffer[baseOffset + 2] / 255);
  let totalWeight = 1;
  let escapedNeighbors = 0;

  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const neighborIndex = ny * width + nx;
      if (unresolvedMask[neighborIndex] !== 0 || escapedMask[neighborIndex] === 0) continue;
      const neighborOffset = neighborIndex * 4;
      const weight = dx === 0 || dy === 0 ? 1 : 0.5;
      linearR += srgbToLinear(buffer[neighborOffset] / 255) * weight;
      linearG += srgbToLinear(buffer[neighborOffset + 1] / 255) * weight;
      linearB += srgbToLinear(buffer[neighborOffset + 2] / 255) * weight;
      totalWeight += weight;
      escapedNeighbors += 1;
    }
  }

  if (escapedNeighbors === 0) return false;
  writeColor(buffer, baseOffset, {
    r: Math.round(linearToSrgb(linearR / totalWeight) * 255),
    g: Math.round(linearToSrgb(linearG / totalWeight) * 255),
    b: Math.round(linearToSrgb(linearB / totalWeight) * 255)
  });
  return true;
}

function fillUnresolvedPreview(buffer: Uint8ClampedArray, unresolvedMask: Uint8Array, width: number, height: number): void {
  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixelIndex = y * width + x;
        if (unresolvedMask[pixelIndex] === 0) continue;
        let red = 0;
        let green = 0;
        let blue = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const neighborIndex = ny * width + nx;
            if (unresolvedMask[neighborIndex] !== 0) continue;
            const offset = neighborIndex * 4;
            red += buffer[offset];
            green += buffer[offset + 1];
            blue += buffer[offset + 2];
            count += 1;
          }
        }
        const offset = pixelIndex * 4;
        if (count > 0) {
          buffer[offset] = Math.round(red / count);
          buffer[offset + 1] = Math.round(green / count);
          buffer[offset + 2] = Math.round(blue / count);
          buffer[offset + 3] = 255;
          unresolvedMask[pixelIndex] = 0;
          changed = true;
        } else if (pass === 2) {
          buffer[offset] = 40;
          buffer[offset + 1] = 162;
          buffer[offset + 2] = 142;
          buffer[offset + 3] = 255;
        }
      }
    }
    if (!changed && pass === 2) break;
  }
}

function tileRadius(rect: { x: number; y: number; width: number; height: number }, reference: ReferenceSnapshot, pixelSpan: number): number {
  const corners = [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height]
  ];
  let radius = 0;
  for (const [x, y] of corners) {
    radius = Math.max(radius, Math.hypot(x - reference.screenX, y - reference.screenY) * pixelSpan);
  }
  return radius;
}

function tileProbeOffsets(rect: { x: number; y: number; width: number; height: number }, reference: ReferenceSnapshot, pixelSpan: number): Complex[] {
  const minX = rect.x + 0.5;
  const maxX = rect.x + Math.max(0.5, rect.width - 0.5);
  const minY = rect.y + 0.5;
  const maxY = rect.y + Math.max(0.5, rect.height - 0.5);
  const midX = rect.x + rect.width * 0.5;
  const midY = rect.y + rect.height * 0.5;
  return [
    [midX, midY],
    [minX, minY],
    [maxX, minY],
    [minX, maxY],
    [maxX, maxY],
    [midX, minY],
    [midX, maxY],
    [minX, midY],
    [maxX, midY]
  ].map(([screenX, screenY]) => ({
    re: (screenX - reference.screenX) * pixelSpan,
    im: (screenY - reference.screenY) * pixelSpan
  }));
}

function colorForResult(iter: number, maxIter: number, mag2: number): Color {
  if (iter >= maxIter) {
    return { r: 4, g: 8, b: 16 };
  }

  const smooth = smoothIteration(iter, maxIter, mag2);
  const index = paletteIndex(smooth);
  const offset = index * 3;
  return {
    r: COSINE_PALETTE[offset],
    g: COSINE_PALETTE[offset + 1],
    b: COSINE_PALETTE[offset + 2]
  };
}

function writeColorForSmooth(buffer: Uint8ClampedArray, offset: number, interior: boolean, smooth: number): void {
  if (interior) {
    buffer[offset] = 4;
    buffer[offset + 1] = 8;
    buffer[offset + 2] = 16;
    buffer[offset + 3] = 255;
    return;
  }

  const paletteOffset = paletteIndex(smooth) * 3;
  buffer[offset] = COSINE_PALETTE[paletteOffset];
  buffer[offset + 1] = COSINE_PALETTE[paletteOffset + 1];
  buffer[offset + 2] = COSINE_PALETTE[paletteOffset + 2];
  buffer[offset + 3] = 255;
}

function createCosinePalette(size: number): Uint8Array {
  const palette = new Uint8Array(size * 3);
  for (let index = 0; index < size; index += 1) {
    const t = index / size;
    const wave = (phase: number) => 0.5 + 0.5 * Math.cos(6.283185307179586 * (t + phase));
    const offset = index * 3;
    palette[offset] = clampByte(Math.round(255 * Math.pow(wave(0.95), 1.4)));
    palette[offset + 1] = clampByte(Math.round(255 * Math.pow(wave(0.58), 1.1)));
    palette[offset + 2] = clampByte(Math.round(255 * Math.pow(wave(0.22), 0.9)));
  }
  return palette;
}

function paletteIndex(smooth: number): number {
  const value = smooth * 0.018;
  const fraction = value - Math.floor(value);
  return Math.min(PALETTE_SIZE - 1, Math.max(0, Math.floor(fraction * PALETTE_SIZE)));
}

function smoothIteration(iter: number, maxIter: number, mag2: number): number {
  if (iter >= maxIter) return maxIter;
  return iter + 1 - Math.log(Math.max(1e-12, Math.log(Math.max(4, mag2)) * SMOOTH_LOG_SCALE)) * INV_LN2;
}

function dampenChroma(color: Color, edgeStrength: number): Color {
  const chromaScale = 1 - (1 - MIN_EDGE_CHROMA_SCALE) * clamp01(edgeStrength);
  const linearR = srgbToLinear(color.r / 255);
  const linearG = srgbToLinear(color.g / 255);
  const linearB = srgbToLinear(color.b / 255);
  const luma = 0.2126 * linearR + 0.7152 * linearG + 0.0722 * linearB;
  return {
    r: Math.round(linearToSrgb(luma + (linearR - luma) * chromaScale) * 255),
    g: Math.round(linearToSrgb(luma + (linearG - luma) * chromaScale) * 255),
    b: Math.round(linearToSrgb(luma + (linearB - luma) * chromaScale) * 255)
  };
}

function writeColor(buffer: Uint8ClampedArray, offset: number, color: Color): void {
  buffer[offset] = clampByte(color.r);
  buffer[offset + 1] = clampByte(color.g);
  buffer[offset + 2] = clampByte(color.b);
  buffer[offset + 3] = 255;
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  const clamped = clamp01(value);
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

function asFloat64(value: Float64Array | ArrayLike<number>): Float64Array {
  return value instanceof Float64Array ? value : Float64Array.from(value);
}
