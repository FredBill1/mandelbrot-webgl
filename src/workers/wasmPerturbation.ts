import init, {
  compute_reference,
  estimate_max_iter_bounded_radius,
  estimate_precision_bits,
  render_tile,
  reset_render_cache,
  set_render_reference
} from "../wasm/pkg/mandelbrot_wasm";
import type { RawReferenceResult } from "../scheduler/workerPool";
import type { ReferenceSnapshot, RenderTileMessage, TileDoneMessage } from "../types";

let ready: Promise<void> | undefined;
let residentRevision = -1;
let hasResidentReference = false;

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
    escaped_at: number;
    orbit_re: Float64Array | number[];
    orbit_im: Float64Array | number[];
  };
  const orbitRe = asFloat64(raw.orbit_re);
  const orbitIm = asFloat64(raw.orbit_im);
  return {
    maxIterBoundedRadius: estimate_max_iter_bounded_radius(raw.escaped_at, input.maxIter, orbitRe, orbitIm),
    orbitRe,
    orbitIm
  };
}

export async function warmupWasm(): Promise<void> {
  await initRenderWasm();
}

export async function prepareReferenceWasm(reference: ReferenceSnapshot): Promise<void> {
  await initRenderWasm();
  syncRevision(reference.revision);
  putReference(reference);
}

export async function renderPerturbationTileWasm(message: RenderTileMessage): Promise<TileDoneMessage> {
  await initRenderWasm();
  syncRevision(message.tile.revision);
  if (message.reference.orbitRe.length > 0) putReference(message.reference);
  if (!hasResidentReference) throw new Error("tile worker has no resident view reference");
  const raw = render_tile(
    message.tile.id,
    message.tile.revision,
    message.tile.rect.x,
    message.tile.rect.y,
    message.tile.rect.width,
    message.tile.rect.height,
    message.pixelSpan,
    message.maxIter
  ) as TileDoneMessage;
  return { ...raw, rgba: normalizeRgbaBuffer(raw.rgba) };
}

export function resetWasmPerturbationCacheForTests(): void {
  residentRevision = -1;
  hasResidentReference = false;
}

async function initRenderWasm(): Promise<void> {
  ready ??= init().then(() => undefined);
  await ready;
}

function syncRevision(revision: number): void {
  if (residentRevision === revision) return;
  reset_render_cache();
  residentRevision = revision;
  hasResidentReference = false;
}

function putReference(reference: ReferenceSnapshot): void {
  set_render_reference(
    reference.screenX,
    reference.screenY,
    reference.maxIterBoundedRadius,
    asFloat64(reference.orbitRe),
    asFloat64(reference.orbitIm)
  );
  hasResidentReference = true;
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
    return Uint8Array.from(source).buffer;
  }
  throw new Error("WASM render_tile returned an invalid rgba buffer");
}

function asFloat64(value: Float64Array | ArrayLike<number>): Float64Array {
  return value instanceof Float64Array ? value : Float64Array.from(value);
}
