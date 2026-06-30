import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import init, { apply_view_transform, compute_reference, direct_escape } from "../src/wasm/pkg/mandelbrot_wasm";
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
      references: [reference],
      seriesDegree: 8,
      paletteId: "cosine",
      refined: true,
      refinementLevel: 1,
      renderMode: "final",
      sampleStep: 1
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

  it.each([
    [
      "near-real scale-15",
      {
        re: "-1.7195312667941079545586189454398113271069746647515813505680542504632787025805573e0",
        im: "6.5505858903810377100204901499228868589789948177206009920848026920443700420219874e-4",
        scale: "1.4879731724872819376827096167093147183191284045682361153628693061499318199119286e1",
        maxIter: 588
      },
      { x: 624, y: 624 }
    ],
    [
      "near-real scale-299",
      {
        re: "-1.7837703627058171488767894782491136871879847141256353015158193606747347767684793e0",
        im: "5.5357063425251600676626417761698877134903352475830355358631008611595013848605954e-4",
        scale: "2.9886740096705962489052976484705668623645989664805902945876196244325516986288952e2",
        maxIter: 671
      },
      { x: 624, y: 336 }
    ]
  ])("resolves %s with accumulated references instead of staying unresolved", (_name, view, screen) => {
    const point = pointAtScreen(view, screen.x, screen.y);
    const direct = direct_escape(point.re, point.im, view.maxIter, 224);
    const centerReference = makeReference(view.re, view.im, view.maxIter, 224, 1912 * 0.5, 948 * 0.5);
    const pointReference = makeReference(point.re, point.im, view.maxIter, 224, screen.x, screen.y);

    const unresolved = renderSinglePixelWithReferences(view, point, screen.x, screen.y, [centerReference], 0);
    expect(centerReference.escapedAt).toBeLessThan(direct);
    expect(unresolved.stats.unresolvedCount).toBe(1);
    expect(unresolved.stats.unresolvedClusters.length).toBeGreaterThan(0);

    const resolved = renderSinglePixelWithReferences(view, point, screen.x, screen.y, [centerReference, pointReference], 1);
    expect(resolved.stats.unresolvedCount).toBe(0);
    expect(resolved.stats.escapedPixels).toBe(direct < view.maxIter ? 1 : 0);
  });

  it("uses adaptive unresolved clusters for the 1170x784 near-real performance regression", () => {
    const view = {
      re: "-1.5737407486227469252433174706063197673796016133716925506497393696303123079866005e0",
      im: "2.3298749061632902966620424763943810032963152815290060660675502164545864497691752e-5",
      scale: "5.166754427175971621093750355246036136162467976203352006225560442836867743195112e3",
      maxIter: 750
    };
    const reference = makeReference(view.re, view.im, view.maxIter, 224, 1170 * 0.5, 784 * 0.5);
    const tile: TileDescriptor = {
      id: "near-real-stripe",
      key: { level: 0, x: 0, y: 0, span: 128 },
      rect: { x: 0, y: 256, width: 1170, height: 128 },
      centerScreenX: 585,
      centerScreenY: 320,
      centerRe: view.re,
      centerIm: view.im,
      revision: 1
    };

    const result = renderPerturbationTile({
      type: "renderTile",
      tile,
      canvasWidth: 1170,
      canvasHeight: 784,
      pixelSpan: pixelSpan(view.scale, 1170),
      maxIter: view.maxIter,
      references: [reference],
      seriesDegree: 8,
      paletteId: "cosine",
      refined: false,
      refinementLevel: 0,
      renderMode: "final",
      sampleStep: 1
    });

    expect(reference.escapedAt).toBe(34);
    expect(result.stats.unresolvedCount).toBeGreaterThan(0);
    expect(result.stats.unresolvedClusters.length).toBeGreaterThan(4);
    expect(result.stats.unresolvedClusters.length).toBeLessThanOrEqual(16);
    expect(result.stats.unresolvedClusters.every((cluster) => cluster.bounds.width > 0 && cluster.bounds.height > 0)).toBe(true);
  });

  it("resolves the 1912x948 deep interior sample with perturbation period detection", () => {
    const view = {
      re: "-1.5738375605512487151154265653948631632264711132220526532084658732407373266127815e0",
      im: "-5.436641856961396284208136132163104968082086032418720386308428789634830866733822e-10",
      scale: "1.1351152221045656587152530244486905603141464775053705184640271695455593072075544e9",
      maxIter: 1092
    };
    const screen = { x: 1700, y: 700 };
    const point = pointAtScreen(view, screen.x, screen.y);
    const reference = makeReference(point.re, point.im, view.maxIter, 256, screen.x, screen.y);
    expect(reference.escapedAt).toBe(view.maxIter);

    const result = renderSinglePixelWithReferences(view, point, screen.x, screen.y, [reference], 1);

    expect(result.stats.unresolvedCount).toBe(0);
    expect(result.stats.escapedPixels).toBe(0);
    expect(result.stats.periodicInteriorCount).toBe(1);
  });

  it.each([
    ["top large disk", 1111.7, 160.6],
    ["bottom large disk", 946.3, 817.9],
    ["mid-left disk", 825.0, 492.9],
    ["mid-right disk", 1233.0, 485.5],
    ["left-top disk", 514.2, 200.2],
    ["central disk", 1029.0, 489.2]
  ])("does not classify the false %s at 1e27 as interior", (_name, x, y) => {
    const view = {
      re: "4.3792424135946285718646361930043170565329095266291420488816260206742136590487596e-1",
      im: "3.4189208433811610894511184773165189135789717878674952119590075744029026125433273e-1",
      scale: "1.0835064437740330620649324308790033236032009031542860476819043611262629043597067e27",
      maxIter: 2243
    };
    const point = highPrecisionPointAtScreen(view, x, y, 1912, 948);
    const direct = direct_escape(point.re, point.im, view.maxIter, 4096);
    const reference = makeReference(point.re, point.im, view.maxIter, 512, x, y);

    const result = renderSinglePixelWithReferences(view, point, x, y, [reference], 1);

    expect(direct).toBeLessThan(view.maxIter);
    expect(result.stats.periodicInteriorCount).toBe(0);
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
  return renderSinglePixelWithReferences(view, point, screenX, screenY, [reference], refinementLevel);
}

function renderSinglePixelWithReferences(
  view: { re: string; im: string; scale: string; maxIter: number },
  point: { re: string; im: string },
  screenX: number,
  screenY: number,
  references: ReferenceSnapshot[],
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
    references,
    seriesDegree: 8,
    paletteId: "cosine",
    refined: refinementLevel > 0,
    refinementLevel,
    renderMode: "final",
    sampleStep: 1
  };
  return renderPerturbationTile(message);
}

function pointAtScreen(view: { re: string; im: string; scale: string }, x: number, y: number): { re: string; im: string } {
  const span = pixelSpan(view.scale, 1912);
  const re = Number(view.re) + (x - 1912 * 0.5) * span;
  const im = Number(view.im) + (y - 948 * 0.5) * span;
  return { re: re.toPrecision(18), im: im.toPrecision(18) };
}

function highPrecisionPointAtScreen(
  view: { re: string; im: string; scale: string },
  x: number,
  y: number,
  width: number,
  height: number
): { re: string; im: string } {
  return apply_view_transform(
    { re: view.re, im: view.im, scale: view.scale, width, height },
    -(x - width * 0.5),
    -(y - height * 0.5),
    1,
    width * 0.5,
    height * 0.5
  ) as { re: string; im: string };
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
