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
      refined: true,
      refinementLevel: 1
    };
    const result = renderPerturbationTile(message);
    expect(result.stats.escapedPixels).toBe(escaped < maxIter ? 1 : 0);
    expect(result.stats.seriesSkip).toBeGreaterThanOrEqual(0);
  });

  it("does not use unsafe series skips for the reported scale-27 regression", () => {
    const view = {
      re: "-7.5357439432760979567799292092358849408631766136639749629881847491270958924729797e-1",
      im: "4.1829098796254371047848652422265196230273460832374920810175261015280261764135947e-2",
      scale: "2.7112638920657753457314574878835803145383223195308304348976984034375546586792402e1",
      maxIter: 604
    };
    const screen = { x: (15.5 / 32) * 1912, y: (12.5 / 16) * 948 };
    const point = pointAtScreen(view, screen.x, screen.y);
    const direct = direct_escape(point.re, point.im, view.maxIter, 192);
    const reference = makeReference(view.re, view.im, view.maxIter, 192, 1912 * 0.5, 948 * 0.5);

    const result = renderSinglePixel(view, point, screen.x, screen.y, reference, 0);

    expect(result.stats.seriesSkip).toBe(0);
    expect(result.stats.unresolvedCount).toBe(0);
    expect(result.stats.escapedPixels).toBe(direct < view.maxIter ? 1 : 0);
  });

  it("marks pixels unresolved instead of interior when the selected reference escapes early", () => {
    const view = {
      re: "-7.549229970244027197908742917925261755751044636618703913223906199716382497449534e-1",
      im: "5.320534885440088329282320858070240068704121711152834282354886837408395062921113e-2",
      scale: "1.3394307643944097352319707599505029862713399693759721188427992474105938471591505e3",
      maxIter: 713
    };
    const screen = { x: 1912 * 0.5, y: 948 * 0.15 };
    const point = pointAtScreen(view, screen.x, screen.y);
    const direct = direct_escape(point.re, point.im, view.maxIter, 224);
    const reference = makeReference(view.re, view.im, view.maxIter, 224, 1912 * 0.5, 948 * 0.5);
    expect(reference.escapedAt).toBeLessThan(view.maxIter);
    expect(direct).toBeLessThan(view.maxIter);

    const result = renderSinglePixel(view, point, screen.x, screen.y, reference, 0);

    expect(result.stats.unresolvedCount).toBe(1);
    expect(result.needsReference).toBe(true);
    expect(result.stats.escapedPixels).toBe(0);
  });

  it("resolves the early-reference regression pixel after rebasing to that location", () => {
    const view = {
      re: "-7.549229970244027197908742917925261755751044636618703913223906199716382497449534e-1",
      im: "5.320534885440088329282320858070240068704121711152834282354886837408395062921113e-2",
      scale: "1.3394307643944097352319707599505029862713399693759721188427992474105938471591505e3",
      maxIter: 713
    };
    const screen = { x: 1912 * 0.5, y: 948 * 0.15 };
    const point = pointAtScreen(view, screen.x, screen.y);
    const direct = direct_escape(point.re, point.im, view.maxIter, 224);
    const reference = makeReference(point.re, point.im, view.maxIter, 224, screen.x, screen.y);

    const result = renderSinglePixel(view, point, screen.x, screen.y, reference, 1);

    expect(direct).toBeLessThan(view.maxIter);
    expect(result.stats.unresolvedCount).toBe(0);
    expect(result.stats.escapedPixels).toBe(1);
  });
});

function makeReference(re: string, im: string, maxIter: number, precisionBits: number, screenX = 0.5, screenY = 0.5): ReferenceSnapshot {
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
    screenX,
    screenY,
    precisionBits: raw.precision_bits,
    escapedAt: raw.escaped_at,
    maxIter,
    revision: 1,
    orbitRe: new Float64Array(raw.orbit_re),
    orbitIm: new Float64Array(raw.orbit_im)
  };
}

function renderSinglePixel(
  view: { re: string; im: string; scale: string; maxIter: number },
  point: { re: string; im: string },
  screenX: number,
  screenY: number,
  reference: ReferenceSnapshot,
  refinementLevel: number
) {
  const tile: TileDescriptor = {
    id: "sample-tile",
    key: { level: 0, x: 0, y: 0, span: 1 },
    rect: { x: screenX - 0.5, y: screenY - 0.5, width: 1, height: 1 },
    centerScreenX: screenX,
    centerScreenY: screenY,
    centerRe: point.re,
    centerIm: point.im,
    revision: 1
  };
  const message: RenderTileMessage = {
    type: "renderTile",
    tile,
    canvasWidth: 1912,
    canvasHeight: 948,
    pixelSpan: pixelSpan(view.scale, 1912),
    maxIter: view.maxIter,
    reference,
    seriesDegree: 8,
    paletteId: "cosine",
    refined: refinementLevel > 0,
    refinementLevel
  };
  return renderPerturbationTile(message);
}

function pointAtScreen(view: { re: string; im: string; scale: string }, x: number, y: number): { re: string; im: string } {
  const span = pixelSpan(view.scale, 1912);
  const re = Number(view.re) + (x - 1912 * 0.5) * span;
  const im = Number(view.im) + (y - 948 * 0.5) * span;
  return { re: re.toPrecision(18), im: im.toPrecision(18) };
}

function pixelSpan(scale: string, width: number): number {
  return 3.5 / (Number(scale) * width);
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
