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
  const coeffRe = new Float64Array(degree + 1);
  const coeffIm = new Float64Array(degree + 1);
  const nextRe = new Float64Array(degree + 1);
  const nextIm = new Float64Array(degree + 1);
  let skip = 0;

  for (let n = 0; n < Math.min(maxSkip, orbitRe.length - 1); n += 1) {
    nextRe.fill(0);
    nextIm.fill(0);
    const zr = orbitRe[n] ?? 0;
    const zi = orbitIm[n] ?? 0;
    if (!Number.isFinite(zr) || !Number.isFinite(zi)) break;

    for (let k = 1; k <= degree; k += 1) {
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
    for (let k = 1; k <= degree; k += 1) {
      const contribution = Math.hypot(nextRe[k], nextIm[k]) * radiusPower;
      if (!Number.isFinite(contribution) || contribution > 0.35) {
        stable = false;
        break;
      }
      radiusPower *= tileRadius;
    }
    if (!stable) break;

    coeffRe.set(nextRe);
    coeffIm.set(nextIm);
    skip = n + 1;
  }

  return { skip, degree, coeffRe, coeffIm };
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
