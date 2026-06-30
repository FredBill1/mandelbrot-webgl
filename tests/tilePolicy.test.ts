import { describe, expect, it } from "vitest";
import {
  maxReferencesForRect,
  MAX_TILE_REFERENCES_LARGE,
  MAX_TILE_REFERENCES_SMALL,
  nextStalledRefinementRounds,
  shouldSplitTile,
  splitAxis
} from "../src/scheduler/tilePolicy";

describe("tile refinement policy", () => {
  it("uses larger reference budgets for large tiles", () => {
    expect(maxReferencesForRect({ x: 0, y: 0, width: 128, height: 128 })).toBe(MAX_TILE_REFERENCES_LARGE);
    expect(maxReferencesForRect({ x: 0, y: 0, width: 32, height: 16 })).toBe(MAX_TILE_REFERENCES_SMALL);
  });

  it("keeps refining when unresolved pixels improve substantially", () => {
    const stalled = nextStalledRefinementRounds(1000, 600, 1);
    expect(stalled).toBe(0);
    expect(
      shouldSplitTile({
        rect: { x: 0, y: 0, width: 128, height: 128 },
        lastUnresolvedCount: 1000,
        unresolvedCount: 600,
        stalledRefinementRounds: stalled,
        pendingReferences: 0,
        referenceCount: 12,
        maxReferences: MAX_TILE_REFERENCES_LARGE,
        microtileAllowed: false
      })
    ).toBe(false);
  });

  it("splits only after stalled refinement rounds", () => {
    const first = nextStalledRefinementRounds(1000, 900, 0);
    const second = nextStalledRefinementRounds(900, 850, first);
    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(
      shouldSplitTile({
        rect: { x: 0, y: 0, width: 128, height: 128 },
        lastUnresolvedCount: 900,
        unresolvedCount: 850,
        stalledRefinementRounds: second,
        pendingReferences: 0,
        referenceCount: 20,
        maxReferences: MAX_TILE_REFERENCES_LARGE,
        microtileAllowed: false
      })
    ).toBe(true);
  });

  it("does not split normal small tiles into one-pixel microtiles unless explicitly allowed", () => {
    expect(splitAxis(8, false)).toEqual([0, 8]);
    expect(splitAxis(8, true)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
