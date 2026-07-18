import { describe, expect, it } from "vitest";
import { createVisibleTiles, planVisibleTiles } from "../src/tiles/tilePlanner";
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

  it("keeps the 1912x948 performance viewport on a fixed 128-pixel grid", () => {
    const view: RuntimeView = {
      re: "-0.5",
      im: "0",
      scale: "4",
      maxIter: 512,
      width: 1912,
      height: 948,
      pixelRatio: 1,
      revision: 9
    };
    const planned = planVisibleTiles(view, 128);

    expect(planned).toHaveLength(120);
    expect(planned.every(({ tile }) => tile.rect.width === 128 || tile.rect.x === 1792)).toBe(true);
    expect(planned.every(({ tile }) => tile.rect.height === 128 || tile.rect.y === 896)).toBe(true);
    const coverage = new Uint8Array(view.width * view.height);
    for (const { tile } of planned) {
      for (let y = tile.rect.y; y < tile.rect.y + tile.rect.height; y += 1) {
        for (let x = tile.rect.x; x < tile.rect.x + tile.rect.width; x += 1) coverage[y * view.width + x] += 1;
      }
    }
    expect(coverage.every((value) => value === 1)).toBe(true);
    expect(new Set(planned.map(({ tile }) => tile.id)).size).toBe(planned.length);
  });

  it("uses deterministic center-first ordering and coordinate tie breakers", () => {
    const view: RuntimeView = {
      re: "-0.5",
      im: "0",
      scale: "4",
      maxIter: 64,
      width: 256,
      height: 128,
      pixelRatio: 1,
      revision: 10
    };
    const first = planVisibleTiles(view, 128);
    const second = planVisibleTiles(view, 128);
    expect(first.map(({ tile }) => tile.id)).toEqual(second.map(({ tile }) => tile.id));
    expect(first.map(({ tile }) => tile.rect.x)).toEqual([0, 128]);
  });
});
