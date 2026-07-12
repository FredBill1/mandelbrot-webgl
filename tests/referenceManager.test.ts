import { describe, expect, it, vi } from "vitest";
import { ReferenceManager } from "../src/reference/referenceManager";
import type { RawReferenceResult, ReferenceClient } from "../src/reference/referenceClient";
import type { RuntimeView } from "../src/types";

describe("ReferenceManager", () => {
  it("keeps exactly one view reference for the active revision", async () => {
    const client = makeClient();
    const manager = new ReferenceManager(client);
    const first = await manager.ensureViewReference(makeView(1));
    const second = await manager.ensureViewReference({ ...makeView(2), re: "-0.5" });

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(manager.size).toBe(1);
    expect(client.compute).toHaveBeenCalledTimes(2);
  });

  it("deduplicates an identical pending view reference", async () => {
    let release: (() => void) | undefined;
    const client = {
      compute: vi.fn(async (re: string, im: string, _scale: string, maxIter: number, precisionBits: number) => {
        await new Promise<void>((resolve) => { release = resolve; });
        return makeRawReference(re, im, maxIter, precisionBits);
      }),
      cancelObsoleteWork: vi.fn(),
      dispose: vi.fn()
    } as unknown as ReferenceClient;
    const manager = new ReferenceManager(client);
    const view = makeView(1);
    const first = manager.ensureViewReference(view);
    const second = manager.ensureViewReference(view);
    release?.();

    expect(await first).toBe(await second);
    expect(client.compute).toHaveBeenCalledTimes(1);
    expect(manager.size).toBe(1);
  });

  it("drops an obsolete cached reference immediately", async () => {
    const client = makeClient();
    const manager = new ReferenceManager(client);
    await manager.ensureViewReference(makeView(1));
    manager.cancelObsoleteWork(2);

    expect(manager.size).toBe(0);
    expect(client.cancelObsoleteWork).toHaveBeenCalledWith(2);
  });

  it("reuses the active view reference", async () => {
    const client = makeClient();
    const manager = new ReferenceManager(client);
    const view = makeView(1);
    const first = await manager.ensureViewReference(view);
    const second = await manager.ensureViewReference(view);

    expect(second).toBe(first);
    expect(client.compute).toHaveBeenCalledTimes(1);
  });
});

function makeClient(): ReferenceClient {
  return {
    compute: vi.fn(async (re: string, im: string, _scale: string, maxIter: number, precisionBits: number) =>
      makeRawReference(re, im, maxIter, precisionBits)),
    cancelObsoleteWork: vi.fn(),
    dispose: vi.fn()
  } as unknown as ReferenceClient;
}

function makeRawReference(re: string, im: string, maxIter: number, precisionBits: number): RawReferenceResult {
  return {
    centerRe: re,
    centerIm: im,
    precisionBits,
    escapedAt: maxIter,
    maxIterBoundedRadius: 0,
    orbitRe: new Float64Array(maxIter + 1),
    orbitIm: new Float64Array(maxIter + 1)
  };
}

function makeView(revision: number): RuntimeView {
  return {
    re: "-0.75",
    im: "0.05",
    scale: "1024",
    maxIter: 64,
    width: 1280,
    height: 720,
    pixelRatio: 1,
    revision
  };
}
