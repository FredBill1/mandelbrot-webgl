import type { ReferenceSnapshot, RuntimeView, TileDescriptor } from "../types";
import { ReferenceClient } from "./referenceClient";

interface ReferenceKey {
  centerRe: string;
  centerIm: string;
  maxIter: number;
  precisionBits: number;
}

export class ReferenceManager {
  private readonly references = new Map<string, ReferenceSnapshot>();
  private currentViewReference: ReferenceSnapshot | undefined;
  private sequence = 0;

  constructor(private readonly client = new ReferenceClient()) {}

  get size(): number {
    return this.references.size;
  }

  get entries(): ReferenceSnapshot[] {
    return [...this.references.values()];
  }

  async ensureViewReference(view: RuntimeView): Promise<ReferenceSnapshot> {
    const reference = await this.ensureReference({
      centerRe: view.re,
      centerIm: view.im,
      screenX: view.width * 0.5,
      screenY: view.height * 0.5,
      scale: view.scale,
      maxIter: view.maxIter,
      revision: view.revision,
      minPrecisionBits: 128
    });
    this.currentViewReference = reference;
    return reference;
  }

  async ensureTileReference(view: RuntimeView, tile: TileDescriptor, minPrecisionBits: number): Promise<ReferenceSnapshot> {
    return this.ensureReference({
      centerRe: tile.centerRe,
      centerIm: tile.centerIm,
      screenX: tile.centerScreenX,
      screenY: tile.centerScreenY,
      scale: view.scale,
      maxIter: view.maxIter,
      revision: view.revision,
      minPrecisionBits
    });
  }

  selectBest(tile: TileDescriptor, maxIter: number, revision: number): ReferenceSnapshot | undefined {
    let best: ReferenceSnapshot | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const reference of this.references.values()) {
      if (reference.maxIter !== maxIter || reference.revision !== revision) continue;
      const distance = Math.hypot(tile.centerScreenX - reference.screenX, tile.centerScreenY - reference.screenY);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = reference;
      }
    }
    if (best && bestDistance <= 768) return best;
    return this.currentViewReference?.revision === revision ? this.currentViewReference : best;
  }

  dispose(): void {
    this.client.dispose();
  }

  private async ensureReference(input: {
    centerRe: string;
    centerIm: string;
    screenX: number;
    screenY: number;
    scale: string;
    maxIter: number;
    revision: number;
    minPrecisionBits: number;
  }): Promise<ReferenceSnapshot> {
    const roughKey: ReferenceKey = {
      centerRe: input.centerRe,
      centerIm: input.centerIm,
      maxIter: input.maxIter,
      precisionBits: input.minPrecisionBits
    };
    const existing = this.references.get(referenceKey(roughKey));
    if (existing) {
      existing.screenX = input.screenX;
      existing.screenY = input.screenY;
      existing.revision = input.revision;
      return existing;
    }

    const raw = await this.client.compute(input.centerRe, input.centerIm, input.scale, input.maxIter, input.minPrecisionBits);
    const snapshot: ReferenceSnapshot = {
      id: `ref-${++this.sequence}`,
      centerRe: raw.centerRe,
      centerIm: raw.centerIm,
      screenX: input.screenX,
      screenY: input.screenY,
      precisionBits: raw.precisionBits,
      escapedAt: raw.escapedAt,
      maxIter: input.maxIter,
      revision: input.revision,
      orbitRe: raw.orbitRe,
      orbitIm: raw.orbitIm
    };
    this.references.set(
      referenceKey({
        centerRe: snapshot.centerRe,
        centerIm: snapshot.centerIm,
        maxIter: snapshot.maxIter,
        precisionBits: input.minPrecisionBits
      }),
      snapshot
    );
    this.trim(input.revision);
    return snapshot;
  }

  private trim(currentRevision: number): void {
    for (const [key, reference] of this.references.entries()) {
      if (reference.revision < currentRevision - 2) this.references.delete(key);
    }
    while (this.references.size > 48) {
      const first = this.references.keys().next().value as string | undefined;
      if (!first) break;
      this.references.delete(first);
    }
  }
}

function referenceKey(key: ReferenceKey): string {
  return `${key.centerRe}|${key.centerIm}|${key.maxIter}|${key.precisionBits}`;
}
