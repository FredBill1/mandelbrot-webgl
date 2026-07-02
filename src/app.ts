import { ReferenceManager } from "./reference/referenceManager";
import { WebglTileRenderer } from "./render/webglRenderer";
import {
  canSplitRect,
  clusterReferenceLimit,
  maxReferencesForRect,
  MAX_CLUSTER_REFERENCES_PER_PASS,
  MAX_NEW_SUBTILES_PER_FRAME,
  nextStalledRefinementRounds,
  shouldSplitTile,
  splitAxis as splitTileAxis
} from "./scheduler/tilePolicy";
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
  previewInFlight: boolean;
  completed: boolean;
  pendingReferences: number;
  localReferenceRequests: number;
  lastUnresolvedCount: number | undefined;
  stalledRefinementRounds: number;
  previewUploaded: boolean;
  microtileAllowed: boolean;
  splitReason: string | undefined;
  centerReferenceAttempted: boolean;
  referenceWaveLevel: number;
  lastReferencePressure: number;
  lastPreviewElapsedMs: number;
  lastPreviewUnresolvedCount: number;
}

interface ReferenceBrokerWaiter {
  tileId: string;
  refinementLevel: number;
}

interface ReferenceBrokerEntry {
  key: string;
  revision: number;
  targetScreenX: number;
  targetScreenY: number;
  requiredPrecision: number;
  cellSize: number;
  survivedIter: number;
  pixelCount: number;
  waiters: ReferenceBrokerWaiter[];
}

interface PointerSample {
  x: number;
  y: number;
}

interface PinchSample {
  centerX: number;
  centerY: number;
  distance: number;
}

