import type { ReferenceSnapshot, RuntimeView } from "../types";
import type { ReferenceComputer } from "./referenceClient";

export class ReferenceManager {
  private currentViewReference: ReferenceSnapshot | undefined;
  private pendingReference: Promise<ReferenceSnapshot> | undefined;
  private pendingKey = "";
  private sequence = 0;
  private activeRevision = 0;

  constructor(private readonly client: ReferenceComputer) {}

  get size(): number {
    return this.currentViewReference ? 1 : 0;
  }

  async ensureViewReference(view: RuntimeView, priority = 0): Promise<ReferenceSnapshot> {
    this.activeRevision = view.revision;
    const key = `${view.re}|${view.im}|${view.scale}|${view.maxIter}|${view.revision}`;
    if (
      this.currentViewReference?.revision === view.revision &&
      this.currentViewReference.centerRe === view.re &&
      this.currentViewReference.centerIm === view.im &&
      this.currentViewReference.maxIter === view.maxIter
    ) {
      return this.currentViewReference;
    }
    if (this.pendingReference && this.pendingKey === key) return this.pendingReference;

    this.pendingKey = key;
    const pending = this.client.compute(view.re, view.im, view.scale, view.maxIter, 128, {
      revision: view.revision,
      priority,
      kind: "viewReference"
    }).then((raw) => {
      const snapshot: ReferenceSnapshot = {
        id: `ref-${++this.sequence}`,
        centerRe: raw.centerRe,
        centerIm: raw.centerIm,
        screenX: view.width * 0.5,
        screenY: view.height * 0.5,
        precisionBits: raw.precisionBits,
        escapedAt: raw.escapedAt,
        maxIterBoundedRadius: raw.maxIterBoundedRadius,
        maxIter: view.maxIter,
        revision: view.revision,
        orbitRe: raw.orbitRe,
        orbitIm: raw.orbitIm
      };
      if (snapshot.revision === this.activeRevision) this.currentViewReference = snapshot;
      return snapshot;
    }).finally(() => {
      if (this.pendingReference === pending) {
        this.pendingReference = undefined;
        this.pendingKey = "";
      }
    });
    this.pendingReference = pending;
    return pending;
  }

  cancelObsoleteWork(currentRevision: number): void {
    this.activeRevision = currentRevision;
    this.client.cancelObsoleteWork(currentRevision);
    if (this.currentViewReference?.revision !== currentRevision) this.currentViewReference = undefined;
    this.pendingReference = undefined;
    this.pendingKey = "";
  }

  dispose(): void {
    this.client.dispose();
  }
}
