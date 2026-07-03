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
  phase: "fast" | "full";
}

interface DefaultIterEstimate {
  recommendedIter: number;
  confidence: "high" | "low";
  phase: "fast" | "full";
  fastMs: number;
  fullMs: number;
  maxEscapedAt: number;
  cap: number;
  sampleCount: number;
  reason: string;
}

type ReferenceWorkerIn = ComputeReferenceIn | EstimateDefaultIterIn;

let ready: Promise<void> | undefined;

self.onmessage = async (event: MessageEvent<ReferenceWorkerIn>) => {
  try {
    ready ??= init().then(() => undefined);
    await ready;
    if (event.data.type === "estimateDefaultIter") {
      const estimate = estimateAdaptiveDefaultIter(event.data);
      self.postMessage({ type: "defaultIterDone", requestId: event.data.requestId, estimate });
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

function estimateAdaptiveDefaultIter(input: EstimateDefaultIterIn): DefaultIterEstimate {
  const started = performance.now();
  const points = input.phase === "fast" ? fastProbePoints() : fullProbePoints();
  let cap = Math.min(20_000, Math.max(4096, input.baseline * (input.phase === "full" ? 4 : 2)));
  let bestEscape = 0;
  let maxEscapedAt = 0;
  let sampleCount = 0;
  let nearCapHit = false;
  let reason = "baseline";

  for (let round = 0; round < 3; round += 1) {
    const precisionBits = estimate_precision_bits(input.scale, cap);
    const result = runProbePoints(input, points, cap, precisionBits);
    sampleCount += result.sampleCount;
    bestEscape = Math.max(bestEscape, result.bestEscape);
    maxEscapedAt = Math.max(maxEscapedAt, result.maxEscapedAt);
    nearCapHit ||= result.nearCapHit;
    if (!result.nearCapHit || cap >= 20_000) break;
    cap = Math.min(20_000, cap * 2);
    reason = "near-cap";
  }

  let recommendedIter = input.baseline;
  if (bestEscape > input.baseline) {
    recommendedIter = roundUp128(Math.ceil(bestEscape * (input.phase === "full" ? 1.35 : 1.2) + 512));
    reason = "escaped";
  } else if (nearCapHit) {
    recommendedIter = roundUp128(cap);
    reason = "near-cap";
  }
  recommendedIter = Math.min(20_000, Math.max(input.baseline, recommendedIter));

  const elapsed = performance.now() - started;
  const confidence = confidenceFor(input, recommendedIter, nearCapHit, reason);
  if (input.phase === "fast" && confidence === "low" && reason !== "baseline") {
    recommendedIter = Math.min(20_000, Math.max(recommendedIter, roundUp128(input.baseline * 4)));
  }
  return {
    recommendedIter,
    confidence,
    phase: input.phase,
    fastMs: input.phase === "fast" ? elapsed : 0,
    fullMs: input.phase === "full" ? elapsed : 0,
    maxEscapedAt,
    cap,
    sampleCount,
    reason
  };
}

function runProbePoints(
  input: EstimateDefaultIterIn,
  points: Array<{ fx: number; fy: number }>,
  cap: number,
  precisionBits: number
): { bestEscape: number; maxEscapedAt: number; nearCapHit: boolean; sampleCount: number } {
  let bestEscape = 0;
  let maxEscapedAt = 0;
  let nearCapHit = false;
  let sampleCount = 0;
  for (const pointFraction of points) {
    sampleCount += 1;
    const x = input.width * pointFraction.fx;
    const y = input.height * pointFraction.fy;
    const point = apply_view_transform(
      { re: input.re, im: input.im, scale: input.scale, width: input.width, height: input.height },
      -(x - input.width * 0.5),
      -(y - input.height * 0.5),
      1,
      input.width * 0.5,
      input.height * 0.5
    ) as { re: string; im: string };
    const escapedAt = direct_escape(point.re, point.im, cap, precisionBits);
    maxEscapedAt = Math.max(maxEscapedAt, escapedAt);
    if (escapedAt < cap && escapedAt >= cap * 0.85) nearCapHit = true;
    if (escapedAt > input.baseline && escapedAt < cap) bestEscape = Math.max(bestEscape, escapedAt);
    if (input.phase === "fast" && sampleCount >= 9 && (nearCapHit || bestEscape > input.baseline)) break;
  }
  return { bestEscape, maxEscapedAt, nearCapHit, sampleCount };
}

function confidenceFor(input: EstimateDefaultIterIn, recommendedIter: number, nearCapHit: boolean, reason: string): "high" | "low" {
  if (input.phase === "full") return "high";
  if (nearCapHit) return "low";
  if (reason === "baseline" && decimalLog10FromString(input.scale) >= 12) return "low";
  if (recommendedIter > input.baseline * 1.5) return "low";
  return "high";
}

function fastProbePoints(): Array<{ fx: number; fy: number }> {
  const points = [{ fx: 0.5, fy: 0.5 }];
  for (const radius of [0.18, 0.36]) {
    for (let index = 0; index < 8; index += 1) {
      const angle = (Math.PI * 2 * index) / 8;
      points.push({
        fx: clamp01(0.5 + Math.cos(angle) * radius),
        fy: clamp01(0.5 + Math.sin(angle) * radius)
      });
    }
  }
  return points;
}

function fullProbePoints(): Array<{ fx: number; fy: number }> {
  const fractions = [0.125, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.875];
  const points: Array<{ fx: number; fy: number }> = [];
  for (const fx of fractions) {
    for (const fy of fractions) points.push({ fx, fy });
  }
  return points;
}

function clamp01(value: number): number {
  return Math.max(0.02, Math.min(0.98, value));
}

function roundUp128(value: number): number {
  return Math.ceil(value / 128) * 128;
}

function decimalLog10FromString(value: string): number {
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(?:e([+-]?\d+))?$/i.exec(value.trim());
  if (!match) return 0;
  const mantissa = Math.abs(Number(match[1]));
  const exponent = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isFinite(mantissa) || mantissa === 0) return exponent;
  return Math.log10(mantissa) + exponent;
}
