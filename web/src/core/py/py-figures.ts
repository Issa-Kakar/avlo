/**
 * Python figure placement — turns a run's `PyFigure` PNGs into canvas image
 * objects wired back to their code block by an elbow connector.
 *
 * Semantics (owner-specified):
 * - **assetId dedup, create-only.** A rerun whose figure PNG matches a
 *   still-alive image this block created before is a no-op; a different PNG
 *   creates a NEW image + connector. Existing images are never moved,
 *   updated, or deleted. Tracking rides a `figureIds: string[]` Y field on
 *   the code map (dead ids pruned opportunistically on the next write).
 * - **Undo-tracked.** Creation rides the normal user-origin `transact` —
 *   Cmd+Z removes image + connector + the figureIds append as one step.
 *   (Output text stays on PY_RUN_ORIGIN, never undoable.)
 * - **Placement.** East of the block at drag-drop sizing parity (400wu wide,
 *   aspect-preserved), slid vertically past bindable blockers via
 *   `slideClear` (the connector-flow avoidance core); the base spot when the
 *   search fails — a figure is ALWAYS placed. Sequential per-figure
 *   transacts are load-bearing: the deep observer runs at each commit, so
 *   figure i+1's spatial probe and z-mint see figure i.
 */

import { generateNZAtTop } from '@avlo/shared';
import { getAssetId } from '@/core/accessors';
import { insertConnector } from '@/core/connectors/connector-actions';
import { insertImage } from '@/core/image/image-actions';
import { enqueue, type IngestResult, ingest } from '@/core/image/image-manager';
import { slideClear } from '@/core/spatial/clear-placement';
import type { FrameTuple } from '@/core/types/geometry';
import type { ObjectHandle } from '@/core/types/objects';
import { getHandle, getZOrder, hasActiveRoom, transact } from '@/runtime/room-runtime';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import type { PyFigure } from './py-protocol';

/** Figure image width in world units — drag-drop/file-picker parity. */
const FIGURE_WIDTH_WU = 400;
/** Block↔image and blocker gaps as a fraction of the relevant image extent
 * (mirrors FLOW_SIBLING_GAP_FACTOR). */
const FIGURE_GAP_FACTOR = 0.25;
/** Vertical search reach in image heights (mirrors FLOW_OFFSET_MAX_REACH). */
const FIGURE_MAX_REACH = 4;

/** Last finished run per block — a slow ingest from run N must not place
 * figures after run N+1's result already landed. */
const latestRun = new Map<string, number>();

/** Result-time entry point (py-manager) — stamps the staleness guard even on
 * figure-less results, then ingests + places asynchronously. */
export function placeRunFigures(blockId: string, runId: number, figures: PyFigure[]): void {
  latestRun.set(blockId, runId);
  if (figures.length === 0) return;
  void ingestAndPlace(blockId, runId, figures);
}

async function ingestAndPlace(blockId: string, runId: number, figures: PyFigure[]): Promise<void> {
  let ingested: IngestResult[];
  try {
    ingested = await Promise.all(figures.map((f) => ingest(new Blob([f.png], { type: 'image/png' }))));
  } catch {
    return; // validation/decode failure — drop the batch, output text already landed
  }
  // Staleness guards — everything past here is synchronous (no interleaving).
  if (!hasActiveRoom() || latestRun.get(blockId) !== runId) return;
  const block = getHandle(blockId);
  if (!block || block.kind !== 'code') return;

  const tracked = (block.y.get('figureIds') as string[] | undefined) ?? [];
  const liveIds = tracked.filter((id) => getHandle(id)?.kind === 'image');
  const liveAssetIds = new Set(liveIds.map((id) => getAssetId(getHandle(id)!.y)));
  for (const r of ingested) {
    if (liveAssetIds.has(r.assetId)) continue; // same plot as a live figure → no-op
    liveIds.push(createFigureImage(block, r, liveIds));
    liveAssetIds.add(r.assetId);
    enqueue(r.assetId); // offline-first R2 upload
  }
}

/** Place + create one figure image and its connector in ONE user-origin
 * transact. `trackedLive` is the pruned figureIds value BEFORE this figure. */
function createFigureImage(block: ObjectHandle, r: IngestResult, trackedLive: readonly string[]): string {
  const w = FIGURE_WIDTH_WU;
  const h = (w * r.naturalHeight) / r.naturalWidth;
  const bb = block.bbox; // code bbox === frame (no padding)
  const baseC = (bb[1] + bb[3]) / 2;
  const base: FrameTuple = [bb[2] + FIGURE_GAP_FACTOR * w, baseC - h / 2, w, h];
  const vGap = FIGURE_GAP_FACTOR * h;
  const limit = FIGURE_MAX_REACH * h;
  const down = slideClear(base, 1, h / 2, vGap, 1, baseC, baseC + limit);
  const up = slideClear(base, 1, h / 2, vGap, -1, baseC, baseC - limit);
  // Nearest cleared centre wins; both directions exhausted → base spot.
  const c = down !== null && (up === null || Math.abs(down - baseC) <= Math.abs(up - baseC)) ? down : (up ?? baseC);
  base[1] = c - h / 2;

  return transact(() => {
    const [zImg, zConn] = generateNZAtTop(getZOrder().maxZ(), 2);
    const imageId = insertImage(r, base, zImg);
    const { color, width } = useDeviceUIStore.getState().connector;
    insertConnector(
      {
        start: { id: block.id, anchor: [1, 0.5] }, // code E midpoint (elbow side derived at route time)
        end: { id: imageId, anchor: [0, 0.5] }, // image W midpoint
        startCap: 'none',
        endCap: 'arrow',
        connectorType: 'elbow',
        color,
        width,
      },
      zConn,
    );
    block.y.set('figureIds', [...trackedLive, imageId]);
    return imageId;
  }) as string;
}
