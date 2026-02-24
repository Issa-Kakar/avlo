/**
 * ContextMenuController — coordinates context menu visibility and positioning.
 * Skeleton: method stubs only, subscriptions wired in a future step.
 */
export class ContextMenuController {
  private floatingEl: HTMLElement | null = null;
  private showScheduled = false;

  /** Bind the floating DOM element. Call once after mount. */
  init(floatingEl: HTMLElement): void {
    this.floatingEl = floatingEl;
    // TODO: subscribe to selectionStore (menuActive, boundsVersion)
  }

  /** Tear down subscriptions and release DOM ref. */
  destroy(): void {
    this.floatingEl = null;
    // TODO: unsubscribe
  }

  /** Coalesced rAF repositioning (placeholder). */
  scheduleReposition(): void {
    if (this.showScheduled) return;
    this.showScheduled = true;
    requestAnimationFrame(() => {
      this.showScheduled = false;
      // TODO: compute position from selection bounds → screen coords
    });
  }

  /** Show the context menu by setting data-visible. */
  show(): void {
    this.floatingEl?.setAttribute('data-visible', '');
  }

  /** Hide the context menu by removing data-visible. */
  hide(): void {
    this.floatingEl?.removeAttribute('data-visible');
  }
}
