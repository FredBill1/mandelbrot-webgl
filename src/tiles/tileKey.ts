import { TILE_SIZE, type Rect, type RuntimeView, type TileDescriptor, type TileKey } from "../types";
import { decimalLog2 } from "../math/view";

export function tileKeyToId(key: TileKey, revision: number): string {
  return `${revision}:${key.level}:${key.x}:${key.y}:${key.span}`;
}

export function createVisibleTileShells(view: RuntimeView, tileSize = TILE_SIZE): Array<Omit<TileDescriptor, "centerRe" | "centerIm">> {
  const level = Math.max(0, Math.floor(decimalLog2(view.scale)));
  const tiles: Array<Omit<TileDescriptor, "centerRe" | "centerIm">> = [];

  for (let y = 0; y < view.height; y += tileSize) {
    for (let x = 0; x < view.width; x += tileSize) {
      const rect: Rect = {
        x,
        y,
        width: Math.min(tileSize, view.width - x),
        height: Math.min(tileSize, view.height - y)
      };
      const key: TileKey = {
        level,
        x: Math.floor((x - view.width * 0.5) / tileSize),
        y: Math.floor((y - view.height * 0.5) / tileSize),
        span: tileSize
      };
      tiles.push({
        id: tileKeyToId(key, view.revision),
        key,
        rect,
        centerScreenX: rect.x + rect.width * 0.5,
        centerScreenY: rect.y + rect.height * 0.5,
        revision: view.revision
      });
    }
  }

  return tiles;
}
