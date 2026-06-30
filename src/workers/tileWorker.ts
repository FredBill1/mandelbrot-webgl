import { renderPerturbationTile } from "./perturbation";
import type { ReferenceSnapshot, TileWorkerInMessage, TileWorkerOutMessage } from "../types";

const referenceCache = new Map<string, ReferenceSnapshot>();

self.onmessage = (event: MessageEvent<TileWorkerInMessage>) => {
  if (event.data.type === "cacheReferences") {
    for (const reference of event.data.references) referenceCache.set(reference.id, reference);
    return;
  }

  if (event.data.type === "dropReferences") {
    for (const id of event.data.referenceIds) referenceCache.delete(id);
    return;
  }

  const hydratedReferences: ReferenceSnapshot[] = [];
  let referenceCacheMissCount = 0;
  for (const reference of event.data.references) {
    if ("orbitRe" in reference && "orbitIm" in reference) {
      referenceCache.set(reference.id, reference);
      hydratedReferences.push(reference);
      continue;
    }
    const cached = referenceCache.get(reference.id);
    if (cached) {
      hydratedReferences.push({
        ...cached,
        screenX: reference.screenX,
        screenY: reference.screenY,
        escapedAt: reference.escapedAt,
        precisionBits: reference.precisionBits,
        maxIter: reference.maxIter
      });
    } else {
      referenceCacheMissCount += 1;
    }
  }

  const result = renderPerturbationTile({
    ...event.data,
    references: hydratedReferences
  });
  result.stats.referenceCacheMissCount += referenceCacheMissCount;
  self.postMessage(result satisfies TileWorkerOutMessage, [result.rgba]);
};
