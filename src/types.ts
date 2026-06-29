export const BASE_VIEW_WIDTH = 3.5;
export const TILE_SIZE = 128;
export const TEXTURE_CACHE_BYTES = 256 * 1024 * 1024;
export const SERIES_DEGREE = 8;

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

export interface TileKey {
  level: number;
  x: number;
  y: number;
  span: number;
}

export interface TileDescriptor {
  id: string;
  key: TileKey;
  rect: Rect;
  centerScreenX: number;
  centerScreenY: number;
  centerRe: string;
  centerIm: string;
  revision: number;
}

export interface ReferenceSnapshot {
  id: string;
  centerRe: string;
  centerIm: string;
  screenX: number;
  screenY: number;
  precisionBits: number;
  escapedAt: number;
  maxIter: number;
  revision: number;
  orbitRe: Float64Array;
  orbitIm: Float64Array;
}

export interface RenderTileMessage {
  type: "renderTile";
  tile: TileDescriptor;
  canvasWidth: number;
  canvasHeight: number;
  pixelSpan: number;
  maxIter: number;
  reference: ReferenceSnapshot;
  seriesDegree: number;
  paletteId: string;
  refined: boolean;
  refinementLevel: number;
}

export interface TileStats {
  elapsedMs: number;
  glitchCount: number;
  unresolvedCount: number;
  escapedPixels: number;
  seriesSkip: number;
  referenceId: string;
  unresolvedScreenX: number | undefined;
  unresolvedScreenY: number | undefined;
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
  needsReference: boolean;
}

export interface NeedReferenceMessage {
  type: "needReference";
  tile: TileDescriptor;
  requiredPrecision: number;
  maxIter: number;
  targetScreenX: number;
  targetScreenY: number;
  refinementLevel: number;
  sourceReferenceId: string;
}

export type TileWorkerOutMessage = TileDoneMessage | NeedReferenceMessage;
