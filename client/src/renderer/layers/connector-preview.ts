/**
 * Connector Preview Rendering
 *
 * Thin dispatcher over the shared draw atoms in `connector-render-atoms.ts`.
 * Preview data is deliberately minimal (`points`, `fromSnap`, `hoverSnap`) —
 * style comes live from `device-ui-store`, and the polyline / arrow / snap
 * feedback are all composed from atoms that the committed-render path shares.
 *
 * After pointer-down, only the TARGET side ever renders an anchor dot — the
 * from-side is intentionally dot-less so the cursor isn't double-stamped.
 *
 * CRITICAL: Called INSIDE world transform scope; all coordinates are world.
 *
 * @module renderer/layers/connector-preview
 */

import type { ConnectorPreview } from '@/tools/types';
import { isAnchorInterior } from '@/core/connectors/types';
import { buildConnectorPaths } from '@/core/connectors/connector-paths';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { drawConnectorDashGuide, drawSnapFeedback, paintConnector } from './connector-render-atoms';

/**
 * Draw connector preview on overlay canvas.
 */
export function drawConnectorPreview(ctx: CanvasRenderingContext2D, preview: ConnectorPreview): void {
  const { points, fromSnap, hoverSnap } = preview;
  const hasRoute = points.length >= 2;

  // Live style — device-ui-store is stable within a gesture.
  const uiState = useDeviceUIStore.getState();
  const color = uiState.drawingSettings.color;
  const width = uiState.connectorSize;
  const opacity = uiState.drawingSettings.opacity;
  const startCap = uiState.connectorStartCap;
  const endCap = uiState.connectorEndCap;
  const isStraight = uiState.connectorType === 'straight';

  // 1. Polyline + arrow caps — shared paint atom with objects.ts.
  if (hasRoute) {
    const paths = buildConnectorPaths({ points, strokeWidth: width, startCap, endCap });
    paintConnector(ctx, paths, color, width, opacity);
  }

  // 2. Dashed guides for straight connectors with interior anchors.
  //    For interior snaps (clamped to [0.01, 0.99]), `snap.edgePosition` equals
  //    the anchor frame point — no need to resolve the shape frame here.
  if (isStraight && hasRoute) {
    if (fromSnap && isAnchorInterior(fromSnap.normalizedAnchor)) {
      drawConnectorDashGuide(ctx, points[0], fromSnap.edgePosition);
    }
    if (hoverSnap && isAnchorInterior(hoverSnap.normalizedAnchor)) {
      drawConnectorDashGuide(ctx, points[points.length - 1], hoverSnap.edgePosition);
    }
  }

  // 3. Target feedback — hover side only. The from-side never renders a dot after pointer-down.
  drawSnapFeedback(ctx, hoverSnap, isStraight);
}
