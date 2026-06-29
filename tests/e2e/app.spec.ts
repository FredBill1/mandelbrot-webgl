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

async function waitForNonBlankCanvas(page: import("@playwright/test").Page, timeout = 15_000): Promise<void> {
  await expect(page.locator("#readStatus")).toHaveText("stable", { timeout });
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>("#fractal");
        const gl = canvas?.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true });
        if (!canvas || !gl || gl.isContextLost() || canvas.width === 0 || canvas.height === 0) return 0;
        const samples = new Uint8Array(4 * 9);
        let offset = 0;
        for (const x of [0.25, 0.5, 0.75]) {
          for (const y of [0.25, 0.5, 0.75]) {
            const pixel = new Uint8Array(4);
            gl.readPixels(
              Math.floor(canvas.width * x),
              Math.floor(canvas.height * y),
              1,
              1,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              pixel
            );
            samples.set(pixel, offset);
            offset += 4;
          }
        }
        return samples.reduce((sum, value) => sum + value, 0);
      });
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
