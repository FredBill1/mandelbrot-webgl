import { buildSeriesPlan, evaluateSeries } from "../math/series";
import type { ReferenceSnapshot, RenderTileMessage, TileDoneMessage, UnresolvedCluster } from "../types";

interface PixelResult {
  iter: number;
  mag2: number;
  glitch: boolean;
  unresolved: boolean;
  survivedIter: number;
  periodicInterior: boolean;
  rebaseCount: number;
  rebaseLimit: boolean;
  blaSkipCount: number;
  blaStepCount: number;
}

interface ReferenceContext {
  reference: ReferenceSnapshot;
  orbitRe: Float64Array;
  orbitIm: Float64Array;
  series: ReturnType<typeof buildSeriesPlan>;
  bla: BlaTable | undefined;
}

interface PeriodicScratch {
  checkpointRe: Float64Array;
  checkpointIm: Float64Array;
  checkpointIter: Int32Array;
}

interface BlaLevel {
  skip: number;
  ar: Float64Array;
  ai: Float64Array;
  br: Float64Array;
  bi: Float64Array;
  radius: Float64Array;
  maxRefMag2: Float64Array;
}

type BlaTable = BlaLevel[];

interface ClusterAccumulator {
  binX: number;
  binY: number;
  bounds: { x: number; y: number; width: number; height: number };
  count: number;
  sumX: number;
  sumY: number;
  bestX: number;
  bestY: number;
  bestSurvivedIter: number;
}

const MIN_PIXEL_SPAN_FOR_PERIODIC_INTERIOR = 1e-18;
const REBASE_G = 1e-8;
const MAX_REBASES_PER_PIXEL = 64;
const MAX_BLA_TILE_RADIUS = 1e-3;
const BLA_CACHE_LIMIT = 512;
const BLA_EPSILON = 1e-5;
const blaCache = new Map<string, BlaTable>();

export function renderPerturbationTile(message: RenderTileMessage): TileDoneMessage {
  const started = performance.now();
  const { tile, pixelSpan, maxIter, seriesDegree } = message;
  const sampleStep = message.renderMode === "preview" ? Math.max(1, Math.floor(message.sampleStep)) : 1;
  const width = Math.max(1, Math.ceil(tile.rect.width / sampleStep));
  const height = Math.max(1, Math.ceil(tile.rect.height / sampleStep));
  const rgba = new Uint8ClampedArray(width * height * 4);
  const contexts = message.references.filter(isReferenceSnapshot).map((reference) => {
    const orbitRe = asFloat64(reference.orbitRe);
    const orbitIm = asFloat64(reference.orbitIm);
    const radius = tileRadius(tile.rect, reference, pixelSpan);
    return {
      reference,
      orbitRe,
      orbitIm,
      series: buildSeriesPlan(orbitRe, orbitIm, seriesDegree, 64, radius),
      bla: getBlaTable(reference.id, orbitRe, orbitIm, radius)
    } satisfies ReferenceContext;
  });
  const scratch: PeriodicScratch = {
    checkpointRe: new Float64Array(32),
    checkpointIm: new Float64Array(32),
    checkpointIter: new Int32Array(32)
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
  const usedReferenceIds = new Set<string>();
  const clusters = createClusterAccumulators(tile.rect);
  const unresolvedMask = new Uint8Array(width * height);

  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      const screenX = Math.min(tile.rect.x + tile.rect.width - 0.5, tile.rect.x + (px + 0.5) * sampleStep);
      const screenY = Math.min(tile.rect.y + tile.rect.height - 0.5, tile.rect.y + (py + 0.5) * sampleStep);
      const { result, referenceId, skip } = renderPixelWithReferences(screenX, screenY, pixelSpan, maxIter, contexts, scratch);
      const offset = (py * width + px) * 4;
      if (result.iter < maxIter) escapedPixels += 1;
      if (result.periodicInterior) periodicInteriorCount += 1;
      rebaseCount += result.rebaseCount;
      if (result.rebaseLimit) rebaseLimitCount += 1;
      blaSkipCount += result.blaSkipCount;
      blaStepCount += result.blaStepCount;
      if (result.glitch) glitchCount += 1;
      if (referenceId) usedReferenceIds.add(referenceId);
      seriesSkip = Math.max(seriesSkip, skip);
      if (result.unresolved) {
        unresolvedCount += 1;
        unresolvedScreenXSum += screenX;
        unresolvedScreenYSum += screenY;
        unresolvedMask[py * width + px] = 1;
        recordUnresolvedCluster(clusters, tile.rect, screenX, screenY, result.survivedIter);
      }
      colorPixel(rgba, offset, result.iter, maxIter, result.mag2);
    }
  }

  if (unresolvedCount > 0) fillUnresolvedPreview(rgba, unresolvedMask, width, height);

  const unresolvedScreenX = unresolvedCount > 0 ? unresolvedScreenXSum / unresolvedCount : undefined;
  const unresolvedScreenY = unresolvedCount > 0 ? unresolvedScreenYSum / unresolvedCount : undefined;
  const unresolvedClusters = buildUnresolvedClusters(clusters, tile.rect);
  const referenceIdsUsed = [...usedReferenceIds];

  return {
    type: "tileDone",
    tileId: tile.id,
    revision: tile.revision,
    rect: tile.rect,
    width,
    height,
    rgba: rgba.buffer,
    needsReference: unresolvedClusters.length > 0,
    stats: {
      elapsedMs: performance.now() - started,
      glitchCount,
      unresolvedCount,
      escapedPixels,
      periodicInteriorCount,
      rebaseCount,
      rebaseLimitCount,
      blaSkipCount,
      blaStepCount,
      referenceCacheMissCount: 0,
      seriesSkip,
      referenceId: referenceIdsUsed[0] ?? contexts[0]?.reference.id ?? "",
      referenceIdsUsed,
      unresolvedScreenX,
      unresolvedScreenY,
      unresolvedClusters,
      preview: message.renderMode === "preview",
      renderMode: message.renderMode
    }
  };
}

