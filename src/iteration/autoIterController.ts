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

const MAX_AUTO_ITER = 20_000;
const HYSTERESIS_MIN = 512;
const HYSTERESIS_RATIO = 0.2;

export class AutoIterController {
  private estimates = new Map<string, number>();
  private currentEstimate: number;

  constructor(initialView: ViewState, private modeValue: IterMode) {
    this.currentEstimate = initialView.maxIter;
    if (modeValue === "auto") this.remember(initialView, initialView.maxIter);
  }

  get mode(): IterMode {
    return this.modeValue;
  }

  setMode(mode: IterMode, view: ViewState): void {
    this.modeValue = mode;
    this.currentEstimate = view.maxIter;
    if (mode === "auto") this.remember(view, view.maxIter);
  }

  shouldProbe(view: ViewState): boolean {
    return this.modeValue === "auto" && decimalLog10(view.scale) >= 8 && defaultMaxIter(view.scale) < MAX_AUTO_ITER;
  }

  immediateView(next: ViewState, previous: ViewState): ViewState {
    if (this.modeValue === "explicit") return { ...next, maxIter: previous.maxIter };
    const baseline = defaultMaxIter(next.scale);
    const cached = this.cachedEstimate(next);
    const predicted = this.predictedIter(previous, next);
    const maxIter = clampIter(Math.max(baseline, cached ?? 0, predicted));
    this.currentEstimate = maxIter;
    this.remember(next, maxIter);
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
      this.remember(view, previousIter);
      return unchanged(previousIter);
    }

    this.currentEstimate = maxIter;
    this.remember(view, maxIter);
    return {
      changed: true,
      maxIter,
      previousIter,
      delta,
      direction: delta > 0 ? "increase" : "decrease"
    };
  }

  remember(view: ViewState, maxIter: number): void {
    this.estimates.set(cacheKey(view), clampIter(maxIter));
    if (this.estimates.size > 96) {
      const first = this.estimates.keys().next().value;
      if (first !== undefined) this.estimates.delete(first);
    }
  }

  private cachedEstimate(view: ViewState): number | undefined {
    return this.estimates.get(cacheKey(view));
  }

  private predictedIter(previous: ViewState, next: ViewState): number {
    const previousLog = decimalLog10(previous.scale);
    const nextLog = decimalLog10(next.scale);
    const logDelta = nextLog - previousLog;
    const predicted = this.currentEstimate + Math.round(logDelta * 64);
    return clampIter(predicted);
  }
}

function unchanged(maxIter: number): IterEstimateChange {
  return { changed: false, maxIter, previousIter: maxIter, delta: 0, direction: "unchanged" };
}

function clampIter(maxIter: number): number {
  if (!Number.isFinite(maxIter)) return defaultMaxIter("1");
  return Math.min(MAX_AUTO_ITER, Math.max(32, Math.round(maxIter)));
}

function cacheKey(view: Pick<ViewState, "re" | "im" | "scale">): string {
  const scaleBucket = Math.round(decimalLog10(view.scale) * 4) / 4;
  return `${scaleBucket}:${view.re.slice(0, 18)}:${view.im.slice(0, 18)}`;
}
