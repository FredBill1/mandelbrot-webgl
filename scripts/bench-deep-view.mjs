import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
  let maxHudTotalTiles = 0;
  let maxHudCompletedTiles = 0;
  while (Date.now() - started < options.timeoutMs) {
    hud = await readHud(page);
    const hudTiles = parseTileProgress(hud.tiles);
    maxHudCompletedTiles = Math.max(maxHudCompletedTiles, hudTiles.completed);
    maxHudTotalTiles = Math.max(maxHudTotalTiles, hudTiles.total);
    if (hud.status === "stable") break;
    await page.waitForTimeout(500);
  }

  const elapsedMs = Date.now() - started;
  const interactive = summaryCanInteract(hud, options) ? await runInteraction(page, options.interaction) : undefined;
  if (interactive !== undefined && options.postInteractionStable) {
    const postStarted = Date.now();
    while (Date.now() - postStarted < options.timeoutMs) {
      hud = await readHud(page);
      const hudTiles = parseTileProgress(hud.tiles);
      maxHudCompletedTiles = Math.max(maxHudCompletedTiles, hudTiles.completed);
      maxHudTotalTiles = Math.max(maxHudTotalTiles, hudTiles.total);
      if (hud.status === "stable") break;
      await page.waitForTimeout(500);
    }
  }
  const bench = await page.evaluate(() => globalThis.__deepBench);
  bench.stableAt = elapsedMs;
  const hudTiles = parseTileProgress(hud.tiles);
  const summary = {
    elapsedMs,
    stable: hud.status === "stable",
    stableMs: hud.status === "stable" ? elapsedMs : null,
    assertMs: options.assertMs,
    timeoutMs: options.timeoutMs,
    hud,
    workers: bench.workers,
    counts: bench.counts,
    averages: {
      finalWorkerMs: average(bench.sums.finalWorkerMs, bench.counts.final),
      finalWallMs: average(bench.sums.finalWallMs, bench.counts.final),
      finalQueueMs: average(bench.sums.finalQueueMs, bench.counts.finalStarted),
      finalUploadMs: average(bench.sums.finalUploadMs, bench.counts.finalUploaded),
      referenceWallMs: average(bench.sums.referenceWallMs, bench.counts.referenceDone)
    },
    percentiles: {
      finalWorkerMs: percentiles(bench.samples.finalWorkerMs),
      finalWallMs: percentiles(bench.samples.finalWallMs),
      finalQueueMs: percentiles(bench.samples.finalQueueMs),
      finalUploadMs: percentiles(bench.samples.finalUploadMs)
    },
    waves: bench.waves,
    interactive,
    slowFinalTiles: bench.slowFinalTiles,
    regression: {
      stableMs: hud.status === "stable" ? elapsedMs : null,
      tileDone: bench.counts.tileDone,
      finalCount: bench.counts.final,
      referenceDone: bench.counts.referenceDone,
      referenceRequests: bench.counts.referenceDone + bench.counts.referenceError,
      finalPasses: bench.counts.final,
      totalTiles: hudTiles.total || maxHudTotalTiles,
      maxActiveTiles: maxHudTotalTiles,
      p50WorkerMs: percentiles(bench.samples.finalWorkerMs).p50,
      p95WorkerMs: percentiles(bench.samples.finalWorkerMs).p95,
      onePixelTiles: bench.waves.onePixelTiles,
      minTileArea: bench.waves.minTileArea === Infinity ? 0 : bench.waves.minTileArea,
      maxCompletedTiles: maxHudCompletedTiles
    }
  };

  console.log(JSON.stringify(summary, null, 2));
  if (options.profileJson !== undefined) await writeProfile(options.profileJson, { summary, profile: bench.profile });

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
    url: undefined,
    profileJson: undefined,
    interaction: undefined,
    postInteractionStable: false
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
    } else if (arg === "--profile-json") {
      parsed.profileJson = args[++i];
    } else if (arg.startsWith("--profile-json=")) {
      parsed.profileJson = arg.slice("--profile-json=".length);
    } else if (arg === "--interaction") {
      parsed.interaction = args[++i];
    } else if (arg.startsWith("--interaction=")) {
      parsed.interaction = arg.slice("--interaction=".length);
    } else if (arg === "--post-interaction-stable") {
      parsed.postInteractionStable = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (parsed.assertMs !== undefined && (!Number.isFinite(parsed.assertMs) || parsed.assertMs <= 0)) {
    throw new Error("--assert-ms must be a positive number");
  }
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) throw new Error("--timeout-ms must be a positive number");
  if (!Number.isFinite(parsed.port) || parsed.port <= 0) throw new Error("--port must be a positive number");
  if (parsed.interaction !== undefined && !["pan", "zoom", "zoom-out"].includes(parsed.interaction)) throw new Error("--interaction must be pan, zoom, or zoom-out");
  return parsed;
}

