import type {
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

interface RenderQueueItem {
  kind: "render";
  message: RenderTileMessage;
  priority: number;
  sequence: number;
  queuedAt: number;
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

interface ComputeReferenceMessage {
  type: "computeReference";
  requestId: number;
  centerRe: string;
  centerIm: string;
  scale: string;
  maxIter: number;
  minPrecisionBits: number;
}

type QueueItem = RenderQueueItem | ReferenceQueueItem;
type WorkerMessage =
  | TileWorkerOutMessage
  | { type: "referenceDone"; requestId: number; reference: RawReferenceResult }
  | { type: "referenceError"; requestId: number; message: string };

export class TileWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: QueueItem[] = [];
  private readonly inFlight = new Map<Worker, QueueItem>();
  private readonly residentRevision = new Map<Worker, number>();
  private sequence = 0;
  private requestId = 0;

  constructor(readonly size = resolveWorkerCount()) {
    this.idle.push(this.createWorker());
  }

  get pending(): number {
    return this.queue.length;
  }

  get active(): number {
    return this.inFlight.size;
  }

  render(message: RenderTileMessage, priority = 0): Promise<TileDoneMessage> {
    this.ensureRenderCapacity();
    const queuedAt = performance.now();
    const promise = new Promise<TileDoneMessage>((resolve, reject) => {
      this.queue.push({ kind: "render", message, priority, sequence: ++this.sequence, queuedAt, resolve, reject });
      this.sortQueue();
      recordDeepBench({ type: "tileQueued", tileId: message.tile.id, revision: message.tile.revision, priority, queuedAt });
    });
    this.pump();
    return promise;
  }

  async computeViewReference(view: RuntimeView): Promise<ReferenceSnapshot> {
    const requestId = ++this.requestId;
    const raw = await new Promise<RawReferenceResult>((resolve, reject) => {
      this.queue.push({
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
      this.sortQueue();
      this.pump();
    });
    return {
      revision: view.revision,
      screenX: view.width * 0.5,
      screenY: view.height * 0.5,
      maxIterBoundedRadius: raw.maxIterBoundedRadius,
      orbitRe: raw.orbitRe,
      orbitIm: raw.orbitIm
    };
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
      item.reject(new Error("stale work revision"));
      this.replaceWorker(worker);
    }
    this.pump();
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop();
      const item = this.queue.shift();
      if (!worker || !item) break;
      this.inFlight.set(worker, item);
      if (item.kind === "reference") {
        worker.postMessage(item.message);
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

  private createWorker(): Worker {
    const worker = new Worker(new URL("../workers/tileWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => this.handleMessage(worker, event.data);
    worker.onerror = (event) => this.handleError(worker, new Error(event.message));
    this.workers.push(worker);
    return worker;
  }

  private replaceWorker(worker: Worker): void {
    worker.terminate();
    const idleIndex = this.idle.indexOf(worker);
    if (idleIndex >= 0) this.idle.splice(idleIndex, 1);
    const workerIndex = this.workers.indexOf(worker);
    if (workerIndex >= 0) this.workers.splice(workerIndex, 1);
    this.residentRevision.delete(worker);
    this.idle.push(this.createWorker());
  }

  private ensureRenderCapacity(): void {
    while (this.workers.length < this.size) this.idle.push(this.createWorker());
  }

  private handleMessage(worker: Worker, message: WorkerMessage): void {
    const item = this.inFlight.get(worker);
    if (!item) return;
    this.inFlight.delete(worker);
    this.idle.push(worker);
    if (item.kind === "render" && message.type === "tileDone") {
      item.resolve(message);
    } else if (item.kind === "reference" && message.type === "referenceDone") {
      item.resolve({
        ...message.reference,
        orbitRe: asFloat64(message.reference.orbitRe),
        orbitIm: asFloat64(message.reference.orbitIm)
      });
    } else {
      item.reject(new Error(message.type === "referenceError" ? message.message : "worker returned a mismatched response"));
    }
    this.pump();
  }

  private handleError(worker: Worker, error: Error): void {
    const item = this.inFlight.get(worker);
    if (item) {
      this.inFlight.delete(worker);
      item.reject(error);
    }
    this.replaceWorker(worker);
    this.pump();
  }
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
