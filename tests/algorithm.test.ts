import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import init, { apply_view_transform, compute_reference, compute_reference_3mul, compute_reference_sparse, direct_escape } from "../src/wasm/pkg/mandelbrot_wasm";
import { createVisibleTileShells } from "../src/tiles/tileKey";
import { renderPerturbationTile } from "../src/workers/perturbation";
import { renderPerturbationTileWasm, resetWasmPerturbationCacheForTests } from "../src/workers/wasmPerturbation";
import { SERIES_DEGREE, type ReferenceSnapshot, type RenderTileMessage, type TileDescriptor } from "../src/types";

beforeAll(async () => {
  const wasm = readFileSync(new URL("../src/wasm/pkg/mandelbrot_wasm_bg.wasm", import.meta.url));
  await init({ module_or_path: wasm });
});

describe("perturbation renderer", () => {
  it.each([
    ["shallow", "3e-1", "5e-1", 128, 128],
    ["1e100", "-7.43643887037158704752191506114774e-1", "1.31825904205311970493132056385139e-1", 512, 512],
    [
      "e79",
      "-7.4688394343169276054191953271440985923260663988633375070109254116564380822428781e-1",
      "-1.0052598241121587675259369892011437164151107429135698306788524375078819321907888e-1",
      5601,
      768
    ],
    [
      "false disk",
      "4.3792424135946285718646361930043170565329095266291420488816260206742136590487596e-1",
      "3.4189208433811610894511184773165189135789717878674952119590075744029026125433273e-1",
      2243,
      4096
    ]
  ])("2-mul sparse reference matches 3-mul escape for %s", (_name, re, im, maxIter, precisionBits) => {
    const baseline = compute_reference_3mul(re, im, maxIter, precisionBits) as RawReference;
    for (const interval of [8, 16, 32]) {
      const sparse = compute_reference_sparse(re, im, maxIter, precisionBits, interval) as RawReference;
      expect(sparse.escaped_at).toBe(baseline.escaped_at);
      expect(sparse.orbit_re.length).toBe(Math.min(maxIter, sparse.escaped_at) + 1);
      expect(sparse.orbit_im.length).toBe(sparse.orbit_re.length);
    }
  });

  it("returns reference orbit arrays as Float64Array", () => {
    const raw = compute_reference("3e-1", "5e-1", 64, 128) as RawReference;
    expect(raw.orbit_re).toBeInstanceOf(Float64Array);
    expect(raw.orbit_im).toBeInstanceOf(Float64Array);
    expect(raw.orbit_re.length).toBe(raw.escaped_at + 1);
  });

  it.each([
    [
      "shallow completed final AA",
      { re: "-7.5e-1", im: "1e-1", scale: "1", maxIter: 128 },
      { x: 960, y: 448 },
      { x: 960, y: 448 },
      32,
      32,
      128,
      "final" as const,
      1
    ],
    [
      "early escape unresolved",
      {
        re: "-7.549229970244027197908742917925261755751044636618703913223906199716382497449534e-1",
        im: "5.320534885440088329282320858070240068704121711152834282354886837408395062921113e-2",
        scale: "1.3394307643944097352319707599505029862713399693759721188427992474105938471591505e3",
        maxIter: 713
      },
      { x: 1912 * 0.5, y: 948 * 0.15 },
      { x: 1912 * 0.5, y: 948 * 0.5 },
      16,
      16,
      224,
      "final" as const,
      1
    ],
    [
      "1e100 preview",
      { re: "-7.43643887037158704752191506114774e-1", im: "1.31825904205311970493132056385139e-1", scale: "1e100", maxIter: 512 },
      { x: 1000, y: 500 },
      { x: 1000, y: 500 },
      32,
      32,
      768,
      "preview" as const,
      4
    ],
    [
      "rainbow boundary final",
      {
        re: "-7.44743856455867584502971474051977658103817187893185200400939609851583632432852598231790469e-1",
        im: "-1.35593942108114561959508453803647827165860206496504860209432696505792919260554145799490801e-1",
        scale: "2.5723755590577444907048627502998122776921365543852726093737771835857766320092045519877944e2",
        maxIter: 667
      },
      { x: 960, y: 448 },
      { x: 960, y: 448 },
      32,
      32,
      256,
      "final" as const,
      1
    ]
  ])(
    "WASM cached tile renderer matches TypeScript renderer for %s",
    async (_name, view, screen, referenceScreen, width, height, precisionBits, renderMode, sampleStep) => {
      const point = highPrecisionPointAtScreen(view, screen.x, screen.y, 1912, 948);
      const referencePoint = highPrecisionPointAtScreen(view, referenceScreen.x, referenceScreen.y, 1912, 948);
      const reference = makeReference(referencePoint.re, referencePoint.im, view.maxIter, precisionBits, referenceScreen.x, referenceScreen.y);
      const message = makeTileMessage(view, point, screen.x, screen.y, width, height, [reference], renderMode, sampleStep);

      const tsResult = renderPerturbationTile(message);
      resetWasmPerturbationCacheForTests();
      const wasmResult = await renderPerturbationTileWasm(message);

      expect(wasmResult.width).toBe(tsResult.width);
      expect(wasmResult.height).toBe(tsResult.height);
      expect(wasmResult.needsReference).toBe(tsResult.needsReference);
      expect(wasmResult.stats.unresolvedCount).toBe(tsResult.stats.unresolvedCount);
      expect(wasmResult.stats.escapedPixels).toBe(tsResult.stats.escapedPixels);
      expect(wasmResult.stats.periodicInteriorCount).toBe(tsResult.stats.periodicInteriorCount);
      expect(wasmResult.stats.rebaseCount).toBe(tsResult.stats.rebaseCount);
      expect(wasmResult.stats.rebaseLimitCount).toBe(tsResult.stats.rebaseLimitCount);
      expect(wasmResult.stats.seriesSkip).toBe(tsResult.stats.seriesSkip);
      expect(wasmResult.stats.boundaryDampenedCount).toBe(tsResult.stats.boundaryDampenedCount);
      expect(wasmResult.stats.aaPixelCount).toBe(tsResult.stats.aaPixelCount);
      expect(wasmResult.stats.aaSampleCount).toBe(tsResult.stats.aaSampleCount);
      expect(wasmResult.stats.referenceIdsUsed).toEqual(tsResult.stats.referenceIdsUsed);
      expect(wasmResult.stats.unresolvedClusters).toEqual(tsResult.stats.unresolvedClusters);
      expectSampledPixelsClose(wasmResult.rgba, tsResult.rgba, wasmResult.width * wasmResult.height, 200);
    }
  );

  it("keeps e79 adjacent pixels and tile centers distinct after WASM decimal serialization", () => {
    const view = {
      re: "-7.4688394343169276054191953271440985923260663988633375070109254116564380822428781e-1",
      im: "-1.0052598241121587675259369892011437164151107429135698306788524375078819321907888e-1",
      scale: "3.1649373179255141123643235951764328734858585667107715296013629081580305459152227e79",
      maxIter: 5601
    };

    const firstPixel = highPrecisionPointAtScreen(view, 956, 474, 1912, 948);
    const nextPixel = highPrecisionPointAtScreen(view, 957, 474, 1912, 948);
    expect(nextPixel.re).not.toBe(firstPixel.re);
    expect(significantDigits(firstPixel.re)).toBeGreaterThanOrEqual(130);

    const shells = createVisibleTileShells({ ...view, width: 1912, height: 948, pixelRatio: 1, revision: 1 }, 128);
    const centers = shells.map((tile) => {
      const point = highPrecisionPointAtScreen(view, tile.centerScreenX, tile.centerScreenY, 1912, 948);
      return `${point.re}|${point.im}`;
    });

    expect(shells).toHaveLength(120);
    expect(new Set(centers).size).toBe(centers.length);
  });

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
      seriesDegree: SERIES_DEGREE,
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

  it("skips final AA while a tile is still an unresolved refinement candidate", () => {
    const view = {
      re: "-7.549229970244027197908742917925261755751044636618703913223906199716382497449534e-1",
      im: "5.320534885440088329282320858070240068704121711152834282354886837408395062921113e-2",
      scale: "1.3394307643944097352319707599505029862713399693759721188427992474105938471591505e3",
      maxIter: 713
    };
    const screen = { x: 1912 * 0.5, y: 948 * 0.15 };
    const point = pointAtScreen(view, screen.x, screen.y);
    const reference = makeReference(view.re, view.im, view.maxIter, 224, 1912 * 0.5, 948 * 0.5);
    const tile: TileDescriptor = {
      id: "unresolved-aa-skip",
      key: { level: 0, x: 0, y: 0, span: 16 },
      rect: { x: screen.x - 8, y: screen.y - 8, width: 16, height: 16 },
      centerScreenX: screen.x,
      centerScreenY: screen.y,
      centerRe: point.re,
      centerIm: point.im,
      revision: 1
    };

    const result = renderPerturbationTile({
      type: "renderTile",
      tile,
      canvasWidth: 1912,
      canvasHeight: 948,
      pixelSpan: pixelSpan(view.scale, 1912),
      maxIter: view.maxIter,
      references: [reference],
      seriesDegree: SERIES_DEGREE,
      paletteId: "cosine",
      refined: false,
      refinementLevel: 0,
      renderMode: "final",
      sampleStep: 1
    });

    expect(result.stats.unresolvedCount).toBeGreaterThan(0);
    expect(result.stats.aaPixelCount).toBe(0);
    expect(result.stats.aaSampleCount).toBe(0);
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

  it("uses safe series or adaptive unresolved clusters for the 1170x784 near-real performance regression", () => {
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
      seriesDegree: SERIES_DEGREE,
      paletteId: "cosine",
      refined: false,
      refinementLevel: 0,
      renderMode: "final",
      sampleStep: 1
    });

    expect(reference.escapedAt).toBe(34);
    if (result.stats.unresolvedCount > 0) {
      expect(result.stats.unresolvedClusters.length).toBeGreaterThan(4);
      expect(result.stats.unresolvedClusters.length).toBeLessThanOrEqual(16);
      expect(result.stats.unresolvedClusters.every((cluster) => cluster.bounds.width > 0 && cluster.bounds.height > 0)).toBe(true);
    } else {
      expect(result.stats.seriesSkip).toBeGreaterThanOrEqual(0);
    }
    expect(result.stats.blaStepCount).toBe(0);
  });

  it("dampens noisy escaped boundary color without changing center-sample classification", () => {
    const view = {
      re: "-7.44743856455867584502971474051977658103817187893185200400939609851583632432852598231790469e-1",
      im: "-1.35593942108114561959508453803647827165860206496504860209432696505792919260554145799490801e-1",
      scale: "2.5723755590577444907048627502998122776921365543852726093737771835857766320092045519877944e2",
      maxIter: 667
    };
    const tile: TileDescriptor = {
      id: "rainbow-boundary",
      key: { level: 0, x: 7, y: 3, span: 128 },
      rect: { x: 896, y: 384, width: 128, height: 128 },
      centerScreenX: 960,
      centerScreenY: 448,
      centerRe: view.re,
      centerIm: view.im,
      revision: 1
    };
    const tileCenter = highPrecisionPointAtScreen(view, tile.centerScreenX, tile.centerScreenY, 1912, 948);
    const reference = makeReference(tileCenter.re, tileCenter.im, view.maxIter, 256, tile.centerScreenX, tile.centerScreenY);
    const baseMessage: RenderTileMessage = {
      type: "renderTile",
      tile,
      canvasWidth: 1912,
      canvasHeight: 948,
      pixelSpan: pixelSpan(view.scale, 1912),
      maxIter: view.maxIter,
      references: [reference],
      seriesDegree: SERIES_DEGREE,
      paletteId: "cosine",
      refined: true,
      refinementLevel: 1,
      renderMode: "preview",
      sampleStep: 1
    };

    const preview = renderPerturbationTile(baseMessage);
    const final = renderPerturbationTile({ ...baseMessage, renderMode: "final" });

    expect(final.stats.escapedPixels).toBe(preview.stats.escapedPixels);
    expect(final.stats.unresolvedCount).toBe(preview.stats.unresolvedCount);
    expect(preview.stats.boundaryDampenedCount).toBe(0);
    expect(preview.stats.aaPixelCount).toBe(0);
    if (final.stats.unresolvedCount > 0) {
      expect(final.stats.boundaryDampenedCount).toBe(0);
      expect(final.stats.aaPixelCount).toBe(0);
      expect(final.stats.aaSampleCount).toBe(0);
    } else {
      expect(final.stats.boundaryDampenedCount).toBeGreaterThan(0);
      expect(final.stats.aaPixelCount).toBeGreaterThan(0);
      expect(final.stats.aaPixelCount).toBeLessThanOrEqual(1024);
      expect(final.stats.aaSampleCount).toBeLessThanOrEqual(2560);
    }
  });

  it("keeps boundary smoothing and AA for completed final tiles", () => {
    const view = {
      re: "-7.5e-1",
      im: "1e-1",
      scale: "1",
      maxIter: 128
    };
    const tile: TileDescriptor = {
      id: "completed-boundary",
      key: { level: 0, x: 0, y: 0, span: 128 },
      rect: { x: 896, y: 384, width: 128, height: 128 },
      centerScreenX: 960,
      centerScreenY: 448,
      centerRe: view.re,
      centerIm: view.im,
      revision: 1
    };
    const tileCenter = highPrecisionPointAtScreen(view, tile.centerScreenX, tile.centerScreenY, 1912, 948);
    const reference = makeReference(tileCenter.re, tileCenter.im, view.maxIter, 128, tile.centerScreenX, tile.centerScreenY);
    const result = renderPerturbationTile({
      type: "renderTile",
      tile,
      canvasWidth: 1912,
      canvasHeight: 948,
      pixelSpan: pixelSpan(view.scale, 1912),
      maxIter: view.maxIter,
      references: [reference],
      seriesDegree: SERIES_DEGREE,
      paletteId: "cosine",
      refined: true,
      refinementLevel: 1,
      renderMode: "final",
      sampleStep: 1
    });

    expect(result.stats.unresolvedCount).toBe(0);
    expect(result.stats.escapedPixels).toBeGreaterThan(0);
    expect(result.stats.escapedPixels).toBeLessThan(result.width * result.height);
    expect(result.stats.boundaryDampenedCount).toBeGreaterThan(0);
    expect(result.stats.aaPixelCount).toBeGreaterThan(0);
    expect(result.stats.aaSampleCount).toBeLessThanOrEqual(2560);
  });

  it("resolves the 1912x948 deep interior sample without refinement", () => {
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
    expect(result.stats.periodicInteriorCount + result.stats.seriesSkip).toBeGreaterThan(0);
    expect(result.stats.blaStepCount).toBe(0);
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

  it.each([
    [
      "seahorse valley scale-633",
      {
        re: "-7.4966934496787838098731959297327082792276256276453894183802736415249648212435748e-1",
        im: "-3.6835970065942988109940808475490090964316091450085844904438388017995897542104474e-2",
        scale: "6.3270229281225222636256752583925066391594865119590585837604607679616921758554968e2",
        maxIter: 692
      },
      1000,
      500
    ],
    [
      "seahorse valley scale-854",
      {
        re: "-7.4966934496787838098731959297327082792276256276453894183834598253472297257976325e-1",
        im: "-3.6861521736029792925609229356779358072862177412970006775043765158497834429601425e-2",
        scale: "8.5405876252614986071100413930631932487692657156726781640555443950802640849770656e2",
        maxIter: 700
      },
      1000,
      110
    ],
    [
      "seahorse valley scale-469",
      {
        re: "-7.5063661562619738456963379784747998047874472923886570517636877125007290188512631e-1",
        im: "-3.6457067483775627969230673979175923069700656808867805874612940372022092088015668e-2",
        scale: "4.6871738678241589821479833520019796943674415809383314289220537923628457223414714e2",
        maxIter: 683
      },
      1215,
      385
    ],
    [
      "near-real scale-1808",
      {
        re: "-1.6319406659348067713391981382836692942658351212899461703065805913137973677448364e0",
        im: "-8.4297463302004818527904256553713991311087966292829363756488246622180047190212363e-6",
        scale: "1.8080424144560554947071644758141790158871605775151382306494555746329017800115708e3",
        maxIter: 721
      },
      486,
      456
    ],
    [
      "near-real scale-31257",
      {
        re: "-1.6318861370342711427419798675435821363599491240092572029547364566350336131805832e0",
        im: "1.9658838014048480577534033042396975947924884570650342666305024357717553810158527e-6",
        scale: "3.1257042819609434520294065852842157825991238901920869982888307778804518684226075e4",
        maxIter: 800
      },
      360,
      430
    ],
    [
      "seahorse valley scale-108465",
      {
        re: "-7.5334616440141300198402043563623536803333838622141813662066992521181596683305397e-1",
        im: "-4.696919675440392553632571151226876300052345258551595459624481658859540695903849e-2",
        scale: "1.0846546284082077156096591056319128446503558802465354324581765182582005442316815e5",
        maxIter: 835
      },
      1008,
      546
    ]
  ])("keeps reported BLA regression interior sample inside for %s", (_name, view, x, y) => {
    const point = highPrecisionPointAtScreen(view, x, y, 1912, 948);
    const direct = direct_escape(point.re, point.im, view.maxIter, 512);
    const centerReference = makeReference(view.re, view.im, view.maxIter, 512, 1912 * 0.5, 948 * 0.5);
    const localReference = makeReference(point.re, point.im, view.maxIter, 512, x, y);

    const centerOnly = renderSinglePixelWithReferences(view, point, x, y, [centerReference], 0);
    const result = centerOnly.stats.unresolvedCount === 0
      ? centerOnly
      : renderSinglePixelWithReferences(view, point, x, y, [centerReference, localReference], 1);

    expect(direct).toBe(view.maxIter);
    expect(result.stats.unresolvedCount).toBe(0);
    expect(result.stats.escapedPixels).toBe(0);
  });

  it.each([
    [
      "1e20",
      { re: "-7.43643887037158704752191506114774e-1", im: "1.31825904205311970493132056385139e-1", scale: "1e20", maxIter: 256 },
      1000,
      500,
      512
    ],
    [
      "1e60",
      { re: "-7.43643887037158704752191506114774e-1", im: "1.31825904205311970493132056385139e-1", scale: "1e60", maxIter: 384 },
      1000,
      500,
      512
    ],
    [
      "1e79",
      {
        re: "-7.4688394343169276054191953271440985923260663988633375070109254116564380822428781e-1",
        im: "-1.0052598241121587675259369892011437164151107429135698306788524375078819321907888e-1",
        scale: "3.1649373179255141123643235951764328734858585667107715296013629081580305459152227e79",
        maxIter: 5601
      },
      960,
      476,
      768
    ],
    [
      "1e100",
      { re: "-7.43643887037158704752191506114774e-1", im: "1.31825904205311970493132056385139e-1", scale: "1e100", maxIter: 512 },
      1000,
      500,
      768
    ]
  ])("matches direct classification with series enabled and disabled at %s", (_name, view, x, y, precisionBits) => {
    const point = highPrecisionPointAtScreen(view, x, y, 1912, 948);
    const direct = direct_escape(point.re, point.im, view.maxIter, precisionBits);
    const reference = makeReference(point.re, point.im, view.maxIter, precisionBits, x, y);
    const seriesEnabled = renderSinglePixelWithReferences(view, point, x, y, [reference], 1, SERIES_DEGREE);
    const seriesDisabled = renderSinglePixelWithReferences(view, point, x, y, [reference], 1, 0);
    const escaped = direct < view.maxIter ? 1 : 0;

    expect(seriesEnabled.stats.unresolvedCount).toBe(0);
    expect(seriesDisabled.stats.unresolvedCount).toBe(0);
    expect(seriesEnabled.stats.escapedPixels).toBe(escaped);
    expect(seriesDisabled.stats.escapedPixels).toBe(escaped);
    expect(seriesEnabled.stats.blaStepCount).toBe(0);
  });
});

function makeReference(re: string, im: string, maxIter: number, precisionBits: number, screenX = 0.5, screenY = 0.5): ReferenceSnapshot {
  const raw = compute_reference(re, im, maxIter, precisionBits) as RawReference;
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
    orbitRe: raw.orbit_re instanceof Float64Array ? raw.orbit_re : new Float64Array(raw.orbit_re),
    orbitIm: raw.orbit_im instanceof Float64Array ? raw.orbit_im : new Float64Array(raw.orbit_im)
  };
}

interface RawReference {
  center_re: string;
  center_im: string;
  precision_bits: number;
  escaped_at: number;
  orbit_re: Float64Array | number[];
  orbit_im: Float64Array | number[];
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
  refinementLevel: number,
  seriesDegree = SERIES_DEGREE
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
    seriesDegree,
    paletteId: "cosine",
    refined: refinementLevel > 0,
    refinementLevel,
    renderMode: "final",
    sampleStep: 1
  };
  return renderPerturbationTile(message);
}