function renderPixelWithReferences(
  screenX: number,
  screenY: number,
  pixelSpan: number,
  maxIter: number,
  contexts: ReferenceContext[],
  scratch: PeriodicScratch
): { result: PixelResult; referenceId: string | undefined; skip: number } {
  let bestUnresolved: PixelResult | undefined;
  let bestUnresolvedReferenceId: string | undefined;
  let maxSkip = 0;

  for (const context of contexts) {
    const cRe = (screenX - context.reference.screenX) * pixelSpan;
    const cIm = (screenY - context.reference.screenY) * pixelSpan;
    const result = perturb(
      cRe,
      cIm,
      context.orbitRe,
      context.orbitIm,
      maxIter,
      context.series,
      context.bla,
      pixelSpan >= MIN_PIXEL_SPAN_FOR_PERIODIC_INTERIOR,
      scratch
    );
    maxSkip = Math.max(maxSkip, context.series.skip);
    if (!result.unresolved) return { result, referenceId: context.reference.id, skip: maxSkip };
    if (!bestUnresolved || result.survivedIter > bestUnresolved.survivedIter) {
      bestUnresolved = result;
      bestUnresolvedReferenceId = context.reference.id;
    }
  }

  return {
    result: bestUnresolved ?? {
      iter: maxIter,
      mag2: 0,
      glitch: true,
      unresolved: true,
      survivedIter: 0,
      periodicInterior: false,
      rebaseCount: 0,
      rebaseLimit: false,
      blaSkipCount: 0,
      blaStepCount: 0
    },
    referenceId: bestUnresolvedReferenceId,
    skip: maxSkip
  };
}

