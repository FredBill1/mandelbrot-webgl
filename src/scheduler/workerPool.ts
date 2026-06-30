import type {
  NeedReferenceMessage,
  ReferenceHandle,
  ReferenceSnapshot,
  RenderTileMessage,
  TileDoneMessage,
  TileWorkerInMessage,
  TileWorkerOutMessage
} from "../types";

interface QueueItem {
  message: RenderTileMessage;
  priority: number;
  sequence: number;
  resolve: (result: TileDoneMessage) => void;
  reject: (error: Error) => void;
}

export class TileWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: QueueItem[] = [];
  private readonly inFlight = new Map<Worker, QueueItem>();
  private readonly workerCaches = new Map<Worker, WorkerReferenceCache>();
  private sequence = 0;

  constructor(
    readonly size = resolveWorkerCount(),
    private readonly onNeedReference?: (message: NeedReferenceMessage) => void
  ) {
    for (let i = 0; i < size; i += 1) {
      const worker = new Worker(new URL("../workers/tileWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<TileWorkerOutMessage>) => this.handleMessage(worker, event.data);
      worker.onerror = (event) => this.handleError(worker, new Error(event.message));
      this.workers.push(worker);
      this.idle.push(worker);
      this.workerCaches.set(worker, { ids: new Map(), bytes: 0, sequence: 0 });
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
      this.queue.push({ message, priority, sequence: ++this.sequence, resolve, reject });
      this.queue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
    });
    this.pump();
    return promise;
  }

  clearQueueForOldRevisions(currentRevision: number): void {
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      if (this.queue[i].message.tile.revision !== currentRevision) this.queue.splice(i, 1);
    }
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate();
    this.queue.splice(0);
    this.inFlight.clear();
    this.idle.splice(0);
    this.workerCaches.clear();
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop();
      const item = this.queue.shift();
      if (!worker || !item) break;
      this.inFlight.set(worker, item);
      this.cacheReferences(worker, item.message);
      worker.postMessage(toWorkerRenderMessage(item.message) satisfies TileWorkerInMessage);
    }
  }

  private cacheReferences(worker: Worker, message: RenderTileMessage): void {
    const cache = this.workerCaches.get(worker);
    if (!cache) return;

    const referencesToCache: ReferenceSnapshot[] = [];
    const neededIds = new Set<string>();
    for (const reference of message.references) {
      neededIds.add(reference.id);
      cache.sequence += 1;
      const cached = cache.ids.get(reference.id);
      if (cached) {
        cached.lastUsed = cache.sequence;
        continue;
      }
      if (!isReferenceSnapshot(reference)) continue;
      const bytes = referenceBytes(reference);
      cache.ids.set(reference.id, { bytes, lastUsed: cache.sequence });
      cache.bytes += bytes;
      referencesToCache.push(reference);
    }

    const dropped = trimWorkerCache(cache, neededIds);
    if (dropped.length > 0) worker.postMessage({ type: "dropReferences", referenceIds: dropped } satisfies TileWorkerInMessage);
    if (referencesToCache.length > 0) worker.postMessage({ type: "cacheReferences", references: referencesToCache } satisfies TileWorkerInMessage);
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

interface WorkerReferenceCache {
  ids: Map<string, { bytes: number; lastUsed: number }>;
  bytes: number;
  sequence: number;
}

const WORKER_REFERENCE_CACHE_BYTES = 32 * 1024 * 1024;

export function resolveWorkerCount(hardwareConcurrency = globalThis.navigator?.hardwareConcurrency ?? 4): number {
  return Math.max(1, Math.floor(hardwareConcurrency));
}

function defaultPriority(message: RenderTileMessage): number {
  if (message.renderMode === "preview") return 0;
  return message.refined ? 2 : 10;
}

function toWorkerRenderMessage(message: RenderTileMessage): RenderTileMessage {
  return {
    ...message,
    references: message.references.map(toReferenceHandle)
  };
}

function toReferenceHandle(reference: ReferenceHandle | ReferenceSnapshot): ReferenceHandle {
  return {
    id: reference.id,
    screenX: reference.screenX,
    screenY: reference.screenY,
    escapedAt: reference.escapedAt,
    precisionBits: reference.precisionBits,
    maxIter: reference.maxIter
  };
}

function trimWorkerCache(cache: WorkerReferenceCache, neededIds: Set<string>): string[] {
  if (cache.bytes <= WORKER_REFERENCE_CACHE_BYTES) return [];
  const dropped: string[] = [];
  const candidates = [...cache.ids.entries()]
    .filter(([id]) => !neededIds.has(id))
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [id, entry] of candidates) {
    if (cache.bytes <= WORKER_REFERENCE_CACHE_BYTES) break;
    cache.ids.delete(id);
    cache.bytes -= entry.bytes;
    dropped.push(id);
  }
  return dropped;
}

function referenceBytes(reference: ReferenceSnapshot): number {
  return reference.orbitRe.byteLength + reference.orbitIm.byteLength;
}

function isReferenceSnapshot(reference: ReferenceHandle | ReferenceSnapshot): reference is ReferenceSnapshot {
  return "orbitRe" in reference && "orbitIm" in reference;
}
