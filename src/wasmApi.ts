import init, { apply_view_transform } from "./wasm/pkg/mandelbrot_wasm";
import wasmUrl from "./wasm/pkg/mandelbrot_wasm_bg.wasm?url";
import type { ViewState } from "./types";

let wasmReady: Promise<void> | undefined;
let wasmModuleReady: Promise<WebAssembly.Module> | undefined;

export function compileWasmModule(): Promise<WebAssembly.Module> {
  wasmModuleReady ??= WebAssembly.compileStreaming(fetch(wasmUrl));
  return wasmModuleReady;
}

export async function initWasm(module?: WebAssembly.Module): Promise<void> {
  wasmReady ??= (module === undefined ? compileWasmModule() : Promise.resolve(module))
    .then((compiled) => init({ module_or_path: compiled }))
    .then(() => undefined);
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
