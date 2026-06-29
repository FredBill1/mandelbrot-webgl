import type { ViewState } from "../types";
import { defaultMaxIter } from "../math/view";

export const DEFAULT_VIEW: ViewState = {
  re: "-5e-1",
  im: "0",
  scale: "1",
  maxIter: defaultMaxIter("1")
};

export const DEEP_TEST_VIEW: ViewState = {
  re: "-7.43643887037158704752191506114774e-1",
  im: "1.31825904205311970493132056385139e-1",
  scale: "1e100",
  maxIter: defaultMaxIter("1e100")
};

const DECIMAL_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

export function parseViewFromUrl(url: URL = new URL(window.location.href)): ViewState {
  const re = validDecimal(url.searchParams.get("re")) ?? DEFAULT_VIEW.re;
  const im = validDecimal(url.searchParams.get("im")) ?? DEFAULT_VIEW.im;
  const scale = positiveDecimal(url.searchParams.get("scale")) ?? DEFAULT_VIEW.scale;
  const iter = Number.parseInt(url.searchParams.get("iter") ?? "", 10);
  const maxIter = Number.isFinite(iter) && iter >= 32 ? Math.min(50_000, iter) : defaultMaxIter(scale);
  return { re, im, scale, maxIter };
}

export function viewToSearchParams(view: ViewState): URLSearchParams {
  const params = new URLSearchParams();
  params.set("re", normalizeDecimal(view.re));
  params.set("im", normalizeDecimal(view.im));
  params.set("scale", normalizeDecimal(view.scale));
  params.set("iter", String(Math.round(view.maxIter)));
  return params;
}

export function serializeViewToQuery(view: ViewState): string {
  return `?${viewToSearchParams(view).toString()}`;
}

export function writeViewToUrl(view: ViewState): void {
  const next = `${window.location.pathname}${serializeViewToQuery(view)}${window.location.hash}`;
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
