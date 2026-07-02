import { REFERENCE_CACHE_SOFT_BYTES, type ReferenceSnapshot, type RuntimeView, type TileDescriptor } from "../types";
import { ReferenceClient } from "./referenceClient";

interface ReferenceKey {
  centerRe: string;
  centerIm: string;
  maxIter: number;
  precisionBits: number;
}

export class ReferenceManager {
  private readonly references = new Map<string, ReferenceSnapshot>();
  private readonly pendingReferences = new Map<string, Promise<ReferenceSnapshot>>();
  private readonly pinnedReferenceIds = new Set<string>();
  private currentViewReference: ReferenceSnapshot | undefined;
  private sequence = 0;

  constructor(private readonly client = new ReferenceClient()) {}

  get size(): number {
    return this.references.size;
  }

  get entries(): ReferenceSnapshot[] {
    return [...this.references.values()];
  }

  get bytes(): number {
    let total = 0;
    for (const reference of this.references.values()) total += referenceBytes(reference);
    return total;
  }

  getById(id: string): ReferenceSnapshot | undefined {
    return this.entries.find((reference) => reference.id === id);
  }

  setPinnedReferenceIds(ids: Iterable<string>): void {
    this.pinnedReferenceIds.clear();
    for (const id of ids) this.pinnedReferenceIds.add(id);
    this.trim(this.currentViewReference?.revision ?? 0);
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
    return this.referenceCandidatesWithDistance(tile, maxIter, revision)
      .sort((a, b) => {
        const completeDelta = Number(b.reference.escapedAt >= maxIter) - Number(a.reference.escapedAt >= maxIter);
        if (completeDelta !== 0) return completeDelta;
        const escapedDelta = b.reference.escapedAt - a.reference.escapedAt;
        if (escapedDelta !== 0) return escapedDelta;
        return a.distance - b.distance;
      })[0]?.reference;
  }

  selectCandidates(tile: TileDescriptor, maxIter: number, revision: number, maxCount: number): ReferenceSnapshot[] {
    const candidates = this.referenceCandidatesWithDistance(tile, maxIter, revision);
    if (candidates.length === 0) {
      return this.currentViewReference?.revision === revision ? [this.currentViewReference] : [];
    }

    const byOrbit = [...candidates].sort((a, b) => {
      const completeDelta = Number(b.reference.escapedAt >= maxIter) - Number(a.reference.escapedAt >= maxIter);
      if (completeDelta !== 0) return completeDelta;
      const escapedDelta = b.reference.escapedAt - a.reference.escapedAt;
      if (escapedDelta !== 0) return escapedDelta;
      return a.distance - b.distance;
    });
    const byDistance = [...candidates].sort((a, b) => a.distance - b.distance);

    const selected = new Map<string, ReferenceSnapshot>();
    for (const entry of byDistance.slice(0, Math.max(1, Math.ceil(maxCount * 0.6)))) selected.set(entry.reference.id, entry.reference);
    for (const entry of byOrbit) {
      selected.set(entry.reference.id, entry.reference);
      if (selected.size >= maxCount) break;
    }
    for (const entry of byDistance) {
      selected.set(entry.reference.id, entry.reference);
      if (selected.size >= maxCount) break;
    }
    return [...selected.values()].slice(0, maxCount);
  }

  findReusableNear(
    screenX: number,
    screenY: number,
    radiusPx: number,
    maxIter: number,
    revision: number,
    minPrecisionBits: number
  ): ReferenceSnapshot | undefined {
    let best: { reference: ReferenceSnapshot; distance: number } | undefined;
    for (const reference of this.references.values()) {
      if (reference.revision !== revision || reference.maxIter !== maxIter || reference.precisionBits < minPrecisionBits) continue;
      const distance = Math.hypot(reference.screenX - screenX, reference.screenY - screenY);
      if (distance > radiusPx) continue;
      if (!best || reference.escapedAt > best.reference.escapedAt || (reference.escapedAt === best.reference.escapedAt && distance < best.distance)) {
        best = { reference, distance };
      }
    }
    return best?.reference;
  }

  estimateDefaultIter(input: { re: string; im: string; scale: string; width: number; height: number; baseline: number }): Promise<number> {
    return this.client.estimateDefaultIter(input);
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
    const satisfying = this.findSatisfyingReference(input.centerRe, input.centerIm, input.maxIter, input.minPrecisionBits);
    if (satisfying) {
      satisfying.screenX = input.screenX;
      satisfying.screenY = input.screenY;
      satisfying.revision = input.revision;
      return satisfying;
    }

    const roughKey: ReferenceKey = {
      centerRe: input.centerRe,
      centerIm: input.centerIm,
      maxIter: input.maxIter,
      precisionBits: input.minPrecisionBits
    };
    const key = referenceKey(roughKey);
    const pending = this.pendingReferences.get(key);
    if (pending) {
      const reference = await pending;
      reference.screenX = input.screenX;
      reference.screenY = input.screenY;
      reference.revision = input.revision;
      return reference;
    }

    const promise = this.client
      .compute(input.centerRe, input.centerIm, input.scale, input.maxIter, input.minPrecisionBits)
      .then((raw) => {
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
      })
      .finally(() => {
        this.pendingReferences.delete(key);
      });
    this.pendingReferences.set(key, promise);
    return promise;
  }

  private findSatisfyingReference(
    centerRe: string,
    centerIm: string,
    maxIter: number,
    minPrecisionBits: number
  ): ReferenceSnapshot | undefined {
    return this.entries.find(
      (reference) =>
        reference.centerRe === centerRe &&
        reference.centerIm === centerIm &&
        reference.maxIter === maxIter &&
        reference.precisionBits >= minPrecisionBits
    );
  }

  private referenceCandidatesWithDistance(tile: TileDescriptor, maxIter: number, revision: number): Array<{ reference: ReferenceSnapshot; distance: number }> {
    return this.entries
      .filter((reference) => reference.maxIter === maxIter && reference.revision === revision)
      .map((reference) => ({
        reference,
        distance: Math.hypot(tile.centerScreenX - reference.screenX, tile.centerScreenY - reference.screenY)
      }));
  }

  private trim(currentRevision: number): void {
    for (const [key, reference] of this.references.entries()) {
      if (reference.revision < currentRevision - 2 && !this.pinnedReferenceIds.has(reference.id)) this.references.delete(key);
    }
    while (this.bytes > REFERENCE_CACHE_SOFT_BYTES) {
      let deleted = false;
      for (const [key, reference] of this.references.entries()) {
        if (this.pinnedReferenceIds.has(reference.id)) continue;
        this.references.delete(key);
        deleted = true;
        break;
      }
      if (!deleted) break;
    }
  }
}

function referenceKey(key: ReferenceKey): string {
  return `${key.centerRe}|${key.centerIm}|${key.maxIter}|${key.precisionBits}`;
}

function referenceBytes(reference: ReferenceSnapshot): number {
  return reference.orbitRe.byteLength + reference.orbitIm.byteLength;
}
