import {
  computeReferenceWasm,
  prepareTilesWasm,
  prepareReferenceWasm,
  renderPerturbationTileWasm,
  warmupWasm
} from "./wasmPerturbation";
import type { TileWorkerInMessage, TileWorkerOutMessage, WorkerErrorMessage } from "../types";

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
    void warmupWasm(event.data.module).then(() => self.postMessage({ type: "warmupDone" })).catch(postWorkerError);
    return;
  }
  if (event.data.type === "prepareReference") {
    const revision = event.data.reference.revision;
    void prepareReferenceWasm(event.data.reference).then(() => {
      self.postMessage({ type: "referencePrepared", revision });
    }).catch(postWorkerError);
    return;
  }
  if (event.data.type === "computeReference") {
    const request = event.data;
    void computeReferenceWasm(request).then((reference) => {
      self.postMessage({ type: "referenceDone", requestId: request.requestId, reference }, [reference.orbitRe.buffer, reference.orbitIm.buffer]);
    }).catch(postWorkerError);
    return;
  }
  if (event.data.type === "prepareTiles") {
    void prepareTilesWasm(event.data).then((result) => {
      self.postMessage(result satisfies TileWorkerOutMessage, [
        result.derivativeEagerScores.buffer,
        result.seriesSkips.buffer
      ]);
    }).catch(postWorkerError);
    return;
  }
  if (event.data.type !== "renderTile") return;
  void renderPerturbationTileWasm(event.data).then((result) => {
    self.postMessage(result satisfies TileWorkerOutMessage, [result.rgba]);
  }).catch(postWorkerError);
};

function postWorkerError(error: unknown): void {
  self.postMessage({
    type: "workerError",
    message: error instanceof Error ? error.message : String(error)
  } satisfies WorkerErrorMessage);
}
