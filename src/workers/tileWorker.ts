import { renderPerturbationTile } from "./perturbation";
import type { NeedReferenceMessage, RenderTileMessage, TileWorkerOutMessage } from "../types";

self.onmessage = (event: MessageEvent<RenderTileMessage>) => {
  if (event.data.type !== "renderTile") return;
  const result = renderPerturbationTile(event.data);
  if (result.needsReference) {
    const request: NeedReferenceMessage = {
      type: "needReference",
      tile: event.data.tile,
      requiredPrecision: event.data.reference.precisionBits + 32,
      maxIter: event.data.maxIter,
      targetScreenX: result.stats.unresolvedScreenX ?? event.data.tile.centerScreenX,
      targetScreenY: result.stats.unresolvedScreenY ?? event.data.tile.centerScreenY,
      refinementLevel: event.data.refinementLevel + 1,
      sourceReferenceId: event.data.reference.id
    };
    self.postMessage(request satisfies TileWorkerOutMessage);
  }
  self.postMessage(result satisfies TileWorkerOutMessage, [result.rgba]);
};
