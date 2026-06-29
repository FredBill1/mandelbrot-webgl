import { buildSeriesPlan, evaluateSeries } from "../math/series";
import type { ReferenceSnapshot, RenderTileMessage, TileDoneMessage } from "../types";

interface PixelResult {
  iter: number;
  mag2: number;
  glitch: boolean;
}

export function renderPerturbationTile(message: RenderTileMessage): TileDoneMessage {
  const started = performance.now();
  const { tile, reference, pixelSpan, maxIter, seriesDegree } = message;
  const width = Math.max(1, Math.floor(tile.rect.width));
  const height = Math.max(1, Math.floor(tile.rect.height));
  const rgba = new Uint8ClampedArray(width * height * 4);
  const orbitRe = asFloat64(reference.orbitRe);
  const orbitIm = asFloat64(reference.orbitIm);
  const radius = tileRadius(tile.rect, reference, pixelSpan);
  const series = buildSeriesPlan(orbitRe, orbitIm, seriesDegree, 64, radius);

  let glitchCount = 0;
  let escapedPixels = 0;

  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      const screenX = tile.rect.x + px + 0.5;
      const screenY = tile.rect.y + py + 0.5;
      const cRe = (screenX - reference.screenX) * pixelSpan;
      const cIm = (screenY - reference.screenY) * pixelSpan;
      const result = perturb(cRe, cIm, orbitRe, orbitIm, maxIter, series);
      const offset = (py * width + px) * 4;
      if (result.iter < maxIter) escapedPixels += 1;
      if (result.glitch) glitchCount += 1;
      colorPixel(rgba, offset, result.iter, maxIter, result.mag2);
    }
  }

  return {
    type: "tileDone",
    tileId: tile.id,
    revision: tile.revision,
    rect: tile.rect,
    width,
    height,
    rgba: rgba.buffer,
    needsReference: !message.refined && glitchCount > width * height * 0.015,
    stats: {
      elapsedMs: performance.now() - started,
      glitchCount,
      escapedPixels,
      seriesSkip: series.skip,
      referenceId: reference.id
    }
  };
}

function perturb(
  cRe: number,
  cIm: number,
  orbitRe: Float64Array,
  orbitIm: Float64Array,
  maxIter: number,
  series: ReturnType<typeof buildSeriesPlan>
): PixelResult {
  let dzRe = 0;
  let dzIm = 0;
  let iter = 0;
  let mag2 = 0;
  let glitch = false;

  if (series.skip > 0) {
    const dz = evaluateSeries(series, cRe, cIm);
    dzRe = dz.re;
    dzIm = dz.im;
    iter = series.skip;
  }

  const limit = Math.min(maxIter, orbitRe.length - 1);
  for (; iter <= limit; iter += 1) {
    const refRe = orbitRe[iter];
    const refIm = orbitIm[iter];
    if (!Number.isFinite(refRe) || !Number.isFinite(refIm)) {
      glitch = true;
      break;
    }

    const zRe = refRe + dzRe;
    const zIm = refIm + dzIm;
    mag2 = zRe * zRe + zIm * zIm;
    if (mag2 > 4) return { iter, mag2, glitch };
    if (iter === limit) break;

    const dz2Re = dzRe * dzRe - dzIm * dzIm;
    const dz2Im = 2 * dzRe * dzIm;
    const twoRefDzRe = 2 * (refRe * dzRe - refIm * dzIm);
    const twoRefDzIm = 2 * (refRe * dzIm + refIm * dzRe);
    dzRe = twoRefDzRe + dz2Re + cRe;
    dzIm = twoRefDzIm + dz2Im + cIm;

    const refMag2 = refRe * refRe + refIm * refIm;
    const dzMag2 = dzRe * dzRe + dzIm * dzIm;
    if (!Number.isFinite(dzMag2) || (refMag2 > 1e-24 && dzMag2 > refMag2 * 1e8)) {
      glitch = true;
      break;
    }
  }

  return { iter: maxIter, mag2, glitch };
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
