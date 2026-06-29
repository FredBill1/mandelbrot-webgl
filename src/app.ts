import { ReferenceManager } from "./reference/referenceManager";
import { WebglTileRenderer } from "./render/webglRenderer";
import { TileWorkerPool } from "./scheduler/workerPool";
import { createVisibleTileShells, tileKeyToId } from "./tiles/tileKey";
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

const MIN_SUBTILE_SIZE = 32;

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
  const pendingTileIds = new Set<string>();

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
    pendingTileIds.clear();

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

    for (const tile of tiles) pendingTileIds.add(tile.id);
    stats.pending = pendingTileIds.size;
    stats.references = references.size;
    stats.status = `rendering ${tiles.length} tiles`;

    for (const tile of tiles) {
      const reference = references.selectBest(tile, localRuntime.maxIter, localRuntime.revision) ?? viewReference;
      void submitTile(localRuntime, tile, reference.id, 0);
    }
  }

  async function submitTile(localRuntime: RuntimeView, tile: TileDescriptor, referenceId: string, refinementLevel: number): Promise<void> {
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
        refined: refinementLevel > 0,
        refinementLevel
      });
      if (result.revision !== revision) return;
      stats.lastTileMs = result.stats.elapsedMs;
      stats.lastSeriesSkip = result.stats.seriesSkip;
      stats.glitches += result.stats.glitchCount;
      stats.activeWorkers = pool.active;
      stats.references = references.size;

      if (result.stats.unresolvedCount > 0) {
        if (result.needsReference) {
          stats.pending = pendingTileIds.size;
          stats.status = "refining";
          return;
        }
        if (canSplitTile(tile)) {
          await splitTile(localRuntime, tile);
          return;
        }
        stats.pending = pendingTileIds.size;
        stats.status = "unresolved";
        return;
      }

      renderer.uploadTile(result);
      stats.completedTiles += 1;
      pendingTileIds.delete(tile.id);
      stats.pending = pendingTileIds.size;
      renderer.pruneRetainedWhenActiveCoverage(Math.max(1, Math.floor((localRuntime.width * localRuntime.height) / (TILE_SIZE * TILE_SIZE) * 0.7)));
      stats.status = stats.pending > 0 ? "rendering" : "stable";
    } catch (error) {
      stats.status = error instanceof Error ? error.message : String(error);
    }
  }

  async function refineReference(message: NeedReferenceMessage): Promise<void> {
    if (message.tile.revision !== revision) return;
    const localRuntime = currentRuntimeView();
    const targetCenter = await pointToViewCenter(view, localRuntime.width, localRuntime.height, message.targetScreenX, message.targetScreenY);
    const targetTile: TileDescriptor = {
      ...message.tile,
      centerScreenX: message.targetScreenX,
      centerScreenY: message.targetScreenY,
      centerRe: targetCenter.re,
      centerIm: targetCenter.im
    };
    const reference = await references.ensureTileReference(localRuntime, targetTile, message.requiredPrecision);
    if (message.tile.revision !== revision) return;
    stats.references = references.size;
    await submitTile(localRuntime, message.tile, reference.id, message.refinementLevel);
  }

  async function splitTile(localRuntime: RuntimeView, tile: TileDescriptor): Promise<void> {
    if (tile.revision !== revision) return;
    const subtiles = await createSubtiles(localRuntime, tile);
    if (tile.revision !== revision || subtiles.length === 0) return;

    pendingTileIds.delete(tile.id);
    for (const subtile of subtiles) pendingTileIds.add(subtile.id);
    stats.pending = pendingTileIds.size;
    stats.status = "splitting";

    for (const subtile of subtiles) {
      const reference = references.selectBest(subtile, localRuntime.maxIter, localRuntime.revision);
      if (reference) void submitTile(localRuntime, subtile, reference.id, 0);
      else void references.ensureTileReference(localRuntime, subtile, 128).then((nextReference) => submitTile(localRuntime, subtile, nextReference.id, 0));
    }
  }

  async function createSubtiles(localRuntime: RuntimeView, tile: TileDescriptor): Promise<TileDescriptor[]> {
    const splitX = tile.rect.width > MIN_SUBTILE_SIZE;
    const splitY = tile.rect.height > MIN_SUBTILE_SIZE;
    if (!splitX && !splitY) return [];

    const xCuts = splitX ? [0, Math.floor(tile.rect.width * 0.5), tile.rect.width] : [0, tile.rect.width];
    const yCuts = splitY ? [0, Math.floor(tile.rect.height * 0.5), tile.rect.height] : [0, tile.rect.height];
    const subtiles: TileDescriptor[] = [];

    for (let yi = 0; yi < yCuts.length - 1; yi += 1) {
      for (let xi = 0; xi < xCuts.length - 1; xi += 1) {
        const rect = {
          x: tile.rect.x + xCuts[xi],
          y: tile.rect.y + yCuts[yi],
          width: xCuts[xi + 1] - xCuts[xi],
          height: yCuts[yi + 1] - yCuts[yi]
        };
        if (rect.width <= 0 || rect.height <= 0) continue;
        const key = {
          level: tile.key.level + 1,
          x: tile.key.x * 2 + xi,
          y: tile.key.y * 2 + yi,
          span: Math.max(MIN_SUBTILE_SIZE, Math.floor(tile.key.span * 0.5))
        };
        const centerScreenX = rect.x + rect.width * 0.5;
        const centerScreenY = rect.y + rect.height * 0.5;
        const center = await pointToViewCenter(view, localRuntime.width, localRuntime.height, centerScreenX, centerScreenY);
        subtiles.push({
          id: tileKeyToId(key, tile.revision),
          key,
          rect,
          centerScreenX,
          centerScreenY,
          centerRe: center.re,
          centerIm: center.im,
          revision: tile.revision
        });
      }
    }
    return subtiles;
  }

  function canSplitTile(tile: TileDescriptor): boolean {
    return tile.rect.width > MIN_SUBTILE_SIZE || tile.rect.height > MIN_SUBTILE_SIZE;
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