function perturb(
  cRe: number,
  cIm: number,
  orbitRe: Float64Array,
  orbitIm: Float64Array,
  maxIter: number,
  series: ReturnType<typeof buildSeriesPlan>,
  bla: BlaTable | undefined,
  allowPeriodicInterior: boolean,
  scratch: PeriodicScratch
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
    return failureResult(maxIter, mag2, true, Math.max(0, limit), rebaseCount, rebaseLimit, blaSkipCount, blaStepCount);
  }

  while (iter <= maxIter && refIndex <= limit) {
    const refRe = orbitRe[refIndex];
    const refIm = orbitIm[refIndex];
    if (!Number.isFinite(refRe) || !Number.isFinite(refIm)) {
      glitch = true;
      break;
    }

    const zRe = refRe + dzRe;
    const zIm = refIm + dzIm;
    mag2 = zRe * zRe + zIm * zIm;
    if (mag2 > 4) return successResult(iter, mag2, glitch, false, rebaseCount, rebaseLimit, blaSkipCount, blaStepCount);
    if (iter >= maxIter) return successResult(maxIter, mag2, false, false, rebaseCount, rebaseLimit, blaSkipCount, blaStepCount);

    if (checkpointRe && checkpointIm && checkpointIter && iter > 32 && iter % 8 === 0) {
      const cycleTolerance = 1e-20 * Math.max(1, mag2);
      for (let checkpoint = 0; checkpoint < checkpointCount; checkpoint += 1) {
        if (iter - checkpointIter[checkpoint] < 32) continue;
        const cycleDeltaRe = zRe - checkpointRe[checkpoint];
        const cycleDeltaIm = zIm - checkpointIm[checkpoint];
        const cycleDelta2 = cycleDeltaRe * cycleDeltaRe + cycleDeltaIm * cycleDeltaIm;
        if (Number.isFinite(cycleDelta2) && cycleDelta2 < cycleTolerance) {
          return successResult(maxIter, mag2, false, true, rebaseCount, rebaseLimit, blaSkipCount, blaStepCount);
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
    if (shouldRebase(mag2, refMag2, refIndex)) {
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
    } else if (isCancellationGlitch(mag2, refMag2, dzMag2BeforeStep)) {
      glitch = true;
      break;
    }

    if (refIndex === limit) break;

    const blaStep = tryBlaStep(bla, refIndex, dzRe, dzIm, cRe, cIm, limit);
    if (blaStep) {
      dzRe = blaStep.dzRe;
      dzIm = blaStep.dzIm;
      iter += blaStep.skip;
      refIndex += blaStep.skip;
      blaSkipCount += Math.max(0, blaStep.skip - 1);
      blaStepCount += 1;
      continue;
    }

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
    return failureResult(maxIter, mag2, true, Math.min(iter, maxIter), rebaseCount, rebaseLimit, blaSkipCount, blaStepCount);
  }
  return successResult(maxIter, mag2, false, false, rebaseCount, rebaseLimit, blaSkipCount, blaStepCount);
}

function successResult(
  iter: number,
  mag2: number,
  glitch: boolean,
  periodicInterior: boolean,
  rebaseCount: number,
  rebaseLimit: boolean,
  blaSkipCount: number,
  blaStepCount: number
): PixelResult {
  return { iter, mag2, glitch, unresolved: false, survivedIter: iter, periodicInterior, rebaseCount, rebaseLimit, blaSkipCount, blaStepCount };
}

function failureResult(
  iter: number,
  mag2: number,
  glitch: boolean,
  survivedIter: number,
  rebaseCount: number,
  rebaseLimit: boolean,
  blaSkipCount: number,
  blaStepCount: number
): PixelResult {
  return { iter, mag2, glitch, unresolved: true, survivedIter, periodicInterior: false, rebaseCount, rebaseLimit, blaSkipCount, blaStepCount };
}

function getBlaTable(referenceId: string, orbitRe: Float64Array, orbitIm: Float64Array, tileRadiusValue: number): BlaTable | undefined {
  if (!Number.isFinite(tileRadiusValue) || tileRadiusValue <= 0 || tileRadiusValue > MAX_BLA_TILE_RADIUS || orbitRe.length < 3) {
    return undefined;
  }
  const radiusBucket = Math.ceil(Math.log2(1 / Math.max(tileRadiusValue, 1e-300)));
  const key = `${referenceId}:${radiusBucket}`;
  const cached = blaCache.get(key);
  if (cached) return cached;

  const baseLength = Math.max(0, Math.min(orbitRe.length, orbitIm.length) - 1);
  const base = createBlaLevel(1, baseLength);
  const cBudget = Math.max(tileRadiusValue, 1e-300);
  for (let index = 0; index < baseLength; index += 1) {
    const zr = orbitRe[index] ?? 0;
    const zi = orbitIm[index] ?? 0;
    const absZ = Math.hypot(zr, zi);
    const absA = 2 * absZ;
    base.ar[index] = 2 * zr;
    base.ai[index] = 2 * zi;
    base.br[index] = 1;
    base.bi[index] = 0;
    base.radius[index] = Math.max(0, (BLA_EPSILON * Math.max(0, absZ * 0.5 - cBudget)) / (absA + 1));
    base.maxRefMag2[index] = zr * zr + zi * zi;
  }

  const table: BlaTable = [base];
  while (table.length < 10) {
    const previous = table[table.length - 1];
    const length = previous.ar.length - previous.skip;
    if (length <= 0) break;
    const next = createBlaLevel(previous.skip * 2, length);
    for (let index = 0; index < length; index += 1) {
      const secondIndex = index + previous.skip;
      const a1r = previous.ar[index];
      const a1i = previous.ai[index];
      const b1r = previous.br[index];
      const b1i = previous.bi[index];
      const a2r = previous.ar[secondIndex];
      const a2i = previous.ai[secondIndex];
      const b2r = previous.br[secondIndex];
      const b2i = previous.bi[secondIndex];

      next.ar[index] = a2r * a1r - a2i * a1i;
      next.ai[index] = a2r * a1i + a2i * a1r;
      next.br[index] = a2r * b1r - a2i * b1i + b2r;
      next.bi[index] = a2r * b1i + a2i * b1r + b2i;
      const absAx = Math.hypot(a1r, a1i);
      const absBx = Math.hypot(b1r, b1i);
      const transportedRadius = (previous.radius[secondIndex] - absBx * cBudget) / Math.max(absAx, 1e-300);
      next.radius[index] = Math.max(0, Math.min(previous.radius[index], transportedRadius));
      next.maxRefMag2[index] = Math.max(previous.maxRefMag2[index], previous.maxRefMag2[secondIndex]);
    }
    table.push(next);
  }

  blaCache.set(key, table);
  while (blaCache.size > BLA_CACHE_LIMIT) {
    const first = blaCache.keys().next().value;
    if (!first) break;
    blaCache.delete(first);
  }
  return table;
}

function createBlaLevel(skip: number, length: number): BlaLevel {
  return {
    skip,
    ar: new Float64Array(length),
    ai: new Float64Array(length),
    br: new Float64Array(length),
    bi: new Float64Array(length),
    radius: new Float64Array(length),
    maxRefMag2: new Float64Array(length)
  };
}

function tryBlaStep(
  table: BlaTable | undefined,
  refIndex: number,
  dzRe: number,
  dzIm: number,
  cRe: number,
  cIm: number,
  limit: number
): { dzRe: number; dzIm: number; skip: number } | undefined {
  if (!table) return undefined;
  const dzMag2 = dzRe * dzRe + dzIm * dzIm;
  for (let levelIndex = table.length - 1; levelIndex >= 0; levelIndex -= 1) {
    const level = table[levelIndex];
    if (level.skip <= 1) continue;
    if (refIndex + level.skip > limit || refIndex >= level.ar.length) continue;
    const radius = level.radius[refIndex];
    if (radius <= 0 || dzMag2 > radius * radius) continue;
    if (level.maxRefMag2[refIndex] > 3.25) continue;
    const ar = level.ar[refIndex];
    const ai = level.ai[refIndex];
    const br = level.br[refIndex];
    const bi = level.bi[refIndex];
    return {
      dzRe: ar * dzRe - ai * dzIm + br * cRe - bi * cIm,
      dzIm: ar * dzIm + ai * dzRe + br * cIm + bi * cRe,
      skip: level.skip
    };
  }
  return undefined;
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
      bounds: cluster.bounds
    }))
    .sort((a, b) => b.pixelCount - a.pixelCount || b.survivedIter - a.survivedIter)
    .slice(0, 16);
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

