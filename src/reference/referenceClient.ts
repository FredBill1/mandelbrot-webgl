interface PendingReference {
  resolve: (value: RawReferenceResult) => void;
  reject: (reason: Error) => void;
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
  private readonly worker = new Worker(new URL("../workers/referenceWorker.ts", import.meta.url), { type: "module" });
  private readonly pending = new Map<number, PendingReference>();
  private requestId = 0;

  constructor() {
    this.worker.onmessage = (event: MessageEvent) => {
      const data = event.data as
        | { type: "referenceDone"; requestId: number; reference: RawReferenceResult }
        | { type: "referenceError"; requestId: number; message: string };
      const pending = this.pending.get(data.requestId);
      if (!pending) return;
      this.pending.delete(data.requestId);
      if (data.type === "referenceDone") {
        pending.resolve({
          ...data.reference,
          orbitRe: data.reference.orbitRe instanceof Float64Array ? data.reference.orbitRe : Float64Array.from(data.reference.orbitRe),
          orbitIm: data.reference.orbitIm instanceof Float64Array ? data.reference.orbitIm : Float64Array.from(data.reference.orbitIm)
        });
      } else {
        pending.reject(new Error(data.message));
      }
    };
  }

  compute(centerRe: string, centerIm: string, scale: string, maxIter: number, minPrecisionBits = 128): Promise<RawReferenceResult> {
    const requestId = ++this.requestId;
    const promise = new Promise<RawReferenceResult>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });
    this.worker.postMessage({
      type: "computeReference",
      requestId,
      centerRe,
      centerIm,
      scale,
      maxIter,
      minPrecisionBits
    });
    return promise;
  }

  dispose(): void {
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error("Reference worker terminated"));
    this.pending.clear();
  }
}
