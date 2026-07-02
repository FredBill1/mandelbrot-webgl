import { renderPerturbationTileWasm } from "./wasmPerturbation";
import type { RenderTileMessage, TileWorkerOutMessage } from "../types";

self.onmessage = (event: MessageEvent<RenderTileMessage>) => {
  if (event.data.type !== "renderTile") return;
  void renderPerturbationTileWasm(event.data).then((result) => {
    self.postMessage(result satisfies TileWorkerOutMessage, [result.rgba]);
  });
};
