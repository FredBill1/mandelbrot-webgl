import {
  computeReferenceWasm,
  prepareReferenceWasm,
  renderPerturbationTileWasm,
  warmupWasm
} from "./wasmPerturbation";
import type { TileWorkerInMessage, TileWorkerOutMessage } from "../types";

interface ComputeReferenceMessage {
  type: "computeReference";
  requestId: number;
  centerRe: string;
  centerIm: string;
  scale: string;
  maxIter: number;
  minPrecisionBits: number;
}

self.onmessage = (event: MessageEvent<TileWorkerInMessage | ComputeReferenceMessage>) => {
  if (event.data.type === "warmup") {
    void warmupWasm().then(() => self.postMessage({ type: "warmupDone" }));
    return;
  }
  if (event.data.type === "prepareReference") {
    const revision = event.data.reference.revision;
    void prepareReferenceWasm(event.data.reference).then(() => {
      self.postMessage({ type: "referencePrepared", revision });
    });
    return;
  }
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
