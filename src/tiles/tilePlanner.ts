import { TILE_SIZE, type Rect, type RuntimeView, type TileDescriptor } from "../types";

export function createVisibleTiles(view: RuntimeView, tileSize = TILE_SIZE): TileDescriptor[] {
  const tiles: TileDescriptor[] = [];
  for (let y = 0; y < view.height; y += tileSize) {
    for (let x = 0; x < view.width; x += tileSize) {
      const rect: Rect = {
        x,
        y,
        width: Math.min(tileSize, view.width - x),
        height: Math.min(tileSize, view.height - y)
      };
      tiles.push({
        id: `${view.revision}:${x}:${y}:${rect.width}:${rect.height}`,
        rect,
        revision: view.revision
      });
    }
  }
  return tiles;
}
