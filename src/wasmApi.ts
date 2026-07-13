import init, { apply_view_transform } from "./wasm/pkg/mandelbrot_wasm";
import type { ViewState } from "./types";

let wasmReady: Promise<void> | undefined;

export async function initWasm(): Promise<void> {
  wasmReady ??= init().then(() => undefined);
  await wasmReady;
}

export function transformViewNow(
  view: ViewState,
  width: number,
  height: number,
  panX: number,
  panY: number,
  zoomFactor: number,
  anchorX: number,
  anchorY: number
): ViewState {
  const next = apply_view_transform(
    { re: view.re, im: view.im, scale: view.scale, width, height },
    panX,
    panY,
    zoomFactor,
    anchorX,
    anchorY
  ) as { re: string; im: string; scale: string };
  return { re: next.re, im: next.im, scale: next.scale, maxIter: view.maxIter };
}
