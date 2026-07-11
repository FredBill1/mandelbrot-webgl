import { ReferenceManager } from "./reference/referenceManager";
import { WebglTileRenderer, type RetainedScreenTransform } from "./render/webglRenderer";
import { TileWorkerPool } from "./scheduler/workerPool";
import { createVisibleTileShells } from "./tiles/tileKey";
import {
  DEEP_TEST_VIEW,
  DEFAULT_VIEW,
  parseViewStateFromUrl,
  writeViewToUrl
} from "./state/urlState";
import {
  DEFAULT_ITER_FORMULA,
  ITER_MAX,
  ITER_MIN,
  ITER_SLOPE_MAX,
  ITER_SLOPE_MIN,
  clampIter,
  defaultMaxIter,
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
  inFlight: boolean;
  previewInFlight: boolean;
  completed: boolean;
  pendingReferences: number;
  localReferenceRequests: number;
  previewUploaded: boolean;
  centerReferenceAttempted: boolean;
  centerReferenceReady: boolean;
  referenceCellSize: number;
  referenceWaveLevel: number;
  lastReferencePressure: number;
  lastPreviewElapsedMs: number;
  lastPreviewUnresolvedCount: number;
  refinementBaseRgba: ArrayBuffer | undefined;
  refinementUnresolvedMask: ArrayBuffer | undefined;
  refinementSmoothValues: ArrayBuffer | undefined;
  refinementDistanceValues: ArrayBuffer | undefined;
  refinementEscapedMask: ArrayBuffer | undefined;
}

type TileShell = Omit<TileDescriptor, "centerRe" | "centerIm">;

interface ReferenceBrokerWaiter {
  tileId: string;
  refinementLevel: number;
  center: boolean;
}

