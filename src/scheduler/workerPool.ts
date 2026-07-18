import type {
  PrepareTilesMessage,
  Rect,
  ReferenceSnapshot,
  RenderTileMessage,
  RuntimeView,
  TileDoneMessage,
  TileWorkerInMessage,
  TileWorkerOutMessage
} from "../types";

export interface RawReferenceResult {
  maxIterBoundedRadius: number;
  orbitRe: Float64Array;
  orbitIm: Float64Array;
}

export interface TilePreparation {
  derivativeEagerScores: Float64Array;
  seriesSkips: Float64Array;
}

interface RenderQueueItem {
  kind: "render";
  message: RenderTileMessage;
  priority: number;
  sequence: number;
  queuedAt: number;
  preferredWorker?: Worker;
  resolve: (result: TileDoneMessage) => void;
  reject: (error: Error) => void;
}

interface ReferenceQueueItem {
  kind: "reference";
  message: ComputeReferenceMessage;
  revision: number;
  priority: number;
  sequence: number;
  resolve: (result: RawReferenceResult) => void;
  reject: (error: Error) => void;
}

interface PrepareTilesQueueItem {
  kind: "prepareTiles";
  message: PrepareTilesMessage;
  revision: number;
  priority: number;
  sequence: number;
  resolve: (preparation: TilePreparation) => void;
  reject: (error: Error) => void;
}

interface PrepareReferenceItem {
  kind: "prepareReference";
  revision: number;
}

interface ComputeReferenceMessage {
  type: "computeReference";
  requestId: number;
  centerRe: string;
  centerIm: string;
  scale: string;
  maxIter: number;
  minPrecisionBits: number;
}

type QueueItem = RenderQueueItem | ReferenceQueueItem | PrepareTilesQueueItem;
type WorkerMessage =
  | TileWorkerOutMessage
  | { type: "warmupDone" }
  | { type: "referencePrepared"; revision: number }
  | { type: "referenceDone"; requestId: number; reference: RawReferenceResult }
  | { type: "referenceError"; requestId: number; message: string };

