import { describe, expect, it } from "vitest";
import { createVisibleTileShells, tileKeyToId } from "../src/tiles/tileKey";
import type { RuntimeView } from "../src/types";

describe("tile planner", () => {
  it("covers the viewport with local quadtree-style keys", () => {
    const view: RuntimeView = {
      re: "-0.5",
      im: "0",
      scale: "4",
      maxIter: 512,
      width: 300,
      height: 260,
      pixelRatio: 1,
      revision: 7
    };
    const tiles = createVisibleTileShells(view, 128);
    expect(tiles).toHaveLength(9);
    expect(tiles[0].rect).toEqual({ x: 0, y: 0, width: 128, height: 128 });
    expect(tiles.at(-1)?.rect).toEqual({ x: 256, y: 256, width: 44, height: 4 });
    expect(tileKeyToId(tiles[0].key, view.revision)).toBe(tiles[0].id);
    expect(tiles[0].key.level).toBe(2);
  });
});
