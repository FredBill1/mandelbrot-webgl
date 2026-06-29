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
import {
  SERIES_DEGREE,
  TILE_SIZE,
  type NeedReferenceMessage,
  type RuntimeView,
  type TileDescriptor,
  type UnresolvedCluster,
  type ViewState
} from "./types";

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

interface TileWorkState {
  tile: TileDescriptor;
  referenceIds: Set<string>;
  requestedReferenceKeys: Set<string>;
  refinementLevel: number;
  splitLevel: number;
  inFlight: boolean;
  completed: boolean;
  pendingReferences: number;
}

const MAX_TILE_REFERENCES = 16;
const MAX_CLUSTER_REFERENCES_PER_PASS = 4;
const MIN_NORMAL_SUBTILE_SIZE = 8;
const MICROTILE_SIZE = 1;

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
  const tileStates = new Map<string, TileWorkState>();

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
    tileStates.clear();

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

    for (const tile of tiles) createTileState(tile, [viewReference.id], 0);
    syncPinnedReferences();
    stats.pending = pendingTileIds.size;
    stats.references = references.size;
    stats.status = `rendering ${tiles.length} tiles`;

    for (const tile of tiles) void submitTile(localRuntime, mustTileState(tile.id));
  }

  function createTileState(tile: TileDescriptor, referenceIds: Iterable<string>, splitLevel: number): TileWorkState {
    const state: TileWorkState = {
      tile,
      referenceIds: new Set(referenceIds),
      requestedReferenceKeys: new Set(),
      refinementLevel: 0,
      splitLevel,
      inFlight: false,
      completed: false,
      pendingReferences: 0
    };
    tileStates.set(tile.id, state);
    pendingTileIds.add(tile.id);
    return state;
  }

  function mustTileState(tileId: string): TileWorkState {
    const state = tileStates.get(tileId);
    if (!state) throw new Error(`Missing tile state ${tileId}`);
    return state;
  }

  async function submitTile(localRuntime: RuntimeView, state: TileWorkState): Promise<void> {
    if (state.inFlight || state.completed || state.tile.revision !== revision) return;
    const candidates = buildReferenceCandidates(state, localRuntime);
    if (candidates.length === 0) {
      const reference = await references.ensureTileReference(localRuntime, state.tile, 128);
      if (state.tile.revision !== revision || state.completed) return;
      state.referenceIds.add(reference.id);
      syncPinnedReferences();
      void submitTile(localRuntime, state);
      return;
    }

    for (const reference of candidates) state.referenceIds.add(reference.id);
    syncPinnedReferences();
    state.inFlight = true;
    try {
      const result = await pool.render({
        type: "renderTile",
        tile: state.tile,
        canvasWidth: localRuntime.width,
        canvasHeight: localRuntime.height,
        pixelSpan: pixelSpanForView(localRuntime, localRuntime.width),
        maxIter: localRuntime.maxIter,
        references: candidates,
        seriesDegree: SERIES_DEGREE,
        paletteId: "cosine",
        refined: state.refinementLevel > 0,
        refinementLevel: state.refinementLevel
      });
      state.inFlight = false;
      if (result.revision !== revision || state.completed || state.tile.revision !== revision) return;
      stats.lastTileMs = result.stats.elapsedMs;
      stats.lastSeriesSkip = result.stats.seriesSkip;
      stats.glitches += result.stats.glitchCount;
      stats.activeWorkers = pool.active;
      stats.references = references.size;

      if (result.stats.unresolvedCount > 0) {
        const queued = queueClusterReferences(localRuntime, state, result.stats.unresolvedClusters);
        if (queued > 0 || state.pendingReferences > 0) {
          stats.pending = pendingTileIds.size;
          stats.status = "refining";
          return;
        }
        if (canSplitTile(state.tile)) {
          await splitTile(localRuntime, state);
          return;
        }
        await forceCenterReference(localRuntime, state);
        return;
      }

      renderer.uploadTile(result);
      state.completed = true;
      stats.completedTiles += 1;
      pendingTileIds.delete(state.tile.id);
      syncPinnedReferences();
      stats.pending = pendingTileIds.size;
      renderer.pruneRetainedWhenActiveCoverage(Math.max(1, Math.floor((localRuntime.width * localRuntime.height) / (TILE_SIZE * TILE_SIZE) * 0.7)));
      stats.status = stats.pending > 0 ? "rendering" : "stable";
    } catch (error) {
      state.inFlight = false;
      stats.status = error instanceof Error ? error.message : String(error);
    }
  }

  async function refineReference(message: NeedReferenceMessage): Promise<void> {
    if (message.tile.revision !== revision) return;
    const state = tileStates.get(message.tile.id);
    if (!state || state.completed) return;
    const localRuntime = currentRuntimeView();
    const requestKey = referenceRequestKey(message.targetScreenX, message.targetScreenY, message.requiredPrecision);
    if (state.requestedReferenceKeys.has(requestKey)) return;
    if (state.referenceIds.size + state.pendingReferences >= MAX_TILE_REFERENCES && canSplitTile(state.tile)) return;

    state.requestedReferenceKeys.add(requestKey);
    state.pendingReferences += 1;
    stats.pending = pendingTileIds.size;
    stats.status = "refining";

    const targetCenter = await pointToViewCenter(view, localRuntime.width, localRuntime.height, message.targetScreenX, message.targetScreenY);
    const targetTile: TileDescriptor = {
      ...message.tile,
      centerScreenX: message.targetScreenX,
      centerScreenY: message.targetScreenY,
      centerRe: targetCenter.re,
      centerIm: targetCenter.im
    };
    const reference = await references.ensureTileReference(localRuntime, targetTile, message.requiredPrecision);
    state.pendingReferences = Math.max(0, state.pendingReferences - 1);
    if (message.tile.revision !== revision || state.completed) return;
    state.referenceIds.add(reference.id);
    state.refinementLevel = Math.max(state.refinementLevel, message.refinementLevel);
    syncPinnedReferences();
    stats.references = references.size;
    if (!state.inFlight) await submitTile(localRuntime, state);
  }

  function buildReferenceCandidates(state: TileWorkState, localRuntime: RuntimeView) {
    const explicit = [...state.referenceIds]
      .map((id) => references.getById(id))
      .filter((reference): reference is NonNullable<typeof reference> => Boolean(reference));
    const selected = references.selectCandidates(state.tile, localRuntime.maxIter, localRuntime.revision, MAX_TILE_REFERENCES);
    const merged = new Map<string, (typeof selected)[number]>();
    for (const reference of explicit) merged.set(reference.id, reference);
    for (const reference of selected) merged.set(reference.id, reference);
    return [...merged.values()].slice(0, MAX_TILE_REFERENCES);
  }

  function queueClusterReferences(localRuntime: RuntimeView, state: TileWorkState, clusters: UnresolvedCluster[]): number {
    if (clusters.length === 0) return 0;
    if (state.referenceIds.size + state.pendingReferences >= MAX_TILE_REFERENCES && canSplitTile(state.tile)) return 0;
    let queued = 0;
    const highestPrecision = buildReferenceCandidates(state, localRuntime).reduce((bits, reference) => Math.max(bits, reference.precisionBits), 128);
    for (const cluster of clusters.slice(0, MAX_CLUSTER_REFERENCES_PER_PASS)) {
      if (state.referenceIds.size + state.pendingReferences + queued >= MAX_TILE_REFERENCES && canSplitTile(state.tile)) break;
      const requestKey = referenceRequestKey(cluster.screenX, cluster.screenY, highestPrecision + 32);
      if (state.requestedReferenceKeys.has(requestKey)) continue;
      state.pendingReferences += 1;
      state.requestedReferenceKeys.add(requestKey);
      queued += 1;
      void requestReferenceForPoint(localRuntime, state, cluster.screenX, cluster.screenY, highestPrecision + 32, state.refinementLevel + 1);
    }
    return queued;
  }

  async function requestReferenceForPoint(
    localRuntime: RuntimeView,
    state: TileWorkState,
    screenX: number,
    screenY: number,
    requiredPrecision: number,
    refinementLevel: number
  ): Promise<void> {
    const targetCenter = await pointToViewCenter(view, localRuntime.width, localRuntime.height, screenX, screenY);
    const targetTile: TileDescriptor = {
      ...state.tile,
      centerScreenX: screenX,
      centerScreenY: screenY,
      centerRe: targetCenter.re,
      centerIm: targetCenter.im
    };
    const reference = await references.ensureTileReference(localRuntime, targetTile, requiredPrecision);
    state.pendingReferences = Math.max(0, state.pendingReferences - 1);
    if (state.tile.revision !== revision || state.completed) return;
    state.referenceIds.add(reference.id);
    state.refinementLevel = Math.max(state.refinementLevel, refinementLevel);
    syncPinnedReferences();
    stats.references = references.size;
    if (!state.inFlight) await submitTile(localRuntime, state);
  }

  async function forceCenterReference(localRuntime: RuntimeView, state: TileWorkState): Promise<void> {
    const highestPrecision = buildReferenceCandidates(state, localRuntime).reduce((bits, reference) => Math.max(bits, reference.precisionBits), 128);
    state.referenceIds.clear();
    state.requestedReferenceKeys.clear();
    state.pendingReferences = 0;
    state.refinementLevel += 1;
    const reference = await references.ensureTileReference(localRuntime, state.tile, highestPrecision + 64);
    if (state.tile.revision !== revision || state.completed) return;
    state.referenceIds.add(reference.id);
    syncPinnedReferences();
    stats.references = references.size;
    stats.status = "refining";
    await submitTile(localRuntime, state);
  }

  async function splitTile(localRuntime: RuntimeView, state: TileWorkState): Promise<void> {
    const tile = state.tile;
    if (tile.revision !== revision) return;
    const subtiles = await createSubtiles(localRuntime, tile);
    if (tile.revision !== revision || subtiles.length === 0) return;

    pendingTileIds.delete(tile.id);
    tileStates.delete(tile.id);
    for (const subtile of subtiles) pendingTileIds.add(subtile.id);
    stats.pending = pendingTileIds.size;
    stats.status = "splitting";

    for (const subtile of subtiles) {
      const seedReferences = references.selectCandidates(subtile, localRuntime.maxIter, localRuntime.revision, 4).map((reference) => reference.id);
      const child = createTileState(subtile, seedReferences, state.splitLevel + 1);
      void submitTile(localRuntime, child);
    }
    syncPinnedReferences();
  }

  async function createSubtiles(localRuntime: RuntimeView, tile: TileDescriptor): Promise<TileDescriptor[]> {
    const splitX = tile.rect.width > MICROTILE_SIZE;
    const splitY = tile.rect.height > MICROTILE_SIZE;
    if (!splitX && !splitY) return [];

    const xCuts = splitAxis(tile.rect.width);
    const yCuts = splitAxis(tile.rect.height);
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
        const span = Math.max(MICROTILE_SIZE, Math.floor(Math.max(rect.width, rect.height)));
        const key = {
          level: tile.key.level + 1,
          x: tile.key.x * 16 + xi,
          y: tile.key.y * 16 + yi,
          span
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
    return tile.rect.width > MICROTILE_SIZE || tile.rect.height > MICROTILE_SIZE;
  }

  function splitAxis(length: number): number[] {
    if (length <= MICROTILE_SIZE) return [0, length];
    if (length <= MIN_NORMAL_SUBTILE_SIZE) {
      const cuts = [0];
      for (let value = 1; value < length; value += 1) cuts.push(value);
      cuts.push(length);
      return cuts;
    }
    return [0, Math.floor(length * 0.5), length];
  }

  function referenceRequestKey(screenX: number, screenY: number, precisionBits: number): string {
    return `${Math.round(screenX * 4) / 4}:${Math.round(screenY * 4) / 4}:${precisionBits}`;
  }

  function syncPinnedReferences(): void {
    const ids = new Set<string>();
    for (const state of tileStates.values()) {
      if (state.completed) continue;
      for (const id of state.referenceIds) ids.add(id);
    }
    references.setPinnedReferenceIds(ids);
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
