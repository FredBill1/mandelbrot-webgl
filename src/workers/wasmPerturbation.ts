import init, { compute_reference, estimate_max_iter_bounded_radius, estimate_precision_bits, put_render_reference, render_tile_cached, render_tile_exact, reset_render_cache } from "../wasm/pkg/mandelbrot_wasm";
import type { ReferenceSnapshot, RenderTileMessage, TileDoneMessage } from "../types";
import type { RawReferenceResult } from "../reference/referenceClient";

interface CachedReferenceState {
  revision: number;
  nextId: number;
  ids: Map<string, number>;
}

const cacheState: CachedReferenceState = {
  revision: -1,
  nextId: 1,
  ids: new Map()
};

let ready: Promise<void> | undefined;

export async function computeReferenceWasm(input: {
  centerRe: string;
  centerIm: string;
  scale: string;
  maxIter: number;
  minPrecisionBits: number;
}): Promise<RawReferenceResult> {
  await initRenderWasm();
  const precisionBits = Math.max(input.minPrecisionBits, estimate_precision_bits(input.scale, input.maxIter));
  const raw = compute_reference(input.centerRe, input.centerIm, input.maxIter, precisionBits) as {
    center_re: string;
    center_im: string;
    precision_bits: number;
    escaped_at: number;
    orbit_re: Float64Array | number[];
    orbit_im: Float64Array | number[];
  };
  const orbitRe = raw.orbit_re instanceof Float64Array ? raw.orbit_re : new Float64Array(raw.orbit_re);
  const orbitIm = raw.orbit_im instanceof Float64Array ? raw.orbit_im : new Float64Array(raw.orbit_im);
  return {
    centerRe: raw.center_re,
    centerIm: raw.center_im,
    precisionBits: raw.precision_bits,
    escapedAt: raw.escaped_at,
    maxIterBoundedRadius: estimate_max_iter_bounded_radius(raw.escaped_at, input.maxIter, orbitRe, orbitIm),
    orbitRe,
    orbitIm
  };
}

