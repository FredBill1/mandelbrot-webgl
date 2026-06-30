import { describe, expect, it, vi } from "vitest";
import { ReferenceManager } from "../src/reference/referenceManager";
import { resolveReferenceWorkerCount, type RawReferenceResult, type ReferenceClient } from "../src/reference/referenceClient";
import type { RuntimeView, TileDescriptor } from "../src/types";

describe("ReferenceManager", () => {
  it("prefers a complete reference orbit over a nearer early-escaped reference", async () => {
    const maxIter = 256;
    const client = {
      compute: vi.fn(async (centerRe: string, centerIm: string, _scale: string, requestedMaxIter: number, minPrecisionBits: number) => {
        const escapedAt = centerRe === "complete" ? requestedMaxIter : 32;
        return {
          centerRe,
          centerIm,
          precisionBits: minPrecisionBits,
          escapedAt,
          orbitRe: new Float64Array(escapedAt + 1),
          orbitIm: new Float64Array(escapedAt + 1)
        } satisfies RawReferenceResult;
      }),
      dispose: vi.fn()
    } as unknown as ReferenceClient;
    const manager = new ReferenceManager(client);
    const view = makeView(maxIter);
    const nearShort = makeTile("short", 120, 120);
    const fartherComplete = makeTile("complete", 900, 500);

    await manager.ensureTileReference(view, nearShort, 128);
    await manager.ensureTileReference(view, fartherComplete, 128);

    const selected = manager.selectBest(nearShort, maxIter, view.revision);
    expect(selected?.centerRe).toBe("complete");
    expect(manager.selectCandidates(nearShort, maxIter, view.revision, 2).map((reference) => reference.centerRe)).toEqual(["short", "complete"]);
  });

  it("does not evict references just because the count exceeds 128", async () => {
    const maxIter = 16;
    const client = makeClient(maxIter);
    const manager = new ReferenceManager(client);
    const view = makeView(maxIter);

    for (let i = 0; i < 140; i += 1) {
      await manager.ensureTileReference(view, makeTile(`ref-${i}`, i, i), 128);
    }

    expect(manager.size).toBe(140);
    expect(manager.bytes).toBeLessThan(128 * 1024 * 1024);
  });

  it("keeps pinned active references when trimming old revisions", async () => {
    const maxIter = 16;
    const client = makeClient(maxIter);
    const manager = new ReferenceManager(client);
    const oldView = makeView(maxIter);
    const oldReference = await manager.ensureTileReference(oldView, makeTile("old", 100, 100), 128);
    manager.setPinnedReferenceIds([oldReference.id]);

    await manager.ensureViewReference({ ...oldView, re: "new", revision: 5 });

    expect(manager.getById(oldReference.id)?.centerRe).toBe("old");
  });

  it("deduplicates identical pending reference computations", async () => {
    const maxIter = 64;
    let release: (() => void) | undefined;
    const client = {
      compute: vi.fn(
        async (centerRe: string, centerIm: string, _scale: string, requestedMaxIter: number, minPrecisionBits: number) => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return makeRawReference(centerRe, centerIm, requestedMaxIter, minPrecisionBits);
        }
      ),
      dispose: vi.fn()
    } as unknown as ReferenceClient;
    const manager = new ReferenceManager(client);
    const view = makeView(maxIter);
    const tile = makeTile("same", 100, 100);

    const first = manager.ensureTileReference(view, tile, 160);
    const second = manager.ensureTileReference(view, tile, 160);
    release?.();

    expect(await first).toBe(await second);
    expect(client.compute).toHaveBeenCalledTimes(1);
  });

  it("reuses a higher precision reference for lower precision requests", async () => {
    const maxIter = 64;
    const client = makeClient(maxIter);
    const manager = new ReferenceManager(client);
    const view = makeView(maxIter);
    const tile = makeTile("precise", 100, 100);

    const high = await manager.ensureTileReference(view, tile, 256);
    const low = await manager.ensureTileReference(view, tile, 128);

    expect(low).toBe(high);
    expect(client.compute).toHaveBeenCalledTimes(1);
  });

  it("caps reference worker count to a small CPU fraction", () => {
    expect(resolveReferenceWorkerCount(1)).toBe(1);
    expect(resolveReferenceWorkerCount(8)).toBe(2);
    expect(resolveReferenceWorkerCount(16)).toBe(4);
    expect(resolveReferenceWorkerCount(64)).toBe(4);
  });
});

function makeClient(maxIter: number): ReferenceClient {
  return {
    compute: vi.fn(async (centerRe: string, centerIm: string, _scale: string, requestedMaxIter: number, minPrecisionBits: number) => {
      return makeRawReference(centerRe, centerIm, requestedMaxIter, minPrecisionBits, centerRe === "complete" ? requestedMaxIter : Math.min(maxIter, 32));
    }),
    dispose: vi.fn()
  } as unknown as ReferenceClient;
}

function makeRawReference(
  centerRe: string,
  centerIm: string,
  maxIter: number,
  precisionBits: number,
  escapedAt = maxIter
): RawReferenceResult {
  return {
    centerRe,
    centerIm,
    precisionBits,
    escapedAt,
    orbitRe: new Float64Array(escapedAt + 1),
    orbitIm: new Float64Array(escapedAt + 1)
  };
}

function makeView(maxIter: number): RuntimeView {
  return {
    re: "-0.75",
    im: "0.05",
    scale: "1024",
    maxIter,
    width: 1280,
    height: 720,
    pixelRatio: 1,
    revision: 1
  };
}

function makeTile(centerRe: string, centerScreenX: number, centerScreenY: number): TileDescriptor {
  return {
    id: centerRe,
    key: { level: 0, x: 0, y: 0, span: 128 },
    rect: { x: centerScreenX - 64, y: centerScreenY - 64, width: 128, height: 128 },
    centerScreenX,
    centerScreenY,
    centerRe,
    centerIm: "0",
    revision: 1
  };
}
