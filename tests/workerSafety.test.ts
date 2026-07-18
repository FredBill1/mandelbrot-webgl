import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderPriorityWave, resolveWorkerCount } from "../src/scheduler/workerPool";
import { supportsWasmSimd, WASM_SIMD_REQUIRED_MESSAGE } from "../src/wasmSimd";

describe("worker safety", () => {
  it("caps tile worker oversubscription", () => {
    expect(resolveWorkerCount(1)).toBe(1);
    expect(resolveWorkerCount(12)).toBe(12);
    expect(resolveWorkerCount(16)).toBe(16);
    expect(resolveWorkerCount(3.8)).toBe(3);
  });

  it("does not use cross-origin isolated shared buffers in source", () => {
    const forbidden = "Shared" + "ArrayBuffer";
    const files = collectSourceFiles("src").filter((file) => !file.includes(`${join("src", "wasm", "pkg")}`));
    const offenders = files.filter((file) => readFileSync(file, "utf8").includes(forbidden));
    expect(offenders).toEqual([]);
  });

  it("requires WebAssembly SIMD before workers are constructed", () => {
    expect(supportsWasmSimd(() => true)).toBe(true);
    expect(supportsWasmSimd(() => false)).toBe(false);
    expect(supportsWasmSimd(() => { throw new Error("unavailable"); })).toBe(false);
    expect(WASM_SIMD_REQUIRED_MESSAGE).toContain("WebAssembly SIMD");
  });

  it("keeps cache affinity inside one center-first worker wave", () => {
    expect([0, 15, 16, 31, 32].map((priority) => renderPriorityWave(priority, 16))).toEqual([0, 0, 1, 1, 2]);
    expect(renderPriorityWave(8, 0)).toBe(8);
  });
});

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...collectSourceFiles(path));
    else if (/\.(ts|tsx|rs|js|css|html)$/.test(path)) out.push(path);
  }
  return out;
}
