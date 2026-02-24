import { useSelectionStore } from '@/stores/selection-store';
import { computeSelectionBounds } from '@/lib/utils/selection-utils';
import { useCameraStore, worldToClient } from '@/stores/camera-store';

/**
 * ContextMenuController — coordinates context menu visibility and positioning.
 * Subscribes to selection store (menuActive, boundsVersion) and camera store
 * to show/hide and reposition the floating context menu element.
 */
export class ContextMenuController {
  private el: HTMLElement | null = null;
  private unsubs: (() => void)[] = [];
  private rafId = 0;
  private settleTimer = 0;

  /** Bind the floating DOM element and wire subscriptions. Call once after mount. */
  init(el: HTMLElement): void {
    this.el = el;
    this.unsubs.push(
      useSelectionStore.subscribe(s => s.menuActive, a => a ? this.activate() : this.deactivate()),
      useSelectionStore.subscribe(s => s.boundsVersion, () => {
        if (useSelectionStore.getState().menuActive) this.scheduleReposition();
      }),
      useCameraStore.subscribe(
        s => ({ s: s.scale, x: s.pan.x, y: s.pan.y }),
        () => this.onCameraChange(),
        { equalityFn: (a, b) => a.s === b.s && a.x === b.x && a.y === b.y },
      ),
    );
  }

  private activate(): void {
    if (!this.el) return;
    this.el.style.display = '';
    this.scheduleReposition();
  }

  private deactivate(): void {
    if (!this.el) return;
    delete this.el.dataset.visible;
    this.el.style.display = 'none';
    clearTimeout(this.settleTimer);
  }

  private onCameraChange(): void {
    if (!this.el || !useSelectionStore.getState().menuActive) return;
    delete this.el.dataset.visible;
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      if (useSelectionStore.getState().menuActive) this.scheduleReposition();
    }, 80);
  }

  /** Coalesced rAF repositioning — positions element above selection center. */
  scheduleReposition(): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(() => {
      if (!this.el || !useSelectionStore.getState().menuActive) return;
      const { selectedIds, textEditingId } = useSelectionStore.getState();
      const ids = textEditingId && selectedIds.length === 0 ? [textEditingId] : selectedIds;
      const bounds = computeSelectionBounds(ids);
      if (!bounds) return;
      // Position above selection center — placeholder until floating-ui integration
      const [cx, cy] = worldToClient((bounds.minX + bounds.maxX) / 2, bounds.minY);
      const h = this.el.offsetHeight;
      this.el.style.left = `${cx}px`;
      this.el.style.top = `${cy - h - 12}px`;
      this.el.style.transform = 'translateX(-50%)';
      this.el.dataset.visible = '';
    });
  }

  /** Tear down subscriptions and release DOM ref. */
  destroy(): void {
    for (const fn of this.unsubs) fn();
    this.unsubs.length = 0;
    cancelAnimationFrame(this.rafId);
    clearTimeout(this.settleTimer);
    this.el = null;
  }
}
