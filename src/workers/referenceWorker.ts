import init, { compute_reference, estimate_max_iter_bounded_radius, estimate_precision_bits } from "../wasm/pkg/mandelbrot_wasm";

interface ComputeReferenceIn {
  type: "computeReference";
  requestId: number;
  centerRe: string;
  centerIm: string;
  scale: string;
  maxIter: number;
  minPrecisionBits: number;
}

let ready: Promise<void> | undefined;

self.onmessage = async (event: MessageEvent<ComputeReferenceIn>) => {
  try {
    ready ??= init().then(() => undefined);
    await ready;
    if (event.data.type !== "computeReference") return;
    const precisionBits = Math.max(event.data.minPrecisionBits, estimate_precision_bits(event.data.scale, event.data.maxIter));
    const raw = compute_reference(event.data.centerRe, event.data.centerIm, event.data.maxIter, precisionBits) as {
      center_re: string;
      center_im: string;
      precision_bits: number;
      escaped_at: number;
      orbit_re: Float64Array | number[];
      orbit_im: Float64Array | number[];
    };
    const orbitRe = raw.orbit_re instanceof Float64Array ? raw.orbit_re : new Float64Array(raw.orbit_re);
    const orbitIm = raw.orbit_im instanceof Float64Array ? raw.orbit_im : new Float64Array(raw.orbit_im);
    const maxIterBoundedRadius = estimate_max_iter_bounded_radius(raw.escaped_at, event.data.maxIter, orbitRe, orbitIm);
    self.postMessage(
      {
        type: "referenceDone",
        requestId: event.data.requestId,
        reference: {
          centerRe: raw.center_re,
          centerIm: raw.center_im,
          precisionBits: raw.precision_bits,
          escapedAt: raw.escaped_at,
          maxIterBoundedRadius,
          orbitRe,
          orbitIm
        }
      },
      [orbitRe.buffer, orbitIm.buffer]
    );
  } catch (error) {
    self.postMessage({
      type: "referenceError",
      requestId: event.data.requestId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
};
