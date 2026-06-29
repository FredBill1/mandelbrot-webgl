import { expect, test } from "@playwright/test";

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

async function waitForNonBlankCanvas(page: import("@playwright/test").Page): Promise<void> {
  await expect(page.locator("#readStatus")).toHaveText("stable", { timeout: 15_000 });
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>("#fractal");
        const gl = canvas?.getContext("webgl2");
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
