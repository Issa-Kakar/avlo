import { computePosition, offset, flip, shift, hide } from '@floating-ui/dom';
import type { VirtualElement } from '@floating-ui/dom';
import { useSelectionStore } from '@/stores/selection-store';
import { computeSelectionBounds } from '@/lib/utils/selection-utils';
import { worldToClient } from '@/stores/camera-store';
import type { WorldBounds } from '@/types/geometry';

const SETTLE_MS = 150;

// Exclusion zone padding — keeps menu clear of toolbar (top) and zoom controls (bottom-left)
const FLIP_PADDING = { top: 66, bottom: 76, left: 12, right: 12 };
const SHIFT_PADDING = { top: 66, bottom: 12, left: 12, right: 12 };

/**
 * ContextMenuController — floating-ui powered positioning for the context menu.
 *
 * Two boolean flags:
 *   active  — menu is logically open (React mounts content via menuOpen)
 *   visible — not gesture-hidden (camera debounce can show; SelectTool.begin sets false)
 *
 * Activation paths:
 *   show()      — SelectTool end/cancel. Auto-sets menuOpen if needed.
 *   menuOpen    — store subscription (beginTextEditing, etc). No-op if show() already activated.
 * Deactivation: always via menuOpen → false (clearSelection, endTextEditing).
 * Camera: onCameraMove() called by CanvasRuntime — no lazy subscription needed.
 */
class ContextMenuController {
  private el!: HTMLElement;
  private active = false;
  private visible = false;
  private storeUnsubs: (() => void)[] = [];
  private rafId = 0;
  private settleTimer = 0;

  /** Bind portal element and wire store subscriptions. Call once after mount. */
  init(el: HTMLElement): void {
    this.el = el;
    this.storeUnsubs.push(
      useSelectionStore.subscribe(
        (s) => s.menuOpen,
        (open) => (open ? this.activate() : this.deactivate()),
      ),
      useSelectionStore.subscribe(
        (s) => s.boundsVersion,
        () => {
          if (this.active && this.visible) this.schedulePosition();
        },
      ),
    );
  }

  // === Public API ===

  /** Show menu after gesture ends. Auto-activates + sets menuOpen if needed. */
  show(): void {
    const { selectedIds, textEditingId } = useSelectionStore.getState();
    if (selectedIds.length === 0 && textEditingId === null) return;
    if (!this.active) {
      this.active = true;
      useSelectionStore.setState({ menuOpen: true });
    }
    this.visible = true;
    clearTimeout(this.settleTimer);
    this.schedulePosition();
  }

  /** Hide during gesture — stays active, React stays mounted. */
  hide(): void {
    if (!this.active) return;
    this.visible = false;
    this.el.classList.add('ctx-hidden');
    cancelAnimationFrame(this.rafId);
    clearTimeout(this.settleTimer);
  }

  /** Undo hide() synchronously in the same frame — no paint between add/remove of ctx-hidden. */
  cancelHide(): void {
    if (!this.active) return;
    this.visible = true;
    this.el.classList.remove('ctx-hidden');
  }

  /** Camera changed. Debounced hide + reposition. No-op if gesture-hidden or inactive. */
  onCameraMove(): void {
    if (!this.active || !this.visible) return;
    this.el.classList.add('ctx-hidden');
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      if (this.active && this.visible) this.schedulePosition();
    }, SETTLE_MS);
  }

  /** Tear down subscriptions and timers. */
  destroy(): void {
    for (const fn of this.storeUnsubs) fn();
    this.storeUnsubs.length = 0;
    cancelAnimationFrame(this.rafId);
    clearTimeout(this.settleTimer);
    this.active = false;
    this.visible = false;
  }

  // === Internal ===

  /** Subscription-driven activation (text editing). No-op if show() already activated. */
  private activate(): void {
    if (this.active) return;
    this.active = true;
    this.visible = true;
    this.el.classList.add('ctx-hidden');
    this.schedulePosition();
  }

  private deactivate(): void {
    this.active = false;
    this.visible = false;
    this.el.classList.add('ctx-hidden');
    this.el.style.left = '0px';
    this.el.style.top = '0px';
    cancelAnimationFrame(this.rafId);
    clearTimeout(this.settleTimer);
  }

  private schedulePosition(): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(() => this.positionAndReveal());
  }

  private positionAndReveal(): void {
    if (!this.active || !this.visible) return;

    const bounds = computeSelectionBounds();
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
        shift({ padding: SHIFT_PADDING, crossAxis: true }),
        hide({ strategy: 'referenceHidden' }),
      ],
    }).then(({ x, y, middlewareData }) => {
      if (!this.active || !this.visible) return;

      if (middlewareData.hide?.referenceHidden) {
        this.el.classList.add('ctx-hidden');
        return;
      }

      this.el.style.left = `${Math.round(x)}px`;
      this.el.style.top = `${Math.round(y)}px`;
      this.el.classList.remove('ctx-hidden');
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
        x: left,
        y: top,
        top,
        left,
        right,
        bottom,
        width: right - left,
        height: bottom - top,
      };
    },
  };
}

export const contextMenuController = new ContextMenuController();
