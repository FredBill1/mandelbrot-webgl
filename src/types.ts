export const BASE_VIEW_WIDTH = 3.5;
export const TILE_SIZE = 128;
export const TEXTURE_CACHE_BYTES = 256 * 1024 * 1024;
export const REFERENCE_CACHE_SOFT_BYTES = 128 * 1024 * 1024;
export const SERIES_DEGREE = 12;

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
  interiorRadius: number;
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
  viewScale?: string;
  pixelSpan: number;
  maxIter: number;
  references: ReferenceSnapshot[];
  seriesDegree: number;
  paletteId: string;
  refined: boolean;
  refinementLevel: number;
  renderMode: "preview" | "final" | "exact";
  sampleStep: number;
  exactBaseRgba?: ArrayBuffer;
  exactUnresolvedMask?: ArrayBuffer;
  refinementBaseRgba?: ArrayBuffer;
  refinementUnresolvedMask?: ArrayBuffer;
  refinementSmoothValues?: ArrayBuffer;
  refinementEscapedMask?: ArrayBuffer;
}

export type FailureKind = "earlyReferenceEscape" | "cancellationGlitch" | "deltaOverflow" | "rebaseLimit" | "seriesUnsafe";

export type FailureKindCounts = Record<FailureKind, number>;

export interface UnresolvedCluster {
  screenX: number;
  screenY: number;
  pixelCount: number;
  survivedIter: number;
  radiusPx: number;
  binX: number;
  binY: number;
  bounds: Rect;
  bestSurvivedIter?: number;
  sourceReferenceId?: string;
  failureKindCounts?: FailureKindCounts;
  suggestedPrecisionBits?: number;
}

export interface TileStats {
  elapsedMs: number;
  glitchCount: number;
  unresolvedCount: number;
  escapedPixels: number;
  periodicInteriorCount: number;
  maxEscapedIter: number;
  p95EscapedIter: number;
  nearCapEscapedCount: number;
  capHitUnknownCount: number;
  capHitBoundaryCount: number;
  rebaseCount: number;
  rebaseLimitCount: number;
  blaSkipCount: number;
  blaStepCount: number;
  referenceCacheMissCount: number;
  seriesSkip: number;
  boundaryDampenedCount: number;
  aaPixelCount: number;
  aaSampleCount: number;
  aaFallbackCount: number;
  referenceId: string;
  referenceIdsUsed: string[];
  unresolvedScreenX: number | undefined;
  unresolvedScreenY: number | undefined;
  unresolvedClusters: UnresolvedCluster[];
  preview: boolean;
  renderMode: "preview" | "final" | "exact";
  exactFallbackPixels: number;
}

export interface TileDoneMessage {
  type: "tileDone";
  tileId: string;
  revision: number;
  rect: Rect;
  width: number;
  height: number;
  rgba: ArrayBuffer;
  unresolvedMask?: ArrayBuffer;
  refinementSmoothValues?: ArrayBuffer;
  refinementEscapedMask?: ArrayBuffer;
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

export type TileWorkerInMessage = RenderTileMessage;
export type TileWorkerOutMessage = TileDoneMessage | NeedReferenceMessage;
