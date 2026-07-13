import { computeReferenceWasm, renderPerturbationTileWasm } from "./wasmPerturbation";
import type { RenderTileMessage, TileWorkerOutMessage } from "../types";

interface ComputeReferenceMessage {
  type: "computeReference";
  requestId: number;
  centerRe: string;
  centerIm: string;
  scale: string;
  maxIter: number;
  minPrecisionBits: number;
}

self.onmessage = (event: MessageEvent<RenderTileMessage | ComputeReferenceMessage>) => {
  if (event.data.type === "computeReference") {
    const request = event.data;
    void computeReferenceWasm(request).then((reference) => {
      self.postMessage({ type: "referenceDone", requestId: request.requestId, reference }, [reference.orbitRe.buffer, reference.orbitIm.buffer]);
    }).catch((error) => {
      self.postMessage({ type: "referenceError", requestId: request.requestId, message: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  void renderPerturbationTileWasm(event.data).then((result) => {
    self.postMessage(result satisfies TileWorkerOutMessage, [result.rgba]);
  });
};
