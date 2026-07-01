import init, { put_render_reference, render_tile_cached, reset_render_cache } from "../wasm/pkg/mandelbrot_wasm";
import type { ReferenceSnapshot, RenderTileMessage, TileDoneMessage } from "../types";

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

export async function renderPerturbationTileWasm(message: RenderTileMessage): Promise<TileDoneMessage> {
  await initRenderWasm();
  syncRevision(message.tile.revision);
  const refIds = new Int32Array(message.references.length);
  let cacheMisses = 0;

  for (let index = 0; index < message.references.length; index += 1) {
    const reference = message.references[index];
    const key = referenceCacheKey(reference);
    let numericId = cacheState.ids.get(key);
    if (numericId === undefined) {
      numericId = cacheState.nextId;
      cacheState.nextId += 1;
      cacheState.ids.set(key, numericId);
      cacheMisses += 1;
      putReference(numericId, reference);
    }
    refIds[index] = numericId;
  }

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
    message.sampleStep
  ) as TileDoneMessage;

  const rgba = normalizeRgbaBuffer(raw.rgba);
  return {
    ...raw,
    rgba,
    stats: {
      ...raw.stats,
      referenceCacheMissCount: (raw.stats.referenceCacheMissCount ?? 0) + cacheMisses
    }
  };
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
    asFloat64(reference.orbitRe),
    asFloat64(reference.orbitIm)
  );
}

function referenceCacheKey(reference: ReferenceSnapshot): string {
  return `${reference.revision}|${reference.id}|${reference.screenX}|${reference.screenY}|${reference.escapedAt}|${reference.maxIter}`;
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

function asFloat64(value: Float64Array | ArrayLike<number>): Float64Array {
  return value instanceof Float64Array ? value : Float64Array.from(value);
}
