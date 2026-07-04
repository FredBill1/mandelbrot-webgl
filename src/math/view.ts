import { BASE_VIEW_WIDTH, type ViewState } from "../types";

export const ITER_MIN = 32;
export const ITER_MAX = 50_000;
export const ITER_SLOPE_MIN = 0;
export const ITER_SLOPE_MAX = 512;

export interface IterFormula {
  base: number;
  slope: number;
  cap: number;
}

export type IterMode = "default" | "fixed";

export interface IterSettings {
  mode: IterMode;
  formula: IterFormula;
  fixedIter: number;
}

export const DEFAULT_ITER_FORMULA: IterFormula = {
  base: 512,
  slope: 64,
  cap: 20_000
};

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

export function defaultMaxIter(scale: string, formula: IterFormula = DEFAULT_ITER_FORMULA): number {
  const normalized = normalizeIterFormula(formula);
  const zoomLog10 = Math.max(0, decimalLog10(scale));
  return clampIter(Math.min(normalized.cap, normalized.base + Math.ceil(normalized.slope * zoomLog10)));
}

export function resolveMaxIter(scale: string, settings: IterSettings): number {
  return settings.mode === "fixed" ? clampIter(settings.fixedIter) : defaultMaxIter(scale, settings.formula);
}

export function normalizeIterSettings(settings: IterSettings, scale = "1"): IterSettings {
  const formula = normalizeIterFormula(settings.formula);
  return {
    mode: settings.mode,
    formula,
    fixedIter: clampIter(settings.fixedIter, defaultMaxIter(scale, formula))
  };
}

export function normalizeIterFormula(formula: Partial<IterFormula> = {}): IterFormula {
  return {
    base: clampIter(formula.base, DEFAULT_ITER_FORMULA.base),
    slope: clampNumber(formula.slope, ITER_SLOPE_MIN, ITER_SLOPE_MAX, DEFAULT_ITER_FORMULA.slope),
    cap: clampIter(formula.cap, DEFAULT_ITER_FORMULA.cap)
  };
}

export function clampIter(value: number | undefined, fallback = DEFAULT_ITER_FORMULA.base): number {
  return clampNumber(value, ITER_MIN, ITER_MAX, fallback);
}

export function iterFormulaEquals(left: IterFormula, right: IterFormula = DEFAULT_ITER_FORMULA): boolean {
  return left.base === right.base && left.slope === right.slope && left.cap === right.cap;
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

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value as number)));
}
