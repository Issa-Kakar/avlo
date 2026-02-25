import { computePosition, offset, flip, shift, hide } from '@floating-ui/dom';
import type { VirtualElement } from '@floating-ui/dom';
import { useSelectionStore } from '@/stores/selection-store';
import { computeSelectionBounds } from '@/lib/utils/selection-utils';
import { useCameraStore, worldToClient } from '@/stores/camera-store';
import type { WorldBounds } from '@avlo/shared';

const SETTLE_MS = 150;

// Exclusion zone padding — keeps menu clear of toolbar (top) and zoom controls (bottom-left)
const FLIP_PADDING = { top: 72, bottom: 76, left: 12, right: 12 };
const SHIFT_PADDING = { top: 72, bottom: 12, left: 12, right: 12 };
const ZOOM_CONTROLS_RIGHT_EDGE = 176; // 24px left + 140px width + 12px gap

/**
 * ContextMenuController — floating-ui powered positioning for the context menu.
 *
 * Two boolean flags:
 *   active  — menu is logically open (controls display block/none)
 *   visible — menu should be showing right now (controls data-visible for CSS transition)
 *
 * The controller subscribes to selection-store (menuOpen, boundsVersion) globally,
 * and to camera-store lazily (only while active).
 */
class ContextMenuController {
  private el: HTMLElement | null = null;
  private active = false;
  private visible = false;
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
        open => open ? this.activate() : this.deactivate(),
      ),
      useSelectionStore.subscribe(
        s => s.boundsVersion,
        () => { if (this.active && this.visible) this.schedulePosition(); },
      ),
    );
  }

  // === Public API (called by SelectTool) ===

  /** Hide menu during gesture — stays logically open, just not visible. */
  hide(): void {
    if (!this.active) return;
    this.visible = false;
    cancelAnimationFrame(this.rafId);
    clearTimeout(this.settleTimer);
    if (this.el) delete this.el.dataset.visible;
  }

  /** Show menu after gesture ends — schedule reposition + reveal. */
  show(): void {
    if (!this.active) return;
    this.visible = true;
    this.schedulePosition();
  }

  /** Tear down all subscriptions and release DOM ref. */
  destroy(): void {
    for (const fn of this.storeUnsubs) fn();
    this.storeUnsubs.length = 0;
    this.unsubCamera();
    cancelAnimationFrame(this.rafId);
    clearTimeout(this.settleTimer);
    this.active = false;
    this.visible = false;
    this.el = null;
  }

  // === Internal lifecycle ===

  private activate(): void {
    if (!this.el) return;
    this.active = true;
    this.visible = true;
    this.el.style.display = 'block';
    this.subCamera();
    this.schedulePosition();
  }

  private deactivate(): void {
    if (!this.el) return;
    this.active = false;
    this.visible = false;
    delete this.el.dataset.visible;
    this.el.style.display = '';
    this.unsubCamera();
    cancelAnimationFrame(this.rafId);
    clearTimeout(this.settleTimer);
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
    if (!this.active || !this.visible) return;
    // Instant hide during camera move
    if (this.el) delete this.el.dataset.visible;
    cancelAnimationFrame(this.rafId);
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      if (this.active && this.visible) this.schedulePosition();
    }, SETTLE_MS);
  }

  // === Positioning ===

  private schedulePosition(): void {
    cancelAnimationFrame(this.rafId);
    // Double-RAF: ensures React has committed content before measuring
    this.rafId = requestAnimationFrame(() => {
      this.rafId = requestAnimationFrame(() => this.positionAndReveal());
    });
  }

  private positionAndReveal(): void {
    if (!this.el || !this.active || !this.visible) return;

    const { selectedIds, textEditingId } = useSelectionStore.getState();
    const ids = textEditingId && selectedIds.length === 0 ? [textEditingId] : selectedIds;
    const bounds = computeSelectionBounds(ids);
    if (!bounds) return;

    const virtualEl = createVirtualElement(bounds);

    computePosition(virtualEl, this.el, {
      strategy: 'fixed',
      placement: 'top',
      middleware: [
        offset(40),
        flip({
          padding: FLIP_PADDING,
          fallbackPlacements: ['bottom'],
          fallbackStrategy: 'initialPlacement',
        }),
        shift({ padding: SHIFT_PADDING }),
        hide({ strategy: 'referenceHidden' }),
      ],
    }).then(({ x, y, placement, middlewareData }) => {
      if (!this.el || !this.active || !this.visible) return;

      // Reference fully offscreen → stay hidden
      if (middlewareData.hide?.referenceHidden) {
        delete this.el.dataset.visible;
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
    });
  }
}

/** Build a floating-ui VirtualElement from selection world bounds. */
function createVirtualElement(worldBounds: WorldBounds): VirtualElement {
  return {
    getBoundingClientRect() {
      const [left, top] = worldToClient(worldBounds.minX, worldBounds.minY);
      const [right, bottom] = worldToClient(worldBounds.maxX, worldBounds.maxY);
      return {
        x: left, y: top,
        top, left, right, bottom,
        width: right - left, height: bottom - top,
      };
    },
  };
}

export const contextMenuController = new ContextMenuController();
