import { describe, expect, it } from "vitest";
import { AutoIterController } from "../src/iteration/autoIterController";
import type { ViewState } from "../src/types";

describe("AutoIterController", () => {
  it("keeps explicit iteration fixed during interaction", () => {
    const view = makeView("1e16", 1576);
    const controller = new AutoIterController(view, "explicit");
    const next = controller.immediateView({ ...view, scale: "1e18", maxIter: 0 }, view);

    expect(next.maxIter).toBe(1576);
    expect(controller.shouldProbe(next)).toBe(false);
  });

  it("allows auto iteration to decrease when zooming out", () => {
    const view = makeView("1e100", 6912);
    const controller = new AutoIterController(view, "auto");
    const next = controller.immediateView({ ...view, scale: "1e10", maxIter: 0 }, view);

    expect(next.maxIter).toBeLessThan(view.maxIter);
    expect(next.maxIter).toBeGreaterThanOrEqual(1152);
  });

  it("uses hysteresis for small probe changes but accepts large decreases", () => {
    const view = makeView("1e20", 4096);
    const controller = new AutoIterController(view, "auto");

    const small = controller.applyEstimate(view, makeEstimate(3800));
    expect(small.changed).toBe(false);

    const large = controller.applyEstimate(view, makeEstimate(2500));
    expect(large.changed).toBe(true);
    expect(large.direction).toBe("decrease");
  });
});

function makeView(scale: string, maxIter: number): ViewState {
  return {
    re: "-0.75",
    im: "0.1",
    scale,
    maxIter
  };
}

function makeEstimate(recommendedIter: number) {
  return {
    recommendedIter,
    confidence: "high" as const,
    phase: "fast" as const,
    fastMs: 1,
    fullMs: 0,
    maxEscapedAt: recommendedIter,
    cap: recommendedIter,
    sampleCount: 17,
    reason: "test"
  };
}
