import { describe, expect, it } from "vitest";
import { LruCache } from "../src/cache/lru";

describe("lru cache", () => {
  it("evicts least recently used entries by byte budget", () => {
    const evicted: string[] = [];
    const cache = new LruCache<string, number>(10, (key) => evicted.push(key));
    cache.set("a", 1, 4);
    cache.set("b", 2, 4);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3, 4);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(evicted).toEqual(["b"]);
  });
});
