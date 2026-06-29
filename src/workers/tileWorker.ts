import { renderPerturbationTile } from "./perturbation";
import type { NeedReferenceMessage, RenderTileMessage, TileWorkerOutMessage } from "../types";

self.onmessage = (event: MessageEvent<RenderTileMessage>) => {
  if (event.data.type !== "renderTile") return;
  const result = renderPerturbationTile(event.data);
  if (result.needsReference) {
    const maxPrecision = event.data.references.reduce((bits, reference) => Math.max(bits, reference.precisionBits), 128);
    const sourceReferenceId = result.stats.referenceIdsUsed[0] ?? event.data.references[0]?.id ?? "";
    for (const cluster of result.stats.unresolvedClusters.slice(0, 4)) {
      const request: NeedReferenceMessage = {
        type: "needReference",
        tile: event.data.tile,
        requiredPrecision: maxPrecision + 32,
        maxIter: event.data.maxIter,
        targetScreenX: cluster.screenX,
        targetScreenY: cluster.screenY,
        refinementLevel: event.data.refinementLevel + 1,
        sourceReferenceId
      };
      self.postMessage(request satisfies TileWorkerOutMessage);
    }
  }
  self.postMessage(result satisfies TileWorkerOutMessage, [result.rgba]);
};
