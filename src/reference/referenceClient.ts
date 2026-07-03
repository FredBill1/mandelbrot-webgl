interface PendingReference {
  type: "computeReference";
  requestId: number;
  revision: number | undefined;
  priority: number;
  sequence: number;
  kind: ReferenceWorkKind;
  centerRe: string;
  centerIm: string;
  scale: string;
  maxIter: number;
  minPrecisionBits: number;
  resolve: (value: RawReferenceResult) => void;
  reject: (reason: Error) => void;
}

interface PendingDefaultIter {
  type: "estimateDefaultIter";
  requestId: number;
  revision: number | undefined;
  priority: number;
  sequence: number;
  kind: ReferenceWorkKind;
  phase: DefaultIterProbePhase;
  re: string;
  im: string;
  scale: string;
  width: number;
  height: number;
  baseline: number;
  resolve: (value: DefaultIterEstimate) => void;
  reject: (reason: Error) => void;
}

type PendingWork = PendingReference | PendingDefaultIter;
export type ReferenceWorkKind = "viewReference" | "localReference" | "defaultIter";
export type DefaultIterProbePhase = "fast" | "full";

export interface DefaultIterEstimate {
  recommendedIter: number;
  confidence: "high" | "low";
  phase: DefaultIterProbePhase;
  fastMs: number;
  fullMs: number;
  maxEscapedAt: number;
  cap: number;
  sampleCount: number;
  confirmedClusters: number;
  reason: string;
}

export interface ReferenceWorkOptions {
  revision?: number;
  priority?: number;
  kind?: ReferenceWorkKind;
  phase?: DefaultIterProbePhase;
}

export interface RawReferenceResult {
  centerRe: string;
  centerIm: string;
  precisionBits: number;
  escapedAt: number;
  orbitRe: Float64Array;
  orbitIm: Float64Array;
}

export class ReferenceClient {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: PendingWork[] = [];
  private readonly inFlight = new Map<Worker, PendingWork>();
  private requestId = 0;
  private sequence = 0;

  constructor(size = resolveReferenceWorkerCount()) {
    for (let index = 0; index < size; index += 1) {
      this.idle.push(this.createWorker());
    }
  }

  get size(): number {
    return this.workers.length;
  }

  compute(centerRe: string, centerIm: string, scale: string, maxIter: number, minPrecisionBits = 128, options: ReferenceWorkOptions = {}): Promise<RawReferenceResult> {
    const requestId = ++this.requestId;
    const promise = new Promise<RawReferenceResult>((resolve, reject) => {
      this.enqueue({
        type: "computeReference",
        requestId,
        revision: options.revision,
        priority: options.priority ?? 10,
        sequence: ++this.sequence,
        kind: options.kind ?? "localReference",
        centerRe,
        centerIm,
        scale,
        maxIter,
        minPrecisionBits,
        resolve,
        reject
      });
    });
    this.pump();
    return promise;
  }

  estimateDefaultIter(input: { re: string; im: string; scale: string; width: number; height: number; baseline: number }, options: ReferenceWorkOptions = {}): Promise<DefaultIterEstimate> {
    const requestId = ++this.requestId;
    const promise = new Promise<DefaultIterEstimate>((resolve, reject) => {
      this.enqueue({
        type: "estimateDefaultIter",
        requestId,
        revision: options.revision,
        priority: options.priority ?? 100,
        sequence: ++this.sequence,
        kind: options.kind ?? "defaultIter",
        phase: options.phase ?? "fast",
        ...input,
        resolve,
        reject
      });
    });
    this.pump();
    return promise;
  }

  cancelObsoleteWork(currentRevision: number): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const pending = this.queue[index];
      if (pending.revision === undefined || pending.revision >= currentRevision) continue;
      this.queue.splice(index, 1);
      pending.reject(new Error("obsolete reference revision"));
    }
    for (const [worker, pending] of [...this.inFlight.entries()]) {
      if (pending.revision === undefined || pending.revision >= currentRevision) continue;
      this.inFlight.delete(worker);
      pending.reject(new Error("obsolete reference revision"));
      this.replaceWorker(worker);
    }
    this.pump();
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate();
    for (const pending of this.queue) pending.reject(new Error("Reference worker terminated"));
    for (const pending of this.inFlight.values()) pending.reject(new Error("Reference worker terminated"));
    this.queue.splice(0);
    this.inFlight.clear();
    this.idle.splice(0);
  }

  private enqueue(work: PendingWork): void {
    this.queue.push(work);
    this.queue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
  }

  private createWorker(): Worker {
    const worker = new Worker(new URL("../workers/referenceWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as
        | { type: "referenceDone"; requestId: number; reference: RawReferenceResult }
        | { type: "defaultIterDone"; requestId: number; estimate: DefaultIterEstimate }
        | { type: "referenceError"; requestId: number; message: string };
      this.handleMessage(worker, data);
    };
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

  private handleMessage(
    worker: Worker,
    data:
      | { type: "referenceDone"; requestId: number; reference: RawReferenceResult }
      | { type: "defaultIterDone"; requestId: number; estimate: DefaultIterEstimate }
      | { type: "referenceError"; requestId: number; message: string }
  ): void {
    const pending = this.inFlight.get(worker);
    if (!pending) return;
    this.inFlight.delete(worker);
    this.idle.push(worker);
    if (data.type === "referenceDone" && pending.type === "computeReference") {
      pending.resolve({
        ...data.reference,
        orbitRe: data.reference.orbitRe instanceof Float64Array ? data.reference.orbitRe : Float64Array.from(data.reference.orbitRe),
        orbitIm: data.reference.orbitIm instanceof Float64Array ? data.reference.orbitIm : Float64Array.from(data.reference.orbitIm)
      });
    } else if (data.type === "defaultIterDone" && pending.type === "estimateDefaultIter") {
      pending.resolve(data.estimate);
    } else {
      pending.reject(new Error(data.type === "referenceError" ? data.message : "Reference worker returned mismatched response"));
    }
    this.pump();
  }

  private handleError(worker: Worker, error: Error): void {
    const pending = this.inFlight.get(worker);
    if (pending) {
      this.inFlight.delete(worker);
      pending.reject(error);
    }
    this.idle.push(worker);
    this.pump();
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop();
      const pending = this.queue.shift();
      if (!worker || !pending) break;
      this.inFlight.set(worker, pending);
      if (pending.type === "computeReference") {
        worker.postMessage({
          type: "computeReference",
          requestId: pending.requestId,
          centerRe: pending.centerRe,
          centerIm: pending.centerIm,
          scale: pending.scale,
          maxIter: pending.maxIter,
          minPrecisionBits: pending.minPrecisionBits
        });
      } else {
        worker.postMessage({
          type: "estimateDefaultIter",
          requestId: pending.requestId,
          re: pending.re,
          im: pending.im,
          scale: pending.scale,
          width: pending.width,
          height: pending.height,
          baseline: pending.baseline,
          phase: pending.phase
        });
      }
    }
  }
}

export function resolveReferenceWorkerCount(hardwareConcurrency = globalThis.navigator?.hardwareConcurrency ?? 4): number {
  return Math.min(2, Math.max(1, Math.floor(hardwareConcurrency / 4)));
}