function isCancellationGlitch(mag2: number, refMag2: number, dzMag2: number): boolean {
  if (!Number.isFinite(mag2) || !Number.isFinite(refMag2) || !Number.isFinite(dzMag2)) return true;
  if (refMag2 <= 1e-30 || dzMag2 <= 1e-30) return false;
  return dzMag2 > refMag2 * 1e-4 && mag2 < refMag2 * 1e-20;
}

function shouldRebase(mag2: number, refMag2: number, refIndex: number): boolean {
  if (refIndex <= 0) return false;
  if (!Number.isFinite(mag2) || !Number.isFinite(refMag2) || refMag2 <= 1e-30) return false;
  return mag2 < refMag2 * REBASE_G;
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

function colorPixel(buffer: Uint8ClampedArray, offset: number, iter: number, maxIter: number, mag2: number): void {
  if (iter >= maxIter) {
    buffer[offset] = 2;
    buffer[offset + 1] = 4;
    buffer[offset + 2] = 8;
    buffer[offset + 3] = 255;
    return;
  }

  const smooth = iter + 1 - Math.log2(Math.max(1e-12, Math.log2(Math.max(2, Math.sqrt(mag2)))));
  const t = (smooth * 0.018) % 1;
  const wave = (phase: number) => 0.5 + 0.5 * Math.cos(6.283185307179586 * (t + phase));
  buffer[offset] = Math.round(255 * Math.pow(wave(0.95), 1.4));
  buffer[offset + 1] = Math.round(255 * Math.pow(wave(0.58), 1.1));
  buffer[offset + 2] = Math.round(255 * Math.pow(wave(0.22), 0.9));
  buffer[offset + 3] = 255;
}

function asFloat64(value: Float64Array | ArrayLike<number>): Float64Array {
  return value instanceof Float64Array ? value : Float64Array.from(value);
}

function isReferenceSnapshot(reference: unknown): reference is ReferenceSnapshot {
  return (
    typeof reference === "object" &&
    reference !== null &&
    "orbitRe" in reference &&
    "orbitIm" in reference
  );
}
