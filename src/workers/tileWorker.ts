import { renderPerturbationTile } from "./perturbation";
import type { RenderTileMessage, TileWorkerOutMessage } from "../types";

self.onmessage = (event: MessageEvent<RenderTileMessage>) => {
  if (event.data.type !== "renderTile") return;
  const result = renderPerturbationTile(event.data);
  self.postMessage(result satisfies TileWorkerOutMessage, [result.rgba]);
};
