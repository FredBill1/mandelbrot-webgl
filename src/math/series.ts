export interface SeriesPlan {
  skip: number;
  degree: number;
  coeffRe: Float64Array;
  coeffIm: Float64Array;
}

export interface Complex {
  re: number;
  im: number;
}

export interface SeriesEvaluation {
  value: Complex;
  derivative: Complex;
}

const MAX_SERIES_TILE_RADIUS = 1e-3;
const SERIES_ERROR_SCALE = 1e-7;
const SERIES_SKIP_SATURATION = 0.7;

export function buildSeriesPlan(
  orbitRe: ArrayLike<number>,
  orbitIm: ArrayLike<number>,
  degree: number,
  maxSkip: number,
  tileRadius: number,
  probes: readonly Complex[] = [{ re: 0, im: 0 }]
): SeriesPlan {
  const normalizedDegree = Math.max(0, Math.floor(degree));
  if (normalizedDegree > 2) {
    let best = buildSeriesPlanForDegree(orbitRe, orbitIm, 2, maxSkip, tileRadius, probes);
    if (isSeriesSkipSaturated(best.skip, maxSkip, orbitRe, orbitIm)) return best;
    for (const candidateDegree of [4, 8, 12]) {
      if (candidateDegree > normalizedDegree) break;
      const candidate = buildSeriesPlanForDegree(orbitRe, orbitIm, candidateDegree, maxSkip, tileRadius, probes);
      if (candidate.skip > best.skip || (candidate.skip === best.skip && candidate.degree < best.degree)) {
        best = candidate;
      }
      if (isSeriesSkipSaturated(best.skip, maxSkip, orbitRe, orbitIm)) break;
    }
    return best;
  }
  return buildSeriesPlanForDegree(orbitRe, orbitIm, normalizedDegree, maxSkip, tileRadius, probes);
}

function isSeriesSkipSaturated(skip: number, maxSkip: number, orbitRe: ArrayLike<number>, orbitIm: ArrayLike<number>): boolean {
  const availableSkip = Math.max(0, Math.min(Math.floor(maxSkip), orbitRe.length - 1, orbitIm.length - 1));
  return availableSkip > 0 && skip >= Math.ceil(availableSkip * SERIES_SKIP_SATURATION);
}

function buildSeriesPlanForDegree(
  orbitRe: ArrayLike<number>,
  orbitIm: ArrayLike<number>,
  normalizedDegree: number,
  maxSkip: number,
  tileRadius: number,
  probes: readonly Complex[]
): SeriesPlan {
  const coeffRe = new Float64Array(normalizedDegree + 1);
  const coeffIm = new Float64Array(normalizedDegree + 1);
  if (
    normalizedDegree < 2 ||
    maxSkip <= 0 ||
    !Number.isFinite(tileRadius) ||
    tileRadius <= 0 ||
    tileRadius > MAX_SERIES_TILE_RADIUS ||
    orbitRe.length < 2 ||
    orbitIm.length < 2 ||
    probes.length === 0
  ) {
    return { skip: 0, degree: normalizedDegree, coeffRe, coeffIm };
  }

  const nextRe = new Float64Array(normalizedDegree + 1);
  const nextIm = new Float64Array(normalizedDegree + 1);
  const probeRe = new Float64Array(probes.length);
  const probeIm = new Float64Array(probes.length);
  const nextProbeRe = new Float64Array(probes.length);
  const nextProbeIm = new Float64Array(probes.length);
  let skip = 0;

  for (let n = 0; n < Math.min(maxSkip, orbitRe.length - 1); n += 1) {
    nextRe.fill(0);
    nextIm.fill(0);
    const zr = orbitRe[n] ?? 0;
    const zi = orbitIm[n] ?? 0;
    if (!Number.isFinite(zr) || !Number.isFinite(zi)) break;

    for (let k = 1; k <= normalizedDegree; k += 1) {
      const ar = coeffRe[k];
      const ai = coeffIm[k];
      nextRe[k] += 2 * (zr * ar - zi * ai);
      nextIm[k] += 2 * (zr * ai + zi * ar);
      if (k === 1) nextRe[k] += 1;

      for (let j = 1; j < k; j += 1) {
        const br = coeffRe[j];
        const bi = coeffIm[j];
        const cr = coeffRe[k - j];
        const ci = coeffIm[k - j];
        nextRe[k] += br * cr - bi * ci;
        nextIm[k] += br * ci + bi * cr;
      }
    }

    if (!probesValidateSeriesStep(probes, probeRe, probeIm, nextProbeRe, nextProbeIm, nextRe, nextIm, orbitRe, orbitIm, n, tileRadius)) break;

    coeffRe.set(nextRe);
    coeffIm.set(nextIm);
    probeRe.set(nextProbeRe);
    probeIm.set(nextProbeIm);
    skip = n + 1;
  }

  return { skip, degree: normalizedDegree, coeffRe, coeffIm };
}