const MAX_RENDER_REFERENCES = 16;
const PREVIEW_REFERENCE_LIMIT = 2;
const PREVIEW_REFERENCE_GLOBAL_BUDGET = 96;
const PREVIEW_REFERENCE_CELL_SIZE = 128;
const VIEWPORT_PREVIEW_SAMPLE_STEP = 16;
const HIGH_REFERENCE_PRESSURE = 0.12;
const LOW_REFERENCE_PRESSURE = 0.01;
const BROKER_FLUSH_DELAY_MS = 12;

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
  const referenceBroker = new Map<string, ReferenceBrokerEntry>();
  let referenceBrokerFlush = 0;
  let previewReferenceBudget = 0;

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

  const activePointers = new Map<number, PointerSample>();
  let lastPinch: PinchSample | undefined;
  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    activePointers.set(event.pointerId, pointerSample(event));
    resetPinchBaseline();
  });
  canvas.addEventListener("pointermove", (event) => {
    const previous = activePointers.get(event.pointerId);
    if (!previous) return;
    const current = pointerSample(event);
    activePointers.set(event.pointerId, current);

    if (activePointers.size >= 2) {
      handlePinchMove();
      return;
    }

    lastPinch = undefined;
    const dx = current.x - previous.x;
    const dy = current.y - previous.y;
    if (Math.abs(dx) + Math.abs(dy) < 0.5) return;
    renderer.applyRetainedPan(dx, dy);
    void transformView(view, runtime.width, runtime.height, dx, dy, 1, runtime.width * 0.5, runtime.height * 0.5).then((next) => {
      next.maxIter = defaultMaxIter(next.scale);
      void setView(next, "pan", false);
    });
  });
  canvas.addEventListener("pointerup", (event) => {
    finishPointer(event);
  });
  canvas.addEventListener("pointercancel", (event) => {
    finishPointer(event);
  });
  canvas.addEventListener("lostpointercapture", (event) => {
    activePointers.delete(event.pointerId);
    resetPinchBaseline();
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
    referenceBroker.clear();
    window.clearTimeout(referenceBrokerFlush);
    referenceBrokerFlush = 0;
    previewReferenceBudget = 0;

    await references.ensureViewReference(localRuntime);
    if (token !== renderToken) return;
    void submitViewportPreview(localRuntime, token);

    const shells = createVisibleTileShells(localRuntime, TILE_SIZE);
    const tiles = await Promise.all(
      shells.map(async (shell) => {
        const center = await pointToViewCenter(view, localRuntime.width, localRuntime.height, shell.centerScreenX, shell.centerScreenY);
        return { ...shell, centerRe: center.re, centerIm: center.im } satisfies TileDescriptor;
      })
    );
    if (token !== renderToken) return;

    for (const tile of tiles) createTileState(tile, [], 0);
    syncPinnedReferences();
    previewReferenceBudget = Math.min(PREVIEW_REFERENCE_GLOBAL_BUDGET, Math.max(16, tiles.length));
    stats.pending = pendingTileIds.size;
    stats.references = references.size;
    stats.status = `rendering ${tiles.length} tiles`;

    for (const tile of tiles) void submitPreview(localRuntime, mustTileState(tile.id));
  }

  function createTileState(tile: TileDescriptor, referenceIds: Iterable<string>, splitLevel: number): TileWorkState {
    const state: TileWorkState = {
      tile,
      referenceIds: new Set(referenceIds),
      requestedReferenceKeys: new Set(),
      refinementLevel: 0,
      splitLevel,
      inFlight: false,
      previewInFlight: false,
      completed: false,
      pendingReferences: 0,
      localReferenceRequests: 0,
      lastUnresolvedCount: undefined,
      stalledRefinementRounds: 0,
      previewUploaded: false,
      microtileAllowed: false,
      splitReason: undefined,
      centerReferenceAttempted: false,
      referenceWaveLevel: 0,
      lastReferencePressure: 0,
      lastPreviewElapsedMs: 0,
      lastPreviewUnresolvedCount: 0
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

  async function submitPreview(localRuntime: RuntimeView, state: TileWorkState): Promise<void> {
    if (state.previewInFlight || state.previewUploaded || state.completed || state.tile.revision !== revision) return;
    const candidates = buildReferenceCandidates(state, localRuntime);
    if (candidates.length === 0) {
      const reference = await references.ensureTileReference(localRuntime, state.tile, 128);
      if (state.tile.revision !== revision || state.completed) return;
      state.referenceIds.add(reference.id);
      state.localReferenceRequests += 1;
      syncPinnedReferences();
      void submitPreview(localRuntime, state);
      return;
    }
    state.previewInFlight = true;
    try {
      const result = await pool.render(
        {
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
          refinementLevel: state.refinementLevel,
          renderMode: "preview",
          sampleStep: previewSampleStep(state.tile)
        },
        0
      );
      state.previewInFlight = false;
      if (result.revision !== revision || state.tile.revision !== revision) return;
      if (state.completed) {
        updateWorkStatus("rendering");
        return;
      }
      renderer.uploadTile(result);
      state.previewUploaded = true;
      state.lastPreviewElapsedMs = result.stats.elapsedMs;
      state.lastPreviewUnresolvedCount = result.stats.unresolvedCount;
      stats.activeWorkers = pool.active;
      stats.references = references.size;
      if (result.stats.unresolvedCount > 0) {
        state.lastReferencePressure = previewUnresolvedPressure(result.stats.unresolvedCount, result.width, result.height);
        if (state.lastReferencePressure < HIGH_REFERENCE_PRESSURE) {
          const queued = queuePreviewReferences(localRuntime, state, result.stats.unresolvedClusters);
          if (queued > 0 || state.pendingReferences > 0) {
            stats.pending = pendingTileIds.size;
            stats.status = "refining";
            updateWorkStatus("refining");
            return;
          }
        }
      }
      updateWorkStatus("rendering");
      void submitTile(localRuntime, state);
    } catch (error) {
      state.previewInFlight = false;
      if (state.tile.revision !== revision) return;
      stats.status = error instanceof Error ? error.message : String(error);
    }
  }

  async function submitTile(localRuntime: RuntimeView, state: TileWorkState): Promise<void> {
    if (state.inFlight || state.completed || state.tile.revision !== revision) return;
    if (!state.previewUploaded || state.pendingReferences > 0) return;
    const candidates = buildReferenceCandidates(state, localRuntime);
    if (candidates.length === 0) {
      const reference = await references.ensureTileReference(localRuntime, state.tile, 128);
      if (state.tile.revision !== revision || state.completed) return;
      state.referenceIds.add(reference.id);
      state.localReferenceRequests += 1;
      syncPinnedReferences();
      void submitTile(localRuntime, state);
      return;
    }

    syncPinnedReferences();
    state.inFlight = true;
    const priority = finalRenderPriority(state);
    try {
      const result = await pool.render(
        {
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
          refinementLevel: state.refinementLevel,
          renderMode: "final",
          sampleStep: 1
        },
        priority
      );
      state.inFlight = false;
      if (result.revision !== revision || state.completed || state.tile.revision !== revision) return;
      stats.lastTileMs = result.stats.elapsedMs;
      stats.lastSeriesSkip = result.stats.seriesSkip;
      stats.glitches += result.stats.glitchCount;
      stats.activeWorkers = pool.active;
      stats.references = references.size;

      if (result.stats.unresolvedCount > 0) {
        renderer.uploadTile(result);
        state.previewUploaded = true;
        state.lastReferencePressure = unresolvedPressure(state, result.stats.unresolvedCount);
        state.stalledRefinementRounds = nextStalledRefinementRounds(
          state.lastUnresolvedCount,
          result.stats.unresolvedCount,
          state.stalledRefinementRounds
        );
        state.lastUnresolvedCount = result.stats.unresolvedCount;

        if (shouldRequestCenterReferenceFirst(localRuntime, state, result.stats.referenceIdsUsed)) {
          const queuedCenter = requestCenterReference(localRuntime, state, highestPrecisionForState(state, localRuntime) + 32);
          if (queuedCenter) {
            stats.pending = pendingTileIds.size;
            stats.status = "refining";
            return;
          }
        }

        const queued = queueClusterReferences(localRuntime, state, result.stats.unresolvedClusters);
        if (queued > 0 || state.pendingReferences > 0) {
          stats.pending = pendingTileIds.size;
          stats.status = "refining";
          return;
        }
        if (shouldSplitTile({
          rect: state.tile.rect,
          lastUnresolvedCount: state.lastUnresolvedCount,
          unresolvedCount: result.stats.unresolvedCount,
          stalledRefinementRounds: state.stalledRefinementRounds,
          pendingReferences: state.pendingReferences,
          referenceCount: state.referenceIds.size,
          maxReferences: maxReferencesForRect(state.tile.rect),
          hasLocalRefinement: state.localReferenceRequests > 0,
          microtileAllowed: state.microtileAllowed
        })) {
          state.splitReason = "stalled refinement";
          await splitTile(localRuntime, state);
          return;
        }
        if (canSplitTile(state.tile) && state.referenceIds.size >= maxReferencesForRect(state.tile.rect)) {
          state.microtileAllowed = true;
          state.splitReason = "reference budget";
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
      updateWorkStatus("rendering");
    } catch (error) {
      state.inFlight = false;
      if (state.tile.revision !== revision) return;
      stats.status = error instanceof Error ? error.message : String(error);
    }
  }

  async function refineReference(message: NeedReferenceMessage): Promise<void> {
    if (message.tile.revision !== revision) return;
    const state = tileStates.get(message.tile.id);
    if (!state || state.completed) return;
    const localRuntime = currentRuntimeView();
    const request = referenceRequestKey(localRuntime, message.targetScreenX, message.targetScreenY, message.requiredPrecision, 32);
    const requestKey = request.key;
    if (state.requestedReferenceKeys.has(requestKey)) return;
    if (state.referenceIds.size + state.pendingReferences >= maxReferencesForRect(state.tile.rect) && canSplitTile(state.tile)) return;

    state.requestedReferenceKeys.add(requestKey);
    state.pendingReferences += 1;
    state.localReferenceRequests += 1;
    stats.pending = pendingTileIds.size;
    stats.status = "refining";
    enqueueBrokerReference(localRuntime, state, {
      ...request,
      refinementLevel: message.refinementLevel,
      survivedIter: 0,
      pixelCount: 1
    });
  }

  function buildReferenceCandidates(state: TileWorkState, localRuntime: RuntimeView) {
    const explicit = [...state.referenceIds]
      .map((id) => references.getById(id))
      .filter((reference): reference is NonNullable<typeof reference> => Boolean(reference));
    explicit.sort((a, b) => referenceDistance(state.tile, a) - referenceDistance(state.tile, b));
    const maxReferences = maxRenderReferencesForState(state);
    const localReferenceLimit = Math.max(1, Math.ceil(maxReferences * 0.75));
    const selected = references.selectCandidates(state.tile, localRuntime.maxIter, localRuntime.revision, maxReferences);
    const merged = new Map<string, (typeof selected)[number]>();
    for (const reference of explicit.slice(0, localReferenceLimit)) merged.set(reference.id, reference);
    for (const reference of selected) merged.set(reference.id, reference);
    for (const reference of explicit.slice(localReferenceLimit)) merged.set(reference.id, reference);
    return [...merged.values()].slice(0, maxReferences);
  }

  function queuePreviewReferences(localRuntime: RuntimeView, state: TileWorkState, clusters: UnresolvedCluster[]): number {
    if (clusters.length === 0) return 0;
    if (previewReferenceBudget <= 0) return 0;
    const maxReferences = maxReferencesForRect(state.tile.rect);
    if (state.referenceIds.size + state.pendingReferences >= maxReferences && canSplitTile(state.tile)) return 0;
    let queued = 0;
    const highestPrecision = highestPrecisionForState(state, localRuntime);
    for (const cluster of clusters.slice(0, PREVIEW_REFERENCE_LIMIT)) {
      if (previewReferenceBudget <= 0) break;
      if (state.referenceIds.size + state.pendingReferences >= maxReferences && canSplitTile(state.tile)) break;
      const request = referenceRequestKey(localRuntime, cluster.screenX, cluster.screenY, highestPrecision + 32, PREVIEW_REFERENCE_CELL_SIZE);
      const requestKey = request.key;
      if (state.requestedReferenceKeys.has(requestKey)) continue;
      state.pendingReferences += 1;
      state.localReferenceRequests += 1;
      state.requestedReferenceKeys.add(requestKey);
      queued += 1;
      previewReferenceBudget -= 1;
      enqueueBrokerReference(localRuntime, state, {
        ...request,
        refinementLevel: state.refinementLevel + 1,
        survivedIter: cluster.survivedIter,
        pixelCount: cluster.pixelCount
      });
    }
    if (queued > 0) state.referenceWaveLevel += 1;
    return queued;
  }

  function maxRenderReferencesForState(state: TileWorkState): number {
    const policyLimit = maxReferencesForRect(state.tile.rect);
    if (state.refinementLevel >= 2 || state.stalledRefinementRounds > 0) return policyLimit;
    return Math.min(MAX_RENDER_REFERENCES, policyLimit);
  }

  function queueClusterReferences(localRuntime: RuntimeView, state: TileWorkState, clusters: UnresolvedCluster[]): number {
    if (clusters.length === 0) return 0;
    const maxReferences = maxReferencesForRect(state.tile.rect);
    if (state.referenceIds.size + state.pendingReferences >= maxReferences && canSplitTile(state.tile)) return 0;
    let queued = 0;
    const highestPrecision = highestPrecisionForState(state, localRuntime);
    const perPassLimit = clusterReferenceLimitForState(localRuntime, state);
    const cellSize = referenceWaveCellSize(state);
    for (const cluster of clusters.slice(0, perPassLimit)) {
      if (state.referenceIds.size + state.pendingReferences >= maxReferences && canSplitTile(state.tile)) break;
      const request = referenceRequestKey(localRuntime, cluster.screenX, cluster.screenY, highestPrecision + 32, cellSize);
      const requestKey = request.key;
      if (state.requestedReferenceKeys.has(requestKey)) continue;
      state.pendingReferences += 1;
      state.localReferenceRequests += 1;
      state.requestedReferenceKeys.add(requestKey);
      queued += 1;
      enqueueBrokerReference(localRuntime, state, {
        ...request,
        refinementLevel: state.refinementLevel + 1,
        survivedIter: cluster.survivedIter,
        pixelCount: cluster.pixelCount
      });
    }
    if (queued > 0) state.referenceWaveLevel += 1;
    return queued;
  }

  function enqueueBrokerReference(
    localRuntime: RuntimeView,
    state: TileWorkState,
    request: ReturnType<typeof referenceRequestKey> & { refinementLevel: number; survivedIter: number; pixelCount: number }
  ): void {
    const existing = referenceBroker.get(request.key);
    if (existing) {
      existing.waiters.push({ tileId: state.tile.id, refinementLevel: request.refinementLevel });
      if (isBetterBrokerRepresentative(request, existing)) {
        existing.targetScreenX = request.targetScreenX;
        existing.targetScreenY = request.targetScreenY;
        existing.survivedIter = request.survivedIter;
        existing.pixelCount = request.pixelCount;
      }
      return;
    }
    const entry: ReferenceBrokerEntry = {
      key: request.key,
      revision: localRuntime.revision,
      targetScreenX: request.targetScreenX,
      targetScreenY: request.targetScreenY,
      requiredPrecision: request.requiredPrecision,
      cellSize: request.cellSize,
      survivedIter: request.survivedIter,
      pixelCount: request.pixelCount,
      waiters: [{ tileId: state.tile.id, refinementLevel: request.refinementLevel }]
    };
    referenceBroker.set(request.key, entry);
    scheduleBrokerFlush(localRuntime);
  }

  function scheduleBrokerFlush(localRuntime: RuntimeView): void {
    if (referenceBrokerFlush !== 0) return;
    referenceBrokerFlush = window.setTimeout(() => {
      referenceBrokerFlush = 0;
      const entries = [...referenceBroker.values()]
        .filter((entry) => entry.revision === localRuntime.revision)
        .sort((a, b) => b.survivedIter - a.survivedIter || b.pixelCount - a.pixelCount);
      for (const entry of entries) void computeBrokerReference(localRuntime, entry);
    }, BROKER_FLUSH_DELAY_MS);
  }

  async function computeBrokerReference(localRuntime: RuntimeView, entry: ReferenceBrokerEntry): Promise<void> {
    try {
      const reusable = references.findReusableNear(
        entry.targetScreenX,
        entry.targetScreenY,
        Math.max(0.5, entry.cellSize * 0.75),
        localRuntime.maxIter,
        entry.revision,
        entry.requiredPrecision
      );
      if (reusable) {
        distributeBrokerReference(localRuntime, entry, reusable.id);
        return;
      }

      const targetCenter = await pointToViewCenter(view, localRuntime.width, localRuntime.height, entry.targetScreenX, entry.targetScreenY);
      if (entry.revision !== revision) return;
      const targetTile: TileDescriptor = {
        id: `reference:${entry.key}`,
        key: { level: 0, x: 0, y: 0, span: 1 },
        rect: { x: entry.targetScreenX - 0.5, y: entry.targetScreenY - 0.5, width: 1, height: 1 },
        centerScreenX: entry.targetScreenX,
        centerScreenY: entry.targetScreenY,
        centerRe: targetCenter.re,
        centerIm: targetCenter.im,
        revision: entry.revision
      };
      const reference = await references.ensureTileReference(localRuntime, targetTile, entry.requiredPrecision);
      if (entry.revision !== revision) return;
      distributeBrokerReference(localRuntime, entry, reference.id);
    } catch (error) {
      for (const waiter of entry.waiters) {
        const waiterState = tileStates.get(waiter.tileId);
        if (!waiterState) continue;
        waiterState.pendingReferences = Math.max(0, waiterState.pendingReferences - 1);
        submitReadyTile(localRuntime, waiterState);
      }
      stats.status = error instanceof Error ? error.message : String(error);
    } finally {
      referenceBroker.delete(entry.key);
    }
  }

  async function forceCenterReference(localRuntime: RuntimeView, state: TileWorkState): Promise<void> {
    if (requestCenterReference(localRuntime, state, highestPrecisionForState(state, localRuntime) + 64)) return;
    if (canSplitTile(state.tile)) {
      state.microtileAllowed = true;
      state.splitReason = "center reference exhausted";
      await splitTile(localRuntime, state);
    }
  }

  async function splitTile(localRuntime: RuntimeView, state: TileWorkState): Promise<void> {
    const tile = state.tile;
    if (tile.revision !== revision) return;
    const subtiles = await createSubtiles(localRuntime, tile, state.microtileAllowed);
    if (tile.revision !== revision || subtiles.length === 0) return;

    pendingTileIds.delete(tile.id);
    tileStates.delete(tile.id);
    const scheduledSubtiles = subtiles.slice(0, MAX_NEW_SUBTILES_PER_FRAME);
    for (const subtile of scheduledSubtiles) pendingTileIds.add(subtile.id);
    stats.pending = pendingTileIds.size;
    stats.status = "splitting";

    for (const subtile of scheduledSubtiles) {
      const child = createTileState(subtile, state.referenceIds, state.splitLevel + 1);
      child.microtileAllowed = state.microtileAllowed;
      child.localReferenceRequests = state.localReferenceRequests;
      child.centerReferenceAttempted = state.centerReferenceAttempted;
      child.referenceWaveLevel = state.referenceWaveLevel;
      void submitPreview(localRuntime, child);
    }
    syncPinnedReferences();
  }

  async function createSubtiles(localRuntime: RuntimeView, tile: TileDescriptor, allowMicrotile: boolean): Promise<TileDescriptor[]> {
    if (!canSplitTile(tile)) return [];

    const xCuts = splitTileAxis(tile.rect.width, allowMicrotile);
    const yCuts = splitTileAxis(tile.rect.height, allowMicrotile);
    if (xCuts.length <= 2 && yCuts.length <= 2) return [];
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
        const span = Math.max(1, Math.floor(Math.max(rect.width, rect.height)));
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
    return canSplitRect(tile.rect);
  }

  function previewSampleStep(tile: TileDescriptor): number {
    const span = Math.max(tile.rect.width, tile.rect.height);
    if (span >= 96) return 4;
    if (span >= 32) return 2;
    return 1;
  }

  function finalRenderPriority(state: TileWorkState): number {
    const previewCost = Math.min(300, Math.max(0, state.lastPreviewElapsedMs));
    const unresolvedCost = Math.min(200, state.lastPreviewUnresolvedCount * 0.2);
    const refinementCost = state.refinementLevel * 24;
    const score = previewCost + unresolvedCost + refinementCost;
    return -1 - Math.min(0.95, score / 360);
  }

  async function submitViewportPreview(localRuntime: RuntimeView, token: number): Promise<void> {
    const tile = createViewportPreviewTile(localRuntime);
    const candidates = references.selectCandidates(tile, localRuntime.maxIter, localRuntime.revision, MAX_RENDER_REFERENCES);
    if (candidates.length === 0) return;

    try {
      const result = await pool.render(
        {
          type: "renderTile",
          tile,
          canvasWidth: localRuntime.width,
          canvasHeight: localRuntime.height,
          pixelSpan: pixelSpanForView(localRuntime, localRuntime.width),
          maxIter: localRuntime.maxIter,
          references: candidates,
          seriesDegree: SERIES_DEGREE,
          paletteId: "cosine",
          refined: false,
          refinementLevel: 0,
          renderMode: "preview",
          sampleStep: VIEWPORT_PREVIEW_SAMPLE_STEP
        },
        -2
      );
      if (token !== renderToken || result.revision !== revision) return;
      renderer.uploadTile(result);
      updateWorkStatus("rendering");
    } catch (error) {
      if (token === renderToken) stats.status = error instanceof Error ? error.message : String(error);
    }
  }

  function createViewportPreviewTile(localRuntime: RuntimeView): TileDescriptor {
    return {
      id: `${localRuntime.revision}:viewport-preview`,
      key: {
        level: -1,
        x: 0,
        y: 0,
        span: Math.max(localRuntime.width, localRuntime.height)
      },
      rect: { x: 0, y: 0, width: localRuntime.width, height: localRuntime.height },
      centerScreenX: localRuntime.width * 0.5,
      centerScreenY: localRuntime.height * 0.5,
      centerRe: localRuntime.re,
      centerIm: localRuntime.im,
      revision: localRuntime.revision
    };
  }

  function hasOutstandingWork(): boolean {
    if (pendingTileIds.size > 0 || pool.pending > 0 || pool.active > 0) return true;
    for (const state of tileStates.values()) {
      if (state.inFlight || state.previewInFlight || state.pendingReferences > 0) return true;
    }
    return false;
  }

  function updateWorkStatus(activeStatus: string): void {
    stats.pending = pendingTileIds.size;
    stats.activeWorkers = pool.active;
    stats.references = references.size;
    stats.status = hasOutstandingWork() ? activeStatus : "stable";
  }

  function distributeBrokerReference(localRuntime: RuntimeView, entry: ReferenceBrokerEntry, referenceId: string): void {
    for (const waiter of entry.waiters) {
      const waiterState = tileStates.get(waiter.tileId);
      if (!waiterState) continue;
      waiterState.pendingReferences = Math.max(0, waiterState.pendingReferences - 1);
      if (waiterState.completed || waiterState.tile.revision !== revision) continue;
      waiterState.referenceIds.add(referenceId);
      waiterState.refinementLevel = Math.max(waiterState.refinementLevel, waiter.refinementLevel);
      submitReadyTile(localRuntime, waiterState);
    }
    syncPinnedReferences();
    stats.references = references.size;
    updateWorkStatus("refining");
  }

  function submitReadyTile(localRuntime: RuntimeView, state: TileWorkState): void {
    if (state.inFlight || state.pendingReferences > 0 || !state.previewUploaded || state.completed || state.tile.revision !== revision) return;
    void submitTile(localRuntime, state);
  }

  function clusterReferenceLimitForState(_localRuntime: RuntimeView, state: TileWorkState): number {
    const stagedLimit = Math.min(MAX_CLUSTER_REFERENCES_PER_PASS, clusterReferenceLimit(state.localReferenceRequests, state.stalledRefinementRounds));
    if (state.lastReferencePressure >= HIGH_REFERENCE_PRESSURE && state.referenceWaveLevel === 0) return Math.min(2, stagedLimit);
    if (state.referenceWaveLevel <= 1) return Math.min(4, stagedLimit);
    return stagedLimit;
  }

  function referenceWaveCellSize(state: TileWorkState): number {
    if (state.lastReferencePressure < LOW_REFERENCE_PRESSURE && state.referenceWaveLevel > 0) return 1;
    if (state.referenceWaveLevel <= 0) return 128;
    if (state.referenceWaveLevel === 1) return 64;
    return 32;
  }

  function referenceRequestKey(
    localRuntime: RuntimeView,
    screenX: number,
    screenY: number,
    precisionBits: number,
    cellSize: number
  ): { key: string; targetScreenX: number; targetScreenY: number; requiredPrecision: number; cellSize: number } {
    const normalizedCellSize = Math.max(1, Math.floor(cellSize));
    const cellX = Math.floor(screenX / normalizedCellSize);
    const cellY = Math.floor(screenY / normalizedCellSize);
    const requiredPrecision = Math.ceil(precisionBits / 32) * 32;
    return {
      key: `${localRuntime.revision}:${localRuntime.maxIter}:${requiredPrecision}:${normalizedCellSize}:${cellX}:${cellY}`,
      targetScreenX: Math.max(0.5, Math.min(localRuntime.width - 0.5, screenX)),
      targetScreenY: Math.max(0.5, Math.min(localRuntime.height - 0.5, screenY)),
      requiredPrecision,
      cellSize: normalizedCellSize
    };
  }

  function highestPrecisionForState(state: TileWorkState, localRuntime: RuntimeView): number {
    let highest = buildReferenceCandidates(state, localRuntime).reduce((bits, reference) => Math.max(bits, reference.precisionBits), 128);
    for (const id of state.referenceIds) {
      const reference = references.getById(id);
      if (reference) highest = Math.max(highest, reference.precisionBits);
    }
    return highest;
  }

  function unresolvedPressure(state: TileWorkState, unresolvedCount: number): number {
    return unresolvedCount / Math.max(1, Math.ceil(state.tile.rect.width) * Math.ceil(state.tile.rect.height));
  }

  function previewUnresolvedPressure(unresolvedCount: number, width: number, height: number): number {
    return unresolvedCount / Math.max(1, width * height);
  }

  function shouldRequestCenterReferenceFirst(localRuntime: RuntimeView, state: TileWorkState, referenceIdsUsed: string[]): boolean {
    if (state.centerReferenceAttempted || state.localReferenceRequests > 0 || state.pendingReferences > 0) return false;
    const usedReferences = referenceIdsUsed.map((id) => references.getById(id)).filter((reference): reference is NonNullable<typeof reference> => Boolean(reference));
    const bestEscapedAt = usedReferences.reduce((best, reference) => Math.max(best, reference.escapedAt), 0);
    return usedReferences.length === 0 || bestEscapedAt < localRuntime.maxIter || state.lastReferencePressure >= HIGH_REFERENCE_PRESSURE;
  }

  function requestCenterReference(localRuntime: RuntimeView, state: TileWorkState, precisionBits: number): boolean {
    const requestKey = `center:${state.tile.id}:${Math.ceil(precisionBits / 32) * 32}`;
    if (state.requestedReferenceKeys.has(requestKey)) return false;
    if (state.referenceIds.size + state.pendingReferences >= maxReferencesForRect(state.tile.rect) && canSplitTile(state.tile)) return false;

    state.requestedReferenceKeys.add(requestKey);
    state.pendingReferences += 1;
    state.localReferenceRequests += 1;
    state.centerReferenceAttempted = true;
    void computeCenterReference(localRuntime, state, precisionBits);
    return true;
  }

  async function computeCenterReference(localRuntime: RuntimeView, state: TileWorkState, precisionBits: number): Promise<void> {
    try {
      const reference = await references.ensureTileReference(localRuntime, state.tile, precisionBits);
      state.pendingReferences = Math.max(0, state.pendingReferences - 1);
      if (state.tile.revision !== revision || state.completed) return;
      state.referenceIds.add(reference.id);
      state.refinementLevel = Math.max(state.refinementLevel, 1);
      syncPinnedReferences();
      stats.references = references.size;
      submitReadyTile(localRuntime, state);
    } catch (error) {
      state.pendingReferences = Math.max(0, state.pendingReferences - 1);
      submitReadyTile(localRuntime, state);
      stats.status = error instanceof Error ? error.message : String(error);
    }
  }

  function isBetterBrokerRepresentative(
    request: { survivedIter: number; pixelCount: number; targetScreenX: number; targetScreenY: number },
    existing: ReferenceBrokerEntry
  ): boolean {
    if (request.survivedIter !== existing.survivedIter) return request.survivedIter > existing.survivedIter;
    if (request.pixelCount !== existing.pixelCount) return request.pixelCount > existing.pixelCount;
    return Math.hypot(request.targetScreenX - existing.targetScreenX, request.targetScreenY - existing.targetScreenY) < existing.cellSize * 0.25;
  }

  function referenceDistance(tile: TileDescriptor, reference: { screenX: number; screenY: number }): number {
    return Math.hypot(tile.centerScreenX - reference.screenX, tile.centerScreenY - reference.screenY);
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

  function pointerSample(event: PointerEvent): PointerSample {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * runtime.pixelRatio,
      y: (event.clientY - rect.top) * runtime.pixelRatio
    };
  }

  function finishPointer(event: PointerEvent): void {
    activePointers.delete(event.pointerId);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    resetPinchBaseline();
  }

  function resetPinchBaseline(): void {
    lastPinch = activePointers.size >= 2 ? currentPinchSample() : undefined;
  }

  function currentPinchSample(): PinchSample | undefined {
    const points = [...activePointers.values()];
    if (points.length < 2) return undefined;
    const first = points[0];
    const second = points[1];
    return {
      centerX: (first.x + second.x) * 0.5,
      centerY: (first.y + second.y) * 0.5,
      distance: Math.hypot(second.x - first.x, second.y - first.y)
    };
  }

  function handlePinchMove(): void {
    const current = currentPinchSample();
    if (!current) {
      lastPinch = undefined;
      return;
    }
    const previous = lastPinch;
    lastPinch = current;
    if (!previous || previous.distance < 1) return;

    const factor = current.distance / previous.distance;
    const dx = current.centerX - previous.centerX;
    const dy = current.centerY - previous.centerY;
    if (!Number.isFinite(factor) || factor <= 0) return;
    if (Math.abs(current.distance - previous.distance) < 0.5 && Math.abs(dx) + Math.abs(dy) < 0.5) return;

    renderer.applyRetainedZoom(factor, previous.centerX, previous.centerY);
    renderer.applyRetainedPan(dx, dy);
    void transformView(view, runtime.width, runtime.height, dx, dy, factor, previous.centerX, previous.centerY).then((next) => {
      next.maxIter = defaultMaxIter(next.scale);
      void setView(next, "pinch", false);
    });
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
