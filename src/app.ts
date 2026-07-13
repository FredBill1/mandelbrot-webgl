import { WebglTileRenderer, type RetainedScreenTransform } from "./render/webglRenderer";
import { TileWorkerPool } from "./scheduler/workerPool";
import { createVisibleTiles } from "./tiles/tilePlanner";
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
import { initWasm, transformViewNow } from "./wasmApi";
import {
  TILE_SIZE,
  type ReferenceSnapshot,
  type RuntimeView,
  type TileDescriptor,
  type ViewState
} from "./types";

interface Stats {
  fps: number;
  pending: number;
  activeWorkers: number;
  completedTiles: number;
  status: string;
}

interface TileWorkState {
  tile: TileDescriptor;
  inFlight: boolean;
  completed: boolean;
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

  const mainWasmReady = initWasm();

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
    status: "initializing"
  };

  const renderer = new WebglTileRenderer(canvas);
  const pool = new TileWorkerPool();
  const pendingTileIds = new Set<string>();
  const tileStates = new Map<string, TileWorkState>();
  let pendingTilesToSchedule = 0;
  let activeViewReference: ReferenceSnapshot | undefined;

  await mainWasmReady;
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
    pool.clearQueueForOldRevisions(revision);
    resetRenderWorkState();
    renderer.setActiveRevision(revision);
    if (options.resetRetained ?? true) {
      renderer.discardRetained();
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
    pendingTileIds.clear();
    tileStates.clear();
    pendingTilesToSchedule = 0;
    activeViewReference = undefined;
  }

  function scheduleTiles(reason: string, token: number): void {
    const localRuntime = currentRuntimeView();
    stats.status = `rendering ${reason}`;
    resetRenderWorkState();
    const tiles = prioritizeTiles(createVisibleTiles(localRuntime, TILE_SIZE), localRuntime);
    pendingTilesToSchedule = tiles.length;
    stats.pending = pendingWorkCount();
    stats.status = `computing reference for ${tiles.length} tiles`;
    void pool.computeViewReference(localRuntime).then((reference) => {
      if (token !== renderToken || localRuntime.revision !== revision) return;
      activeViewReference = reference;
      scheduleTileBatch(localRuntime, tiles, 0, token);
    }).catch((error) => {
      if (token === renderToken) stats.status = error instanceof Error ? error.message : String(error);
    });
  }

  function prioritizeTiles(tiles: TileDescriptor[], localRuntime: RuntimeView): TileDescriptor[] {
    const centerX = localRuntime.width * 0.5;
    const centerY = localRuntime.height * 0.5;
    return [...tiles].sort((a, b) => {
      const da = Math.hypot(a.rect.x + a.rect.width * 0.5 - centerX, a.rect.y + a.rect.height * 0.5 - centerY);
      const db = Math.hypot(b.rect.x + b.rect.width * 0.5 - centerX, b.rect.y + b.rect.height * 0.5 - centerY);
      return da - db;
    });
  }

  function scheduleTileBatch(localRuntime: RuntimeView, tiles: TileDescriptor[], startIndex: number, token: number): void {
    if (token !== renderToken || localRuntime.revision !== revision || !activeViewReference) return;
    const deadline = performance.now() + TILE_SCHEDULE_BATCH_MS;
    let index = startIndex;
    let processed = 0;
    while (index < tiles.length && (processed < TILE_SCHEDULE_MIN_BATCH || performance.now() < deadline)) {
      const tile = tiles[index];
      const state: TileWorkState = { tile, inFlight: false, completed: false };
      tileStates.set(tile.id, state);
      pendingTileIds.add(tile.id);
      pendingTilesToSchedule = Math.max(0, tiles.length - index - 1);
      void submitTile(localRuntime, state, activeViewReference);
      index += 1;
      processed += 1;
    }
    stats.pending = pendingWorkCount();
    updateWorkStatus("rendering");
    if (index < tiles.length) window.setTimeout(() => scheduleTileBatch(localRuntime, tiles, index, token), 0);
  }

  async function submitTile(localRuntime: RuntimeView, state: TileWorkState, reference: ReferenceSnapshot): Promise<void> {
    if (localRuntime.maxIter !== view.maxIter || localRuntime.revision !== revision) localRuntime = currentRuntimeView();
    if (state.inFlight || state.completed || state.tile.revision !== revision) return;
    state.inFlight = true;
    const centerX = state.tile.rect.x + state.tile.rect.width * 0.5;
    const centerY = state.tile.rect.y + state.tile.rect.height * 0.5;
    const priority = Math.hypot(centerX - localRuntime.width * 0.5, centerY - localRuntime.height * 0.5);
    try {
      const result = await pool.render(
        {
          type: "renderTile",
          tile: state.tile,
          pixelSpan: pixelSpanForView(localRuntime, localRuntime.width),
          maxIter: localRuntime.maxIter,
          reference
        },
        priority
      );
      state.inFlight = false;
      if (result.revision !== revision || state.completed || state.tile.revision !== revision) return;
      stats.activeWorkers = pool.active;
      renderer.uploadTile(result);
      state.completed = true;
      stats.completedTiles += 1;
      pendingTileIds.delete(state.tile.id);
      stats.pending = pendingWorkCount();
      updateWorkStatus("rendering");
    } catch (error) {
      state.inFlight = false;
      if (state.tile.revision !== revision) return;
      stats.status = error instanceof Error ? error.message : String(error);
    }
  }

  function hasOutstandingWork(): boolean {
    if (pendingTilesToSchedule > 0 || pendingTileIds.size > 0 || pool.pending > 0 || pool.active > 0) return true;
    for (const state of tileStates.values()) {
      if (state.inFlight) return true;
    }
    return false;
  }

  function updateWorkStatus(activeStatus: string): void {
    stats.pending = pendingWorkCount();
    stats.activeWorkers = pool.active;
    if (hasOutstandingWork()) {
      stats.status = activeStatus;
      return;
    }
    renderer.discardRetained();
    stats.status = "stable";
  }

  function pendingWorkCount(): number {
    return pendingTileIds.size + pendingTilesToSchedule;
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
    input.addEventListener("change", () => apply(read(input)));
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

