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

  it("evicts the previous value when replacing an existing key", () => {
    const evicted: Array<[string, number]> = [];
    const cache = new LruCache<string, number>(10, (key, value) => evicted.push([key, value]));
    cache.set("tile", 1, 4);
    cache.set("tile", 2, 4);

    expect(cache.get("tile")).toBe(2);
    expect(cache.bytes).toBe(4);
    expect(evicted).toEqual([["tile", 1]]);
  });
});
