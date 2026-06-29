import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import init, { compute_reference, direct_escape } from "../src/wasm/pkg/mandelbrot_wasm";
import { renderPerturbationTile } from "../src/workers/perturbation";
import type { ReferenceSnapshot, RenderTileMessage, TileDescriptor } from "../src/types";

beforeAll(async () => {
  const wasm = readFileSync(new URL("../src/wasm/pkg/mandelbrot_wasm_bg.wasm", import.meta.url));
  await init({ module_or_path: wasm });
});

describe("perturbation renderer", () => {
  it.each([
    ["shallow", "3e-1", "5e-1", "1", 128],
    ["1e20", "-7.43643887037158704752191506114774e-1", "1.31825904205311970493132056385139e-1", "1e20", 256],
    ["1e60", "-7.43643887037158704752191506114774e-1", "1.31825904205311970493132056385139e-1", "1e60", 384],
    ["1e100", "-7.43643887037158704752191506114774e-1", "1.31825904205311970493132056385139e-1", "1e100", 512]
  ])("matches direct high-precision escape at the reference center for %s", (_name, re, im, scale, precisionBits) => {
    const maxIter = 64;
    const escaped = direct_escape(re, im, maxIter, precisionBits);
    const reference = makeReference(re, im, maxIter, precisionBits);
    const tile = makeCenterTile(re, im);
    const message: RenderTileMessage = {
      type: "renderTile",
      tile,
      canvasWidth: 1,
      canvasHeight: 1,
      pixelSpan: 3.5 / Number(scale) || 3.5e-100,
      maxIter,
      reference,
      seriesDegree: 8,
      paletteId: "cosine",
      refined: true
    };
    const result = renderPerturbationTile(message);
    expect(result.stats.escapedPixels).toBe(escaped < maxIter ? 1 : 0);
    expect(result.stats.seriesSkip).toBeGreaterThanOrEqual(0);
  });
});

function makeReference(re: string, im: string, maxIter: number, precisionBits: number): ReferenceSnapshot {
  const raw = compute_reference(re, im, maxIter, precisionBits) as {
    center_re: string;
    center_im: string;
    precision_bits: number;
    escaped_at: number;
    orbit_re: number[];
    orbit_im: number[];
  };
  return {
    id: "test-ref",
    centerRe: raw.center_re,
    centerIm: raw.center_im,
    screenX: 0.5,
    screenY: 0.5,
    precisionBits: raw.precision_bits,
    escapedAt: raw.escaped_at,
    maxIter,
    revision: 1,
    orbitRe: new Float64Array(raw.orbit_re),
    orbitIm: new Float64Array(raw.orbit_im)
  };
}

function makeCenterTile(re: string, im: string): TileDescriptor {
  return {
    id: "test-tile",
    key: { level: 0, x: 0, y: 0, span: 1 },
    rect: { x: 0, y: 0, width: 1, height: 1 },
    centerScreenX: 0.5,
    centerScreenY: 0.5,
    centerRe: re,
    centerIm: im,
    revision: 1
  };
}
