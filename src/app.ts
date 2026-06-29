import { ReferenceManager } from "./reference/referenceManager";
import { WebglTileRenderer } from "./render/webglRenderer";
import { TileWorkerPool } from "./scheduler/workerPool";
import { createVisibleTileShells } from "./tiles/tileKey";
import {
  DEEP_TEST_VIEW,
  DEFAULT_VIEW,
  parseViewFromUrl,
  writeViewToUrl
} from "./state/urlState";
import { defaultMaxIter, formatCompactDecimal, pixelSpanForView } from "./math/view";
import { initWasm, pointToViewCenter, transformView } from "./wasmApi";
import { SERIES_DEGREE, TILE_SIZE, type NeedReferenceMessage, type RuntimeView, type TileDescriptor, type ViewState } from "./types";

interface Stats {
  fps: number;
  pending: number;
  activeWorkers: number;
  completedTiles: number;
  references: number;
  lastTileMs: number;
  lastSeriesSkip: number;
  glitches: number;
  status: string;
}

export async function startApp(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <main class="shell">
      <canvas id="fractal" aria-label="Mandelbrot deep zoom canvas"></canvas>
      <section class="hud" aria-live="polite">
        <div class="hudRow"><span>Re</span><strong id="readRe"></strong></div>
        <div class="hudRow"><span>Im</span><strong id="readIm"></strong></div>
        <div class="hudRow"><span>Scale</span><strong id="readScale"></strong></div>
        <div class="hudRow"><span>Iter</span><strong id="readIter"></strong></div>
        <div class="hudRow"><span>Workers</span><strong id="readWorkers"></strong></div>
        <div class="hudRow"><span>Tiles</span><strong id="readTiles"></strong></div>
        <div class="hudRow"><span>Refs</span><strong id="readRefs"></strong></div>
        <div class="hudRow"><span>FPS</span><strong id="readFps"></strong></div>
        <div class="hudRow"><span>Status</span><strong id="readStatus"></strong></div>
      </section>
      <nav class="toolbar" aria-label="View controls">
        <button id="homeButton" title="Reset view">Home</button>
        <button id="deepButton" title="Jump to a 1e100 validation location">1e100</button>
      </nav>
    </main>
  `;

  const canvas = requireElement(root, "#fractal", HTMLCanvasElement);

  await initWasm();

  let view: ViewState = parseViewFromUrl();
  let revision = 1;
  let renderToken = 0;
  let scheduledUrlWrite = 0;
  const stats: Stats = {
    fps: 0,
    pending: 0,
    activeWorkers: 0,
    completedTiles: 0,
    references: 0,
    lastTileMs: 0,
    lastSeriesSkip: 0,
    glitches: 0,
    status: "initializing"
  };

  const renderer = new WebglTileRenderer(canvas);
  const references = new ReferenceManager();
  const pool = new TileWorkerPool(undefined, (message) => {
    void refineReference(message);
  });

  let runtime = currentRuntimeView();
  resize();
  renderer.setActiveRevision(runtime.revision);
  void scheduleTiles("initial");

  root.querySelector<HTMLButtonElement>("#homeButton")?.addEventListener("click", () => {
    void setView({ ...DEFAULT_VIEW }, "home");
  });
  root.querySelector<HTMLButtonElement>("#deepButton")?.addEventListener("click", () => {
    void setView({ ...DEEP_TEST_VIEW }, "deep");
  });

  const interaction = { dragging: false, lastX: 0, lastY: 0 };
  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    interaction.dragging = true;
    interaction.lastX = event.clientX;
    interaction.lastY = event.clientY;
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!interaction.dragging) return;
    const dx = (event.clientX - interaction.lastX) * runtime.pixelRatio;
    const dy = (event.clientY - interaction.lastY) * runtime.pixelRatio;
    interaction.lastX = event.clientX;
    interaction.lastY = event.clientY;
    if (Math.abs(dx) + Math.abs(dy) < 0.5) return;
    renderer.applyRetainedPan(dx, dy);
    void transformView(view, runtime.width, runtime.height, dx, dy, 1, runtime.width * 0.5, runtime.height * 0.5).then((next) => {
      next.maxIter = defaultMaxIter(next.scale);
      void setView(next, "pan", false);
    });
  });
  canvas.addEventListener("pointerup", (event) => {
    interaction.dragging = false;
    canvas.releasePointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointercancel", () => {
    interaction.dragging = false;
  });
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const anchorX = (event.clientX - rect.left) * runtime.pixelRatio;
      const anchorY = (event.clientY - rect.top) * runtime.pixelRatio;
      const factor = Math.exp(-event.deltaY * 0.0015);
      renderer.applyRetainedZoom(factor, anchorX, anchorY);
      void transformView(view, runtime.width, runtime.height, 0, 0, factor, anchorX, anchorY).then((next) => {
        next.maxIter = defaultMaxIter(next.scale);
        void setView(next, "zoom", false);
      });
    },
    { passive: false }
  );
  window.addEventListener("resize", () => {
    resize();
    void setView(view, "resize", false);
  });

  let lastFrame = performance.now();
  function frame(now: number): void {
    const dt = Math.max(1, now - lastFrame);
    lastFrame = now;
    stats.fps = stats.fps * 0.9 + (1000 / dt) * 0.1;
    renderer.render();
    updateHud();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  async function setView(next: ViewState, reason: string, resetRetained = true): Promise<void> {
    view = next;
    revision += 1;
    runtime = currentRuntimeView();
    renderer.setActiveRevision(revision);
    if (resetRetained) renderer.pruneRetainedWhenActiveCoverage(0);
    pool.clearQueueForOldRevisions(revision);
    scheduleUrlSync();
    await scheduleTiles(reason);
  }

  async function scheduleTiles(reason: string): Promise<void> {
    const token = ++renderToken;
    const localRuntime = currentRuntimeView();
    stats.status = `reference ${reason}`;
    stats.pending = 0;
    stats.completedTiles = 0;
    stats.glitches = 0;

    const viewReference = await references.ensureViewReference(localRuntime);
    if (token !== renderToken) return;

    const shells = createVisibleTileShells(localRuntime, TILE_SIZE);
    const tiles = await Promise.all(
      shells.map(async (shell) => {
        const center = await pointToViewCenter(view, localRuntime.width, localRuntime.height, shell.centerScreenX, shell.centerScreenY);
        return { ...shell, centerRe: center.re, centerIm: center.im } satisfies TileDescriptor;
      })
    );
    if (token !== renderToken) return;

    stats.pending = tiles.length;
    stats.references = references.size;
    stats.status = `rendering ${tiles.length} tiles`;

    for (const tile of tiles) {
      const reference = references.selectBest(tile, localRuntime.maxIter, localRuntime.revision) ?? viewReference;
      void submitTile(localRuntime, tile, reference.id, false);
    }
  }

  async function submitTile(localRuntime: RuntimeView, tile: TileDescriptor, referenceId: string, refined: boolean): Promise<void> {
    const reference = references.entries.find((entry) => entry.id === referenceId) ?? references.selectBest(tile, localRuntime.maxIter, localRuntime.revision);
    if (!reference) return;
    try {
      const result = await pool.render({
        type: "renderTile",
        tile,
        canvasWidth: localRuntime.width,
        canvasHeight: localRuntime.height,
        pixelSpan: pixelSpanForView(localRuntime, localRuntime.width),
        maxIter: localRuntime.maxIter,
        reference,
        seriesDegree: SERIES_DEGREE,
        paletteId: "cosine",
        refined
      });
      if (result.revision !== revision) return;
      renderer.uploadTile(result);
      stats.completedTiles += 1;
      stats.pending = Math.max(0, stats.pending - 1);
      stats.lastTileMs = result.stats.elapsedMs;
      stats.lastSeriesSkip = result.stats.seriesSkip;
      stats.glitches += result.stats.glitchCount;
      stats.activeWorkers = pool.active;
      stats.references = references.size;
      renderer.pruneRetainedWhenActiveCoverage(Math.max(1, Math.floor((localRuntime.width * localRuntime.height) / (TILE_SIZE * TILE_SIZE) * 0.7)));
      stats.status = stats.pending > 0 ? "rendering" : "stable";
    } catch (error) {
      stats.status = error instanceof Error ? error.message : String(error);
    }
  }

  async function refineReference(message: NeedReferenceMessage): Promise<void> {
    if (message.tile.revision !== revision) return;
    const localRuntime = currentRuntimeView();
    const reference = await references.ensureTileReference(localRuntime, message.tile, message.requiredPrecision);
    if (message.tile.revision !== revision) return;
    stats.references = references.size;
    await submitTile(localRuntime, message.tile, reference.id, true);
  }

  function resize(): void {
    const pixelRatio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.floor(window.innerWidth * pixelRatio));
    const height = Math.max(1, Math.floor(window.innerHeight * pixelRatio));
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    runtime = { ...view, width, height, pixelRatio, revision };
    renderer.resize(width, height);
  }

  function currentRuntimeView(): RuntimeView {
    return {
      ...view,
      width: canvas.width || Math.max(1, Math.floor(window.innerWidth * (window.devicePixelRatio || 1))),
      height: canvas.height || Math.max(1, Math.floor(window.innerHeight * (window.devicePixelRatio || 1))),
      pixelRatio: Math.max(1, Math.min(2, window.devicePixelRatio || 1)),
      revision
    };
  }

  function scheduleUrlSync(): void {
    window.clearTimeout(scheduledUrlWrite);
    scheduledUrlWrite = window.setTimeout(() => writeViewToUrl(view), 80);
  }

  function updateHud(): void {
    setText("readRe", formatCompactDecimal(view.re));
    setText("readIm", formatCompactDecimal(view.im));
    setText("readScale", formatCompactDecimal(view.scale));
    setText("readIter", String(view.maxIter));
    setText("readWorkers", `${pool.active}/${pool.size}`);
    setText("readTiles", `${stats.completedTiles}/${stats.completedTiles + stats.pending}`);
    setText("readRefs", String(stats.references));
    setText("readFps", stats.fps.toFixed(0));
    setText("readStatus", stats.status);
  }

  function setText(id: string, value: string): void {
    const node = root.querySelector<HTMLElement>(`#${id}`);
    if (node) node.textContent = value;
  }
}

function requireElement<T extends Element>(root: ParentNode, selector: string, constructor: new () => T): T {
  const element = root.querySelector(selector);
  if (!(element instanceof constructor)) throw new Error(`Missing ${selector}`);
  return element;
}
