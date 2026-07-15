export const BASE_VIEW_WIDTH = 3.5;
export const TILE_SIZE = 128;
export const TEXTURE_CACHE_BYTES = 256 * 1024 * 1024;

export interface ViewState {
  re: string;
  im: string;
  scale: string;
  maxIter: number;
}

export interface RuntimeView extends ViewState {
  width: number;
  height: number;
  pixelRatio: number;
  revision: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TileDescriptor {
  id: string;
  rect: Rect;
  revision: number;
}

export interface ReferenceSnapshot {
  screenX: number;
  screenY: number;
  maxIterBoundedRadius: number;
  revision: number;
  orbitRe: Float64Array;
  orbitIm: Float64Array;
}

export interface RenderTileMessage {
  type: "renderTile";
  tile: TileDescriptor;
  pixelSpan: number;
  maxIter: number;
  reference: ReferenceSnapshot;
}

export interface PrepareReferenceMessage {
  type: "prepareReference";
  reference: ReferenceSnapshot;
}

export interface WarmupMessage {
  type: "warmup";
}

export interface TileStats {
  elapsedMs: number;
  escapedPixels: number;
  periodicInteriorCount: number;
  capHitUnknownCount: number;
  rebaseCount: number;
  scalarIterations: number;
  seriesSkip: number;
  certifiedInteriorCount: number;
  seriesBuildMs: number;
  blockCertMs: number;
  pixelLoopMs: number;
  postProcessMs: number;
  paletteFootprintCount: number;
  paletteFootprintFallbackCount: number;
  paletteFilteredCount: number;
  paletteProxyCount: number;
  maxPaletteFootprint: number;
  maxPaletteProxyLod: number;
}

export interface TileDoneMessage {
  type: "tileDone";
  tileId: string;
  revision: number;
  rect: Rect;
  width: number;
  height: number;
  rgba: ArrayBuffer;
  stats: TileStats;
}

export type TileWorkerInMessage = RenderTileMessage | PrepareReferenceMessage | WarmupMessage;
export type TileWorkerOutMessage = TileDoneMessage;
