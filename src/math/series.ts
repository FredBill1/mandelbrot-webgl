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

export function buildSeriesPlan(
  orbitRe: ArrayLike<number>,
  orbitIm: ArrayLike<number>,
  degree: number,
  maxSkip: number,
  tileRadius: number
): SeriesPlan {
  const normalizedDegree = Math.max(0, Math.floor(degree));
  const coeffRe = new Float64Array(normalizedDegree + 1);
  const coeffIm = new Float64Array(normalizedDegree + 1);
  if (
    normalizedDegree < 2 ||
    maxSkip <= 0 ||
    !Number.isFinite(tileRadius) ||
    tileRadius <= 0 ||
    tileRadius > 1e-8 ||
    orbitRe.length < 2 ||
    orbitIm.length < 2
  ) {
    return { skip: 0, degree: normalizedDegree, coeffRe, coeffIm };
  }

  const nextRe = new Float64Array(normalizedDegree + 1);
  const nextIm = new Float64Array(normalizedDegree + 1);
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

    let stable = true;
    let radiusPower = tileRadius;
    let contributionSum = 0;
    let lastContribution = 0;
    for (let k = 1; k <= normalizedDegree; k += 1) {
      const contribution = Math.hypot(nextRe[k], nextIm[k]) * radiusPower;
      contributionSum += contribution;
      lastContribution = contribution;
      if (!Number.isFinite(contribution) || contribution > 0.05 || contributionSum > 0.18) {
        stable = false;
        break;
      }
      radiusPower *= tileRadius;
    }
    if (lastContribution > 1e-16) stable = false;
    if (!stable) break;

    coeffRe.set(nextRe);
    coeffIm.set(nextIm);
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
