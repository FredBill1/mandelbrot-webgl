import type { ViewState } from "../types";
import { defaultMaxIter } from "../math/view";
import type { IterMode } from "../iteration/autoIterController";

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
  explicitIter: boolean;
}

export function parseViewFromUrl(url: URL = new URL(window.location.href)): ViewState {
  return parseViewStateFromUrl(url).view;
}

export function parseViewStateFromUrl(url: URL = new URL(window.location.href)): ParsedViewState {
  const re = validDecimal(url.searchParams.get("re")) ?? DEFAULT_VIEW.re;
  const im = validDecimal(url.searchParams.get("im")) ?? DEFAULT_VIEW.im;
  const scale = positiveDecimal(url.searchParams.get("scale")) ?? DEFAULT_VIEW.scale;
  const iter = Number.parseInt(url.searchParams.get("iter") ?? "", 10);
  const explicitIter = Number.isFinite(iter) && iter >= 32;
  const maxIter = explicitIter ? Math.min(50_000, iter) : defaultMaxIter(scale);
  return { view: { re, im, scale, maxIter }, explicitIter };
}

export function viewToSearchParams(view: ViewState, options: { iterMode?: IterMode } = {}): URLSearchParams {
  const params = new URLSearchParams();
  params.set("re", normalizeDecimal(view.re));
  params.set("im", normalizeDecimal(view.im));
  params.set("scale", normalizeDecimal(view.scale));
  if (options.iterMode !== "auto") params.set("iter", String(Math.round(view.maxIter)));
  return params;
}

export function serializeViewToQuery(view: ViewState, options: { iterMode?: IterMode } = {}): string {
  return `?${viewToSearchParams(view, options).toString()}`;
}

export function writeViewToUrl(view: ViewState, options: { iterMode?: IterMode } = {}): void {
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