function makeTileMessage(
  view: { re: string; im: string; scale: string; maxIter: number },
  point: { re: string; im: string },
  screenX: number,
  screenY: number,
  width: number,
  height: number,
  references: ReferenceSnapshot[],
  renderMode: "preview" | "final",
  sampleStep: number
): RenderTileMessage {
  const tile: TileDescriptor = {
    id: `parity-${renderMode}-${width}x${height}`,
    key: { level: 0, x: 0, y: 0, span: Math.max(width, height) },
    rect: { x: screenX - width * 0.5, y: screenY - height * 0.5, width, height },
    centerScreenX: screenX,
    centerScreenY: screenY,
    centerRe: point.re,
    centerIm: point.im,
    revision: 1
  };
  return {
    type: "renderTile",
    tile,
    canvasWidth: 1912,
    canvasHeight: 948,
    pixelSpan: pixelSpan(view.scale, 1912),
    maxIter: view.maxIter,
    references,
    seriesDegree: SERIES_DEGREE,
    paletteId: "cosine",
    refined: true,
    refinementLevel: 1,
    renderMode,
    sampleStep
  };
}

function expectSampledPixelsClose(actual: ArrayBuffer, expected: ArrayBuffer, pixelCount: number, sampleCount: number): void {
  const actualBytes = new Uint8Array(actual);
  const expectedBytes = new Uint8Array(expected);
  expect(actualBytes.byteLength).toBe(expectedBytes.byteLength);
  let seed = 0x12345678;
  for (let sample = 0; sample < Math.min(sampleCount, pixelCount); sample += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const pixelIndex = seed % pixelCount;
    const offset = pixelIndex * 4;
    for (let channel = 0; channel < 4; channel += 1) {
      expect(Math.abs(actualBytes[offset + channel] - expectedBytes[offset + channel])).toBeLessThanOrEqual(1);
    }
  }
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

function significantDigits(value: string): number {
  const mantissa = value.toLowerCase().split("e")[0] ?? value;
  return mantissa.replace(/[-+.]/g, "").replace(/^0+/, "").length;
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
