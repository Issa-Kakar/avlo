import { computePosition, offset, flip, shift, hide } from '@floating-ui/dom';
import type { VirtualElement } from '@floating-ui/dom';
import { useSelectionStore } from '@/stores/selection-store';
import { computeSelectionBounds } from '@/lib/utils/selection-utils';
import { useCameraStore, worldToClient } from '@/stores/camera-store';
import type { WorldBounds } from '@avlo/shared';

type ControllerState = 'dormant' | 'hidden' | 'positioned';

const SETTLE_MS = 150;

// Exclusion zone padding — keeps menu clear of toolbar (top) and zoom controls (bottom-left)
const FLIP_PADDING = { top: 72, bottom: 76, left: 12, right: 12 };
const SHIFT_PADDING = { top: 72, bottom: 12, left: 12, right: 12 };
const ZOOM_CONTROLS_RIGHT_EDGE = 176; // 24px left + 140px width + 12px gap

/**
 * ContextMenuController — floating-ui powered positioning for the context menu.
 *
 * State machine:
 *   dormant    → menuOpen is false, DOM hidden, no subscriptions
 *   hidden     → menuOpen is true, DOM display:'' but no data-visible (during camera settle / gesture)
 *   positioned → menuOpen is true, DOM visible with computed position
 *
 * The controller subscribes to selection-store (menuOpen, boundsVersion) globally,
 * and to camera-store lazily (only while open).
 */
class ContextMenuController {
  private el: HTMLElement | null = null;
  private state: ControllerState = 'dormant';
  private storeUnsubs: (() => void)[] = [];
  private cameraUnsub: (() => void) | null = null;
  private rafId = 0;
  private settleTimer = 0;

  /** Bind the floating DOM element and wire store subscriptions. Call once after mount. */
  init(el: HTMLElement): void {
    this.el = el;
    this.storeUnsubs.push(
      useSelectionStore.subscribe(
        s => s.menuOpen,
        open => open ? this.open() : this.close(),
      ),
      useSelectionStore.subscribe(
        s => s.boundsVersion,
        () => { if (this.state !== 'dormant') this.scheduleReposition(); },
      ),
    );
  }

  // === Public API (called by SelectTool) ===

  /** Hide menu during gesture — stays logically open, just not visible. */
  hide(): void {
    if (this.state === 'dormant') return;
    this.state = 'hidden';
    if (this.el) delete this.el.dataset.visible;
    clearTimeout(this.settleTimer);
  }

  /** Show menu after gesture ends — schedule reposition + reveal. */
  show(): void {
    if (this.state === 'dormant') return;
    this.scheduleReposition();
  }

  /** Tear down all subscriptions and release DOM ref. */
  destroy(): void {
    for (const fn of this.storeUnsubs) fn();
    this.storeUnsubs.length = 0;
    this.unsubCamera();
    cancelAnimationFrame(this.rafId);
    clearTimeout(this.settleTimer);
    this.el = null;
    this.state = 'dormant';
  }

  // === Internal lifecycle ===

  private open(): void {
    if (!this.el) return;
    this.state = 'hidden';
    this.el.style.display = 'block';
    this.subCamera();
    this.scheduleReposition();
  }

  private close(): void {
    if (!this.el) return;
    delete this.el.dataset.visible;
    this.el.style.display = '';  // Removes inline → CSS display:none applies
    this.state = 'dormant';
    this.unsubCamera();
    clearTimeout(this.settleTimer);
    cancelAnimationFrame(this.rafId);
  }

  // === Camera subscription (lazy) ===

  private subCamera(): void {
    if (this.cameraUnsub) return;
    this.cameraUnsub = useCameraStore.subscribe(
      s => ({ s: s.scale, x: s.pan.x, y: s.pan.y }),
      () => this.onCameraChange(),
      { equalityFn: (a, b) => a.s === b.s && a.x === b.x && a.y === b.y },
    );
  }

  private unsubCamera(): void {
    this.cameraUnsub?.();
    this.cameraUnsub = null;
  }

  private onCameraChange(): void {
    if (this.state === 'dormant') return;
    this.state = 'hidden';
    if (this.el) delete this.el.dataset.visible;
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      if (this.state !== 'dormant') this.scheduleReposition();
    }, SETTLE_MS);
  }

  // === Positioning ===

  private scheduleReposition(): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(() => this.positionMenu());
  }

  private positionMenu(): void {
    if (!this.el || this.state === 'dormant') return;

    const { selectedIds, textEditingId } = useSelectionStore.getState();
    const ids = textEditingId && selectedIds.length === 0 ? [textEditingId] : selectedIds;
    const bounds = computeSelectionBounds(ids);
    if (!bounds) return;

    const virtualEl = createVirtualElement(bounds);

    computePosition(virtualEl, this.el, {
      strategy: 'fixed',
      placement: 'top',
      middleware: [
        offset(12),
        flip({
          padding: FLIP_PADDING,
          fallbackPlacements: ['bottom'],
          fallbackStrategy: 'initialPlacement',
        }),
        shift({ padding: SHIFT_PADDING }),
        hide({ strategy: 'referenceHidden' }),
      ],
    }).then(({ x, y, placement, middlewareData }) => {
      if (!this.el || this.state === 'dormant') return;

      // Reference fully offscreen → stay hidden
      if (middlewareData.hide?.referenceHidden) {
        delete this.el.dataset.visible;
        this.state = 'hidden';
        return;
      }

      // Fallback clamp: if top placement pushes above toolbar, clamp to toolbar bottom
      let finalY = y;
      if (finalY < FLIP_PADDING.top) finalY = FLIP_PADDING.top;

      // Zoom controls avoidance: when placed below and overlapping bottom-left zone
      let finalX = x;
      if (placement === 'bottom' && finalX < ZOOM_CONTROLS_RIGHT_EDGE) {
        finalX = ZOOM_CONTROLS_RIGHT_EDGE;
      }

      Object.assign(this.el.style, {
        left: `${finalX}px`,
        top: `${finalY}px`,
        transform: '',
      });
      this.el.dataset.visible = '';
      this.state = 'positioned';
    });
  }
}

/** Build a floating-ui VirtualElement that clips selection bounds to the viewport. */
function createVirtualElement(worldBounds: WorldBounds): VirtualElement {
  return {
    getBoundingClientRect() {
      const [left, top] = worldToClient(worldBounds.minX, worldBounds.minY);
      const [right, bottom] = worldToClient(worldBounds.maxX, worldBounds.maxY);
      const { cssWidth, cssHeight } = useCameraStore.getState();

      // Clip to viewport so floating-ui centers on the VISIBLE portion
      const cl = Math.max(0, left), ct = Math.max(0, top);
      const cr = Math.min(cssWidth, right), cb = Math.min(cssHeight, bottom);

      // Selection entirely offscreen → zero rect
      if (cl >= cr || ct >= cb) {
        return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
      }

      return {
        x: cl, y: ct,
        top: ct, left: cl, right: cr, bottom: cb,
        width: cr - cl, height: cb - ct,
      };
    },
  };
}

export const contextMenuController = new ContextMenuController();