export class TileWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: QueueItem[] = [];
  private readonly inFlight = new Map<Worker, QueueItem | PrepareReferenceItem>();
  private readonly residentRevision = new Map<Worker, number>();
  private readonly preparedWorkerByRect = new Map<string, Worker>();
  private sequence = 0;
  private requestId = 0;
  private fatalError: Error | undefined;
  private wasmModule: WebAssembly.Module | undefined;

  constructor(readonly size = resolveWorkerCount()) {
    while (this.workers.length < this.size) this.idle.push(this.createWorker());
  }

  warmup(wasmModule: WebAssembly.Module): void {
    if (this.fatalError) throw this.fatalError;
    this.wasmModule = wasmModule;
    for (const worker of this.workers) {
      worker.postMessage({ type: "warmup", module: wasmModule } satisfies TileWorkerInMessage);
    }
  }

  dispose(error = new Error("worker pool disposed")): void {
    this.handleFatalError(error);
  }

  get pending(): number {
    return this.queue.length;
  }

  get active(): number {
    return this.inFlight.size;
  }

  render(message: RenderTileMessage, priority = 0): Promise<TileDoneMessage> {
    return this.renderBatch([{ message, priority }])[0];
  }

  renderBatch(requests: ReadonlyArray<{ message: RenderTileMessage; priority: number }>): Promise<TileDoneMessage>[] {
    if (this.fatalError) return requests.map(() => Promise.reject(this.fatalError));
    this.ensureRenderCapacity();
    const items: RenderQueueItem[] = [];
    const promises = requests.map(({ message, priority }) => new Promise<TileDoneMessage>((resolve, reject) => {
      const queuedAt = performance.now();
      items.push({
        kind: "render",
        message,
        priority,
        sequence: ++this.sequence,
        queuedAt,
        preferredWorker: this.preparedWorkerByRect.get(rectWorkerKey(message.tile.revision, message.tile.rect)),
        resolve,
        reject
      });
      recordDeepBench({
        type: "tileQueued",
        tileId: message.tile.id,
        revision: message.tile.revision,
        priority,
        eagerDerivative: message.eagerDerivative,
        queuedAt
      });
    }));
    this.enqueueBatch(items);
    this.pump();
    return promises;
  }

  async prepareTiles(
    reference: ReferenceSnapshot,
    rects: readonly Rect[],
    pixelSpan: number,
    maxIter: number
  ): Promise<TilePreparation> {
    if (this.fatalError) throw this.fatalError;
    if (rects.length === 0) {
      return { derivativeEagerScores: new Float64Array(), seriesSkips: new Float64Array() };
    }
    const startedAt = performance.now();
    const chunkCount = Math.min(this.size, rects.length);
    const items: PrepareTilesQueueItem[] = [];
    const chunkRects = Array.from({ length: chunkCount }, () => ({ indices: [] as number[], rects: [] as Rect[] }));
    for (let index = 0; index < rects.length; index += 1) {
      const chunk = chunkRects[index % chunkCount];
      chunk.indices.push(index);
      chunk.rects.push(rects[index]);
    }
    const chunks: Array<{ indices: number[]; promise: Promise<TilePreparation> }> = [];
    for (const chunk of chunkRects) {
      const requestId = ++this.requestId;
      const message: PrepareTilesMessage = {
        type: "prepareTiles",
        requestId,
        revision: reference.revision,
        rects: chunk.rects,
        pixelSpan,
        maxIter,
        reference
      };
      const promise = new Promise<TilePreparation>((resolve, reject) => {
        items.push({
          kind: "prepareTiles",
          message,
          revision: reference.revision,
          priority: -0.5,
          sequence: ++this.sequence,
          resolve,
          reject
        });
      });
      chunks.push({ indices: chunk.indices, promise });
    }
    this.enqueueBatch(items);
    this.pump();
    const derivativeEagerScores = new Float64Array(rects.length);
    const seriesSkips = new Float64Array(rects.length);
    for (const chunk of chunks) {
      const result = await chunk.promise;
      for (let index = 0; index < chunk.indices.length; index += 1) {
        derivativeEagerScores[chunk.indices[index]] = result.derivativeEagerScores[index];
        seriesSkips[chunk.indices[index]] = result.seriesSkips[index];
      }
    }
    recordDeepBench({
      type: "tilesPrepared",
      revision: reference.revision,
      rectCount: rects.length,
      elapsedMs: performance.now() - startedAt
    });
    return { derivativeEagerScores, seriesSkips };
  }

  async computeViewReference(view: RuntimeView): Promise<ReferenceSnapshot> {
    if (this.fatalError) throw this.fatalError;
    this.preparedWorkerByRect.clear();
    const requestId = ++this.requestId;
    const raw = await new Promise<RawReferenceResult>((resolve, reject) => {
      this.enqueue({
        kind: "reference",
        message: {
          type: "computeReference",
          requestId,
          centerRe: view.re,
          centerIm: view.im,
          scale: view.scale,
          maxIter: view.maxIter,
          minPrecisionBits: 128
        },
        revision: view.revision,
        priority: -1,
        sequence: ++this.sequence,
        resolve,
        reject
      });
      this.pump();
    });
    const reference = {
      revision: view.revision,
      screenX: view.width * 0.5,
      screenY: view.height * 0.5,
      maxIterBoundedRadius: raw.maxIterBoundedRadius,
      orbitRe: raw.orbitRe,
      orbitIm: raw.orbitIm
    };
    this.prepareReferenceWorkers(reference);
    return reference;
  }

  clearQueueForOldRevisions(currentRevision: number): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const item = this.queue[index];
      const itemRevision = item.kind === "render" ? item.message.tile.revision : item.revision;
      if (itemRevision === currentRevision) continue;
      this.queue.splice(index, 1);
      item.reject(new Error("stale work revision"));
    }
    for (const [worker, item] of [...this.inFlight.entries()]) {
      const itemRevision = item.kind === "render" ? item.message.tile.revision : item.revision;
      if (itemRevision === currentRevision) continue;
      this.inFlight.delete(worker);
      if (item.kind !== "prepareReference") item.reject(new Error("stale work revision"));
      this.replaceWorker(worker);
    }
    this.pump();
  }

  private enqueue(item: QueueItem): void {
    if (this.fatalError) {
      item.reject(this.fatalError);
      return;
    }
    let low = 0;
    let high = this.queue.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const current = this.queue[middle];
      if (current.priority < item.priority || (current.priority === item.priority && current.sequence < item.sequence)) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    this.queue.splice(low, 0, item);
  }

  private enqueueBatch(items: QueueItem[]): void {
    if (this.fatalError) {
      for (const item of items) item.reject(this.fatalError);
      return;
    }
    this.queue.push(...items);
    this.queue.sort(compareQueueItems);
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop();
      if (!worker) break;
      const head = this.queue[0];
      const headWave = head?.kind === "render" ? renderPriorityWave(head.priority, this.size) : -1;
      let itemIndex = headWave < 0 ? -1 : this.queue.findIndex(
        (candidate) => candidate.kind === "render"
          && renderPriorityWave(candidate.priority, this.size) === headWave
          && candidate.preferredWorker === worker
      );
      // Preparation may have built an exact long-series plan in this Worker.
      // Reuse it only inside the current center-first wave; never pull a farther
      // tile ahead of the next group of visible work.
      if (itemIndex < 0) itemIndex = 0;
      const [item] = this.queue.splice(itemIndex, 1);
      if (!worker || !item) break;
      this.inFlight.set(worker, item);
      if (item.kind === "reference") {
        worker.postMessage(item.message);
        continue;
      }
      if (item.kind === "prepareTiles") {
        worker.postMessage(this.prepareTilesMessage(worker, item.message) satisfies TileWorkerInMessage);
        continue;
      }
      recordDeepBench({
        type: "tileStarted",
        tileId: item.message.tile.id,
        revision: item.message.tile.revision,
        queuedAt: item.queuedAt,
        startedAt: performance.now()
      });
      worker.postMessage(this.prepareMessage(worker, item.message) satisfies TileWorkerInMessage);
    }
  }

  private prepareMessage(worker: Worker, message: RenderTileMessage): RenderTileMessage {
    if (this.residentRevision.get(worker) !== message.reference.revision) {
      this.residentRevision.set(worker, message.reference.revision);
      return message;
    }
    return {
      ...message,
      reference: { ...message.reference, orbitRe: EMPTY_REFERENCE_ORBIT, orbitIm: EMPTY_REFERENCE_ORBIT }
    };
  }

  private prepareTilesMessage(worker: Worker, message: PrepareTilesMessage): PrepareTilesMessage {
    if (this.residentRevision.get(worker) !== message.reference.revision) {
      this.residentRevision.set(worker, message.reference.revision);
      return message;
    }
    return {
      ...message,
      reference: { ...message.reference, orbitRe: EMPTY_REFERENCE_ORBIT, orbitIm: EMPTY_REFERENCE_ORBIT }
    };
  }

  private createWorker(): Worker {
    const worker = new Worker(new URL("../workers/tileWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => this.handleMessage(worker, event.data);
    worker.onerror = (event) => this.handleError(worker, new Error(event.message));
    this.workers.push(worker);
    if (this.wasmModule) {
      worker.postMessage({ type: "warmup", module: this.wasmModule } satisfies TileWorkerInMessage);
    }
    return worker;
  }

  private prepareReferenceWorkers(reference: ReferenceSnapshot): void {
    for (const worker of [...this.idle]) {
      const idleIndex = this.idle.indexOf(worker);
      if (idleIndex >= 0) this.idle.splice(idleIndex, 1);
      this.inFlight.set(worker, { kind: "prepareReference", revision: reference.revision });
      worker.postMessage({ type: "prepareReference", reference } satisfies TileWorkerInMessage);
    }
  }

  private replaceWorker(worker: Worker): void {
    worker.terminate();
    const idleIndex = this.idle.indexOf(worker);
    if (idleIndex >= 0) this.idle.splice(idleIndex, 1);
    const workerIndex = this.workers.indexOf(worker);
    if (workerIndex >= 0) this.workers.splice(workerIndex, 1);
    this.residentRevision.delete(worker);
    for (const [key, preferred] of this.preparedWorkerByRect) {
      if (preferred === worker) this.preparedWorkerByRect.delete(key);
    }
    this.idle.push(this.createWorker());
  }

  private ensureRenderCapacity(): void {
    if (this.fatalError) return;
    while (this.workers.length < this.size) this.idle.push(this.createWorker());
  }

  private handleMessage(worker: Worker, message: WorkerMessage): void {
    if (message.type === "workerError") {
      this.handleFatalError(new Error(message.message));
      return;
    }
    if (message.type === "warmupDone") return;
    const item = this.inFlight.get(worker);
    if (!item) return;
    this.inFlight.delete(worker);
    this.idle.push(worker);
    if (item.kind === "prepareReference" && message.type === "referencePrepared") {
      this.residentRevision.set(worker, message.revision);
    } else if (item.kind === "render" && message.type === "tileDone") {
      item.resolve(message);
    } else if (item.kind === "prepareTiles" && message.type === "tilesPrepared") {
      const seriesSkips = asFloat64(message.seriesSkips);
      for (let index = 0; index < item.message.rects.length; index += 1) {
        if (seriesSkips[index] >= 512) {
          this.preparedWorkerByRect.set(
            rectWorkerKey(item.revision, item.message.rects[index]),
            worker
          );
        }
      }
      item.resolve({
        derivativeEagerScores: asFloat64(message.derivativeEagerScores),
        seriesSkips
      });
    } else if (item.kind === "reference" && message.type === "referenceDone") {
      item.resolve({
        ...message.reference,
        orbitRe: asFloat64(message.reference.orbitRe),
        orbitIm: asFloat64(message.reference.orbitIm)
      });
    } else {
      if (item.kind !== "prepareReference") {
        item.reject(new Error(message.type === "referenceError" ? message.message : "worker returned a mismatched response"));
      }
    }
    this.pump();
  }

  private handleError(worker: Worker, error: Error): void {
    this.handleFatalError(error);
  }

  private handleFatalError(error: Error): void {
    if (this.fatalError) return;
    this.fatalError = error;
    for (const item of this.queue.splice(0)) item.reject(error);
    for (const item of this.inFlight.values()) {
      if (item.kind !== "prepareReference") item.reject(error);
    }
    this.inFlight.clear();
    for (const worker of this.workers.splice(0)) worker.terminate();
    this.idle.length = 0;
    this.residentRevision.clear();
    this.preparedWorkerByRect.clear();
  }
}

function compareQueueItems(a: QueueItem, b: QueueItem): number {
  return a.priority - b.priority || a.sequence - b.sequence;
}

function rectWorkerKey(revision: number, rect: Rect): string {
  return `${revision}:${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
}

export function renderPriorityWave(priority: number, workerCount: number): number {
  return Math.floor(Math.max(0, priority) / Math.max(1, Math.floor(workerCount)));
}

export function resolveWorkerCount(hardwareConcurrency = globalThis.navigator?.hardwareConcurrency ?? 4): number {
  if (hardwareConcurrency <= 1) return 1;
  return Math.max(1, Math.floor(hardwareConcurrency));
}

const EMPTY_REFERENCE_ORBIT = new Float64Array();

function asFloat64(value: Float64Array | ArrayLike<number>): Float64Array {
  return value instanceof Float64Array ? value : Float64Array.from(value);
}

function recordDeepBench(event: Record<string, unknown>): void {
  (globalThis as unknown as { __deepBenchRecord?: (event: Record<string, unknown>) => void }).__deepBenchRecord?.(event);
}
