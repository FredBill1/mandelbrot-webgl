import init, { apply_view_transform, compute_reference, direct_escape, estimate_precision_bits } from "../wasm/pkg/mandelbrot_wasm";

interface ComputeReferenceIn {
  type: "computeReference";
  requestId: number;
  centerRe: string;
  centerIm: string;
  scale: string;
  maxIter: number;
  minPrecisionBits: number;
}

interface EstimateDefaultIterIn {
  type: "estimateDefaultIter";
  requestId: number;
  re: string;
  im: string;
  scale: string;
  width: number;
  height: number;
  baseline: number;
}

type ReferenceWorkerIn = ComputeReferenceIn | EstimateDefaultIterIn;

let ready: Promise<void> | undefined;

self.onmessage = async (event: MessageEvent<ReferenceWorkerIn>) => {
  try {
    ready ??= init().then(() => undefined);
    await ready;
    if (event.data.type === "estimateDefaultIter") {
      const maxIter = estimateAdaptiveDefaultIter(event.data);
      self.postMessage({ type: "defaultIterDone", requestId: event.data.requestId, maxIter });
      return;
    }
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
    self.postMessage(
      {
        type: "referenceDone",
        requestId: event.data.requestId,
        reference: {
          centerRe: raw.center_re,
          centerIm: raw.center_im,
          precisionBits: raw.precision_bits,
          escapedAt: raw.escaped_at,
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

function estimateAdaptiveDefaultIter(input: EstimateDefaultIterIn): number {
  let cap = Math.min(20_000, Math.max(4096, input.baseline * 4));
  let bestEscape = 0;
  for (let round = 0; round < 3; round += 1) {
    const precisionBits = estimate_precision_bits(input.scale, cap);
    let roundBest = 0;
    let nearCapHit = false;
    for (const fx of probeFractions()) {
      for (const fy of probeFractions()) {
        const x = input.width * fx;
        const y = input.height * fy;
        const point = apply_view_transform(
          { re: input.re, im: input.im, scale: input.scale, width: input.width, height: input.height },
          -(x - input.width * 0.5),
          -(y - input.height * 0.5),
          1,
          input.width * 0.5,
          input.height * 0.5
        ) as { re: string; im: string };
        const escapedAt = direct_escape(point.re, point.im, cap, precisionBits);
        if (escapedAt >= cap * 0.85) nearCapHit = true;
        if (escapedAt > input.baseline && escapedAt < cap) roundBest = Math.max(roundBest, escapedAt);
      }
    }
    bestEscape = Math.max(bestEscape, roundBest);
    if (roundBest <= 0 && nearCapHit) return Math.min(20_000, roundUp128(cap));
    if (roundBest < cap * 0.85 || cap >= 20_000) break;
    cap = Math.min(20_000, cap * 2);
  }
  if (bestEscape <= input.baseline) return input.baseline;
  return Math.min(20_000, roundUp128(Math.ceil(bestEscape * 1.35 + 512)));
}

function probeFractions(): number[] {
  return [0.125, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.875];
}

function roundUp128(value: number): number {
  return Math.ceil(value / 128) * 128;
}
