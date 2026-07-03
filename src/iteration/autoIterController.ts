import { decimalLog10, defaultMaxIter } from "../math/view";
import type { ViewState } from "../types";
import type { DefaultIterEstimate } from "../reference/referenceClient";

export type IterMode = "auto" | "explicit";

export interface IterProbeInput {
  re: string;
  im: string;
  scale: string;
  width: number;
  height: number;
  baseline: number;
}

export interface IterEstimateChange {
  changed: boolean;
  maxIter: number;
  previousIter: number;
  delta: number;
  direction: "increase" | "decrease" | "unchanged";
}

interface VerifiedEstimate {
  rePrefix: string;
  imPrefix: string;
  scaleLog: number;
  maxIter: number;
  lastUsed: number;
}

const MAX_AUTO_ITER = 20_000;
const HYSTERESIS_MIN = 512;
const HYSTERESIS_RATIO = 0.2;
const VERIFIED_SCALE_LOG_WINDOW = 0.25;
const MAX_VERIFIED_ESTIMATES = 96;

export class AutoIterController {
  private estimates: VerifiedEstimate[] = [];
  private sequence = 0;

  constructor(initialView: ViewState, private modeValue: IterMode) {
    if (modeValue === "auto") this.rememberVerified(initialView, initialView.maxIter);
  }

  get mode(): IterMode {
    return this.modeValue;
  }

  setMode(mode: IterMode, view: ViewState): void {
    this.modeValue = mode;
    if (mode === "auto") this.rememberVerified(view, view.maxIter);
  }

  shouldProbe(view: ViewState): boolean {
    return this.modeValue === "auto" && decimalLog10(view.scale) >= 8 && defaultMaxIter(view.scale) < MAX_AUTO_ITER;
  }

  immediateView(next: ViewState, previous: ViewState): ViewState {
    if (this.modeValue === "explicit") return { ...next, maxIter: previous.maxIter };
    const baseline = defaultMaxIter(next.scale);
    const cached = this.nearbyVerifiedEstimate(next);
    const maxIter = clampIter(Math.max(baseline, cached ?? 0));
    return { ...next, maxIter };
  }

  probeInput(view: ViewState, width: number, height: number): IterProbeInput {
    return {
      re: view.re,
      im: view.im,
      scale: view.scale,
      width,
      height,
      baseline: defaultMaxIter(view.scale)
    };
  }

  applyEstimate(view: ViewState, estimate: DefaultIterEstimate): IterEstimateChange {
    if (this.modeValue !== "auto") {
      return unchanged(view.maxIter);
    }
    const previousIter = view.maxIter;
    const maxIter = clampIter(Math.max(defaultMaxIter(view.scale), estimate.recommendedIter));
    const delta = maxIter - previousIter;
    const threshold = Math.max(HYSTERESIS_MIN, Math.round(previousIter * HYSTERESIS_RATIO));
    if (Math.abs(delta) < threshold) {
      return unchanged(previousIter);
    }

    return {
      changed: true,
      maxIter,
      previousIter,
      delta,
      direction: delta > 0 ? "increase" : "decrease"
    };
  }

  rememberVerified(view: ViewState, maxIter: number): void {
    if (this.modeValue !== "auto") return;
    const entry = estimateKey(view);
    const existing = this.estimates.find(
      (candidate) =>
        candidate.rePrefix === entry.rePrefix &&
        candidate.imPrefix === entry.imPrefix &&
        Math.abs(candidate.scaleLog - entry.scaleLog) <= VERIFIED_SCALE_LOG_WINDOW
    );
    if (existing) {
      existing.scaleLog = entry.scaleLog;
      existing.maxIter = clampIter(maxIter);
      existing.lastUsed = ++this.sequence;
    } else {
      this.estimates.push({ ...entry, maxIter: clampIter(maxIter), lastUsed: ++this.sequence });
    }
    if (this.estimates.length > MAX_VERIFIED_ESTIMATES) {
      this.estimates.sort((a, b) => b.lastUsed - a.lastUsed);
      this.estimates.length = MAX_VERIFIED_ESTIMATES;
    }
  }

  private nearbyVerifiedEstimate(view: ViewState): number | undefined {
    const entry = estimateKey(view);
    let best: VerifiedEstimate | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of this.estimates) {
      if (candidate.rePrefix !== entry.rePrefix || candidate.imPrefix !== entry.imPrefix) continue;
      const distance = Math.abs(candidate.scaleLog - entry.scaleLog);
      if (distance > VERIFIED_SCALE_LOG_WINDOW || distance > bestDistance) continue;
      best = candidate;
      bestDistance = distance;
    }
    if (best) {
      best.lastUsed = ++this.sequence;
      return best.maxIter;
    }
    return undefined;
  }
}

function unchanged(maxIter: number): IterEstimateChange {
  return { changed: false, maxIter, previousIter: maxIter, delta: 0, direction: "unchanged" };
}

function clampIter(maxIter: number): number {
  if (!Number.isFinite(maxIter)) return defaultMaxIter("1");
  return Math.min(MAX_AUTO_ITER, Math.max(32, Math.round(maxIter)));
}

function estimateKey(view: Pick<ViewState, "re" | "im" | "scale">): Pick<VerifiedEstimate, "rePrefix" | "imPrefix" | "scaleLog"> {
  return {
    rePrefix: view.re.slice(0, 18),
    imPrefix: view.im.slice(0, 18),
    scaleLog: decimalLog10(view.scale)
  };
}
