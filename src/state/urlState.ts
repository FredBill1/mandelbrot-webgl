import type { ViewState } from "../types";
import {
  DEFAULT_ITER_FORMULA,
  clampIter,
  defaultMaxIter,
  iterFormulaEquals,
  normalizeIterFormula,
  type IterFormula,
  type IterSettings
} from "../math/view";

export const DEFAULT_VIEW: ViewState = {
  re: "-5e-1",
  im: "0",
  scale: "1",
  maxIter: defaultMaxIter("1")
};

export const DEEP_TEST_VIEW: ViewState = {
  re: "-7.46883943431692760541919532714409859232606639886333750701092541165643808224287821342188522092587382149759799587046156756309863566112516698524311312263708365547443519e-1",
  im: "-1.00525982411215876752593698920114371641511074291356983067885243750788193219078894211160534174388216978954526887172496458449660477900264112017850945405489228557321858e-1",
  scale: "1e100",
  maxIter: defaultMaxIter("1e100")
};

const DECIMAL_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

export interface ParsedViewState {
  view: ViewState;
  iterSettings: IterSettings;
  explicitIter: boolean;
}

export function parseViewFromUrl(url: URL = new URL(window.location.href)): ViewState {
  return parseViewStateFromUrl(url).view;
}

export function parseViewStateFromUrl(url: URL = new URL(window.location.href)): ParsedViewState {
  const re = validDecimal(url.searchParams.get("re")) ?? DEFAULT_VIEW.re;
  const im = validDecimal(url.searchParams.get("im")) ?? DEFAULT_VIEW.im;
  const scale = positiveDecimal(url.searchParams.get("scale")) ?? DEFAULT_VIEW.scale;
  const formula = parseIterFormula(url);
  const iter = Number.parseInt(url.searchParams.get("iter") ?? "", 10);
  const explicitIter = Number.isFinite(iter) && iter >= 32;
  const fixedIter = explicitIter ? clampIter(iter) : defaultMaxIter(scale, formula);
  const iterSettings: IterSettings = {
    mode: explicitIter ? "fixed" : "default",
    formula,
    fixedIter
  };
  const maxIter = explicitIter ? fixedIter : defaultMaxIter(scale, formula);
  return { view: { re, im, scale, maxIter }, iterSettings, explicitIter };
}

export function viewToSearchParams(view: ViewState, options: { iterSettings?: IterSettings } = {}): URLSearchParams {
  const params = new URLSearchParams();
  params.set("re", normalizeDecimal(view.re));
  params.set("im", normalizeDecimal(view.im));
  params.set("scale", normalizeDecimal(view.scale));
  const settings = options.iterSettings;
  if (!settings || settings.mode === "fixed") {
    params.set("iter", String(clampIter(settings?.fixedIter ?? view.maxIter)));
  } else {
    const formula = normalizeIterFormula(settings.formula);
    if (!iterFormulaEquals(formula)) {
      if (formula.base !== DEFAULT_ITER_FORMULA.base) params.set("iterBase", String(formula.base));
      if (formula.slope !== DEFAULT_ITER_FORMULA.slope) params.set("iterSlope", String(formula.slope));
      if (formula.cap !== DEFAULT_ITER_FORMULA.cap) params.set("iterCap", String(formula.cap));
    }
  }
  return params;
}

export function serializeViewToQuery(view: ViewState, options: { iterSettings?: IterSettings } = {}): string {
  return `?${viewToSearchParams(view, options).toString()}`;
}

export function writeViewToUrl(view: ViewState, options: { iterSettings?: IterSettings } = {}): void {
  const next = `${window.location.pathname}${serializeViewToQuery(view, options)}${window.location.hash}`;
  window.history.replaceState(null, "", next);
}

function validDecimal(value: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return DECIMAL_RE.test(trimmed) ? normalizeDecimal(trimmed) : undefined;
}

function positiveDecimal(value: string | null): string | undefined {
  const decimal = validDecimal(value);
  if (!decimal) return undefined;
  const numeric = Number(decimal);
  if (Number.isFinite(numeric)) return numeric > 0 ? decimal : undefined;
  return decimal[0] !== "-" ? decimal : undefined;
}

function normalizeDecimal(value: string): string {
  return value.replace("E", "e").replace(/e\+/, "e");
}

function parseIterFormula(url: URL): IterFormula {
  return normalizeIterFormula({
    base: numberParam(url, "iterBase"),
    slope: numberParam(url, "iterSlope"),
    cap: numberParam(url, "iterCap")
  });
}

function numberParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}
