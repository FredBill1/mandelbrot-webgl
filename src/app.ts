import { ReferenceManager } from "./reference/referenceManager";
import { WebglTileRenderer, type RetainedScreenTransform } from "./render/webglRenderer";
import {
  clusterReferenceLimit,
  MAX_CLUSTER_REFERENCES_PER_PASS,
  nextStalledRefinementRounds,
} from "./scheduler/tilePolicy";
import { TileWorkerPool } from "./scheduler/workerPool";
import { createVisibleTileShells, tileKeyToId } from "./tiles/tileKey";
import {
  DEEP_TEST_VIEW,
  DEFAULT_VIEW,
  parseViewStateFromUrl,
  writeViewToUrl
} from "./state/urlState";
import {
  ITER_MAX,
  ITER_MIN,
  ITER_SLOPE_MAX,
  ITER_SLOPE_MIN,
  clampIter,
  decimalLog10,
  formatCompactDecimal,
  normalizeIterSettings,
  pixelSpanForView,
  resolveMaxIter,
  type IterFormula,
  type IterSettings
} from "./math/view";
import { initWasm, pointToViewCenterNow, transformViewNow } from "./wasmApi";
import {
  SERIES_DEGREE,
  TILE_SIZE,
  type NeedReferenceMessage,
  type Rect,
  type RuntimeView,
  type TileDescriptor,
  type TileDoneMessage,
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
  centerReferenceAttempted: boolean;
  referenceWaveLevel: number;
  lastReferencePressure: number;
  lastPreviewElapsedMs: number;
  lastPreviewUnresolvedCount: number;
  forceExact: boolean;
  exactFallback: boolean;
  createdFromPatch: boolean;
  exactBaseRgba: ArrayBuffer | undefined;
  exactUnresolvedMask: ArrayBuffer | undefined;
}

type TileShell = Omit<TileDescriptor, "centerRe" | "centerIm">;

