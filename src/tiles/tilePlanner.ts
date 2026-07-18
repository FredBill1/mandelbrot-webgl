import {
  TILE_SIZE,
  type Rect,
  type RuntimeView,
  type TileDescriptor
} from "../types";

export interface PlannedTile {
  tile: TileDescriptor;
}

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

export function planVisibleTiles(view: RuntimeView, tileSize = TILE_SIZE): PlannedTile[] {
  const centerX = view.width * 0.5;
  const centerY = view.height * 0.5;
  return createVisibleTiles(view, tileSize)
    .sort((a, b) => {
      const aX = a.rect.x + a.rect.width * 0.5 - centerX;
      const aY = a.rect.y + a.rect.height * 0.5 - centerY;
      const bX = b.rect.x + b.rect.width * 0.5 - centerX;
      const bY = b.rect.y + b.rect.height * 0.5 - centerY;
      const distance = aX * aX + aY * aY - (bX * bX + bY * bY);
      if (distance !== 0) return distance;
      if (a.rect.y !== b.rect.y) return a.rect.y - b.rect.y;
      return a.rect.x - b.rect.x;
    })
    .map((tile) => ({ tile }));
}
