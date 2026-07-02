import { describe, expect, it } from "vitest";
import {
  clusterReferenceLimit,
  FIRST_CLUSTER_REFERENCES,
  maxReferencesForRect,
  MAX_CLUSTER_REFERENCES_PER_PASS,
  MAX_TILE_REFERENCES_LARGE,
  MAX_TILE_REFERENCES_SMALL,
  nextStalledRefinementRounds,
  shouldSplitTile,
  STALLED_CLUSTER_REFERENCES,
  splitAxis
} from "../src/scheduler/tilePolicy";

describe("tile refinement policy", () => {
  it("uses larger reference budgets for large tiles", () => {
    expect(maxReferencesForRect({ x: 0, y: 0, width: 128, height: 128 })).toBe(MAX_TILE_REFERENCES_LARGE);
    expect(maxReferencesForRect({ x: 0, y: 0, width: 32, height: 16 })).toBe(MAX_TILE_REFERENCES_SMALL);
  });

  it("ramps cluster reference requests in stages", () => {
    expect(clusterReferenceLimit(0, 0)).toBe(FIRST_CLUSTER_REFERENCES);
    expect(clusterReferenceLimit(2, 0)).toBe(FIRST_CLUSTER_REFERENCES);
    expect(clusterReferenceLimit(2, 1)).toBe(STALLED_CLUSTER_REFERENCES);
    expect(clusterReferenceLimit(2, 2)).toBe(MAX_CLUSTER_REFERENCES_PER_PASS);
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
        hasLocalRefinement: true,
        microtileAllowed: false
      })
    ).toBe(false);
  });

  it("does not split after stalled refinement rounds; exact fallback owns termination", () => {
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
        hasLocalRefinement: true,
        microtileAllowed: false
      })
    ).toBe(false);
  });

  it("does not split just because global candidates fill the render list", () => {
    expect(
      shouldSplitTile({
        rect: { x: 0, y: 0, width: 128, height: 128 },
        lastUnresolvedCount: 1000,
        unresolvedCount: 900,
        stalledRefinementRounds: 2,
        pendingReferences: 0,
        referenceCount: MAX_TILE_REFERENCES_LARGE,
        maxReferences: MAX_TILE_REFERENCES_LARGE,
        hasLocalRefinement: false,
        microtileAllowed: false
      })
    ).toBe(false);
  });

  it("does not split normal small tiles into one-pixel microtiles unless explicitly allowed", () => {
    expect(splitAxis(8, false)).toEqual([0, 8]);
    expect(splitAxis(8, true)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
