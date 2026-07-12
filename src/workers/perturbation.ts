import { buildSeriesPlan, evaluateSeries, evaluateSeriesWithDerivative, type Complex } from "../math/series";
import type { FailureKind, ReferenceSnapshot, RenderTileMessage, TileDoneMessage, UnresolvedCluster } from "../types";

interface PixelResult {
  iter: number;
  mag2: number;
  distancePx: number;
  glitch: boolean;
  unresolved: boolean;
  failureKind: FailureKind;
  survivedIter: number;
  periodicInterior: boolean;
  rebaseCount: number;
  rebaseLimit: boolean;
  blaSkipCount: number;
  blaStepCount: number;
  seriesReplayed: boolean;
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

interface LinearColor {
  r: number;
  g: number;
  b: number;
}

interface PaletteFilterStats {
  paletteFootprintCount: number;
  paletteFootprintFallbackCount: number;
  paletteFilteredCount: number;
  paletteProxyCount: number;
  maxPaletteFootprint: number;
  maxPaletteProxyLod: number;
}

const SERIES_MAX_SKIP = 8192;
const SERIES_PIXEL_ERROR_SCALE = 0.25;
const ZERO_SERIES_PLAN: ReturnType<typeof buildSeriesPlan> = {
  skip: 0,
  degree: 0,
  errorBound: 0,
  radius: 0,
  coeffRe: new Float64Array(1),
  coeffIm: new Float64Array(1)
};
const DISTANCE_EXTRA_ITERATIONS = 1;
const INTERIOR_COLOR = { r: 4, g: 8, b: 16 } as const;
const PALETTE_SIZE = 2048;
const PALETTE_CYCLE_SCALE = 0.018;
const PALETTE_FILTER_LOW = 0.25;
const PALETTE_FILTER_HIGH = 0.5;
const PALETTE_PROXY_FILTER_LOW = 0.5;
const PALETTE_PROXY_FILTER_HIGH = 1.0;
const PALETTE_PROXY_TARGET_FOOTPRINT = 0.25;
const PALETTE_PROXY_STRENGTH = 0.25;
const PALETTE_PROXY_FADE_LOW = 32;
const PALETTE_PROXY_FADE_HIGH = 64;
const PALETTE_DIAGONAL_OFFSETS = [
  [-1, -1], [1, -1], [-1, 1], [1, 1]
] as const;
const COSINE_PALETTE = createCosinePalette(PALETTE_SIZE);
const SRGB_TO_LINEAR_LUT = createSrgbToLinearLut();
const PALETTE_LINEAR_SAMPLES = createLinearPaletteSamples(COSINE_PALETTE);
const PALETTE_LINEAR_PREFIX = createLinearPalettePrefix(PALETTE_LINEAR_SAMPLES);
const PALETTE_LINEAR_MEAN = paletteLinearMean();
const INV_LN2 = 1 / Math.LN2;
const SMOOTH_LOG_SCALE = 0.5 * INV_LN2;

export function renderPerturbationTile(message: RenderTileMessage): TileDoneMessage {
  const started = performance.now();
  const { tile, pixelSpan, maxIter, seriesDegree } = message;
  const sampleStep = message.renderMode === "preview" ? Math.max(1, Math.floor(message.sampleStep)) : 1;
  const width = Math.max(1, Math.ceil(tile.rect.width / sampleStep));
  const height = Math.max(1, Math.ceil(tile.rect.height / sampleStep));
  const rgba = new Uint8ClampedArray(width * height * 4);
  const contexts = message.reference ? [message.reference].map((reference) => {
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
  }) : [];
  const scratch: PeriodicScratch = {
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
  let seriesReplayPixels = 0;
  let unresolvedScreenXSum = 0;
  let unresolvedScreenYSum = 0;
  let seriesSkip = 0;
  const usedReferenceIndices = new Uint8Array(contexts.length);
  const clusters = createClusterAccumulators(tile.rect);
  const unresolvedMask = new Uint8Array(width * height);
  const escapedMask = message.renderMode === "final" ? new Uint8Array(width * height) : undefined;
  const smoothValues = message.renderMode === "final" ? new Float32Array(width * height) : undefined;
  const paletteFootprints = message.renderMode === "final" ? new Float32Array(width * height).fill(-1) : undefined;
  const screenXs = new Float64Array(width);
  const screenYs = new Float64Array(height);
  for (let px = 0; px < width; px += 1) {
    screenXs[px] = Math.min(tile.rect.x + tile.rect.width - 0.5, tile.rect.x + (px + 0.5) * sampleStep);
  }
  for (let py = 0; py < height; py += 1) {
    screenYs[py] = Math.min(tile.rect.y + tile.rect.height - 0.5, tile.rect.y + (py + 0.5) * sampleStep);
  }
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
        false
      );
      const offset = pixelIndex * 4;
      if (result.iter < maxIter) escapedPixels += 1;
      if (result.periodicInterior) periodicInteriorCount += 1;
      rebaseCount += result.rebaseCount;
      if (result.rebaseLimit) rebaseLimitCount += 1;
      blaSkipCount += result.blaSkipCount;
      blaStepCount += result.blaStepCount;
      if (result.seriesReplayed) seriesReplayPixels += 1;
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

  const paletteFootprintFallbackCount = message.renderMode === "final"
    ? estimatePaletteFootprintsFromSmooth(
      paletteFootprints!,
      smoothValues!,
      escapedMask!,
      unresolvedMask,
      width,
      height
    )
    : 0;

  const paletteFilterStats = message.renderMode === "final"
    ? applyBandlimitedPaletteShading(
        rgba,
        smoothValues!,
        paletteFootprints!,
        escapedMask!,
        unresolvedMask,
        width,
        height
      )
    : emptyPaletteFilterStats();
  paletteFilterStats.paletteFootprintFallbackCount = paletteFootprintFallbackCount;

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
      seriesReplayPixels,
      paletteFootprintCount: paletteFilterStats.paletteFootprintCount,
      paletteFootprintFallbackCount: paletteFilterStats.paletteFootprintFallbackCount,
      paletteFilteredCount: paletteFilterStats.paletteFilteredCount,
      paletteProxyCount: paletteFilterStats.paletteProxyCount,
      maxPaletteFootprint: paletteFilterStats.maxPaletteFootprint,
      maxPaletteProxyLod: paletteFilterStats.maxPaletteProxyLod,
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
  computeDistance: boolean
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
    const series = seriesForContext(context, seriesDegree, pixelSpan);
    const result = perturb(
      cRe,
      cIm,
      pixelSpan,
      context.orbitRe,
      context.orbitIm,
      maxIter,
      series,
      computeDistance,
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
    distancePx: -1,
    glitch: false,
    unresolved: false,
    failureKind: "earlyReferenceEscape",
    survivedIter: 0,
    periodicInterior: false,
    rebaseCount: 0,
    rebaseLimit: false,
    blaSkipCount: 0,
    blaStepCount: 0,
    seriesReplayed: false
  };
}

function copyPixelResult(source: PixelResult, target: PixelResult): void {
  target.iter = source.iter;
  target.mag2 = source.mag2;
  target.distancePx = source.distancePx;
  target.glitch = source.glitch;
  target.unresolved = source.unresolved;
  target.failureKind = source.failureKind;
  target.survivedIter = source.survivedIter;
  target.periodicInterior = source.periodicInterior;
  target.rebaseCount = source.rebaseCount;
  target.rebaseLimit = source.rebaseLimit;
  target.blaSkipCount = source.blaSkipCount;
  target.blaStepCount = source.blaStepCount;
  target.seriesReplayed = source.seriesReplayed;
}

function seriesForContext(context: ReferenceContext, seriesDegree: number, pixelSpan: number): ReturnType<typeof buildSeriesPlan> {
  if (!context.series) {
    context.series = buildSeriesPlan(
      context.orbitRe,
      context.orbitIm,
      seriesDegree,
      SERIES_MAX_SKIP,
      context.radius,
      pixelSpan,
      context.probes
    );
  }
  return context.series;
}

function perturb(
  cRe: number,
  cIm: number,
  pixelSpan: number,
  orbitRe: Float64Array,
  orbitIm: Float64Array,
  maxIter: number,
  series: ReturnType<typeof buildSeriesPlan>,
  computeDistance: boolean,
  scratch: PeriodicScratch,
  output: PixelResult,
  allowSeriesReplay = true
): PixelResult {
  let dzRe = 0;
  let dzIm = 0;
  let iter = 0;
  let refIndex = 0;
  let mag2 = 0;
  let derivativeRe = 0;
  let derivativeIm = 0;
  let glitch = false;
  let rebaseCount = 0;
  let rebaseLimit = false;
  let blaSkipCount = 0;
  let blaStepCount = 0;
  const radiusRatio = series.radius > 0 ? Math.min(1, Math.hypot(cRe, cIm) / series.radius) : 0;
  const parameterError = series.errorBound * radiusRatio ** (series.degree + 1);

  if (series.skip > 0) {
    if (computeDistance) {
      const dz = evaluateSeriesWithDerivative(series, cRe, cIm);
      dzRe = dz.value.re;
      dzIm = dz.value.im;
      derivativeRe = dz.derivative.re * pixelSpan;
      derivativeIm = dz.derivative.im * pixelSpan;
    } else {
      const dz = evaluateSeries(series, cRe, cIm);
      dzRe = dz.re;
      dzIm = dz.im;
    }
    iter = series.skip;
    refIndex = series.skip;
  }

  const limit = Math.min(maxIter, orbitRe.length - 1);
  if (limit < 0 || refIndex > limit) {
    return failureResult(output, maxIter, mag2, true, Math.max(0, limit), rebaseCount, rebaseLimit, blaSkipCount, blaStepCount);
  }
  if (
    allowSeriesReplay &&
    series.skip > 0 &&
    (!Number.isFinite(parameterError) || parameterError > Math.abs(pixelSpan) * SERIES_PIXEL_ERROR_SCALE)
  ) {
    return replayWithoutSeries(
      cRe,
      cIm,
      pixelSpan,
      orbitRe,
      orbitIm,
      maxIter,
      computeDistance,
      scratch,
      output
    );
  }

  while (iter <= maxIter && refIndex <= limit) {
    const refRe = orbitRe[refIndex];
    const refIm = orbitIm[refIndex];

    const zRe = refRe + dzRe;
    const zIm = refIm + dzIm;
    if (!Number.isFinite(zRe) || !Number.isFinite(zIm)) {
      glitch = true;
      break;
    }
    const zNorm = Math.max(Math.abs(zRe), Math.abs(zIm));
    if (zNorm > 2) {
      mag2 = zRe * zRe + zIm * zIm;
      return successResult(
        output,
        iter,
        mag2,
        computeDistance
          ? refinedDistanceEstimatePx(
              zRe,
              zIm,
              derivativeRe,
              derivativeIm,
              (orbitRe[1] ?? 0) + cRe,
              (orbitIm[1] ?? 0) + cIm,
              pixelSpan
            )
          : -1,
        glitch,
        false,
        rebaseCount,
        rebaseLimit,
        blaSkipCount,
        blaStepCount
      );
    }
    if (iter >= maxIter) return successResult(output, maxIter, mag2, -1, false, false, rebaseCount, rebaseLimit, blaSkipCount, blaStepCount);

    const dzNormBeforeStep = Math.max(Math.abs(dzRe), Math.abs(dzIm));
    let stepRefRe = refRe;
    let stepRefIm = refIm;
    if (
      refIndex > 0 && (zNorm < dzNormBeforeStep || refIndex === limit)
    ) {
      dzRe = zRe;
      dzIm = zIm;
      refIndex = 0;
      stepRefRe = orbitRe[0] ?? 0;
      stepRefIm = orbitIm[0] ?? 0;
      rebaseCount += 1;
    }

    const nextDerivativeRe = computeDistance ? 2 * (zRe * derivativeRe - zIm * derivativeIm) + pixelSpan : 0;
    const nextDerivativeIm = computeDistance ? 2 * (zRe * derivativeIm + zIm * derivativeRe) : 0;
    const dz2Re = dzRe * dzRe - dzIm * dzIm;
    const dz2Im = 2 * dzRe * dzIm;
    const twoRefDzRe = 2 * (stepRefRe * dzRe - stepRefIm * dzIm);
    const twoRefDzIm = 2 * (stepRefRe * dzIm + stepRefIm * dzRe);
    dzRe = twoRefDzRe + dz2Re + cRe;
    dzIm = twoRefDzIm + dz2Im + cIm;
    derivativeRe = nextDerivativeRe;
    derivativeIm = nextDerivativeIm;
    iter += 1;
    refIndex += 1;

    if (!Number.isFinite(dzRe) || !Number.isFinite(dzIm)) {
      glitch = true;
      break;
    }
  }

  if (glitch || iter < maxIter) {
    return failureResult(output, maxIter, mag2, true, Math.min(iter, maxIter), rebaseCount, rebaseLimit, blaSkipCount, blaStepCount);
  }
  return successResult(output, maxIter, mag2, -1, false, false, rebaseCount, rebaseLimit, blaSkipCount, blaStepCount);
}

function replayWithoutSeries(
  cRe: number,
  cIm: number,
  pixelSpan: number,
  orbitRe: Float64Array,
  orbitIm: Float64Array,
  maxIter: number,
  computeDistance: boolean,
  scratch: PeriodicScratch,
  output: PixelResult
): PixelResult {
  const result = perturb(
    cRe,
    cIm,
    pixelSpan,
    orbitRe,
    orbitIm,
    maxIter,
    ZERO_SERIES_PLAN,
    computeDistance,
    scratch,
    output,
    false
  );
  result.seriesReplayed = true;
  return result;
}

function successResult(
  output: PixelResult,
  iter: number,
  mag2: number,
  distancePx: number,
  glitch: boolean,
  periodicInterior: boolean,
  rebaseCount: number,
  rebaseLimit: boolean,
  blaSkipCount: number,
  blaStepCount: number
): PixelResult {
  output.iter = iter;
  output.mag2 = mag2;
  output.distancePx = distancePx;
  output.glitch = glitch;
  output.unresolved = false;
  output.failureKind = "earlyReferenceEscape";
  output.survivedIter = iter;
  output.periodicInterior = periodicInterior;
  output.rebaseCount = rebaseCount;
  output.rebaseLimit = rebaseLimit;
  output.blaSkipCount = blaSkipCount;
  output.blaStepCount = blaStepCount;
  output.seriesReplayed = false;
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
  output.distancePx = -1;
  output.glitch = glitch;
  output.unresolved = true;
  output.failureKind = "earlyReferenceEscape";
  output.survivedIter = survivedIter;
  output.periodicInterior = false;
  output.rebaseCount = rebaseCount;
  output.rebaseLimit = rebaseLimit;
  output.blaSkipCount = blaSkipCount;
  output.blaStepCount = blaStepCount;
  output.seriesReplayed = false;
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

function applyBandlimitedPaletteShading(
  buffer: Uint8ClampedArray,
  smoothValues: Float32Array,
  paletteFootprints: Float32Array,
  escapedMask: Uint8Array,
  unresolvedMask: Uint8Array,
  width: number,
  height: number
): PaletteFilterStats {
  const pixelCount = width * height;
  if (pixelCount === 0 || smoothValues.length < pixelCount || paletteFootprints.length < pixelCount) return emptyPaletteFilterStats();
  let paletteFootprintCount = 0;
  let paletteFilteredCount = 0;
  let paletteProxyCount = 0;
  let maxPaletteFootprint = 0;
  let maxPaletteProxyLod = 0;

  for (let index = 0; index < pixelCount; index += 1) {
    if (unresolvedMask[index] !== 0 || escapedMask[index] === 0) continue;
    const footprint = paletteFootprints[index];
    if (!Number.isFinite(footprint) || footprint < 0) continue;
    paletteFootprintCount += 1;
    maxPaletteFootprint = Math.max(maxPaletteFootprint, footprint);

    const filterAmount = smoothstep(PALETTE_FILTER_LOW, PALETTE_FILTER_HIGH, footprint);
    if (filterAmount <= 0) continue;
    const offset = index * 4;
    let color = blendLinearColor(
      byteColorToLinear({
        r: buffer[offset],
        g: buffer[offset + 1],
        b: buffer[offset + 2]
      }),
      integratedPaletteLinearColor(smoothValues[index], footprint),
      filterAmount
    );
    paletteFilteredCount += 1;

    const proxyAmount = paletteProxyWeight(footprint);
    if (proxyAmount > 0) {
      const { color: proxyColor, lod } = paletteProxyLinearColor(smoothValues[index], footprint);
      color = addPaletteProxyResidual(color, proxyColor, proxyAmount * PALETTE_PROXY_STRENGTH);
      paletteProxyCount += 1;
      maxPaletteProxyLod = Math.max(maxPaletteProxyLod, lod);
    }
    writeLinearColor(buffer, offset, color);
  }

  return {
    paletteFootprintCount,
    paletteFootprintFallbackCount: 0,
    paletteFilteredCount,
    paletteProxyCount,
    maxPaletteFootprint,
    maxPaletteProxyLod
  };
}

function estimatePaletteFootprintsFromSmooth(
  paletteFootprints: Float32Array,
  smoothValues: Float32Array,
  escapedMask: Uint8Array,
  unresolvedMask: Uint8Array,
  width: number,
  height: number
): number {
  let fallbackCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (escapedMask[index] === 0 || unresolvedMask[index] !== 0) continue;
      const center = smoothValues[index];
      const neighbor = (nx: number, ny: number): number | undefined => {
        const neighborIndex = ny * width + nx;
        return escapedMask[neighborIndex] !== 0 && unresolvedMask[neighborIndex] === 0
          ? smoothValues[neighborIndex]
          : undefined;
      };
      const left = x > 0 ? neighbor(x - 1, y) : undefined;
      const right = x + 1 < width ? neighbor(x + 1, y) : undefined;
      const top = y > 0 ? neighbor(x, y - 1) : undefined;
      const bottom = y + 1 < height ? neighbor(x, y + 1) : undefined;
      const gradientX = Math.max(
        left === undefined ? 0 : Math.abs(center - left),
        right === undefined ? 0 : Math.abs(right - center)
      );
      const gradientY = Math.max(
        top === undefined ? 0 : Math.abs(center - top),
        bottom === undefined ? 0 : Math.abs(bottom - center)
      );
      let gradient = Math.hypot(gradientX, gradientY);
      let neighborCount = Number(left !== undefined) + Number(right !== undefined)
        + Number(top !== undefined) + Number(bottom !== undefined);
      for (const [dx, dy] of PALETTE_DIAGONAL_OFFSETS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const sample = neighbor(nx, ny);
        if (sample === undefined) continue;
        gradient = Math.max(gradient, Math.abs(sample - center) * Math.SQRT1_2);
        neighborCount += 1;
      }
      if (neighborCount === 0) {
        paletteFootprints[index] = 1;
        fallbackCount += 1;
      } else {
        paletteFootprints[index] = paletteFootprintFromGradient(gradient);
      }
    }
  }
  return fallbackCount;
}