interface ExactPatchInput {
  baseRgba: ArrayBuffer;
  unresolvedMask: ArrayBuffer;
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

interface ActivateViewOptions {
  resetRetained?: boolean;
  retainedTransform?: RetainedScreenTransform;
  scheduleWork?: boolean;
}

const MAX_RENDER_REFERENCES = 24;
const PREVIEW_REFERENCE_LIMIT = 2;
const PREVIEW_REFERENCE_GLOBAL_BUDGET = 96;
const VIEWPORT_PREVIEW_SAMPLE_STEP = 16;
const HIGH_REFERENCE_PRESSURE = 0.12;
const BROKER_FLUSH_DELAY_MS = 12;
const MAX_CREATED_REFERENCES_PER_TILE = 32;
const MAX_CREATED_REFERENCES_PER_DEEP_TILE = 64;
const MAX_REFERENCE_REFINEMENT_ROUNDS = 8;
const MAX_DEEP_REFERENCE_REFINEMENT_ROUNDS = 16;
const STALLED_ROUNDS_BEFORE_EXACT = 2;
const EXACT_PATCH_MAX_PIXELS = 4096;
const EXACT_PATCH_PADDING = 2;
const MIN_EXACT_PATCH_SIZE = 8;
const TILE_SCHEDULE_BATCH_MS = 6;
const TILE_SCHEDULE_MIN_BATCH = 2;
const ITER_CONTROL_DEBOUNCE_MS = 120;
const WHEEL_RENDER_DEBOUNCE_MS = 80;

export async function startApp(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <main class="shell">
      <canvas id="fractal" aria-label="Mandelbrot deep zoom canvas"></canvas>
      <aside id="uiDock" class="uiDock" aria-label="Display controls">
        <button
          id="uiToggle"
          class="uiToggle"
          type="button"
          aria-controls="uiRail"
          aria-expanded="true"
          aria-label="Hide controls"
          title="Hide controls"
        >
          <span aria-hidden="true"></span>
        </button>
        <div id="uiRail" class="uiRail">
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
          <section class="iterPanel" aria-label="Iteration controls">
            <div class="iterHeader">
              <span>Iterations</span>
              <div class="segmented" role="group" aria-label="Iteration mode">
                <button id="iterDefaultMode" type="button">Formula</button>
                <button id="iterFixedMode" type="button">Fixed</button>
              </div>
            </div>
            <label class="iterControl" data-mode="default">
              <span>Base</span>
              <input id="iterBaseRange" type="range" min="${ITER_MIN}" max="${ITER_MAX}" step="1" />
              <input id="iterBaseInput" type="number" min="${ITER_MIN}" max="${ITER_MAX}" step="1" />
            </label>
            <label class="iterControl" data-mode="default">
              <span>Slope</span>
              <input id="iterSlopeRange" type="range" min="${ITER_SLOPE_MIN}" max="${ITER_SLOPE_MAX}" step="1" />
              <input id="iterSlopeInput" type="number" min="${ITER_SLOPE_MIN}" max="${ITER_SLOPE_MAX}" step="1" />
            </label>
            <label class="iterControl" data-mode="default">
              <span>Cap</span>
              <input id="iterCapRange" type="range" min="${ITER_MIN}" max="${ITER_MAX}" step="1" />
              <input id="iterCapInput" type="number" min="${ITER_MIN}" max="${ITER_MAX}" step="1" />
            </label>
            <label class="iterControl" data-mode="fixed">
              <span>Fixed</span>
              <input id="iterFixedRange" type="range" min="${ITER_MIN}" max="${ITER_MAX}" step="1" />
              <input id="iterFixedInput" type="number" min="${ITER_MIN}" max="${ITER_MAX}" step="1" />
            </label>
          </section>
        </div>
      </aside>
    </main>
  `;

  const canvas = requireElement(root, "#fractal", HTMLCanvasElement);
  const uiDock = requireElement(root, "#uiDock", HTMLElement);
  const uiRail = requireElement(root, "#uiRail", HTMLElement);
  const uiToggle = requireElement(root, "#uiToggle", HTMLButtonElement);
  let uiHidden = false;

  await initWasm();

  const parsedView = parseViewStateFromUrl();
  let view: ViewState = parsedView.view;
  let iterSettings: IterSettings = parsedView.iterSettings;
  let revision = 1;
  let renderToken = 0;
  let scheduledUrlWrite = 0;
  let scheduledIterSettingsApply = 0;
  let scheduledDeferredRenderWork = 0;
  let pendingPointerWorkReason: string | undefined;
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
  let initialTileCount = 0;
  let patchTilesCreated = 0;
  let patchTileLimit = 512;
  let pendingTileShells = 0;

  let runtime = currentRuntimeView();
  resize();
  renderer.setActiveRevision(runtime.revision);
  renderToken += 1;
  bindIterControls();
  syncIterControls();
  syncUiVisibility();
  scheduleTiles("initial", renderToken);

  uiToggle.addEventListener("click", () => {
    uiHidden = !uiHidden;
    syncUiVisibility();
  });

  root.querySelector<HTMLButtonElement>("#homeButton")?.addEventListener("click", () => {
    activateView(withResolvedIter(DEFAULT_VIEW), "home", { resetRetained: true });
  });
  root.querySelector<HTMLButtonElement>("#deepButton")?.addEventListener("click", () => {
    activateView(withResolvedIter(DEEP_TEST_VIEW), "deep", { resetRetained: true });
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
    const transform = screenTransform(dx, dy, 1, runtime.width * 0.5, runtime.height * 0.5);
    const next = transformViewNow(view, runtime.width, runtime.height, dx, dy, 1, transform.anchorX, transform.anchorY);
    pendingPointerWorkReason = "pan";
    activateView(withResolvedIter(next), "pan", { resetRetained: false, retainedTransform: transform, scheduleWork: false });
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
    schedulePendingPointerWorkIfComplete();
  });
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const anchorX = (event.clientX - rect.left) * runtime.pixelRatio;
      const anchorY = (event.clientY - rect.top) * runtime.pixelRatio;
      const factor = Math.exp(-event.deltaY * 0.0015);
      const transform = screenTransform(0, 0, factor, anchorX, anchorY);
      const next = transformViewNow(view, runtime.width, runtime.height, 0, 0, factor, anchorX, anchorY);
      activateView(withResolvedIter(next), "zoom", { resetRetained: false, retainedTransform: transform, scheduleWork: false });
      scheduleDeferredRenderWork("zoom", WHEEL_RENDER_DEBOUNCE_MS);
    },
    { passive: false }
  );
  window.addEventListener("resize", () => {
    resize();
    activateView(withResolvedIter(view), "resize", { resetRetained: false });
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

  function syncUiVisibility(): void {
    uiDock.classList.toggle("uiHidden", uiHidden);
    uiToggle.setAttribute("aria-expanded", String(!uiHidden));
    uiToggle.setAttribute("aria-label", uiHidden ? "Show controls" : "Hide controls");
    uiToggle.title = uiHidden ? "Show controls" : "Hide controls";
    uiRail.setAttribute("aria-hidden", String(uiHidden));
    uiRail.inert = uiHidden;
    if (uiHidden && uiRail.contains(document.activeElement)) uiToggle.focus();
  }

  function activateView(next: ViewState, reason: string, options: ActivateViewOptions = {}): void {
    view = next;
    revision += 1;
    renderToken += 1;
    const token = renderToken;
    runtime = currentRuntimeView();
    window.clearTimeout(scheduledDeferredRenderWork);
    scheduledDeferredRenderWork = 0;
    references.cancelObsoleteWork(revision);
    pool.clearQueueForOldRevisions(revision);
    resetRenderWorkState();
    renderer.setActiveRevision(revision);
    if (options.resetRetained ?? true) {
      renderer.pruneRetainedWhenActiveCoverage(0);
    } else {
      if (options.retainedTransform) renderer.applyRetainedTransform(options.retainedTransform);
    }
    if (options.scheduleWork === false) stats.status = `navigating ${reason}`;
    renderer.render(true);
    updateHud();
    scheduleUrlSync();
    if (options.scheduleWork === false) return;
    const schedule = () => {
      if (token !== renderToken) return;
      scheduleTiles(reason, token);
    };
    if (options.resetRetained ?? true) {
      window.setTimeout(schedule, 0);
    } else {
      requestAnimationFrame(() => window.setTimeout(schedule, 0));
    }
  }

  function scheduleDeferredRenderWork(reason: string, delayMs: number): void {
    window.clearTimeout(scheduledDeferredRenderWork);
    const token = renderToken;
    scheduledDeferredRenderWork = window.setTimeout(() => {
      scheduledDeferredRenderWork = 0;
      if (token !== renderToken) return;
      scheduleTiles(reason, token);
    }, delayMs);
  }

  function resetRenderWorkState(): void {
    stats.pending = 0;
    stats.completedTiles = 0;
    stats.glitches = 0;
    pendingTileIds.clear();
    tileStates.clear();
    referenceBroker.clear();
    window.clearTimeout(referenceBrokerFlush);
    referenceBrokerFlush = 0;
    previewReferenceBudget = 0;
    initialTileCount = 0;
    patchTilesCreated = 0;
    patchTileLimit = 512;
    pendingTileShells = 0;
    references.setPinnedReferenceIds([]);
  }

  function scheduleTiles(reason: string, token: number): void {
    const localRuntime = currentRuntimeView();
    stats.status = `rendering ${reason}`;
    resetRenderWorkState();

    startViewReference(localRuntime, token);
    void submitViewportPreview(localRuntime, token);

    const shells = prioritizeTileShells(createVisibleTileShells(localRuntime, TILE_SIZE), localRuntime);
    if (token !== renderToken) return;

    initialTileCount = shells.length;
    patchTileLimit = Math.max(512, initialTileCount * 6);
    pendingTileShells = shells.length;
    previewReferenceBudget = Math.min(PREVIEW_REFERENCE_GLOBAL_BUDGET, Math.max(16, shells.length));
    stats.pending = pendingWorkCount();
    stats.references = references.size;
    stats.status = `rendering ${shells.length} tiles`;

    scheduleTileShellBatch(localRuntime, shells, 0, token);
  }

  function scheduleTileShellBatch(localRuntime: RuntimeView, shells: TileShell[], startIndex: number, token: number): void {
    if (token !== renderToken || localRuntime.revision !== revision) return;
    const activeRuntime = currentRuntimeView();
    const deadline = performance.now() + TILE_SCHEDULE_BATCH_MS;
    let index = startIndex;
    let processed = 0;
    while (index < shells.length && (processed < TILE_SCHEDULE_MIN_BATCH || performance.now() < deadline)) {
      const tile = materializeTileShell(activeRuntime, shells[index]);
      if (token !== renderToken || localRuntime.revision !== revision) return;
      createTileState(tile, [], 0);
      pendingTileShells = Math.max(0, shells.length - index - 1);
      void submitPreview(activeRuntime, mustTileState(tile.id));
      index += 1;
      processed += 1;
    }
    syncPinnedReferences();
    stats.pending = pendingWorkCount();
    stats.references = references.size;
    updateWorkStatus("rendering");
    if (index < shells.length) {
      window.setTimeout(() => scheduleTileShellBatch(localRuntime, shells, index, token), 0);
    }
  }

  function materializeTileShell(localRuntime: RuntimeView, shell: TileShell): TileDescriptor {
    const center = pointToViewCenterNow(view, localRuntime.width, localRuntime.height, shell.centerScreenX, shell.centerScreenY);
    return { ...shell, centerRe: center.re, centerIm: center.im };
  }

  function prioritizeTileShells(shells: TileShell[], localRuntime: RuntimeView): TileShell[] {
    const centerX = localRuntime.width * 0.5;
    const centerY = localRuntime.height * 0.5;
    return [...shells].sort((a, b) => {
      const da = Math.hypot(a.centerScreenX - centerX, a.centerScreenY - centerY);
      const db = Math.hypot(b.centerScreenX - centerX, b.centerScreenY - centerY);
      return da - db;
    });
  }

  function startViewReference(localRuntime: RuntimeView, token: number): void {
    void references.ensureViewReference(localRuntime, 0).then((reference) => {
      if (token !== renderToken || localRuntime.revision !== revision) return;
      stats.references = references.size;
      for (const state of tileStates.values()) {
        if (state.tile.revision !== revision || state.completed) continue;
        state.referenceIds.add(reference.id);
      }
      syncPinnedReferences();
      void submitViewportPreview(localRuntime, token);
      for (const state of tileStates.values()) void submitPreview(localRuntime, state);
      updateWorkStatus("rendering");
    }).catch((error) => {
      if (token === renderToken) stats.status = error instanceof Error ? error.message : String(error);
    });
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
      centerReferenceAttempted: false,
      referenceWaveLevel: 0,
      lastReferencePressure: 0,
      lastPreviewElapsedMs: 0,
      lastPreviewUnresolvedCount: 0,
      forceExact: false,
      exactFallback: false,
      createdFromPatch: false,
      exactBaseRgba: undefined,
      exactUnresolvedMask: undefined
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
    if (state.forceExact) {
      void submitTile(localRuntime, state);
      return;
    }
    if (state.previewInFlight || state.previewUploaded || state.completed || state.tile.revision !== revision) return;
    const candidates = buildReferenceCandidates(state, localRuntime);
    if (candidates.length === 0) {
      updateWorkStatus("rendering");
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
          viewScale: localRuntime.scale,
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
        previewRenderPriority()
      );
      state.previewInFlight = false;
      if (result.revision !== revision || state.tile.revision !== revision) return;
      const activeRuntime = currentRuntimeView();
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
          const queued = queuePreviewReferences(activeRuntime, state, result.stats.unresolvedClusters);
          if (queued > 0 || state.pendingReferences > 0) {
            stats.pending = pendingWorkCount();
            stats.status = "refining";
            updateWorkStatus("refining");
            return;
          }
        }
      }
      if (shouldRequestInteriorCenterReference(state, result)) {
        const precisionBits = highestPrecisionForState(state, activeRuntime);
        if (requestCenterReference(activeRuntime, state, precisionBits)) {
          stats.pending = pendingWorkCount();
          stats.status = "refining";
          updateWorkStatus("refining");
          return;
        }
      }
      updateWorkStatus("rendering");
      void submitTile(activeRuntime, state);
    } catch (error) {
      state.previewInFlight = false;
      if (state.tile.revision !== revision) return;
      stats.status = error instanceof Error ? error.message : String(error);
    }
  }

  async function submitTile(localRuntime: RuntimeView, state: TileWorkState): Promise<void> {
    if (localRuntime.maxIter !== view.maxIter || localRuntime.revision !== revision) localRuntime = currentRuntimeView();
    if (state.inFlight || state.completed || state.tile.revision !== revision) return;
    if (!state.forceExact && (!state.previewUploaded || state.pendingReferences > 0)) return;
    const candidates = state.forceExact ? [] : buildReferenceCandidates(state, localRuntime);
    if (!state.forceExact && candidates.length === 0) {
      updateWorkStatus("rendering");
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
          viewScale: localRuntime.scale,
          pixelSpan: pixelSpanForView(localRuntime, localRuntime.width),
          maxIter: localRuntime.maxIter,
          references: candidates,
          seriesDegree: SERIES_DEGREE,
          paletteId: "cosine",
          refined: state.refinementLevel > 0,
          refinementLevel: state.refinementLevel,
          renderMode: state.forceExact ? "exact" : "final",
          sampleStep: 1,
          exactBaseRgba: state.exactBaseRgba,
          exactUnresolvedMask: state.exactUnresolvedMask
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

      if (state.forceExact) {
        renderer.uploadTile(result);
        state.completed = true;
        stats.completedTiles += 1;
        pendingTileIds.delete(state.tile.id);
        stats.pending = pendingWorkCount();
        updateWorkStatus("rendering");
        return;
      }

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
            stats.pending = pendingWorkCount();
            stats.status = "refining";
            return;
          }
        }

        if (state.refinementLevel >= maxReferenceRefinementRounds(localRuntime)) {
          await scheduleExactFallback(localRuntime, state, result);
          return;
        }

        const queued = queueClusterReferences(localRuntime, state, result.stats.unresolvedClusters);
        if (queued > 0 || state.pendingReferences > 0) {
          stats.pending = pendingWorkCount();
          stats.status = "refining";
          return;
        }
        if (state.stalledRefinementRounds >= STALLED_ROUNDS_BEFORE_EXACT || !canRequestMoreReferences(state, localRuntime)) {
          await scheduleExactFallback(localRuntime, state, result);
          return;
        }
        if (requestCenterReference(localRuntime, state, highestPrecisionForState(state, localRuntime) + 64)) return;
        await scheduleExactFallback(localRuntime, state, result);
        return;
      }

      renderer.uploadTile(result);
      state.completed = true;
      stats.completedTiles += 1;
      pendingTileIds.delete(state.tile.id);
      syncPinnedReferences();
      stats.pending = pendingWorkCount();
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
    if (!canRequestMoreReferences(state, localRuntime)) return;

    state.requestedReferenceKeys.add(requestKey);
    state.pendingReferences += 1;
    state.localReferenceRequests += 1;
    stats.pending = pendingWorkCount();
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
    if (!canRequestMoreReferences(state, localRuntime)) return 0;
    let queued = 0;
    const highestPrecision = highestPrecisionForState(state, localRuntime);
    for (const cluster of clusters.slice(0, PREVIEW_REFERENCE_LIMIT)) {
      if (previewReferenceBudget <= 0) break;
      if (!canRequestMoreReferences(state, localRuntime)) break;
      const request = referenceRequestKey(localRuntime, cluster.screenX, cluster.screenY, Math.max(highestPrecision + 32, cluster.suggestedPrecisionBits ?? 128), referenceCellSizeForCluster(cluster));
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
    if (state.refinementLevel <= 1) return Math.min(2, MAX_RENDER_REFERENCES);
    return Math.min(4, MAX_RENDER_REFERENCES);
  }

  function queueClusterReferences(localRuntime: RuntimeView, state: TileWorkState, clusters: UnresolvedCluster[]): number {
    if (clusters.length === 0) return 0;
    if (!canRequestMoreReferences(state, localRuntime)) return 0;
    let queued = 0;
    const highestPrecision = highestPrecisionForState(state, localRuntime);
    const perPassLimit = clusterReferenceLimitForState(localRuntime, state);
    for (const cluster of clusters.slice(0, perPassLimit)) {
      if (!canRequestMoreReferences(state, localRuntime)) break;
      const request = referenceRequestKey(
        localRuntime,
        cluster.screenX,
        cluster.screenY,
        Math.max(highestPrecision + 32, cluster.suggestedPrecisionBits ?? 128),
        referenceCellSizeForCluster(cluster)
      );
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

      const targetCenter = pointToViewCenterNow(view, localRuntime.width, localRuntime.height, entry.targetScreenX, entry.targetScreenY);
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
      const reference = await references.ensureTileReference(localRuntime, targetTile, entry.requiredPrecision, 10);
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

  async function scheduleExactFallback(localRuntime: RuntimeView, state: TileWorkState, result: TileDoneMessage): Promise<void> {
    const tile = state.tile;
    if (tile.revision !== revision) return;
    const clusters = result.stats.unresolvedClusters;
    const patchRects = exactPatchRects(tile.rect, clusters);
    const useWholeTile =
      patchRects.length === 0 ||
      tile.rect.width * tile.rect.height <= EXACT_PATCH_MAX_PIXELS ||
      patchTilesCreated + patchRects.length > patchTileLimit;
    const rects = useWholeTile ? [tile.rect] : patchRects;
    const patches = (
      await Promise.all(
        rects.map(async (rect, index) => {
          const input = buildExactPatchInput(result, rect);
          if (!input) return undefined;
          const patch = createExactPatchTile(localRuntime, tile, rect, index);
          return { patch, input };
        })
      )
    ).filter((entry): entry is { patch: TileDescriptor; input: ExactPatchInput } => Boolean(entry));
    if (tile.revision !== revision || patches.length === 0) return;

    pendingTileIds.delete(tile.id);
    tileStates.delete(tile.id);
    patchTilesCreated += patches.length;
    for (const { patch } of patches) pendingTileIds.add(patch.id);
    stats.pending = pendingWorkCount();
    stats.status = "exact fallback";

    for (const { patch, input } of patches) {
      const child = createTileState(patch, [], state.splitLevel + 1);
      child.forceExact = true;
      child.exactFallback = true;
      child.createdFromPatch = true;
      child.previewUploaded = true;
      child.exactBaseRgba = input.baseRgba;
      child.exactUnresolvedMask = input.unresolvedMask;
      void submitTile(localRuntime, child);
    }
    syncPinnedReferences();
  }

  function buildExactPatchInput(result: TileDoneMessage, rect: Rect): ExactPatchInput | undefined {
    const width = Math.max(1, Math.ceil(rect.width));
    const height = Math.max(1, Math.ceil(rect.height));
    const sourceRgba = new Uint8Array(result.rgba);
    const sourceMask = result.unresolvedMask ? new Uint8Array(result.unresolvedMask) : undefined;
    const baseRgba = new Uint8Array(width * height * 4);
    const unresolvedMask = new Uint8Array(width * height);
    const offsetX = Math.round(rect.x - result.rect.x);
    const offsetY = Math.round(rect.y - result.rect.y);
    let exactPixels = 0;

    for (let y = 0; y < height; y += 1) {
      const sourceY = offsetY + y;
      for (let x = 0; x < width; x += 1) {
        const sourceX = offsetX + x;
        const targetIndex = y * width + x;
        const targetOffset = targetIndex * 4;
        if (sourceX < 0 || sourceY < 0 || sourceX >= result.width || sourceY >= result.height) {
          unresolvedMask[targetIndex] = 1;
          baseRgba[targetOffset + 3] = 255;
          exactPixels += 1;
          continue;
        }

        const sourceIndex = sourceY * result.width + sourceX;
        const sourceOffset = sourceIndex * 4;
        baseRgba[targetOffset] = sourceRgba[sourceOffset];
        baseRgba[targetOffset + 1] = sourceRgba[sourceOffset + 1];
        baseRgba[targetOffset + 2] = sourceRgba[sourceOffset + 2];
        baseRgba[targetOffset + 3] = sourceRgba[sourceOffset + 3];
        if (!sourceMask || sourceMask[sourceIndex] !== 0) {
          unresolvedMask[targetIndex] = 1;
          exactPixels += 1;
        }
      }
    }

    if (exactPixels === 0) return undefined;
    return { baseRgba: baseRgba.buffer, unresolvedMask: unresolvedMask.buffer };
  }

  function createExactPatchTile(localRuntime: RuntimeView, parent: TileDescriptor, rect: TileDescriptor["rect"], index: number): TileDescriptor {
    const centerScreenX = rect.x + rect.width * 0.5;
    const centerScreenY = rect.y + rect.height * 0.5;
    const center = pointToViewCenterNow(view, localRuntime.width, localRuntime.height, centerScreenX, centerScreenY);
    const key = {
      level: parent.key.level + 1,
      x: Math.floor(rect.x),
      y: Math.floor(rect.y),
      span: Math.max(1, Math.ceil(Math.max(rect.width, rect.height)))
    };
    return {
      id: `${tileKeyToId(key, parent.revision)}:exact:${index}`,
      key,
      rect,
      centerScreenX,
      centerScreenY,
      centerRe: center.re,
      centerIm: center.im,
      revision: parent.revision
    };
  }

  function exactPatchRects(tileRect: TileDescriptor["rect"], clusters: UnresolvedCluster[]): TileDescriptor["rect"][] {
    const candidates = clusters
      .map((cluster) => expandedClusterRect(tileRect, cluster))
      .filter((rect): rect is TileDescriptor["rect"] => Boolean(rect));
    if (candidates.length === 0) return [];
    return mergeRects(candidates).filter((rect) => rect.width > 0 && rect.height > 0);
  }

  function expandedClusterRect(tileRect: TileDescriptor["rect"], cluster: UnresolvedCluster): TileDescriptor["rect"] | undefined {
    const bounds = cluster.bounds;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return undefined;
    let left = Math.floor(bounds.x - EXACT_PATCH_PADDING);
    let top = Math.floor(bounds.y - EXACT_PATCH_PADDING);
    let right = Math.ceil(bounds.x + bounds.width + EXACT_PATCH_PADDING);
    let bottom = Math.ceil(bounds.y + bounds.height + EXACT_PATCH_PADDING);
    const centerX = cluster.screenX;
    const centerY = cluster.screenY;
    if (right - left < MIN_EXACT_PATCH_SIZE) {
      left = Math.floor(centerX - MIN_EXACT_PATCH_SIZE * 0.5);
      right = left + MIN_EXACT_PATCH_SIZE;
    }
    if (bottom - top < MIN_EXACT_PATCH_SIZE) {
      top = Math.floor(centerY - MIN_EXACT_PATCH_SIZE * 0.5);
      bottom = top + MIN_EXACT_PATCH_SIZE;
    }
    left = Math.max(tileRect.x, left);
    top = Math.max(tileRect.y, top);
    right = Math.min(tileRect.x + tileRect.width, right);
    bottom = Math.min(tileRect.y + tileRect.height, bottom);
    if (right <= left || bottom <= top) return undefined;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function mergeRects(rects: TileDescriptor["rect"][]): TileDescriptor["rect"][] {
    const merged: TileDescriptor["rect"][] = [];
    for (const rect of rects) {
      let current = rect;
      for (let index = 0; index < merged.length; index += 1) {
        if (!rectsOverlapOrTouch(current, merged[index])) continue;
        const union = unionRect(current, merged[index]);
        const unionArea = rectArea(union);
        const separateArea = rectArea(current) + rectArea(merged[index]);
        if (unionArea > EXACT_PATCH_MAX_PIXELS || unionArea > separateArea * 1.25) continue;
        current = union;
        merged.splice(index, 1);
        index = -1;
      }
      merged.push(current);
    }
    return merged;
  }

  function rectsOverlapOrTouch(a: TileDescriptor["rect"], b: TileDescriptor["rect"]): boolean {
    return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
  }

  function rectArea(rect: TileDescriptor["rect"]): number {
    return rect.width * rect.height;
  }

  function unionRect(a: TileDescriptor["rect"], b: TileDescriptor["rect"]): TileDescriptor["rect"] {
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const right = Math.max(a.x + a.width, b.x + b.width);
    const bottom = Math.max(a.y + a.height, b.y + b.height);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function previewSampleStep(tile: TileDescriptor): number {
    const span = Math.max(tile.rect.width, tile.rect.height);
    if (span >= 96) return 4;
    if (span >= 32) return 2;
    return 1;
  }

  function previewRenderPriority(): number {
    return pendingTileShells > 0 ? -3 : -0.5;
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
          viewScale: localRuntime.scale,
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
        -4
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
    if (pendingTileShells > 0 || pendingTileIds.size > 0 || pool.pending > 0 || pool.active > 0) return true;
    for (const state of tileStates.values()) {
      if (state.inFlight || state.previewInFlight || state.pendingReferences > 0) return true;
    }
    return false;
  }

  function updateWorkStatus(activeStatus: string): void {
    stats.pending = pendingWorkCount();
    stats.activeWorkers = pool.active;
    stats.references = references.size;
    stats.status = hasOutstandingWork() ? activeStatus : "stable";
  }

  function pendingWorkCount(): number {
    return pendingTileIds.size + pendingTileShells;
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

  function canRequestMoreReferences(state: TileWorkState, localRuntime: RuntimeView): boolean {
    return state.localReferenceRequests + state.pendingReferences < maxCreatedReferencesForRuntime(localRuntime);
  }

  function maxCreatedReferencesForRuntime(localRuntime: RuntimeView): number {
    return decimalLog10(localRuntime.scale) >= 12 ? MAX_CREATED_REFERENCES_PER_DEEP_TILE : MAX_CREATED_REFERENCES_PER_TILE;
  }

  function maxReferenceRefinementRounds(localRuntime: RuntimeView): number {
    return decimalLog10(localRuntime.scale) >= 12 ? MAX_DEEP_REFERENCE_REFINEMENT_ROUNDS : MAX_REFERENCE_REFINEMENT_ROUNDS;
  }

  function shouldRequestInteriorCenterReference(state: TileWorkState, result: TileDoneMessage): boolean {
    if (state.centerReferenceAttempted || state.localReferenceRequests > 0 || state.pendingReferences > 0) return false;
    const pixelCount = Math.max(1, result.width * result.height);
    const unresolvedPressure = result.stats.unresolvedCount / pixelCount;
    return (
      result.stats.escapedPixels === 0 &&
      (result.stats.unresolvedCount === 0 || unresolvedPressure >= HIGH_REFERENCE_PRESSURE) &&
      result.stats.periodicInteriorCount / pixelCount < 0.1
    );
  }

  function referenceCellSizeForCluster(cluster: UnresolvedCluster): number {
    const span = Math.max(cluster.bounds?.width ?? 0, cluster.bounds?.height ?? 0, cluster.radiusPx * 2, 1);
    return clampPowerOfTwo(span, 4, 64);
  }

  function clampPowerOfTwo(value: number, min: number, max: number): number {
    if (!Number.isFinite(value) || value <= min) return min;
    let next = min;
    while (next < value && next < max) next *= 2;
    return Math.min(max, next);
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
    if (!canRequestMoreReferences(state, localRuntime)) return false;

    state.requestedReferenceKeys.add(requestKey);
    state.pendingReferences += 1;
    state.localReferenceRequests += 1;
    state.centerReferenceAttempted = true;
    void computeCenterReference(localRuntime, state, precisionBits);
    return true;
  }

  async function computeCenterReference(localRuntime: RuntimeView, state: TileWorkState, precisionBits: number): Promise<void> {
    try {
      const reference = await references.ensureTileReference(localRuntime, state.tile, precisionBits, 5);
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
    schedulePendingPointerWorkIfComplete();
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

    const transform = screenTransform(dx, dy, factor, previous.centerX, previous.centerY);
    const next = transformViewNow(view, runtime.width, runtime.height, dx, dy, factor, previous.centerX, previous.centerY);
    pendingPointerWorkReason = "pinch";
    activateView(withResolvedIter(next), "pinch", { resetRetained: false, retainedTransform: transform, scheduleWork: false });
  }

  function schedulePendingPointerWorkIfComplete(): void {
    if (activePointers.size > 0 || !pendingPointerWorkReason) return;
    const reason = pendingPointerWorkReason;
    pendingPointerWorkReason = undefined;
    scheduleDeferredRenderWork(reason, 0);
  }

  function screenTransform(dx: number, dy: number, scale: number, anchorX: number, anchorY: number): RetainedScreenTransform {
    return { dx, dy, scale, anchorX, anchorY };
  }

  function withResolvedIter(next: Pick<ViewState, "re" | "im" | "scale">): ViewState {
    return {
      re: next.re,
      im: next.im,
      scale: next.scale,
      maxIter: resolveMaxIter(next.scale, iterSettings)
    };
  }

  function bindIterControls(): void {
    const defaultMode = requireElement(root, "#iterDefaultMode", HTMLButtonElement);
    const fixedMode = requireElement(root, "#iterFixedMode", HTMLButtonElement);
    defaultMode.addEventListener("click", () => {
      setIterSettings({ ...iterSettings, mode: "default" }, "iter formula", true);
    });
    fixedMode.addEventListener("click", () => {
      setIterSettings({ ...iterSettings, mode: "fixed", fixedIter: view.maxIter }, "iter fixed", true);
    });

    bindIterControlPair("base", "#iterBaseRange", "#iterBaseInput", ITER_MIN, ITER_MAX, (value) => {
      setIterFormula({ ...iterSettings.formula, base: value }, "iter formula");
    });
    bindIterControlPair("slope", "#iterSlopeRange", "#iterSlopeInput", ITER_SLOPE_MIN, ITER_SLOPE_MAX, (value) => {
      setIterFormula({ ...iterSettings.formula, slope: value }, "iter formula");
    });
    bindIterControlPair("cap", "#iterCapRange", "#iterCapInput", ITER_MIN, ITER_MAX, (value) => {
      setIterFormula({ ...iterSettings.formula, cap: value }, "iter formula");
    });
    bindIterControlPair("fixed", "#iterFixedRange", "#iterFixedInput", ITER_MIN, ITER_MAX, (value) => {
      setIterSettings({ ...iterSettings, fixedIter: clampIter(value) }, "iter fixed");
    });
  }

  function bindIterControlPair(
    name: string,
    rangeSelector: string,
    inputSelector: string,
    min: number,
    max: number,
    apply: (value: number) => void
  ): void {
    const range = requireElement(root, rangeSelector, HTMLInputElement);
    const input = requireElement(root, inputSelector, HTMLInputElement);
    const read = (target: HTMLInputElement) => clampControlNumber(target.valueAsNumber, min, max);
    range.addEventListener("input", () => apply(read(range)));
    input.addEventListener("input", () => apply(read(input)));
    input.addEventListener("change", () => {
      syncIterControls();
      apply(read(input));
    });
    range.setAttribute("aria-label", name);
    input.setAttribute("aria-label", name);
  }

  function setIterFormula(formula: IterFormula, reason: string): void {
    setIterSettings({ ...iterSettings, formula }, reason);
  }

  function setIterSettings(next: IterSettings, reason: string, immediate = false): void {
    iterSettings = normalizeIterSettings(next, view.scale);
    syncIterControls();
    window.clearTimeout(scheduledIterSettingsApply);
    if (immediate) {
      applyIterSettings(reason);
      return;
    }
    scheduledIterSettingsApply = window.setTimeout(() => applyIterSettings(reason), ITER_CONTROL_DEBOUNCE_MS);
  }

  function applyIterSettings(reason: string): void {
    const next = withResolvedIter(view);
    if (next.maxIter === view.maxIter) {
      updateHud();
      scheduleUrlSync();
      return;
    }
    activateView(next, reason, { resetRetained: true });
  }

  function syncIterControls(): void {
    const settings = normalizeIterSettings(iterSettings, view.scale);
    const defaultMode = requireElement(root, "#iterDefaultMode", HTMLButtonElement);
    const fixedMode = requireElement(root, "#iterFixedMode", HTMLButtonElement);
    defaultMode.classList.toggle("active", settings.mode === "default");
    fixedMode.classList.toggle("active", settings.mode === "fixed");
    defaultMode.setAttribute("aria-pressed", String(settings.mode === "default"));
    fixedMode.setAttribute("aria-pressed", String(settings.mode === "fixed"));

    setInputValue("#iterBaseRange", settings.formula.base);
    setInputValue("#iterBaseInput", settings.formula.base);
    setInputValue("#iterSlopeRange", settings.formula.slope);
    setInputValue("#iterSlopeInput", settings.formula.slope);
    setInputValue("#iterCapRange", settings.formula.cap);
    setInputValue("#iterCapInput", settings.formula.cap);
    setInputValue("#iterFixedRange", settings.fixedIter);
    setInputValue("#iterFixedInput", settings.fixedIter);

    for (const element of root.querySelectorAll<HTMLElement>(".iterControl")) {
      const active = element.dataset.mode === settings.mode;
      element.classList.toggle("inactive", !active);
      for (const input of element.querySelectorAll<HTMLInputElement>("input")) input.disabled = !active;
    }
  }

  function setInputValue(selector: string, value: number): void {
    const input = requireElement(root, selector, HTMLInputElement);
    input.value = String(value);
  }

  function clampControlNumber(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, Math.round(value)));
  }

  function scheduleUrlSync(): void {
    window.clearTimeout(scheduledUrlWrite);
    scheduledUrlWrite = window.setTimeout(() => writeViewToUrl(view, { iterSettings }), 80);
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

