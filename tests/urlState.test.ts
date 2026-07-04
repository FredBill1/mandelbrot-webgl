import { describe, expect, it } from "vitest";
import { parseViewFromUrl, parseViewStateFromUrl, serializeViewToQuery } from "../src/state/urlState";

describe("url state", () => {
  it("parses legacy iter links as fixed iteration mode", () => {
    const url = new URL("https://example.test/?re=-7.5e-1&im=1.25e-1&scale=1e100&iter=6912");
    const parsed = parseViewStateFromUrl(url);

    expect(parseViewFromUrl(url)).toEqual({ re: "-7.5e-1", im: "1.25e-1", scale: "1e100", maxIter: 6912 });
    expect(parsed.iterSettings.mode).toBe("fixed");
    expect(parsed.iterSettings.fixedIter).toBe(6912);
    expect(serializeViewToQuery(parsed.view, { iterSettings: parsed.iterSettings })).toBe(
      "?re=-7.5e-1&im=1.25e-1&scale=1e100&iter=6912"
    );
  });

  it("omits default formula iteration parameters", () => {
    const parsed = parseViewStateFromUrl(new URL("https://example.test/?re=-7.5e-1&im=1.25e-1&scale=1e100"));

    expect(parsed.iterSettings.mode).toBe("default");
    expect(parsed.view.maxIter).toBe(6912);
    expect(serializeViewToQuery(parsed.view, { iterSettings: parsed.iterSettings })).toBe("?re=-7.5e-1&im=1.25e-1&scale=1e100");
  });

  it("round-trips non-default formula parameters", () => {
    const parsed = parseViewStateFromUrl(
      new URL("https://example.test/?re=-7.5e-1&im=1.25e-1&scale=1e10&iterBase=640&iterSlope=96&iterCap=12000")
    );

    expect(parsed.iterSettings.mode).toBe("default");
    expect(parsed.iterSettings.formula).toEqual({ base: 640, slope: 96, cap: 12000 });
    expect(parsed.view.maxIter).toBe(1600);
    expect(serializeViewToQuery(parsed.view, { iterSettings: parsed.iterSettings })).toBe(
      "?re=-7.5e-1&im=1.25e-1&scale=1e10&iterBase=640&iterSlope=96&iterCap=12000"
    );
  });

  it("falls back on invalid values", () => {
    const view = parseViewFromUrl(new URL("https://example.test/?re=nope&scale=-2&iter=1"));
    expect(view.re).toBe("-5e-1");
    expect(view.scale).toBe("1");
    expect(view.maxIter).toBeGreaterThanOrEqual(512);
  });
});