function emptyPaletteFilterStats(): PaletteFilterStats {
  return {
    paletteFootprintCount: 0,
    paletteFootprintFallbackCount: 0,
    paletteFilteredCount: 0,
    paletteProxyCount: 0,
    maxPaletteFootprint: 0,
    maxPaletteProxyLod: 0
  };
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

function writeColorForSmooth(buffer: Uint8ClampedArray, offset: number, interior: boolean, smooth: number): void {
  if (interior) {
    buffer[offset] = INTERIOR_COLOR.r;
    buffer[offset + 1] = INTERIOR_COLOR.g;
    buffer[offset + 2] = INTERIOR_COLOR.b;
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

function createSrgbToLinearLut(): Float64Array {
  return Float64Array.from({ length: 256 }, (_, value) => srgbToLinear(value / 255));
}

function createLinearPaletteSamples(palette: Uint8Array): Float64Array {
  return Float64Array.from(palette, (value) => SRGB_TO_LINEAR_LUT[value]);
}

function createLinearPalettePrefix(linearPalette: Float64Array): Float64Array {
  const prefix = new Float64Array((PALETTE_SIZE + 1) * 3);
  for (let index = 0; index < PALETTE_SIZE; index += 1) {
    const source = index * 3;
    const previous = index * 3;
    const next = (index + 1) * 3;
    prefix[next] = prefix[previous] + linearPalette[source] / PALETTE_SIZE;
    prefix[next + 1] = prefix[previous + 1] + linearPalette[source + 1] / PALETTE_SIZE;
    prefix[next + 2] = prefix[previous + 2] + linearPalette[source + 2] / PALETTE_SIZE;
  }
  return prefix;
}

function integratedPaletteLinearColor(smooth: number, footprint: number): LinearColor {
  const width = Math.max(footprint, Number.EPSILON);
  const center = smooth * PALETTE_CYCLE_SCALE;
  const low = center - width * 0.5;
  const high = center + width * 0.5;
  return {
    r: (paletteIntegral(high, 0) - paletteIntegral(low, 0)) / width,
    g: (paletteIntegral(high, 1) - paletteIntegral(low, 1)) / width,
    b: (paletteIntegral(high, 2) - paletteIntegral(low, 2)) / width
  };
}

function paletteLinearMean(): LinearColor {
  const offset = PALETTE_SIZE * 3;
  return {
    r: PALETTE_LINEAR_PREFIX[offset],
    g: PALETTE_LINEAR_PREFIX[offset + 1],
    b: PALETTE_LINEAR_PREFIX[offset + 2]
  };
}

function paletteProxyWeight(footprint: number): number {
  const activation = smoothstep(PALETTE_PROXY_FILTER_LOW, PALETTE_PROXY_FILTER_HIGH, footprint);
  const extremeFade = 1 - smoothstep(PALETTE_PROXY_FADE_LOW, PALETTE_PROXY_FADE_HIGH, footprint);
  return activation * extremeFade;
}

function paletteProxyLinearColor(smooth: number, footprint: number): { color: LinearColor; lod: number } {
  const phase = smooth * PALETTE_CYCLE_SCALE;
  const lod = Math.max(1, Math.log2(Math.max(footprint, Number.EPSILON) / PALETTE_PROXY_TARGET_FOOTPRINT));
  const lowLevel = Math.floor(lod);
  const levelBlend = lod - lowLevel;
  const lowColor = paletteLinearColorAtPhase(phase / 2 ** lowLevel);
  const highColor = paletteLinearColorAtPhase(phase / 2 ** (lowLevel + 1));
  return { color: blendLinearColor(lowColor, highColor, levelBlend), lod };
}

function paletteLinearColorAtPhase(phase: number): LinearColor {
  const fraction = phase - Math.floor(phase);
  const index = Math.min(PALETTE_SIZE - 1, Math.max(0, Math.floor(fraction * PALETTE_SIZE)));
  const offset = index * 3;
  return {
    r: PALETTE_LINEAR_SAMPLES[offset],
    g: PALETTE_LINEAR_SAMPLES[offset + 1],
    b: PALETTE_LINEAR_SAMPLES[offset + 2]
  };
}

function addPaletteProxyResidual(base: LinearColor, proxy: LinearColor, amount: number): LinearColor {
  return {
    r: clamp01(base.r + (proxy.r - PALETTE_LINEAR_MEAN.r) * amount),
    g: clamp01(base.g + (proxy.g - PALETTE_LINEAR_MEAN.g) * amount),
    b: clamp01(base.b + (proxy.b - PALETTE_LINEAR_MEAN.b) * amount)
  };
}

export function sampleIntegratedPaletteForTests(smooth: number, footprint: number): readonly [number, number, number] {
  const color = integratedPaletteLinearColor(smooth, footprint);
  return [linearChannelToByte(color.r), linearChannelToByte(color.g), linearChannelToByte(color.b)] as const;
}

export function paletteFilterWeightForTests(footprint: number): number {
  return smoothstep(PALETTE_FILTER_LOW, PALETTE_FILTER_HIGH, footprint);
}

export function paletteProxyWeightForTests(footprint: number): number {
  return paletteProxyWeight(footprint);
}

export function paletteProxyLodForTests(footprint: number): number {
  return paletteProxyLinearColor(0, footprint).lod;
}

export function paletteFootprintFromGradientForTests(gradientX: number, gradientY: number): number {
  return paletteFootprintFromGradient(Math.hypot(gradientX, gradientY));
}

export function estimatePaletteFootprintsForTests(
  smoothValues: Float32Array,
  escapedMask: Uint8Array,
  unresolvedMask: Uint8Array,
  width: number,
  height: number
): { footprints: Float32Array; fallbackCount: number } {
  const footprints = new Float32Array(width * height);
  const fallbackCount = estimatePaletteFootprintsFromSmooth(
    footprints,
    smoothValues,
    escapedMask,
    unresolvedMask,
    width,
    height
  );
  return { footprints, fallbackCount };
}

export function samplePaletteForTests(smooth: number): readonly [number, number, number] {
  const offset = paletteIndex(smooth) * 3;
  return [COSINE_PALETTE[offset], COSINE_PALETTE[offset + 1], COSINE_PALETTE[offset + 2]] as const;
}

export function shadePaletteFootprintForTests(smooth: number, footprint: number): readonly [number, number, number] {
  const buffer = new Uint8ClampedArray(4);
  writeColorForSmooth(buffer, 0, false, smooth);
  applyBandlimitedPaletteShading(
    buffer,
    Float32Array.of(smooth),
    Float32Array.of(footprint),
    Uint8Array.of(1),
    Uint8Array.of(0),
    1,
    1
  );
  return [buffer[0], buffer[1], buffer[2]] as const;
}

function paletteIntegral(position: number, channel: 0 | 1 | 2): number {
  const cycle = Math.floor(position);
  const fraction = position - cycle;
  const scaled = fraction * PALETTE_SIZE;
  const index = Math.min(PALETTE_SIZE - 1, Math.floor(scaled));
  const remainder = scaled - index;
  const cycleIntegral = PALETTE_LINEAR_PREFIX[PALETTE_SIZE * 3 + channel];
  const prefix = PALETTE_LINEAR_PREFIX[index * 3 + channel];
  const sample = PALETTE_LINEAR_SAMPLES[index * 3 + channel];
  return cycle * cycleIntegral + prefix + sample * remainder / PALETTE_SIZE;
}

function paletteIndex(smooth: number): number {
  const value = smooth * PALETTE_CYCLE_SCALE;
  const fraction = value - Math.floor(value);
  return Math.min(PALETTE_SIZE - 1, Math.max(0, Math.floor(fraction * PALETTE_SIZE)));
}

function paletteFootprintFromGradient(gradient: number): number {
  if (gradient === Number.POSITIVE_INFINITY) return 1;
  return Number.isFinite(gradient) && gradient > Number.EPSILON ? PALETTE_CYCLE_SCALE * gradient : 0;
}

function smoothIteration(iter: number, maxIter: number, mag2: number): number {
  if (iter >= maxIter) return maxIter;
  return iter + 1 - Math.log(Math.max(1e-12, Math.log(Math.max(4, mag2)) * SMOOTH_LOG_SCALE)) * INV_LN2;
}

function distanceEstimatePx(mag2: number, derivativeRe: number, derivativeIm: number): number {
  if (!Number.isFinite(mag2) || mag2 <= 4) return -1;
  const zAbs = Math.sqrt(mag2);
  const derivativeAbs = Math.hypot(derivativeRe, derivativeIm);
  if (!Number.isFinite(zAbs) || !Number.isFinite(derivativeAbs) || derivativeAbs <= 0) return -1;
  const distance = (zAbs * Math.log(zAbs)) / derivativeAbs;
  return Number.isFinite(distance) && distance >= 0 ? distance : -1;
}

function refinedDistanceEstimatePx(
  zRe: number,
  zIm: number,
  derivativeRe: number,
  derivativeIm: number,
  cRe: number,
  cIm: number,
  pixelSpan: number
): number {
  let currentZRe = zRe;
  let currentZIm = zIm;
  let currentDerivativeRe = derivativeRe;
  let currentDerivativeIm = derivativeIm;
  let mag2 = currentZRe * currentZRe + currentZIm * currentZIm;
  if (!Number.isFinite(mag2) || !Number.isFinite(cRe) || !Number.isFinite(cIm)) {
    return distanceEstimatePx(mag2, currentDerivativeRe, currentDerivativeIm);
  }
  for (let index = 0; index < DISTANCE_EXTRA_ITERATIONS; index += 1) {
    const nextDerivativeRe = 2 * (currentZRe * currentDerivativeRe - currentZIm * currentDerivativeIm) + pixelSpan;
    const nextDerivativeIm = 2 * (currentZRe * currentDerivativeIm + currentZIm * currentDerivativeRe);
    const nextZRe = currentZRe * currentZRe - currentZIm * currentZIm + cRe;
    const nextZIm = 2 * currentZRe * currentZIm + cIm;
    const nextMag2 = nextZRe * nextZRe + nextZIm * nextZIm;
    if (!Number.isFinite(nextMag2) || !Number.isFinite(nextDerivativeRe) || !Number.isFinite(nextDerivativeIm)) break;
    currentZRe = nextZRe;
    currentZIm = nextZIm;
    currentDerivativeRe = nextDerivativeRe;
    currentDerivativeIm = nextDerivativeIm;
    mag2 = nextMag2;
    if (mag2 > 1e64) break;
  }
  return distanceEstimatePx(mag2, currentDerivativeRe, currentDerivativeIm);
}

function blendLinearColor(from: LinearColor, to: LinearColor, amount: number): LinearColor {
  const t = clamp01(amount);
  return {
    r: from.r + (to.r - from.r) * t,
    g: from.g + (to.g - from.g) * t,
    b: from.b + (to.b - from.b) * t
  };
}

function byteColorToLinear(color: Color): LinearColor {
  return {
    r: SRGB_TO_LINEAR_LUT[color.r],
    g: SRGB_TO_LINEAR_LUT[color.g],
    b: SRGB_TO_LINEAR_LUT[color.b]
  };
}

function writeLinearColor(buffer: Uint8ClampedArray, offset: number, color: LinearColor): void {
  buffer[offset] = linearChannelToByte(color.r);
  buffer[offset + 1] = linearChannelToByte(color.g);
  buffer[offset + 2] = linearChannelToByte(color.b);
  buffer[offset + 3] = 255;
}

function linearChannelToByte(value: number): number {
  return clampByte(linearToSrgb(value) * 255);
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

function smoothstep(low: number, high: number, value: number): number {
  if (!(high > low)) return value >= high ? 1 : 0;
  const t = clamp01((value - low) / (high - low));
  return t * t * (3 - 2 * t);
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

function asFloat64(value: Float64Array | ArrayLike<number>): Float64Array {
  return value instanceof Float64Array ? value : Float64Array.from(value);
}
