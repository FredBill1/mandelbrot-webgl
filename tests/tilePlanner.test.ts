import { describe, expect, it } from "vitest";
import { createVisibleTiles } from "../src/tiles/tilePlanner";
import type { RuntimeView } from "../src/types";

describe("tile planner", () => {
  it("covers the viewport with a fixed grid", () => {
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
    const tiles = createVisibleTiles(view, 128);
    expect(tiles).toHaveLength(9);
    expect(tiles[0].rect).toEqual({ x: 0, y: 0, width: 128, height: 128 });
    expect(tiles.at(-1)?.rect).toEqual({ x: 256, y: 256, width: 44, height: 4 });
    expect(tiles[0].id).toBe("7:0:0:128:128");
    expect(new Set(tiles.map((tile) => tile.id)).size).toBe(tiles.length);
  });
});
