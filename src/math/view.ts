import { BASE_VIEW_WIDTH, type ViewState } from "../types";

export function decimalLog10(value: string): number {
  const text = value.trim().toLowerCase();
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(?:e([+-]?\d+))?$/.exec(text);
  if (!match) return 0;
  const mantissa = Math.abs(Number(match[1]));
  const exponent = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isFinite(mantissa) || mantissa === 0) return exponent;
  return Math.log10(mantissa) + exponent;
}

export function decimalLog2(value: string): number {
  return decimalLog10(value) * Math.LOG2E * Math.LN10;
}

export function defaultMaxIter(scale: string): number {
  const zoomLog10 = Math.max(0, decimalLog10(scale));
  return Math.min(20_000, 512 + Math.ceil(64 * zoomLog10));
}

export function scaleToNumber(scale: string): number {
  const value = Number(scale);
  if (Number.isFinite(value) && value > 0) return value;
  const log10 = decimalLog10(scale);
  return 10 ** Math.max(-300, Math.min(300, log10));
}

export function pixelSpanForView(view: Pick<ViewState, "scale">, canvasWidth: number): number {
  return BASE_VIEW_WIDTH / scaleToNumber(view.scale) / Math.max(1, canvasWidth);
}

export function formatCompactDecimal(value: string, digits = 8): string {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && Math.abs(numeric) > 1e-4 && Math.abs(numeric) < 1e6) {
    return numeric.toPrecision(digits);
  }
  const match = /^([+-]?\d(?:\.?\d*))(?:e([+-]?\d+))?$/i.exec(value);
  if (!match) return value;
  const mantissa = Number(match[1]);
  const exponent = match[2] ?? "0";
  return `${mantissa.toPrecision(Math.min(digits, 10))}e${Number(exponent)}`;
}

export function cloneView(view: ViewState): ViewState {
  return { re: view.re, im: view.im, scale: view.scale, maxIter: view.maxIter };
}
