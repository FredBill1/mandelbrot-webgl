import { describe, expect, it, vi } from "vitest";
import { ReferenceManager } from "../src/reference/referenceManager";
import type { RawReferenceResult, ReferenceClient } from "../src/reference/referenceClient";
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
  });
});

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
