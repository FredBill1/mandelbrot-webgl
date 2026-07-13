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

const [command, ...args] = process.argv.slice(2);
if (command === "capture") {
  await capture(args[0]);
} else if (command === "compare") {
  await compare(args[0] ?? "before", args[1] ?? "after");
} else {
  throw new Error("usage: visual-regression.mjs capture <label> | compare [before] [after]");
}

async function capture(label) {
  if (!label || !/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error("capture requires a safe label");
  const outputDir = join("visual-baselines", "single-path", label);
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
    for (const [name, path] of Object.entries(views)) {
      await page.goto(new URL(path, baseUrl).toString(), { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelector("#readStatus")?.textContent === "stable",
        undefined,
        { timeout: 120_000 }
      );
      await page.locator("#fractal").screenshot({ path: join(outputDir, `${name}.png`), animations: "disabled" });
      console.log(`captured ${label}/${name}`);
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
