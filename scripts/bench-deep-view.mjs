import { createServer } from "node:net";
import { chromium } from "playwright";
import { preview } from "vite";

const options = parseArgs(process.argv.slice(2));
const port = await findFreePort(options.port);
const server = await preview({
  root: process.cwd(),
  logLevel: "error",
  preview: {
    host: "127.0.0.1",
    port,
    strictPort: true
  }
});

const url = server.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${port}/`;
const browser = await chromium.launch();
let exitCode = 0;

try {
  const page = await browser.newPage({
    viewport: { width: 1912, height: 948 },
    deviceScaleFactor: 1
  });
  await page.addInitScript(installWorkerProbe);
  const targetUrl = options.url === undefined ? url : new URL(options.url, url).toString();
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  if (options.url === undefined) await page.click("#deepButton");

  const started = Date.now();
  let hud = await readHud(page);
  while (Date.now() - started < options.timeoutMs) {
    hud = await readHud(page);
    if (hud.status === "stable") break;
    await page.waitForTimeout(500);
  }

  const elapsedMs = Date.now() - started;
  const bench = await page.evaluate(() => globalThis.__deepBench);
  const summary = {
    elapsedMs,
    stable: hud.status === "stable",
    assertMs: options.assertMs,
    timeoutMs: options.timeoutMs,
    hud,
    workers: bench.workers,
    counts: bench.counts,
    averages: {
      finalWorkerMs: average(bench.sums.finalWorkerMs, bench.counts.final),
      finalWallMs: average(bench.sums.finalWallMs, bench.counts.final),
      previewWorkerMs: average(bench.sums.previewWorkerMs, bench.counts.preview),
      previewWallMs: average(bench.sums.previewWallMs, bench.counts.preview),
      referenceWallMs: average(bench.sums.referenceWallMs, bench.counts.referenceDone)
    },
    slowFinalTiles: bench.slowFinalTiles
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!summary.stable) {
    console.error(`DEEP_TEST_VIEW did not become stable within ${options.timeoutMs}ms.`);
    exitCode = 1;
  } else if (options.assertMs !== undefined && elapsedMs > options.assertMs) {
    console.error(`DEEP_TEST_VIEW stable time ${elapsedMs}ms exceeded assert-ms ${options.assertMs}ms.`);
    exitCode = 1;
  }
} finally {
  await browser.close();
  await closePreview(server);
}

process.exitCode = exitCode;

function parseArgs(args) {
  const parsed = {
    assertMs: undefined,
    timeoutMs: 180_000,
    port: 4173,
    url: undefined
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--assert-ms") {
      parsed.assertMs = Number(args[++i]);
    } else if (arg.startsWith("--assert-ms=")) {
      parsed.assertMs = Number(arg.slice("--assert-ms=".length));
    } else if (arg === "--timeout-ms") {
      parsed.timeoutMs = Number(args[++i]);
    } else if (arg.startsWith("--timeout-ms=")) {
      parsed.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    } else if (arg === "--port") {
      parsed.port = Number(args[++i]);
    } else if (arg.startsWith("--port=")) {
      parsed.port = Number(arg.slice("--port=".length));
    } else if (arg === "--url") {
      parsed.url = args[++i];
    } else if (arg.startsWith("--url=")) {
      parsed.url = arg.slice("--url=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (parsed.assertMs !== undefined && (!Number.isFinite(parsed.assertMs) || parsed.assertMs <= 0)) {
    throw new Error("--assert-ms must be a positive number");
  }
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) throw new Error("--timeout-ms must be a positive number");
  if (!Number.isFinite(parsed.port) || parsed.port <= 0) throw new Error("--port must be a positive number");
  return parsed;
}

async function findFreePort(startPort) {
  for (let candidate = startPort; candidate < startPort + 100; candidate += 1) {
    if (await canListen(candidate)) return candidate;
  }
  throw new Error(`No free port found from ${startPort}`);
}

function canListen(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port, "127.0.0.1");
  });
}

function installWorkerProbe() {
  const OriginalWorker = globalThis.Worker;
  const bench = {
    workers: { tile: 0, reference: 0, unknown: 0 },
    counts: {
      tileDone: 0,
      final: 0,
      preview: 0,
      referenceDone: 0,
      referenceError: 0
    },
    sums: {
      finalWorkerMs: 0,
      finalWallMs: 0,
      previewWorkerMs: 0,
      previewWallMs: 0,
      referenceWallMs: 0
    },
    slowFinalTiles: []
  };
  globalThis.__deepBench = bench;

  globalThis.Worker = function Worker(url, workerOptions) {
    const worker = new OriginalWorker(url, workerOptions);
    const urlText = String(url);
    if (urlText.includes("tileWorker")) bench.workers.tile += 1;
    else if (urlText.includes("referenceWorker")) bench.workers.reference += 1;
    else bench.workers.unknown += 1;

    let current;
    const postMessage = worker.postMessage.bind(worker);
    worker.postMessage = function patchedPostMessage(message, transferOrOptions) {
      if (message?.type === "renderTile") {
        current = {
          type: "tile",
          started: performance.now(),
          renderMode: message.renderMode,
          tileId: message.tile.id,
          rect: { ...message.tile.rect },
          refs: message.references.length,
          refinementLevel: message.refinementLevel
        };
      } else if (message?.type === "computeReference") {
        current = {
          type: "reference",
          started: performance.now(),
          requestId: message.requestId,
          minPrecisionBits: message.minPrecisionBits
        };
      }
      if (arguments.length > 1) return postMessage(message, transferOrOptions);
      return postMessage(message);
    };

    worker.addEventListener("message", (event) => {
      const data = event.data;
      if (data?.type === "tileDone") {
        const wallMs = current?.type === "tile" ? performance.now() - current.started : data.stats.elapsedMs;
        bench.counts.tileDone += 1;
        if (data.stats.renderMode === "final") {
          bench.counts.final += 1;
          bench.sums.finalWorkerMs += data.stats.elapsedMs;
          bench.sums.finalWallMs += wallMs;
          pushSlowFinal({
            workerMs: Math.round(data.stats.elapsedMs),
            wallMs: Math.round(wallMs),
            rect: data.rect,
            refs: current?.refs,
            refinementLevel: current?.refinementLevel,
            unresolved: data.stats.unresolvedCount,
            escaped: data.stats.escapedPixels,
            seriesSkip: data.stats.seriesSkip,
            blaSkip: data.stats.blaSkipCount,
            blaSteps: data.stats.blaStepCount,
            aaSamples: data.stats.aaSampleCount,
            refsUsed: data.stats.referenceIdsUsed.length,
            clusters: data.stats.unresolvedClusters.length
          });
        } else {
          bench.counts.preview += 1;
          bench.sums.previewWorkerMs += data.stats.elapsedMs;
          bench.sums.previewWallMs += wallMs;
        }
        current = undefined;
      } else if (data?.type === "referenceDone") {
        if (current?.type === "reference") bench.sums.referenceWallMs += performance.now() - current.started;
        bench.counts.referenceDone += 1;
        current = undefined;
      } else if (data?.type === "referenceError") {
        bench.counts.referenceError += 1;
        current = undefined;
      }
    });

    return worker;
  };
  globalThis.Worker.prototype = OriginalWorker.prototype;

  function pushSlowFinal(tile) {
    bench.slowFinalTiles.push(tile);
    bench.slowFinalTiles.sort((a, b) => b.workerMs - a.workerMs);
    if (bench.slowFinalTiles.length > 20) bench.slowFinalTiles.pop();
  }
}

async function readHud(page) {
  return page.evaluate(() => ({
    status: document.querySelector("#readStatus")?.textContent ?? "",
    tiles: document.querySelector("#readTiles")?.textContent ?? "",
    refs: document.querySelector("#readRefs")?.textContent ?? "",
    workers: document.querySelector("#readWorkers")?.textContent ?? "",
    iter: document.querySelector("#readIter")?.textContent ?? "",
    scale: document.querySelector("#readScale")?.textContent ?? "",
    canvas: {
      width: document.querySelector("canvas")?.width ?? 0,
      height: document.querySelector("canvas")?.height ?? 0
    }
  }));
}

function average(sum, count) {
  return count > 0 ? Number((sum / count).toFixed(2)) : 0;
}

function closePreview(previewServer) {
  return new Promise((resolve, reject) => {
    previewServer.httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
