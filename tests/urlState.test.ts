import { describe, expect, it } from "vitest";
import { parseViewFromUrl, serializeViewToQuery } from "../src/state/urlState";

describe("url state", () => {
  it("round-trips view parameters", () => {
    const url = new URL("https://example.test/?re=-7.5e-1&im=1.25e-1&scale=1e100&iter=6912");
    const view = parseViewFromUrl(url);
    expect(view).toEqual({ re: "-7.5e-1", im: "1.25e-1", scale: "1e100", maxIter: 6912 });
    expect(serializeViewToQuery(view)).toBe("?re=-7.5e-1&im=1.25e-1&scale=1e100&iter=6912");
  });

  it("falls back on invalid values", () => {
    const view = parseViewFromUrl(new URL("https://example.test/?re=nope&scale=-2&iter=1"));
    expect(view.re).toBe("-5e-1");
    expect(view.scale).toBe("1");
    expect(view.maxIter).toBeGreaterThanOrEqual(512);
  });
});