function summaryCanInteract(hud, options) {
  return options.interaction !== undefined && hud.status === "stable";
}

async function runInteraction(page, interaction) {
  const before = await canvasSignature(page);
  const inputTime = await dispatchInteraction(page, interaction);

  let firstVisualChangeMs = await waitForRetainedFrame(page, inputTime, 250);
  if (firstVisualChangeMs === null) {
    const visualDeadline = Date.now() + 1000;
    while (Date.now() < visualDeadline) {
      const current = await canvasSignature(page);
      if (current !== before) {
        firstVisualChangeMs = await page.evaluate((started) => performance.now() - started, inputTime);
        break;
      }
      await page.waitForTimeout(25);
    }
  }

  await page.waitForTimeout(1500);
  return page.evaluate(({ inputTime, firstVisualChangeMs, interaction }) => {
    const bench = globalThis.__deepBench;
    const events = bench?.profile?.events ?? [];
    const revisions = events
      .filter((event) => typeof event.revision === "number" && event.now >= inputTime)
      .map((event) => event.revision);
    const newRevision = revisions.length > 0 ? Math.max(...revisions) : undefined;
    const newQueues = events.filter((event) => event.type === "tileQueued" && event.now >= inputTime && event.revision === newRevision);
    const firstQueued = newQueues.reduce((best, event) => Math.min(best, event.now), Number.POSITIVE_INFINITY);
    const renders = Object.values(bench?.profile?.tiles ?? {}).flatMap((tile) =>
      (tile.renders ?? []).map((render) => ({ ...render, revision: tile.revision }))
    );
    const newRenders = renders.filter((render) => render.doneAt >= inputTime && render.revision === newRevision);
    const oldRenders = renders.filter((render) => render.doneAt >= inputTime && newRevision !== undefined && render.revision < newRevision);
    const firstDone = newRenders.reduce((best, render) => Math.min(best, render.doneAt), Number.POSITIVE_INFINITY);
    return {
      interaction,
      inputTime,
      newRevision,
      firstVisualChangeMs: firstVisualChangeMs === null ? null : Number(firstVisualChangeMs.toFixed(2)),
      newRevisionQueuedMs: Number.isFinite(firstQueued) ? Number((firstQueued - inputTime).toFixed(2)) : null,
      firstNewTileDoneMs: Number.isFinite(firstDone) ? Number((firstDone - inputTime).toFixed(2)) : null,
      oldRevisionTileDoneAfterInput: oldRenders.length,
      status: document.querySelector("#readStatus")?.textContent ?? ""
    };
  }, { inputTime, firstVisualChangeMs, interaction });
}

async function waitForRetainedFrame(page, inputTime, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const elapsed = await page.evaluate((started) => {
      const events = globalThis.__deepBench?.profile?.events ?? [];
      const frame = events.find((event) => event.type === "retainedFrameRendered" && event.now >= started);
      return frame === undefined ? null : frame.now - started;
    }, inputTime);
    if (elapsed !== null) return elapsed;
    await page.waitForTimeout(10);
  }
  return null;
}

async function dispatchInteraction(page, interaction) {
  return page.evaluate((interaction) => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return performance.now();
    const rect = canvas.getBoundingClientRect();
    const x = rect.left + rect.width * 0.5;
    const y = rect.top + rect.height * 0.5;
    const started = performance.now();
    if (interaction === "pan") {
      const init = {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        buttons: 1
      };
      canvas.dispatchEvent(new PointerEvent("pointerdown", { ...init, clientX: x, clientY: y }));
      canvas.dispatchEvent(new PointerEvent("pointermove", { ...init, clientX: x + 300, clientY: y + 120 }));
      canvas.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0, clientX: x + 300, clientY: y + 120 }));
    } else {
      canvas.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        deltaY: interaction === "zoom-out" ? 2400 : -600
      }));
    }
    return started;
  }, interaction);
}

async function canvasSignature(page) {
  const box = await page.locator("canvas").boundingBox();
  if (!box) return "";
  const png = await page.screenshot({ clip: centeredClip(box), timeout: 2000 });
  return hashBytes(png);
}

