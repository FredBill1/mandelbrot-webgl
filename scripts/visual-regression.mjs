import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { preview } from "vite";

const views = {
  home: "/",
  deepE100:
    "/?re=-7.46883943431692760541919532714409859232606639886333750701092541165643808224287821342188522092587382149759799587046156756309863566112516698524311312263708365547443519e-1&im=-1.00525982411215876752593698920114371641511074291356983067885243750788193219078894211160534174388216978954526887172496458449660477900264112017850945405489228557321858e-1&scale=1e100",
  falsePeriodic:
    "/?re=4.3792424135946285718646361930043170565329095266291420488816260206742136590487596e-1&im=3.4189208433811610894511184773165189135789717878674952119590075744029026125433273e-1&scale=1.0835064437740330620649324308790033236032009031542860476819043611262629043597067e27&iter=2243",
  minibrotSeams:
    "/?re=-7.01387731903521223674098370590029601822238961543775804742227688464250492677780739033222047e-1&im=-3.56367439465469861709467103905413691257500903471530163501858632930155641658498130531713519e-1&scale=8.54058762526144333935599265187197755732295827821093845497191539505192936261353888372715873e2",
  bandlimitedBoundary:
    "/?re=-1.48458330140036247637711150173056275201800398126520184731392135110206459886484778357996466e0&im=-2.59388635255443261801021498780013338816140992922161747121570167509133203590861049947497997e-11&scale=5.36190464429385541522377455367357477832895987078444543448371941540670062366744215336045641e8&iter=7000",
  periodicInterior5000:
    "/?re=-1.76854392069529079967435552147905380619071646671631558221721367158317146672961987405313343e0&im=-7.30078926394540958134620082008361635055501804364889844988162485821612638368665062006680955e-4&scale=5.16675442717597361866334085449662625942340146464132181028971962586112670232698885953242576e3&iter=5000"
};

const nyquistViews = {
  "problem-1":
    "/?re=-7.41738202839910189366677947843941538350902031852992084835612928096070951051962925170270341e-1&im=-1.63761231945507364199933991022019044049835525705543228032984176165333660441627165262145982e-1&scale=2.21406416204186707359021246876978316167308348209666105358841953452659255739600282861041614e2&iter=10000",
  "problem-2":
    "/?re=-7.46883943431692760541919532714409859232606639886333750701092541165643808224287821342188522092587382149759799587046156756309863566112516698524311312263708365547443519e-1&im=-1.00525982411215876752593698920114371641511074291356983067885243750788193219078894211160534174388216978954526887172496458449660477900264112017850945405489228557321858e-1&scale=1e100&iter=10000",
  "problem-3":
    "/?re=3.82347105149063655774373048755868711376300663251518501946954635279967635014564719241880721e-1&im=2.47990692456277820114252480366431545992387976702724278579450835216424034716161089035345723e-1&scale=2.98867400967059904889101771646361344776187295081879331047778196394800566357709466866203306e2&iter=10000",
  "problem-4":
    "/?re=3.78927013424713911560966988627995201145375749177541247699422222086313960388322682337450804e-1&im=2.46813892734007826529097438464947568972374146353401289506298238293673977070782618946941324e-1&scale=2.10064558942017308524002032106983986162840356757260776240080022048689795258370463221283807e3&iter=10000",
  "guard-1":
    "/?re=-1.67529728835576066106786943286337907902171851712283675985137992832774051379973058188186092493699e0&im=9.87220786855566942449436290068413737861532929356419545758106207595334512375161319137904085760398e-34&scale=2.50894431091404028359669994213481762817409341799448945731195496951503685257788989557723823749574e31&iter=10000",
  "guard-2":
    "/?re=3.65507337176578885294026060094803596771753851886465789116904636035808374831904454685041558745129659944566525621423768578726826509334259227102568025179459338196606859e-1&im=5.92476366173214971781468865486627113155901675162131546210951676040509852198816827792342255876351114213269405343861920688594863450989932441948429028708253010581298657e-1&scale=1e100&iter=10000",
  "guard-3":
    "/?re=-1.25485393196095154745460628138292832599326781621100880653779942495339840920278138978979803e0&im=-3.80708852437592923813856158305933042632103634455688297337156400254193656156240443535535756e-1&scale=7.74784629252607845113329688436032438920930419469497711517493823986672997982436655710671439e1&iter=10000"
};

