import { expect, test } from "@playwright/test";

const REGRESSION_VIEWS = [
  {
    url:
      "/?re=-7.5357439432760979567799292092358849408631766136639749629881847491270958924729797e-1&im=4.1829098796254371047848652422265196230273460832374920810175261015280261764135947e-2&scale=2.7112638920657753457314574878835803145383223195308304348976984034375546586792402e1&iter=604",
    sampleX: 15.5 / 32,
    sampleY: 12.5 / 16
  },
  {
    url:
      "/?re=-7.549229970244027197908742917925261755751044636618703913223906199716382497449534e-1&im=5.320534885440088329282320858070240068704121711152834282354886837408395062921113e-2&scale=1.3394307643944097352319707599505029862713399693759721188427992474105938471591505e3&iter=713",
    sampleX: 0.5,
    sampleY: 0.15
  },
  {
    url:
      "/?re=-1.7195312667941079545586189454398113271069746647515813505680542504632787025805573e0&im=6.5505858903810377100204901499228868589789948177206009920848026920443700420219874e-4&scale=1.4879731724872819376827096167093147183191284045682361153628693061499318199119286e1&iter=588",
    sampleX: 624 / 1912,
    sampleY: 624 / 948
  },
  {
    url:
      "/?re=-1.7837703627058171488767894782491136871879847141256353015158193606747347767684793e0&im=5.5357063425251600676626417761698877134903352475830355358631008611595013848605954e-4&scale=2.9886740096705962489052976484705668623645989664805902945876196244325516986288952e2&iter=671",
    sampleX: 624 / 1912,
    sampleY: 336 / 948
  }
] as const;

const MICROTILE_REGRESSION_URL =
  "/?re=-1.5737407486227469252433174706063197673796016133716925506497393696303123079866005e0&im=2.3298749061632902966620424763943810032963152815290060660675502164545864497691752e-5&scale=5.166754427175971621093750355246036136162467976203352006225560442836867743195112e3&iter=750";
const DEEP_INTERIOR_REGRESSION_URL =
  "/?re=-1.5738375605512487151154265653948631632264711132220526532084658732407373266127815e0&im=-5.436641856961396284208136132163104968082086032418720386308428789634830866733822e-10&scale=1.1351152221045656587152530244486905603141464775053705184640271695455593072075544e9&iter=1092";
const FALSE_PERIODIC_INTERIOR_URL =
  "/?re=4.3792424135946285718646361930043170565329095266291420488816260206742136590487596e-1&im=3.4189208433811610894511184773165189135789717878674952119590075744029026125433273e-1&scale=1.0835064437740330620649324308790033236032009031542860476819043611262629043597067e27&iter=2243";
const REFERENCE_EXPLOSION_REGRESSION_URL =
  "/?re=-1.4844984007770583397190828833694392678094050320358041080022085134265597136975238e0&im=-1.1888756927003972876725424636547540252174013462943168696052865147067734469300689e-5&scale=5.4036493724669001296700958127360151018828249203074393236865719904836523640593173e5&iter=879";
const SHALLOW_REFERENCE_PRESSURE_URL =
  "/?re=-7.555285830155848864404330289173214045991921102938369079173868192729048678452592e-1&im=-1.1299255326048044095654679100367577109576335059729038978640756697388655423467892e-1&scale=4.2521082000062727600593870163935622685108740541205488909679304242435828818426798e1&iter=617";
const DEEP_PRECISION_TILE_ALIGNMENT_URL =
  "/?re=-7.4688394343169276054191953271440985923260663988633375070109254116564380822428781e-1&im=-1.0052598241121587675259369892011437164151107429135698306788524375078819321907888e-1&scale=3.1649373179255141123643235951764328734858585667107715296013629081580305459152227e79&iter=5601";
const DEEP_MEMORY_REGRESSION_URL =
  "/?re=-7.4688394343169276054191953271440985923260663988633375070109254116564380822428796e-1&im=-1.0052598241121587675259369892011437164151107429135698306788524375078819321907893e-1&scale=2.1270123524035260478728648392445123424166443778810410355510198092432642054827677e78&iter=5525";
const UNSAFE_ACCELERATION_TILE_REGRESSIONS = [
  {
    url:
      "/?re=-7.4966934496787838098731959297327082792276256276453894183802736415249648212435748e-1&im=-3.6835970065942988109940808475490090964316091450085844904438388017995897542104474e-2&scale=6.3270229281225222636256752583925066391594865119590585837604607679616921758554968e2&iter=692",
    sampleX: 1000 / 1912,
    sampleY: 500 / 948
  },
  {
    url:
      "/?re=-7.4966934496787838098731959297327082792276256276453894183834598253472297257976325e-1&im=-3.6861521736029792925609229356779358072862177412970006775043765158497834429601425e-2&scale=8.5405876252614986071100413930631932487692657156726781640555443950802640849770656e2&iter=700",
    sampleX: 1000 / 1912,
    sampleY: 110 / 948
  },
  {
    url:
      "/?re=-7.5334616440141300198402043563623536803333838622141813662066992521181596683305397e-1&im=-4.696919675440392553632571151226876300052345258551595459624481658859540695903849e-2&scale=1.0846546284082077156096591056319128446503558802465354324581765182582005442316815e5&iter=835",
    sampleX: 1008 / 1912,
    sampleY: 546 / 948
  }
] as const;

