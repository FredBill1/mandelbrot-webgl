import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkerCount } from "../src/scheduler/workerPool";

describe("worker safety", () => {
  it("caps tile worker oversubscription", () => {
    expect(resolveWorkerCount(1)).toBe(1);
    expect(resolveWorkerCount(12)).toBe(24);
    expect(resolveWorkerCount(16)).toBe(32);
    expect(resolveWorkerCount(3.8)).toBe(7);
  });

  it("does not use cross-origin isolated shared buffers in source", () => {
    const forbidden = "Shared" + "ArrayBuffer";
    const files = collectSourceFiles("src").filter((file) => !file.includes(`${join("src", "wasm", "pkg")}`));
    const offenders = files.filter((file) => readFileSync(file, "utf8").includes(forbidden));
    expect(offenders).toEqual([]);
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