const [command, ...args] = process.argv.slice(2);
if (command === "capture") {
  await capture(args[0], views, "single-path", false);
} else if (command === "capture-nyquist") {
  const label = args[0] ?? "fractalshades-after";
  const requestedNames = args.slice(1);
  const selectedViews = requestedNames.length === 0
    ? nyquistViews
    : Object.fromEntries(requestedNames.map((name) => {
        if (!(name in nyquistViews)) throw new Error(`unknown Nyquist view: ${name}`);
        return [name, nyquistViews[name]];
      }));
  await capture(label, selectedViews, "nyquist", true);
} else if (command === "compare") {
  await compare(args[0] ?? "before", args[1] ?? "after");
} else {
  throw new Error("usage: visual-regression.mjs capture <label> | capture-nyquist [label] [view ...] | compare [before] [after]");
}

async function capture(label, captureViews, group, collapseControls) {
  if (!label || !/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error("capture requires a safe label");
  const outputDir = join("visual-baselines", group, label);
  await mkdir(outputDir, { recursive: true });
  const port = await findFreePort();
  const server = await preview({
    root: process.cwd(),
    logLevel: "error",
    preview: { host: "127.0.0.1", port, strictPort: true }
  });
  const baseUrl = server.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1912, height: 948 }, deviceScaleFactor: 1 });
    // Prime Chromium's first WebGL context before collecting baselines. Without
    // this navigation the first completed view can still be composed as white in
    // a headless screenshot even though readPixels and the HUD report valid tiles.
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelector("#readStatus")?.textContent === "stable",
      undefined,
      { timeout: 120_000 }
    );
    await page.waitForFunction(() => {
      const match = document.querySelector("#readTiles")?.textContent?.match(/^(\d+)\/(\d+)$/);
      return match !== null && Number(match[1]) > 0 && match[1] === match[2];
    }, undefined, { timeout: 120_000 });
    await page.screenshot({ fullPage: false, animations: "disabled" });
    for (const [name, path] of Object.entries(captureViews)) {
      await page.goto(new URL(path, baseUrl).toString(), { waitUntil: "domcontentloaded" });
      // The HUD is initially in a valid idle state before URL restoration schedules
      // the first frame. Avoid mistaking that transient state for a completed render.
      await page.waitForTimeout(250);
      await page.waitForFunction(
        () => document.querySelector("#readStatus")?.textContent === "stable",
        undefined,
        { timeout: 120_000 }
      );
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.waitForFunction(() => {
        const match = document.querySelector("#readTiles")?.textContent?.match(/^(\d+)\/(\d+)$/);
        return match !== null && Number(match[1]) > 0 && match[1] === match[2];
      }, undefined, { timeout: 120_000 });
      if (collapseControls && await page.locator("#uiToggle").getAttribute("aria-expanded") === "true") {
        await page.locator("#uiToggle").click();
        await page.waitForTimeout(300);
      }
      // Chromium can occasionally capture an uncomposited WebGL backing store when
      // the first screenshot initializes its GPU readback path. Prime that path with
      // an in-memory capture, then save the following fully composited viewport.
      await page.screenshot({ fullPage: false, animations: "disabled" });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      await page.screenshot({ path: join(outputDir, `${name}.png`), fullPage: false, animations: "disabled" });
      console.log(`captured ${group}/${label}/${name}`);
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

async function compare(before, after) {
  const result = await run("python", [
    join("scripts", "visual-regression.py"),
    join("visual-baselines", "single-path", before),
    join("visual-baselines", "single-path", after),
    join("visual-baselines", "single-path", `${before}-vs-${after}`)
  ]);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.code !== 0) process.exitCode = result.code;
}

function run(executable, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
