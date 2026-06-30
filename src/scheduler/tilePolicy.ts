import type { Rect } from "../types";

export const MAX_CLUSTER_REFERENCES_PER_PASS = 8;
export const FIRST_CLUSTER_REFERENCES = 4;
export const STALLED_CLUSTER_REFERENCES = 8;
export const MAX_TILE_REFERENCES_LARGE = 48;
export const MAX_TILE_REFERENCES_SMALL = 32;
export const MIN_NORMAL_SUBTILE_SIZE = 8;
export const MICROTILE_SIZE = 1;
export const MAX_NEW_SUBTILES_PER_FRAME = 256;
export const SPLIT_IMPROVEMENT_THRESHOLD = 0.25;
export const STALLED_ROUNDS_BEFORE_SPLIT = 2;

export function maxReferencesForRect(rect: Rect): number {
  const span = Math.max(rect.width, rect.height);
  return span >= 64 ? MAX_TILE_REFERENCES_LARGE : MAX_TILE_REFERENCES_SMALL;
}

export function clusterReferenceLimit(localReferenceRequests: number, stalledRefinementRounds: number): number {
  if (localReferenceRequests <= 0) return FIRST_CLUSTER_REFERENCES;
  if (stalledRefinementRounds <= 0) return FIRST_CLUSTER_REFERENCES;
  return STALLED_CLUSTER_REFERENCES;
}

export function unresolvedImprovement(previous: number | undefined, next: number): number {
  if (previous === undefined || previous <= 0) return 1;
  return Math.max(0, (previous - next) / previous);
}

export function nextStalledRefinementRounds(previous: number | undefined, next: number, currentStalledRounds: number): number {
  if (previous === undefined) return 0;
  return unresolvedImprovement(previous, next) < SPLIT_IMPROVEMENT_THRESHOLD ? currentStalledRounds + 1 : 0;
}

export function shouldSplitTile(input: {
  rect: Rect;
  lastUnresolvedCount: number | undefined;
  unresolvedCount: number;
  stalledRefinementRounds: number;
  pendingReferences: number;
  referenceCount: number;
  maxReferences: number;
  hasLocalRefinement: boolean;
  microtileAllowed: boolean;
}): boolean {
  if (!canSplitRect(input.rect)) return false;
  if (input.unresolvedCount <= 0) return false;
  if (input.pendingReferences > 0) return false;
  if (!input.hasLocalRefinement) return false;
  if (input.referenceCount < input.maxReferences && input.stalledRefinementRounds < STALLED_ROUNDS_BEFORE_SPLIT) return false;
  if (Math.max(input.rect.width, input.rect.height) <= MIN_NORMAL_SUBTILE_SIZE && !input.microtileAllowed) return false;
  return input.lastUnresolvedCount !== undefined;
}

export function canSplitRect(rect: Rect): boolean {
  return rect.width > MICROTILE_SIZE || rect.height > MICROTILE_SIZE;
}

export function splitAxis(length: number, allowMicrotile: boolean): number[] {
  if (length <= MICROTILE_SIZE) return [0, length];
  if (length <= MIN_NORMAL_SUBTILE_SIZE) {
    if (!allowMicrotile) return [0, length];
    const cuts = [0];
    for (let value = 1; value < length; value += 1) cuts.push(value);
    cuts.push(length);
    return cuts;
  }
  return [0, Math.floor(length * 0.5), length];
}