export function evaluateSeries(plan: SeriesPlan, cRe: number, cIm: number): Complex {
  let zr = 0;
  let zi = 0;
  for (let k = plan.degree; k >= 1; k -= 1) {
    const pr = zr * cRe - zi * cIm + plan.coeffRe[k];
    const pi = zr * cIm + zi * cRe + plan.coeffIm[k];
    zr = pr;
    zi = pi;
  }
  return {
    re: zr * cRe - zi * cIm,
    im: zr * cIm + zi * cRe
  };
}

export function evaluateSeriesWithDerivative(plan: SeriesPlan, cRe: number, cIm: number): SeriesEvaluation {
  let zr = 0;
  let zi = 0;
  let dr = 0;
  let di = 0;
  for (let k = plan.degree; k >= 1; k -= 1) {
    const nextDr = dr * cRe - di * cIm + zr;
    const nextDi = dr * cIm + di * cRe + zi;
    const pr = zr * cRe - zi * cIm + plan.coeffRe[k];
    const pi = zr * cIm + zi * cRe + plan.coeffIm[k];
    dr = nextDr;
    di = nextDi;
    zr = pr;
    zi = pi;
  }
  return {
    value: {
      re: zr * cRe - zi * cIm,
      im: zr * cIm + zi * cRe
    },
    derivative: {
      re: dr * cRe - di * cIm + zr,
      im: dr * cIm + di * cRe + zi
    }
  };
}

function probesValidateSeriesStep(
  probes: readonly Complex[],
  probeRe: Float64Array,
  probeIm: Float64Array,
  nextProbeRe: Float64Array,
  nextProbeIm: Float64Array,
  coeffRe: Float64Array,
  coeffIm: Float64Array,
  orbitRe: ArrayLike<number>,
  orbitIm: ArrayLike<number>,
  n: number,
  tileRadius: number
): boolean {
  const zr = orbitRe[n] ?? 0;
  const zi = orbitIm[n] ?? 0;
  const nextRefRe = orbitRe[n + 1] ?? 0;
  const nextRefIm = orbitIm[n + 1] ?? 0;
  if (!Number.isFinite(nextRefRe) || !Number.isFinite(nextRefIm)) return false;

  for (let index = 0; index < probes.length; index += 1) {
    const cRe = probes[index].re;
    const cIm = probes[index].im;
    const dzRe = probeRe[index];
    const dzIm = probeIm[index];
    const dz2Re = dzRe * dzRe - dzIm * dzIm;
    const dz2Im = 2 * dzRe * dzIm;
    const twoRefDzRe = 2 * (zr * dzRe - zi * dzIm);
    const twoRefDzIm = 2 * (zr * dzIm + zi * dzRe);
    const exactRe = twoRefDzRe + dz2Re + cRe;
    const exactIm = twoRefDzIm + dz2Im + cIm;
    if (!Number.isFinite(exactRe) || !Number.isFinite(exactIm)) return false;

    const zRe = nextRefRe + exactRe;
    const zIm = nextRefIm + exactIm;
    const mag2 = zRe * zRe + zIm * zIm;
    if (!Number.isFinite(mag2) || mag2 > 4) return false;

    const refMag2 = nextRefRe * nextRefRe + nextRefIm * nextRefIm;
    const dzMag2 = exactRe * exactRe + exactIm * exactIm;
    if (isCancellationGlitch(mag2, refMag2, dzMag2)) return false;

    let estimateZr = 0;
    let estimateZi = 0;
    for (let k = coeffRe.length - 1; k >= 1; k -= 1) {
      const pr = estimateZr * cRe - estimateZi * cIm + coeffRe[k];
      const pi = estimateZr * cIm + estimateZi * cRe + coeffIm[k];
      estimateZr = pr;
      estimateZi = pi;
    }
    const estimateRe = estimateZr * cRe - estimateZi * cIm;
    const estimateIm = estimateZr * cIm + estimateZi * cRe;
    if (!Number.isFinite(estimateRe) || !Number.isFinite(estimateIm)) return false;
    const error = Math.hypot(exactRe - estimateRe, exactIm - estimateIm);
    const exactMag = Math.hypot(exactRe, exactIm);
    const estimateMag = Math.hypot(estimateRe, estimateIm);
    const allowed = SERIES_ERROR_SCALE * Math.max(tileRadius, exactMag, estimateMag, Number.MIN_VALUE);
    if (!Number.isFinite(error) || error > allowed) return false;

    nextProbeRe[index] = exactRe;
    nextProbeIm[index] = exactIm;
  }

  return true;
}

function isCancellationGlitch(mag2: number, refMag2: number, dzMag2: number): boolean {
  if (!Number.isFinite(mag2) || !Number.isFinite(refMag2) || !Number.isFinite(dzMag2)) return true;
  if (refMag2 <= 1e-30 || dzMag2 <= 1e-30) return false;
  return dzMag2 > refMag2 * 1e-4 && mag2 < refMag2 * 1e-20;
}
