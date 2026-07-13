import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import init, {
  apply_view_transform,
  compute_reference,
  estimate_max_iter_bounded_radius,
  estimate_precision_bits
} from "../src/wasm/pkg/mandelbrot_wasm";
import {
  computeReferenceWasm,
  renderPerturbationTileWasm,
  resetWasmPerturbationCacheForTests
} from "../src/workers/wasmPerturbation";
import type { ReferenceSnapshot, RenderTileMessage } from "../src/types";

beforeAll(async () => {
  const wasm = readFileSync(new URL("../src/wasm/pkg/mandelbrot_wasm_bg.wasm", import.meta.url));
  await init({ module_or_path: wasm });
});

beforeEach(() => resetWasmPerturbationCacheForTests());

describe("single perturbation path", () => {
  it("computes the production sparse reference orbit", () => {
    const raw = compute_reference("2", "0", 64, 128) as {
      escaped_at: number;
      orbit_re: Float64Array;
      orbit_im: Float64Array;
    };
    expect(raw.escaped_at).toBe(2);
    expect(Array.from(raw.orbit_re)).toEqual([0, 2, 6]);
    expect(Array.from(raw.orbit_im)).toEqual([0, 0, 0]);
  });

  it("produces a conservative interior certificate only for bounded references", () => {
    const bounded = new Float64Array(65);
    expect(estimate_max_iter_bounded_radius(64, 64, bounded, bounded)).toBeGreaterThan(0);
    expect(estimate_max_iter_bounded_radius(2, 64, new Float64Array([0, 1]), new Float64Array([0, 0]))).toBe(0);
  });

  it("increases reference precision with zoom depth", () => {
    expect(estimate_precision_bits("1e100", 4096)).toBeGreaterThan(estimate_precision_bits("1", 4096));
  });

  it("renders final RGBA tiles through one resident reference", async () => {
    const message = await makeMessage({
      re: "-7.5e-1",
      im: "0",
      scale: "1",
      maxIter: 256,
      width: 32,
      height: 24,
      revision: 7
    });
    const first = await renderPerturbationTileWasm(message);
    const second = await renderPerturbationTileWasm({
      ...message,
      reference: { ...message.reference, orbitRe: new Float64Array(), orbitIm: new Float64Array() }
    });

    expect(first.rgba.byteLength).toBe(32 * 24 * 4);
    expect(new Uint8Array(second.rgba)).toEqual(new Uint8Array(first.rgba));
    expect(first.stats.escapedPixels + first.stats.capHitUnknownCount + first.stats.periodicInteriorCount).toBe(32 * 24);
    expect(first.stats.rebaseCount).toBeGreaterThan(0);
    expect(first.stats.seriesSkip).toBeGreaterThanOrEqual(0);
  });

  it("keeps high-precision view transforms finite at 1e100", () => {
    const transformed = apply_view_transform(
      { re: "-0.75", im: "0.1", scale: "1e100", width: 1912, height: 948 },
      12,
      -7,
      1.25,
      956,
      474
    ) as { re: string; im: string; scale: string };
    expect(transformed.re).toMatch(/e/);
    expect(transformed.im).toMatch(/e/);
    expect(transformed.scale).toContain("1.25");
  });
});

async function makeMessage(view: {
  re: string;
  im: string;
  scale: string;
  maxIter: number;
  width: number;
  height: number;
  revision: number;
}): Promise<RenderTileMessage> {
  const raw = await computeReferenceWasm({
    centerRe: view.re,
    centerIm: view.im,
    scale: view.scale,
    maxIter: view.maxIter,
    minPrecisionBits: 128
  });
  const reference: ReferenceSnapshot = {
    revision: view.revision,
    screenX: view.width * 0.5,
    screenY: view.height * 0.5,
    maxIterBoundedRadius: raw.maxIterBoundedRadius,
    orbitRe: raw.orbitRe,
    orbitIm: raw.orbitIm
  };
  return {
    type: "renderTile",
    tile: {
      id: `${view.revision}:0:0:${view.width}:${view.height}`,
      rect: { x: 0, y: 0, width: view.width, height: view.height },
      revision: view.revision
    },
    pixelSpan: 3.5 / (Number(view.scale) * view.width),
    maxIter: view.maxIter,
    reference
  };
}