test("renders, pans, zooms, and restores URL state", async ({ page }) => {
  await page.goto("/");
  const canvas = page.locator("#fractal");
  await expect(canvas).toBeVisible();
  await waitForNonBlankCanvas(page);

  const initial = new URL(page.url());
  await page.mouse.move(420, 320);
  await page.mouse.down();
  await page.mouse.move(520, 360, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => new URL(page.url()).searchParams.get("re")).not.toBe(initial.searchParams.get("re"));

  const afterPan = new URL(page.url());
  await page.mouse.wheel(0, -600);
  await expect.poll(() => new URL(page.url()).searchParams.get("scale")).not.toBe(afterPan.searchParams.get("scale"));
  await waitForNonBlankCanvas(page);

  const beforeReload = new URL(page.url());
  await page.reload();
  await expect(page.locator("#readScale")).not.toHaveText("");
  expect(new URL(page.url()).searchParams.get("scale")).toBe(beforeReload.searchParams.get("scale"));
});

test("renders the reported regression views without false interior samples", async ({ page }) => {
  await page.setViewportSize({ width: 1912, height: 948 });
  for (const view of REGRESSION_VIEWS) {
    await page.goto(view.url);
    await waitForNonBlankCanvas(page, 30_000);
    await expect(page.locator("#readTiles")).toHaveText(/(\d+)\/\1/);
    const pixel = await readCanvasPixel(page, view.sampleX, view.sampleY);
    expect(pixel[3]).toBe(255);
    expect(pixel[0] + pixel[1] + pixel[2]).toBeGreaterThan(40);
  }
});

test("avoids microtile explosion on the 1170x784 near-real regression view", async ({ page }) => {
  await page.setViewportSize({ width: 1170, height: 784 });
  await page.goto(MICROTILE_REGRESSION_URL);
  await waitForNonBlankCanvas(page, 45_000);
  const tileCounts = await readTileCounts(page);
  expect(tileCounts.completed).toBe(tileCounts.total);
  expect(tileCounts.total).toBeLessThan(2500);

  for (const [x, y] of [
    [585 / 1170, 392 / 784],
    [760 / 1170, 330 / 784],
    [330 / 1170, 310 / 784],
    [30 / 1170, 330 / 784]
  ]) {
    const pixel = await readCanvasPixel(page, x, y);
    expect(pixel[3]).toBe(255);
    expect(pixel[0] + pixel[1] + pixel[2]).toBeGreaterThan(40);
  }
});

test("previews and stabilizes the 1912x948 deep interior regression view", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1912, height: 948 });
  await page.goto(DEEP_INTERIOR_REGRESSION_URL);

  await expect
    .poll(async () => {
      const pixel = await readCanvasPixel(page, 1700 / 1912, 700 / 948);
      return pixel[0] + pixel[1] + pixel[2];
    }, { timeout: 8_000 })
    .toBeGreaterThan(10);

  await waitForNonBlankCanvas(page, 75_000);
  const tileCounts = await readTileCounts(page);
  expect(tileCounts.completed).toBe(tileCounts.total);
  expect(tileCounts.total).toBeLessThan(2500);
  await page.waitForTimeout(3_000);
  await expect(page.locator("#readStatus")).toHaveText("stable");

  const pixel = await readCanvasPixel(page, 1700 / 1912, 700 / 948);
  expect(pixel[3]).toBe(255);
  expect(pixel[0] + pixel[1] + pixel[2]).toBeGreaterThan(10);
});

test("does not leave false periodic disks black at 1e27", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1912, height: 948 });
  await page.goto(FALSE_PERIODIC_INTERIOR_URL);

  for (const [x, y] of [
    [1111.7 / 1912, 160.6 / 948],
    [946.3 / 1912, 817.9 / 948],
    [1233.0 / 1912, 485.5 / 948]
  ]) {
    await expect
      .poll(async () => {
        const pixel = await readCanvasPixel(page, x, y);
        return pixel[0] + pixel[1] + pixel[2];
      }, { timeout: 45_000 })
      .toBeGreaterThan(40);
  }
});

test("keeps reference count bounded on the 120-tile reference explosion view", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1912, height: 948 });
  await page.goto(REFERENCE_EXPLOSION_REGRESSION_URL);
  await waitForNonBlankCanvas(page, 75_000);

  const tileCounts = await readTileCounts(page);
  expect(tileCounts.completed).toBe(tileCounts.total);
  expect(await readReferenceCount(page)).toBeLessThan(300);
});

