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
  prepareTilesWasm,
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
    expect(first.stats.simdDualLaneSteps + first.stats.simdSingleLaneSteps).toBeGreaterThan(0);
    expect(first.stats.simdActiveLaneIterations).toBeGreaterThan(0);
    expect(first.stats.simdLaneUtilization).toBeGreaterThan(0);
    expect(first.stats.simdLaneUtilization).toBeLessThanOrEqual(1);
  });

  it("keeps eager and delayed derivative rendering byte-identical", async () => {
    const message = await makeMessage({
      re: "-7.5e-1",
      im: "1e-1",
      scale: "1",
      maxIter: 1200,
      width: 32,
      height: 24,
      revision: 21
    });
    const delayed = await renderPerturbationTileWasm(message);
    const eager = await renderPerturbationTileWasm({
      ...message,
      eagerDerivative: true,
      reference: { ...message.reference, orbitRe: new Float64Array(), orbitIm: new Float64Array() }
    });

    expect(new Uint8Array(eager.rgba)).toEqual(new Uint8Array(delayed.rgba));
    expect(eager.stats.escapedPixels).toBe(delayed.stats.escapedPixels);
    expect(eager.stats.periodicInteriorCount).toBe(delayed.stats.periodicInteriorCount);
    expect(eager.stats.capHitUnknownCount).toBe(delayed.stats.capHitUnknownCount);
  });

  it("keeps sub-ULP endpoint coordinates invariant across an exact 256-pixel reference shift", async () => {
    const common = {
      im: "0",
      scale: "4e15",
      maxIter: 10_000,
      width: 1912,
      height: 948
    } as const;
    const base = await makeMessage({
      ...common,
      re: "-2",
      revision: 31
    });
    const shifted = await makeMessage({
      ...common,
      re: "-2.000000000000000117154811715481169408760410616898562715065988865982549160804637722321785986423492432",
      revision: 32
    });
    const baseResult = await renderPerturbationTileWasm({
      ...base,
      tile: {
        id: "endpoint-base",
        rect: { x: 960, y: 300, width: 128, height: 4 },
        revision: base.tile.revision
      }
    });
    const shiftedResult = await renderPerturbationTileWasm({
      ...shifted,
      tile: {
        id: "endpoint-shifted",
        rect: { x: 1216, y: 300, width: 128, height: 4 },
        revision: shifted.tile.revision
      }
    });

    expect(shiftedResult.stats.escapedPixels).toBe(baseResult.stats.escapedPixels);
    expect(shiftedResult.stats.periodicInteriorCount).toBe(baseResult.stats.periodicInteriorCount);
    expect(shiftedResult.stats.capHitUnknownCount).toBe(baseResult.stats.capHitUnknownCount);
    const baseRgba = new Uint8Array(baseResult.rgba);
    const shiftedRgba = new Uint8Array(shiftedResult.rgba);
    let totalDifference = 0;
    let comparedChannels = 0;
    for (let offset = 0; offset < baseRgba.length; offset += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        totalDifference += Math.abs(baseRgba[offset + channel] - shiftedRgba[offset + channel]);
        comparedChannels += 1;
      }
      expect(shiftedRgba[offset + 3]).toBe(baseRgba[offset + 3]);
    }
    expect(totalDifference / comparedChannels).toBeLessThanOrEqual(1);
  });

  it("returns deterministic SIMD tile preparation hints", async () => {
    const message = await makeMessage({
      re: "-7.5e-1",
      im: "0",
      scale: "1",
      maxIter: 256,
      width: 128,
      height: 64,
      revision: 8
    });
    const prepareMessage = {
      type: "prepareTiles" as const,
      requestId: 1,
      revision: message.tile.revision,
      rects: [
        { x: 0, y: 0, width: 64, height: 64 },
        { x: 64, y: 0, width: 64, height: 64 }
      ],
      pixelSpan: message.pixelSpan,
      maxIter: message.maxIter,
      reference: message.reference
    };
    const first = await prepareTilesWasm(prepareMessage);
    const second = await prepareTilesWasm({
      ...prepareMessage,
      reference: { ...message.reference, orbitRe: new Float64Array(), orbitIm: new Float64Array() }
    });
    expect(Array.from(first.derivativeEagerScores)).toEqual(Array.from(second.derivativeEagerScores));
    expect(Array.from(first.seriesSkips)).toEqual(Array.from(second.seriesSkips));
    expect(Array.from(first.derivativeEagerScores).every((score) => score >= 0 && score <= 1)).toBe(true);
    expect(Array.from(first.seriesSkips).every((skip) => Number.isFinite(skip) && skip >= 0)).toBe(true);
  });

  it("certifies target periodic interiors without changing their RGBA", async () => {
    const message = await makeMessage({
      re: "-1.76854392069529079967435552147905380619071646671631558221721367158317146672961987405313343e0",
      im: "-7.30078926394540958134620082008361635055501804364889844988162485821612638368665062006680955e-4",
      scale: "5.16675442717597361866334085449662625942340146464132181028971962586112670232698885953242576e3",
      maxIter: 5000,
      width: 1912,
      height: 948,
      revision: 19
    });

    for (const [x, y] of [
      [704, 448],
      [1216, 448]
    ] as const) {
      const result = await renderPerturbationTileWasm({
        ...message,
        tile: {
          id: `periodic:${x}:${y}`,
          rect: { x, y, width: 3, height: 1 },
          revision: message.tile.revision
        }
      });
      expect(result.stats.periodicInteriorCount).toBeGreaterThan(0);
      expect(result.stats.escapedPixels + result.stats.periodicInteriorCount + result.stats.capHitUnknownCount).toBe(3);
      expect(Array.from(new Uint8Array(result.rgba))).toEqual([
        4, 8, 16, 255,
        4, 8, 16, 255,
        4, 8, 16, 255
      ]);
    }
  });

  it("falls back for the target center that escapes near iteration 226", async () => {
    const message = await makeMessage({
      re: "-1.76854392069529079967435552147905380619071646671631558221721367158317146672961987405313343e0",
      im: "-7.30078926394540958134620082008361635055501804364889844988162485821612638368665062006680955e-4",
      scale: "5.16675442717597361866334085449662625942340146464132181028971962586112670232698885953242576e3",
      maxIter: 5000,
      width: 1912,
      height: 948,
      revision: 20
    });
    const result = await renderPerturbationTileWasm({
      ...message,
      tile: {
        id: "escaping-center",
        rect: { x: 955.5, y: 473.5, width: 1, height: 1 },
        revision: message.tile.revision
      }
    });

    expect(result.stats.escapedPixels).toBe(1);
    expect(result.stats.periodicInteriorCount).toBe(0);
    expect(result.stats.capHitUnknownCount).toBe(0);
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
    width: view.width,
    height: view.height,
    maxIter: view.maxIter,
    minPrecisionBits: 128
  });
  const reference: ReferenceSnapshot = {
    revision: view.revision,
    screenX: raw.screenX,
    screenY: raw.screenY,
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
    eagerDerivative: false,
    reference
  };
}