interface ReferenceBrokerEntry {
  key: string;
  revision: number;
  targetScreenX: number;
  targetScreenY: number;
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

const MAX_RENDER_REFERENCES = 8;
const MAX_REFERENCES_PER_VIEW = 512;
const MAX_SPATIAL_REFERENCES_PER_VIEW = 400;
const MAX_REFERENCES_PER_WAVE = 1;
const INITIAL_REFERENCE_CELL_SIZE = 64;
const BROKER_FLUSH_DELAY_MS = 2;
const TILE_SCHEDULE_BATCH_MS = 6;
const TILE_SCHEDULE_MIN_BATCH = 2;
const ITER_CONTROL_DEBOUNCE_MS = 120;
const WHEEL_RENDER_DEBOUNCE_MS = 80;
const ALT_DEEP_TEST_VIEW: Pick<ViewState, "re" | "im" | "scale"> = {
  re: "3.65507337176578885294026060094803596771753851886465789116904636035808374831904454685041558745129659944566525621423768578726826509334259227102568025179459338196606859e-1",
  im: "5.92476366173214971781468865486627113155901675162131546210951676040509852198816827792342255876351114213269405343861920688594863450989932441948429028708253010581298657e-1",
  scale: "1e100"
};

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
            <button id="deepAltButton" title="Jump to an alternate 1e100 location">1e100 B</button>
          </nav>
          <section class="iterPanel" aria-label="Iteration controls">
            <div class="iterHeader">
              <span>Iterations</span>
              <div class="segmented" role="group" aria-label="Iteration mode">
                <button id="iterDefaultMode" type="button">Auto</button>
                <button id="iterFixedMode" type="button">Fixed</button>
              </div>
            </div>
            <div class="iterControl" data-mode="default">
              <span>Base</span>
              <input id="iterBaseRange" type="range" min="${ITER_MIN}" max="${ITER_MAX}" step="1" />
              <input id="iterBaseInput" type="number" min="${ITER_MIN}" max="${ITER_MAX}" step="1" />
              <button id="iterBaseReset" class="iterReset" type="button" title="Reset base to default" aria-label="Reset base to default"><span aria-hidden="true">&#8634;</span></button>
            </div>
            <div class="iterControl" data-mode="default">
              <span>Slope</span>
              <input id="iterSlopeRange" type="range" min="${ITER_SLOPE_MIN}" max="${ITER_SLOPE_MAX}" step="1" />
              <input id="iterSlopeInput" type="number" min="${ITER_SLOPE_MIN}" max="${ITER_SLOPE_MAX}" step="1" />
              <button id="iterSlopeReset" class="iterReset" type="button" title="Reset slope to default" aria-label="Reset slope to default"><span aria-hidden="true">&#8634;</span></button>
            </div>
            <div class="iterControl" data-mode="default">
              <span>Cap</span>
              <input id="iterCapRange" type="range" min="${ITER_MIN}" max="${ITER_MAX}" step="1" />
              <input id="iterCapInput" type="number" min="${ITER_MIN}" max="${ITER_MAX}" step="1" />
              <button id="iterCapReset" class="iterReset" type="button" title="Reset cap to default" aria-label="Reset cap to default"><span aria-hidden="true">&#8634;</span></button>
            </div>
            <div class="iterControl" data-mode="fixed">
              <span>Fixed</span>
              <input id="iterFixedRange" type="range" min="${ITER_MIN}" max="${ITER_MAX}" step="1" />
              <input id="iterFixedInput" type="number" min="${ITER_MIN}" max="${ITER_MAX}" step="1" />
              <button id="iterFixedReset" class="iterReset" type="button" title="Reset fixed iterations to formula default" aria-label="Reset fixed iterations to formula default"><span aria-hidden="true">&#8634;</span></button>
            </div>
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
  const referenceCells = new Map<string, string>();
  const referenceBudgetKeys = new Set<string>();
  const spatialReferenceBudgetKeys = new Set<string>();
  let referenceBrokerFlush = 0;
  let initialTileCount = 0;
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
  root.querySelector<HTMLButtonElement>("#deepAltButton")?.addEventListener("click", () => {
    activateView(withResolvedIter(ALT_DEEP_TEST_VIEW), "deep alternate", { resetRetained: true });
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
    referenceCells.clear();
    referenceBudgetKeys.clear();
    spatialReferenceBudgetKeys.clear();
    initialTileCount = 0;
    pendingTileShells = 0;
    references.setPinnedReferenceIds([]);
  }

  function scheduleTiles(reason: string, token: number): void {
    const localRuntime = currentRuntimeView();
    stats.status = `rendering ${reason}`;
    resetRenderWorkState();

    startViewReference(localRuntime, token);

    const shells = prioritizeTileShells(createVisibleTileShells(localRuntime, TILE_SIZE), localRuntime);
    if (token !== renderToken) return;

    initialTileCount = shells.length;
    pendingTileShells = shells.length;
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
      const inherited = references
        .selectCandidates(tile, activeRuntime.maxIter, revision, 1)
        .map((reference) => reference.id);
      const state = createTileState(tile, inherited);
      pendingTileShells = Math.max(0, shells.length - index - 1);
      void submitPreview(activeRuntime, state);
      requestCenterReference(activeRuntime, state);
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
        addReferenceToState(state, reference.id, localRuntime);
      }
      syncPinnedReferences();
      for (const state of tileStates.values()) void submitPreview(localRuntime, state);
      updateWorkStatus("rendering");
    }).catch((error) => {
      if (token === renderToken) stats.status = error instanceof Error ? error.message : String(error);
    });
  }

  function createTileState(tile: TileDescriptor, referenceIds: Iterable<string>): TileWorkState {
    const state: TileWorkState = {
      tile,
      referenceIds: new Set(referenceIds),
      requestedReferenceKeys: new Set(),
      refinementLevel: 0,
      inFlight: false,
      previewInFlight: false,
      completed: false,
      pendingReferences: 0,
      localReferenceRequests: 0,
      previewUploaded: false,
      centerReferenceAttempted: false,
      centerReferenceReady: false,
      referenceCellSize: INITIAL_REFERENCE_CELL_SIZE,
      referenceWaveLevel: 0,
      lastReferencePressure: 0,
      lastPreviewElapsedMs: 0,
      lastPreviewUnresolvedCount: 0,
      refinementBaseRgba: undefined,
      refinementUnresolvedMask: undefined,
      refinementSmoothValues: undefined,
      refinementDistanceValues: undefined,
      refinementEscapedMask: undefined
    };
    tileStates.set(tile.id, state);
    pendingTileIds.add(tile.id);
    return state;
  }

  async function submitPreview(localRuntime: RuntimeView, state: TileWorkState): Promise<void> {
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
      state.lastReferencePressure = previewUnresolvedPressure(result.stats.unresolvedCount, result.width, result.height);
      updateWorkStatus("rendering");
      if (hasPreviewCoverage()) {
        for (const readyState of tileStates.values()) submitReadyTile(activeRuntime, readyState);
      }
    } catch (error) {
      state.previewInFlight = false;
      if (state.tile.revision !== revision) return;
      stats.status = error instanceof Error ? error.message : String(error);
    }
  }

  async function submitTile(localRuntime: RuntimeView, state: TileWorkState): Promise<void> {
    if (localRuntime.maxIter !== view.maxIter || localRuntime.revision !== revision) localRuntime = currentRuntimeView();
    if (state.inFlight || state.completed || state.tile.revision !== revision) return;
    if (!state.previewUploaded || !state.centerReferenceReady || state.pendingReferences > 0) return;
    const candidates = buildReferenceCandidates(state, localRuntime);
    if (candidates.length === 0) {
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
          renderMode: "final",
          sampleStep: 2,
          refinementBaseRgba: state.refinementBaseRgba,
          refinementUnresolvedMask: state.refinementUnresolvedMask,
          refinementSmoothValues: state.refinementSmoothValues,
          refinementDistanceValues: state.refinementDistanceValues,
          refinementEscapedMask: state.refinementEscapedMask
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
        state.refinementBaseRgba = result.rgba.slice(0);
        state.refinementUnresolvedMask = result.unresolvedMask?.slice(0);
        state.refinementSmoothValues = result.refinementSmoothValues?.slice(0);
        state.refinementDistanceValues = result.refinementDistanceValues?.slice(0);
        state.refinementEscapedMask = result.refinementEscapedMask?.slice(0);
        state.lastReferencePressure = unresolvedPressure(state, result.stats.unresolvedCount);
        const queued = queueClusterReferences(localRuntime, state, result.stats.unresolvedClusters);
        if (queued > 0 || state.pendingReferences > 0) {
          updateWorkStatus("refining");
          return;
        }
        if (state.referenceCellSize > 1) {
          state.referenceCellSize = Math.max(1, state.referenceCellSize >> 1);
          state.requestedReferenceKeys.clear();
          const finerQueued = queueClusterReferences(localRuntime, state, result.stats.unresolvedClusters);
          if (finerQueued > 0) return;
        }
        state.requestedReferenceKeys.clear();
        if (queueClusterReferences(localRuntime, state, result.stats.unresolvedClusters) > 0) return;
        updateWorkStatus("refining");
        return;
      }

      renderer.uploadTile(result);
      state.refinementBaseRgba = undefined;
      state.refinementUnresolvedMask = undefined;
      state.refinementSmoothValues = undefined;
      state.refinementDistanceValues = undefined;
      state.refinementEscapedMask = undefined;
      state.completed = true;
      stats.completedTiles += 1;
      pendingTileIds.delete(state.tile.id);
      releaseCenterReferenceBudget(state);
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
    const request = referenceRequestKey(localRuntime, message.targetScreenX, message.targetScreenY, state.referenceCellSize);
    const requestKey = request.key;
    if (state.requestedReferenceKeys.has(requestKey)) return;
    if (!reserveSpatialReferenceBudget(request.key)) return;

    state.requestedReferenceKeys.add(requestKey);
    state.pendingReferences += 1;
    state.localReferenceRequests += 1;
    updateWorkStatus("refining");
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
    const merged = new Map<string, (typeof explicit)[number]>();
    for (const reference of explicit) merged.set(reference.id, reference);
    void localRuntime;
    return [...merged.values()]
      .sort((a, b) => referenceDistance(state.tile, a) - referenceDistance(state.tile, b))
      .slice(0, MAX_RENDER_REFERENCES);
  }

  function queueClusterReferences(
    localRuntime: RuntimeView,
    state: TileWorkState,
    clusters: UnresolvedCluster[],
    limit = MAX_REFERENCES_PER_WAVE
  ): number {
    if (clusters.length === 0) return 0;
    let queued = 0;
    for (const cluster of clusters.slice(0, limit)) {
      const request = referenceRequestKey(localRuntime, cluster.screenX, cluster.screenY, state.referenceCellSize);
      const requestKey = request.key;
      if (state.requestedReferenceKeys.has(requestKey)) continue;
      const cachedReferenceId = referenceCells.get(requestKey);
      if (cachedReferenceId) {
        addReferenceToState(state, cachedReferenceId, localRuntime);
        continue;
      }
      if (!reserveSpatialReferenceBudget(requestKey)) break;
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
    request: ReturnType<typeof referenceRequestKey> & { refinementLevel: number; survivedIter: number; pixelCount: number; center?: boolean }
  ): void {
    const existing = referenceBroker.get(request.key);
    if (existing) {
      existing.waiters.push({ tileId: state.tile.id, refinementLevel: request.refinementLevel, center: request.center ?? false });
      return;
    }
    const entry: ReferenceBrokerEntry = {
      key: request.key,
      revision: localRuntime.revision,
      targetScreenX: request.targetScreenX,
      targetScreenY: request.targetScreenY,
      cellSize: request.cellSize,
      survivedIter: request.survivedIter,
      pixelCount: request.pixelCount,
      waiters: [{ tileId: state.tile.id, refinementLevel: request.refinementLevel, center: request.center ?? false }]
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
        .sort((a, b) => Number(b.waiters.some((waiter) => waiter.center)) - Number(a.waiters.some((waiter) => waiter.center))
          || b.survivedIter - a.survivedIter
          || b.pixelCount - a.pixelCount);
      for (const entry of entries) void computeBrokerReference(localRuntime, entry);
    }, BROKER_FLUSH_DELAY_MS);
  }

  async function computeBrokerReference(localRuntime: RuntimeView, entry: ReferenceBrokerEntry): Promise<void> {
    try {
      const cachedReferenceId = referenceCells.get(entry.key);
      if (cachedReferenceId && references.getById(cachedReferenceId)) {
        distributeBrokerReference(localRuntime, entry, cachedReferenceId);
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
      const priority = entry.waiters.some((waiter) => waiter.center) ? 0 : 10;
      const reference = await references.ensureTileReference(localRuntime, targetTile, 128, priority);
      if (entry.revision !== revision) return;
      referenceCells.set(entry.key, reference.id);
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

  function previewSampleStep(tile: TileDescriptor): number {
    const span = Math.max(tile.rect.width, tile.rect.height);
    if (span >= 96) return 5;
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
    stats.status = hasReachedStableQuality() || !hasOutstandingWork() ? "stable" : activeStatus;
  }

  function hasReachedStableQuality(): boolean {
    return hasPreviewCoverage();
  }

  function hasPreviewCoverage(): boolean {
    if (pendingTileShells > 0 || initialTileCount === 0) return false;
    for (const state of tileStates.values()) {
      if (!state.previewUploaded && !state.completed) return false;
    }
    return true;
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
      addReferenceToState(waiterState, referenceId, localRuntime);
      if (waiter.center) waiterState.centerReferenceReady = true;
      waiterState.refinementLevel = Math.max(waiterState.refinementLevel, waiter.refinementLevel);
      if (waiter.center) void submitPreview(localRuntime, waiterState);
      submitReadyTile(localRuntime, waiterState);
    }
    syncPinnedReferences();
    stats.references = references.size;
    updateWorkStatus("refining");
  }

  function submitReadyTile(localRuntime: RuntimeView, state: TileWorkState): void {
    if (!hasPreviewCoverage() || state.inFlight || state.pendingReferences > 0 || !state.previewUploaded || !state.centerReferenceReady || state.completed || state.tile.revision !== revision) return;
    void submitTile(localRuntime, state);
  }

  function reserveReferenceBudget(key: string): boolean {
    if (referenceBudgetKeys.has(key)) return true;
    if (referenceBudgetKeys.size >= MAX_REFERENCES_PER_VIEW) return false;
    referenceBudgetKeys.add(key);
    return true;
  }

  function reserveSpatialReferenceBudget(key: string): boolean {
    if (spatialReferenceBudgetKeys.has(key)) return true;
    if (spatialReferenceBudgetKeys.size >= MAX_SPATIAL_REFERENCES_PER_VIEW) {
      const evicted = [...spatialReferenceBudgetKeys].find((candidate) => !referenceBroker.has(candidate));
      if (!evicted) return false;
      spatialReferenceBudgetKeys.delete(evicted);
      referenceBudgetKeys.delete(evicted);
      referenceCells.delete(evicted);
    }
    if (!reserveReferenceBudget(key)) return false;
    spatialReferenceBudgetKeys.add(key);
    return true;
  }

  function releaseCenterReferenceBudget(state: TileWorkState): void {
    referenceBudgetKeys.delete(`center:${state.tile.id}`);
  }

  function addReferenceToState(state: TileWorkState, referenceId: string, localRuntime: RuntimeView): void {
    const retained = [...state.referenceIds]
      .filter((id) => id !== referenceId)
      .map((id) => references.getById(id))
      .filter((reference): reference is NonNullable<typeof reference> => Boolean(reference))
      .sort((a, b) => referenceDistance(state.tile, a) - referenceDistance(state.tile, b))
      .slice(0, MAX_RENDER_REFERENCES - 1);
    state.referenceIds = new Set([referenceId, ...retained.map((reference) => reference.id)]);
    void localRuntime;
  }

  function referenceRequestKey(
    localRuntime: RuntimeView,
    screenX: number,
    screenY: number,
    cellSize: number
  ): { key: string; targetScreenX: number; targetScreenY: number; cellSize: number } {
    const normalizedCellSize = Math.max(1, Math.floor(cellSize));
    const cellX = Math.floor(screenX / normalizedCellSize);
    const cellY = Math.floor(screenY / normalizedCellSize);
    return {
      key: `${localRuntime.revision}:${localRuntime.maxIter}:${normalizedCellSize}:${cellX}:${cellY}`,
      targetScreenX: Math.max(0.5, Math.min(localRuntime.width - 0.5, (cellX + 0.5) * normalizedCellSize)),
      targetScreenY: Math.max(0.5, Math.min(localRuntime.height - 0.5, (cellY + 0.5) * normalizedCellSize)),
      cellSize: normalizedCellSize
    };
  }

  function unresolvedPressure(state: TileWorkState, unresolvedCount: number): number {
    return unresolvedCount / Math.max(1, Math.ceil(state.tile.rect.width) * Math.ceil(state.tile.rect.height));
  }

  function previewUnresolvedPressure(unresolvedCount: number, width: number, height: number): number {
    return unresolvedCount / Math.max(1, width * height);
  }

  function requestCenterReference(localRuntime: RuntimeView, state: TileWorkState): boolean {
    const requestKey = `center:${state.tile.id}`;
    if (state.requestedReferenceKeys.has(requestKey)) return false;
    if (!reserveReferenceBudget(requestKey)) return false;

    state.requestedReferenceKeys.add(requestKey);
    state.pendingReferences += 1;
    state.localReferenceRequests += 1;
    state.centerReferenceAttempted = true;
    void computeCenterReference(localRuntime, state);
    return true;
  }

  async function computeCenterReference(localRuntime: RuntimeView, state: TileWorkState): Promise<void> {
    try {
      const reference = await references.ensureTileReference(localRuntime, state.tile, 128, 5);
      state.pendingReferences = Math.max(0, state.pendingReferences - 1);
      if (state.tile.revision !== revision || state.completed) return;
      addReferenceToState(state, reference.id, localRuntime);
      state.centerReferenceReady = true;
      state.refinementLevel = Math.max(state.refinementLevel, 1);
      syncPinnedReferences();
      stats.references = references.size;
      void submitPreview(localRuntime, state);
      submitReadyTile(localRuntime, state);
    } catch (error) {
      state.pendingReferences = Math.max(0, state.pendingReferences - 1);
      stats.status = error instanceof Error ? error.message : String(error);
    }
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

    bindIterControlPair("base", "#iterBaseRange", "#iterBaseInput", "#iterBaseReset", ITER_MIN, ITER_MAX, (value) => {
      setIterFormula({ ...iterSettings.formula, base: value }, "iter formula");
    }, () => DEFAULT_ITER_FORMULA.base);
    bindIterControlPair("slope", "#iterSlopeRange", "#iterSlopeInput", "#iterSlopeReset", ITER_SLOPE_MIN, ITER_SLOPE_MAX, (value) => {
      setIterFormula({ ...iterSettings.formula, slope: value }, "iter formula");
    }, () => DEFAULT_ITER_FORMULA.slope);
    bindIterControlPair("cap", "#iterCapRange", "#iterCapInput", "#iterCapReset", ITER_MIN, ITER_MAX, (value) => {
      setIterFormula({ ...iterSettings.formula, cap: value }, "iter formula");
    }, () => DEFAULT_ITER_FORMULA.cap);
    bindIterControlPair("fixed", "#iterFixedRange", "#iterFixedInput", "#iterFixedReset", ITER_MIN, ITER_MAX, (value) => {
      setIterSettings({ ...iterSettings, fixedIter: clampIter(value) }, "iter fixed");
    }, () => defaultMaxIter(view.scale, iterSettings.formula));
  }

  function bindIterControlPair(
    name: string,
    rangeSelector: string,
    inputSelector: string,
    resetSelector: string,
    min: number,
    max: number,
    apply: (value: number) => void,
    resetValue: () => number
  ): void {
    const range = requireElement(root, rangeSelector, HTMLInputElement);
    const input = requireElement(root, inputSelector, HTMLInputElement);
    const reset = requireElement(root, resetSelector, HTMLButtonElement);
    const read = (target: HTMLInputElement) => clampControlNumber(target.valueAsNumber, min, max);
    range.addEventListener("input", () => apply(read(range)));
    input.addEventListener("input", () => apply(read(input)));
    input.addEventListener("change", () => {
      syncIterControls();
      apply(read(input));
    });
    reset.addEventListener("click", () => apply(clampControlNumber(resetValue(), min, max)));
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
      for (const button of element.querySelectorAll<HTMLButtonElement>("button")) button.disabled = !active;
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