function centeredClip(box) {
  return {
    x: Math.floor(box.x + box.width * 0.25),
    y: Math.floor(box.y + box.height * 0.25),
    width: Math.max(1, Math.floor(box.width * 0.5)),
    height: Math.max(1, Math.floor(box.height * 0.5))
  };
}

function hashBytes(bytes) {
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return String(hash);
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
    workers: { tile: 0, unknown: 0 },
    counts: {
      tileDone: 0,
      final: 0,
      finalStarted: 0,
      finalUploaded: 0,
      referenceDone: 0,
      referenceError: 0
    },
    sums: {
      finalWorkerMs: 0,
      finalWallMs: 0,
      finalQueueMs: 0,
      finalUploadMs: 0,
      referenceWallMs: 0
    },
    samples: {
      finalWorkerMs: [],
      finalWallMs: [],
      finalQueueMs: [],
      finalUploadMs: []
    },
    waves: {
      completedFinals: 0,
      maxSeriesSkip: 0,
      paletteFootprintCount: 0,
      paletteFootprintFallbackCount: 0,
      paletteFilteredCount: 0,
      paletteProxyCount: 0,
      maxPaletteFootprint: 0,
      maxPaletteProxyLod: 0,
      totalRebases: 0,
      totalPeriodicInterior: 0,
      onePixelTiles: 0,
      minTileArea: Infinity
    },
    slowFinalTiles: [],
    profile: {
      events: [],
      tiles: {}
    },
    stableAt: undefined
  };
  globalThis.__deepBench = bench;
  globalThis.__deepBenchRecord = function recordDeepBenchEvent(event) {
    const now = performance.now();
    const normalized = { ...event, now };
    bench.profile.events.push(normalized);
    if (event?.tileId) {
      const tile = tileProfile(event.tileId);
      tile.events ??= [];
      tile.events.push(normalized);
      tile.revision = event.revision ?? tile.revision;
      if (event.type === "tileQueued") {
        tile.queuedAt = event.queuedAt ?? now;
        tile.priority = event.priority;
      } else if (event.type === "tileStarted") {
        tile.startedAt = event.startedAt ?? now;
        const queueMs = tile.queuedAt === undefined ? undefined : tile.startedAt - tile.queuedAt;
        if (queueMs !== undefined) {
          tile.queueMs = queueMs;
          bench.counts.finalStarted += 1;
          bench.sums.finalQueueMs += queueMs;
          bench.samples.finalQueueMs.push(queueMs);
        }
      } else if (event.type === "tileUploadStarted") {
        tile.uploadStartedAt = event.uploadStartedAt ?? now;
      } else if (event.type === "tileUploadDone") {
        tile.uploadDoneAt = event.uploadDoneAt ?? now;
        const uploadMs = tile.uploadStartedAt === undefined ? undefined : tile.uploadDoneAt - tile.uploadStartedAt;
        if (uploadMs !== undefined) {
          tile.uploadMs = uploadMs;
          bench.counts.finalUploaded += 1;
          bench.sums.finalUploadMs += uploadMs;
        }
      }
    }
  };

  globalThis.Worker = function Worker(url, workerOptions) {
    const worker = new OriginalWorker(url, workerOptions);
    const urlText = String(url);
    if (urlText.includes("tileWorker")) bench.workers.tile += 1;
    else bench.workers.unknown += 1;

    let current;
    const postMessage = worker.postMessage.bind(worker);
    worker.postMessage = function patchedPostMessage(message, transferOrOptions) {
      if (message?.type === "renderTile") {
        current = {
          type: "tile",
          started: performance.now(),
          tileId: message.tile.id,
          rect: { ...message.tile.rect }
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
        const tileArea = Math.max(0, data.width) * Math.max(0, data.height);
        bench.waves.minTileArea = Math.min(bench.waves.minTileArea, tileArea);
        if (data.width <= 1 || data.height <= 1) bench.waves.onePixelTiles += 1;
        bench.counts.final += 1;
        bench.sums.finalWorkerMs += data.stats.elapsedMs;
        bench.sums.finalWallMs += wallMs;
        bench.samples.finalWorkerMs.push(data.stats.elapsedMs);
        bench.samples.finalWallMs.push(wallMs);
        bench.waves.completedFinals += 1;
        bench.waves.maxSeriesSkip = Math.max(bench.waves.maxSeriesSkip, data.stats.seriesSkip);
        bench.waves.paletteFootprintCount += data.stats.paletteFootprintCount ?? 0;
        bench.waves.paletteFootprintFallbackCount += data.stats.paletteFootprintFallbackCount ?? 0;
        bench.waves.paletteFilteredCount += data.stats.paletteFilteredCount ?? 0;
        bench.waves.paletteProxyCount += data.stats.paletteProxyCount ?? 0;
        bench.waves.maxPaletteFootprint = Math.max(bench.waves.maxPaletteFootprint, data.stats.maxPaletteFootprint ?? 0);
        bench.waves.maxPaletteProxyLod = Math.max(bench.waves.maxPaletteProxyLod, data.stats.maxPaletteProxyLod ?? 0);
        bench.waves.totalRebases += data.stats.rebaseCount;
        bench.waves.totalPeriodicInterior += data.stats.periodicInteriorCount;
        pushSlowFinal({
          workerMs: Math.round(data.stats.elapsedMs),
          wallMs: Math.round(wallMs),
          rect: data.rect,
          escaped: data.stats.escapedPixels,
          seriesSkip: data.stats.seriesSkip,
          rebases: data.stats.rebaseCount,
          periodicInterior: data.stats.periodicInteriorCount,
          paletteFootprints: data.stats.paletteFootprintCount,
          paletteFootprintFallbacks: data.stats.paletteFootprintFallbackCount,
          paletteFiltered: data.stats.paletteFilteredCount,
          paletteProxies: data.stats.paletteProxyCount,
          maxPaletteFootprint: data.stats.maxPaletteFootprint,
          maxPaletteProxyLod: data.stats.maxPaletteProxyLod
        });
        if (current?.tileId) {
          const tile = tileProfile(current.tileId);
          tile.renders ??= [];
          tile.renders.push({
            doneAt: performance.now(),
            wallMs,
            workerMs: data.stats.elapsedMs,
            rect: data.rect,
            stats: {
              escaped: data.stats.escapedPixels,
              seriesSkip: data.stats.seriesSkip,
              rebases: data.stats.rebaseCount,
              periodicInterior: data.stats.periodicInteriorCount,
              paletteFootprints: data.stats.paletteFootprintCount,
              paletteFootprintFallbacks: data.stats.paletteFootprintFallbackCount,
              paletteFiltered: data.stats.paletteFilteredCount,
              paletteProxies: data.stats.paletteProxyCount,
              maxPaletteFootprint: data.stats.maxPaletteFootprint,
              maxPaletteProxyLod: data.stats.maxPaletteProxyLod
            }
          });
          tile.doneAt = performance.now();
          tile.wallMs = wallMs;
          tile.workerMs = data.stats.elapsedMs;
          tile.rect = data.rect;
          tile.stats = {
            escaped: data.stats.escapedPixels,
            seriesSkip: data.stats.seriesSkip,
            rebases: data.stats.rebaseCount,
            periodicInterior: data.stats.periodicInteriorCount,
            paletteFootprints: data.stats.paletteFootprintCount,
            paletteFootprintFallbacks: data.stats.paletteFootprintFallbackCount,
            paletteFiltered: data.stats.paletteFilteredCount,
            paletteProxies: data.stats.paletteProxyCount,
            maxPaletteFootprint: data.stats.maxPaletteFootprint,
            maxPaletteProxyLod: data.stats.maxPaletteProxyLod
          };
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

  function tileProfile(tileId) {
    const key = String(tileId);
    bench.profile.tiles[key] ??= { tileId: key };
    return bench.profile.tiles[key];
  }
}

async function readHud(page) {
  return page.evaluate(() => ({
    status: document.querySelector("#readStatus")?.textContent ?? "",
    tiles: document.querySelector("#readTiles")?.textContent ?? "",
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

function percentiles(values) {
  if (!values.length) return { p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: round(sorted[Math.floor((sorted.length - 1) * 0.5)]),
    p95: round(sorted[Math.floor((sorted.length - 1) * 0.95)]),
    p99: round(sorted[Math.floor((sorted.length - 1) * 0.99)]),
    max: round(sorted[sorted.length - 1])
  };
}

function round(value) {
  return Number(value.toFixed(2));
}

function parseTileProgress(value) {
  const match = /^(\d+)\/(\d+)$/.exec(String(value).trim());
  return {
    completed: match ? Number(match[1]) : 0,
    total: match ? Number(match[2]) : 0
  };
}

async function writeProfile(path, payload) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function closePreview(previewServer) {
  return new Promise((resolve, reject) => {
    previewServer.httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