export async function renderPerturbationTileWasm(message: RenderTileMessage): Promise<TileDoneMessage> {
  await initRenderWasm();
  syncRevision(message.tile.revision);
  if (message.renderMode === "exact") {
    const exactBaseRgba = message.exactBaseRgba ? new Uint8Array(message.exactBaseRgba) : new Uint8Array();
    const exactUnresolvedMask = message.exactUnresolvedMask ? new Uint8Array(message.exactUnresolvedMask) : new Uint8Array();
    const raw = render_tile_exact(
      message.tile.id,
      message.tile.revision,
      message.tile.rect.x,
      message.tile.rect.y,
      message.tile.rect.width,
      message.tile.rect.height,
      message.tile.centerRe,
      message.tile.centerIm,
      message.tile.centerScreenX,
      message.tile.centerScreenY,
      viewScaleForExact(message),
      message.canvasWidth,
      message.maxIter,
      estimate_precision_bits(viewScaleForExact(message), message.maxIter),
      exactBaseRgba,
      exactUnresolvedMask
    ) as TileDoneMessage;
    return {
      ...raw,
      rgba: normalizeRgbaBuffer(raw.rgba),
      unresolvedMask: normalizeOptionalBuffer(raw.unresolvedMask),
      stats: {
        ...raw.stats,
        maxEscapedIter: raw.stats.maxEscapedIter ?? 0,
        p95EscapedIter: raw.stats.p95EscapedIter ?? 0,
        nearCapEscapedCount: raw.stats.nearCapEscapedCount ?? 0,
        capHitUnknownCount: raw.stats.capHitUnknownCount ?? 0,
        capHitBoundaryCount: raw.stats.capHitBoundaryCount ?? 0,
        distanceEstimatedCount: raw.stats.distanceEstimatedCount ?? 0,
        paletteFilteredCount: raw.stats.paletteFilteredCount ?? 0,
        distanceColorizedCount: raw.stats.distanceColorizedCount ?? 0,
        boundaryCoverageCount: raw.stats.boundaryCoverageCount ?? 0,
        maxPaletteFootprint: raw.stats.maxPaletteFootprint ?? 0,
        referenceCacheMissCount: 0,
        exactFallbackPixels: raw.stats.exactFallbackPixels ?? raw.width * raw.height
      }
    };
  }

  const reference = message.reference;
  if (!reference) throw new Error("Perturbation render requires a view reference");
  const refIds = new Int32Array(1);
  let cacheMisses = 0;

  const key = referenceCacheKey(reference);
  let numericId = cacheState.ids.get(key);
  if (numericId === undefined) {
    numericId = cacheState.nextId;
    cacheState.nextId += 1;
    cacheState.ids.set(key, numericId);
    cacheMisses += 1;
    putReference(numericId, reference);
  }
  refIds[0] = numericId;

  const raw = render_tile_cached(
    message.tile.id,
    message.tile.revision,
    message.tile.rect.x,
    message.tile.rect.y,
    message.tile.rect.width,
    message.tile.rect.height,
    message.pixelSpan,
    message.maxIter,
    refIds,
    message.seriesDegree,
    message.renderMode,
    message.sampleStep,
    new Uint8Array(),
    new Uint8Array(),
    new Float32Array(),
    new Float32Array(),
    new Uint8Array()
  ) as TileDoneMessage;

  const rgba = normalizeRgbaBuffer(raw.rgba);
  return {
    ...raw,
    rgba,
    unresolvedMask: normalizeOptionalBuffer(raw.unresolvedMask),
    stats: {
      ...raw.stats,
      maxEscapedIter: raw.stats.maxEscapedIter ?? 0,
      p95EscapedIter: raw.stats.p95EscapedIter ?? 0,
      nearCapEscapedCount: raw.stats.nearCapEscapedCount ?? 0,
      capHitUnknownCount: raw.stats.capHitUnknownCount ?? 0,
      capHitBoundaryCount: raw.stats.capHitBoundaryCount ?? 0,
      distanceEstimatedCount: raw.stats.distanceEstimatedCount ?? 0,
      paletteFilteredCount: raw.stats.paletteFilteredCount ?? 0,
      distanceColorizedCount: raw.stats.distanceColorizedCount ?? 0,
      boundaryCoverageCount: raw.stats.boundaryCoverageCount ?? 0,
      maxPaletteFootprint: raw.stats.maxPaletteFootprint ?? 0,
      referenceCacheMissCount: (raw.stats.referenceCacheMissCount ?? 0) + cacheMisses,
      exactFallbackPixels: raw.stats.exactFallbackPixels ?? 0
    }
  };
}

function viewScaleForExact(message: RenderTileMessage): string {
  return (message as RenderTileMessage & { viewScale?: string }).viewScale ?? String(3.5 / (message.pixelSpan * Math.max(1, message.canvasWidth)));
}

export function resetWasmPerturbationCacheForTests(): void {
  cacheState.revision = -1;
  cacheState.nextId = 1;
  cacheState.ids.clear();
}

async function initRenderWasm(): Promise<void> {
  ready ??= init().then(() => undefined);
  await ready;
}

function syncRevision(revision: number): void {
  if (cacheState.revision === revision) return;
  reset_render_cache(revision);
  cacheState.revision = revision;
  cacheState.nextId = 1;
  cacheState.ids.clear();
}

function putReference(numericId: number, reference: ReferenceSnapshot): void {
  put_render_reference(
    numericId,
    reference.id,
    reference.screenX,
    reference.screenY,
    reference.escapedAt,
    reference.maxIter,
    reference.maxIterBoundedRadius,
    asFloat64(reference.orbitRe),
    asFloat64(reference.orbitIm)
  );
}

function referenceCacheKey(reference: ReferenceSnapshot): string {
  return `${reference.revision}|${reference.id}|${reference.screenX}|${reference.screenY}|${reference.escapedAt}|${reference.maxIter}|${reference.maxIterBoundedRadius}`;
}

function normalizeRgbaBuffer(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    if (view.buffer instanceof ArrayBuffer) {
      return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
        ? view.buffer
        : view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
    }
    const source = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const copy = new Uint8Array(source.byteLength);
    copy.set(source);
    return copy.buffer;
  }
  throw new Error("WASM render_tile_cached returned an invalid rgba buffer");
}

function normalizeOptionalBuffer(value: unknown): ArrayBuffer | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeRgbaBuffer(value);
}

function asFloat64(value: Float64Array | ArrayLike<number>): Float64Array {
  return value instanceof Float64Array ? value : Float64Array.from(value);
}
