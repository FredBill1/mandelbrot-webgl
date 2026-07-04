import type {
  NeedReferenceMessage,
  RenderTileMessage,
  TileDoneMessage,
  TileWorkerInMessage,
  TileWorkerOutMessage
} from "../types";

interface QueueItem {
  message: RenderTileMessage;
  priority: number;
  sequence: number;
  queuedAt: number;
  resolve: (result: TileDoneMessage) => void;
  reject: (error: Error) => void;
}

export class TileWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: QueueItem[] = [];
  private readonly inFlight = new Map<Worker, QueueItem>();
  private sequence = 0;

  constructor(
    readonly size = resolveWorkerCount(),
    private readonly onNeedReference?: (message: NeedReferenceMessage) => void
  ) {
    for (let i = 0; i < size; i += 1) {
      this.idle.push(this.createWorker());
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  get active(): number {
    return this.inFlight.size;
  }

  render(message: RenderTileMessage, priority = defaultPriority(message)): Promise<TileDoneMessage> {
    const promise = new Promise<TileDoneMessage>((resolve, reject) => {
      const queuedAt = performance.now();
      this.queue.push({ message, priority, sequence: ++this.sequence, queuedAt, resolve, reject });
      this.queue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
      recordDeepBench({ type: "tileQueued", tileId: message.tile.id, revision: message.tile.revision, renderMode: message.renderMode, priority, queuedAt });
    });
    this.pump();
    return promise;
  }

  clearQueueForOldRevisions(currentRevision: number): void {
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      if (this.queue[i].message.tile.revision !== currentRevision) {
        const [item] = this.queue.splice(i, 1);
        item?.reject(new Error("stale render revision"));
      }
    }
    for (const [worker, item] of [...this.inFlight.entries()]) {
      if (item.message.tile.revision === currentRevision) continue;
      this.inFlight.delete(worker);
      item.reject(new Error("stale render revision"));
      this.replaceWorker(worker);
    }
    this.pump();
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate();
    this.queue.splice(0);
    this.inFlight.clear();
    this.idle.splice(0);
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop();
      const item = this.queue.shift();
      if (!worker || !item) break;
      this.inFlight.set(worker, item);
      recordDeepBench({
        type: "tileStarted",
        tileId: item.message.tile.id,
        revision: item.message.tile.revision,
        renderMode: item.message.renderMode,
        queuedAt: item.queuedAt,
        startedAt: performance.now()
      });
      worker.postMessage(item.message satisfies TileWorkerInMessage);
    }
  }

  private createWorker(): Worker {
    const worker = new Worker(new URL("../workers/tileWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<TileWorkerOutMessage>) => this.handleMessage(worker, event.data);
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
    this.idle.push(this.createWorker());
  }

  private handleMessage(worker: Worker, message: TileWorkerOutMessage): void {
    if (message.type === "needReference") {
      this.onNeedReference?.(message);
      return;
    }

    const item = this.inFlight.get(worker);
    if (!item) return;
    this.inFlight.delete(worker);
    this.idle.push(worker);
    item.resolve(message);
    this.pump();
  }

  private handleError(worker: Worker, error: Error): void {
    const item = this.inFlight.get(worker);
    if (item) {
      this.inFlight.delete(worker);
      item.reject(error);
    }
    this.idle.push(worker);
    this.pump();
  }
}

export function resolveWorkerCount(hardwareConcurrency = globalThis.navigator?.hardwareConcurrency ?? 4): number {
  if (hardwareConcurrency <= 1) return 1;
  return Math.max(1, Math.floor(hardwareConcurrency * 2));
}

function defaultPriority(message: RenderTileMessage): number {
  if (message.renderMode === "preview") return 0;
  return message.refined ? 2 : 10;
}

function recordDeepBench(event: Record<string, unknown>): void {
  (globalThis as unknown as { __deepBenchRecord?: (event: Record<string, unknown>) => void }).__deepBenchRecord?.(event);
}