test("keeps early-escape reference pressure bounded on the shallow 120-tile view", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1912, height: 948 });
  const started = Date.now();
  await page.goto(SHALLOW_REFERENCE_PRESSURE_URL);
  await waitForNonBlankCanvas(page, 30_000);
  const stableMs = Date.now() - started;

  const tileCounts = await readTileCounts(page);
  expect(tileCounts.completed).toBe(tileCounts.total);
  expect(await readReferenceCount(page)).toBeLessThan(300);
  expect(stableMs).toBeLessThan(20_000);
});

test("does not render unsafe accelerated tiles on the reported medium-zoom views", async ({ page }) => {
  test.setTimeout(140_000);
  await page.setViewportSize({ width: 1912, height: 948 });

  for (const view of UNSAFE_ACCELERATION_TILE_REGRESSIONS) {
    await page.goto(view.url);
    await waitForNonBlankCanvas(page, 75_000);
    const tileCounts = await readTileCounts(page);
    expect(tileCounts.completed).toBe(tileCounts.total);

    const pixel = await readCanvasPixel(page, view.sampleX, view.sampleY);
    expect(pixel[3]).toBe(255);
    expect(pixel[0] + pixel[1] + pixel[2]).toBeLessThan(30);
  }
});

test("keeps e79 deep zoom tiles aligned and avoids ArrayBuffer allocation failures", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1912, height: 948 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(DEEP_PRECISION_TILE_ALIGNMENT_URL);
  await waitForNonBlankCanvas(page, 90_000);
  let tileCounts = await readTileCounts(page);
  expect(tileCounts.completed).toBe(tileCounts.total);
  expect(await page.locator("#readStatus").textContent()).not.toContain("Array buffer allocation failed");
  expect(pageErrors.join("\n")).not.toMatch(/Array buffer allocation failed/i);

  const seamSamples = [
    await readCanvasPixel(page, 1536 / 1912, 320 / 948),
    await readCanvasPixel(page, 1537 / 1912, 320 / 948),
    await readCanvasPixel(page, 1536 / 1912, 448 / 948),
    await readCanvasPixel(page, 1537 / 1912, 448 / 948)
  ];
  for (const pixel of seamSamples) {
    expect(pixel[3]).toBe(255);
    expect(pixel[0] + pixel[1] + pixel[2]).toBeGreaterThan(30);
  }

  await page.goto(DEEP_MEMORY_REGRESSION_URL);
  await waitForNonBlankCanvas(page, 90_000);
  tileCounts = await readTileCounts(page);
  expect(tileCounts.completed).toBe(tileCounts.total);
  expect(await page.locator("#readStatus").textContent()).not.toContain("Array buffer allocation failed");
  expect(pageErrors.join("\n")).not.toMatch(/Array buffer allocation failed/i);
});

async function waitForNonBlankCanvas(page: import("@playwright/test").Page, timeout = 15_000): Promise<void> {
  await expect(page.locator("#readStatus")).toHaveText("stable", { timeout });
  await expect
    .poll(async () => {
      let sum = 0;
      for (const x of [0.1, 0.25, 0.5, 0.75, 0.9]) {
        for (const y of [0.1, 0.25, 0.5, 0.75, 0.9]) {
          const pixel = await readCanvasPixel(page, x, y);
          sum += pixel[0] + pixel[1] + pixel[2] + pixel[3];
        }
      }
      return sum;
    })
    .toBeGreaterThan(100);
}

async function readCanvasPixel(page: import("@playwright/test").Page, x: number, y: number): Promise<[number, number, number, number]> {
  return page.evaluate(
    ({ x, y }) => {
      const canvas = document.querySelector<HTMLCanvasElement>("#fractal");
      const gl = canvas?.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true });
      if (!canvas || !gl) return [0, 0, 0, 0] as [number, number, number, number];
      const pixel = new Uint8Array(4);
      gl.readPixels(
        Math.floor(canvas.width * x),
        Math.max(0, canvas.height - Math.floor(canvas.height * y) - 1),
        1,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixel
      );
      return [pixel[0], pixel[1], pixel[2], pixel[3]] as [number, number, number, number];
    },
    { x, y }
  );
}

async function readTileCounts(page: import("@playwright/test").Page): Promise<{ completed: number; total: number }> {
  const text = await page.locator("#readTiles").textContent();
  const match = /^(\d+)\/(\d+)$/.exec(text ?? "");
  if (!match) return { completed: 0, total: Number.POSITIVE_INFINITY };
  return { completed: Number(match[1]), total: Number(match[2]) };
}

async function readReferenceCount(page: import("@playwright/test").Page): Promise<number> {
  const text = await page.locator("#readRefs").textContent();
  return Number(text ?? Number.POSITIVE_INFINITY);
}
