import type {
  RenderTileMessage,
  TileDoneMessage,
  TileWorkerInMessage,
  TileWorkerOutMessage
} from "../types";
import type { RawReferenceResult, ReferenceComputer, ReferenceWorkOptions } from "../reference/referenceClient";

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
  message: {
    type: "computeReference";
    requestId: number;
    centerRe: string;
    centerIm: string;
    scale: string;
    maxIter: number;
    minPrecisionBits: number;
  };
  revision: number | undefined;
  priority: number;
  sequence: number;
  queuedAt: number;
  resolve: (result: RawReferenceResult) => void;
  reject: (error: Error) => void;
}

type QueueItem = RenderQueueItem | ReferenceQueueItem;

export class TileWorkerPool implements ReferenceComputer {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: QueueItem[] = [];
  private readonly inFlight = new Map<Worker, QueueItem>();
  private readonly residentReferences = new Map<Worker, Set<string>>();
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

  render(message: RenderTileMessage, priority = defaultPriority(message)): Promise<TileDoneMessage> {
    this.ensureRenderCapacity();
    const promise = new Promise<TileDoneMessage>((resolve, reject) => {
      const queuedAt = performance.now();
      this.queue.push({ kind: "render", message, priority, sequence: ++this.sequence, queuedAt, resolve, reject });
      this.queue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
      recordDeepBench({ type: "tileQueued", tileId: message.tile.id, revision: message.tile.revision, renderMode: message.renderMode, priority, queuedAt });
    });
    this.pump();
    return promise;
  }

  compute(
    centerRe: string,
    centerIm: string,
    scale: string,
    maxIter: number,
    minPrecisionBits = 128,
    options: ReferenceWorkOptions = {}
  ): Promise<RawReferenceResult> {
    const requestId = ++this.requestId;
    const promise = new Promise<RawReferenceResult>((resolve, reject) => {
      this.queue.push({
        kind: "reference",
        message: { type: "computeReference", requestId, centerRe, centerIm, scale, maxIter, minPrecisionBits },
        revision: options.revision,
        priority: options.kind === "viewReference" ? -5 : -2.25,
        sequence: ++this.sequence,
        queuedAt: performance.now(),
        resolve,
        reject
      });
      this.queue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
    });
    this.pump();
    return promise;
  }

  cancelObsoleteWork(currentRevision: number): void {
    this.clearQueueForOldRevisions(currentRevision);
  }

  clearQueueForOldRevisions(currentRevision: number): void {
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const item = this.queue[i];
      const itemRevision = item.kind === "render" ? item.message.tile.revision : item.revision;
      if (itemRevision !== undefined && itemRevision !== currentRevision) {
        const [item] = this.queue.splice(i, 1);
        item?.reject(new Error("stale work revision"));
      }
    }
    for (const [worker, item] of [...this.inFlight.entries()]) {
      const itemRevision = item.kind === "render" ? item.message.tile.revision : item.revision;
      if (itemRevision === undefined || itemRevision === currentRevision) continue;
      this.inFlight.delete(worker);
      item.reject(new Error("stale work revision"));
      this.replaceWorker(worker);
    }
    this.pump();
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate();
    this.queue.splice(0);
    this.inFlight.clear();
    this.idle.splice(0);
    this.residentReferences.clear();
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop();
      const item = this.queue.shift();
      if (!worker || !item) break;
      this.inFlight.set(worker, item);
      if (item.kind === "render") {
        recordDeepBench({
          type: "tileStarted",
          tileId: item.message.tile.id,
          revision: item.message.tile.revision,
          renderMode: item.message.renderMode,
          queuedAt: item.queuedAt,
          startedAt: performance.now()
        });
        const message = this.prepareMessage(worker, item.message);
        worker.postMessage(message satisfies TileWorkerInMessage, renderTransferables(message));
      } else {
        worker.postMessage(item.message);
      }
    }
  }

  private createWorker(): Worker {
    const worker = new Worker(new URL("../workers/tileWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent) => this.handleMessage(worker, event.data);
    worker.onerror = (event) => this.handleError(worker, new Error(event.message));
    this.workers.push(worker);
    this.residentReferences.set(worker, new Set());
    return worker;
  }

  private replaceWorker(worker: Worker): void {
    worker.terminate();
    const idleIndex = this.idle.indexOf(worker);
    if (idleIndex >= 0) this.idle.splice(idleIndex, 1);
    const workerIndex = this.workers.indexOf(worker);
    if (workerIndex >= 0) this.workers.splice(workerIndex, 1);
    this.residentReferences.delete(worker);
    this.idle.push(this.createWorker());
  }

  private ensureRenderCapacity(): void {
    while (this.workers.length < this.size) this.idle.push(this.createWorker());
  }

  private prepareMessage(worker: Worker, message: RenderTileMessage): RenderTileMessage {
    const resident = this.residentReferences.get(worker);
    const reference = message.reference;
    if (!resident || !reference) return message;
    const key = referenceTransportKey(reference);
    if (!resident.has(key)) {
      resident.add(key);
      return message;
    }
    return {
      ...message,
      reference: {
        ...reference,
        orbitRe: EMPTY_REFERENCE_ORBIT,
        orbitIm: EMPTY_REFERENCE_ORBIT
      }
    };
  }

  private handleMessage(
    worker: Worker,
    message: TileWorkerOutMessage | { type: "referenceDone"; requestId: number; reference: RawReferenceResult } | { type: "referenceError"; requestId: number; message: string }
  ): void {
    const item = this.inFlight.get(worker);
    if (!item) return;
    this.inFlight.delete(worker);
    this.idle.push(worker);
    if (item.kind === "render" && message.type === "tileDone") {
      item.resolve(message);
    } else if (item.kind === "reference" && message.type === "referenceDone") {
      item.resolve({
        ...message.reference,
        orbitRe: message.reference.orbitRe instanceof Float64Array ? message.reference.orbitRe : Float64Array.from(message.reference.orbitRe),
        orbitIm: message.reference.orbitIm instanceof Float64Array ? message.reference.orbitIm : Float64Array.from(message.reference.orbitIm)
      });
    } else {
      item.reject(new Error(message.type === "referenceError" ? message.message : "Worker returned mismatched response"));
    }
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
  return Math.max(1, Math.floor(hardwareConcurrency));
}

const EMPTY_REFERENCE_ORBIT = new Float64Array();

function referenceTransportKey(reference: NonNullable<RenderTileMessage["reference"]>): string {
  return `${reference.revision}|${reference.id}|${reference.screenX}|${reference.screenY}|${reference.escapedAt}|${reference.maxIter}|${reference.maxIterBoundedRadius}`;
}

function renderTransferables(message: RenderTileMessage): ArrayBuffer[] {
  const buffers = [
    message.exactBaseRgba,
    message.exactUnresolvedMask,
  ].filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer && buffer.byteLength > 0);
  return [...new Set(buffers)];
}

function defaultPriority(message: RenderTileMessage): number {
  if (message.renderMode === "preview") return 0;
  return 10;
}

function recordDeepBench(event: Record<string, unknown>): void {
  (globalThis as unknown as { __deepBenchRecord?: (event: Record<string, unknown>) => void }).__deepBenchRecord?.(event);
}
