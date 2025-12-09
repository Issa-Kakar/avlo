import { useCameraStore } from '@/stores/camera-store';

export class PanTool {
    private pointerId: number | null = null;
    private lastClient: { x: number; y: number } | null = null;
    private isDragging = false;

    constructor(
      private onInvalidateOverlay: () => void,
      private applyCursor: () => void,
      private setCursorOverride: (cursor: string | null) => void,
    ) {}
  
    // PointerTool interface implementation
    canBegin(): boolean {
      return this.pointerId === null;
    }
  
    begin(pointerId: number, _worldX: number, _worldY: number, clientX?: number, clientY?: number): void {
      this.pointerId = pointerId;
      this.isDragging = true;
      // CRITICAL: Seed lastClient to avoid losing first delta
      if (clientX !== undefined && clientY !== undefined) {
        this.lastClient = { x: clientX, y: clientY };
      }
      this.setCursorOverride('grabbing');
      this.applyCursor();
    }
  
    move(_worldX: number, _worldY: number): void {
      // Pan is handled in Canvas.tsx using screen deltas
      // This is just for interface compliance
    }
  
    end(_worldX?: number, _worldY?: number): void {
      this.pointerId = null;
      this.lastClient = null;
      this.isDragging = false;
      this.setCursorOverride(null);
      this.applyCursor();
    }
  
    cancel(): void {
      this.end();
    }
  
    isActive(): boolean {
      return this.pointerId !== null;
    }
  
    getPointerId(): number | null {
      return this.pointerId;
    }
  
    getPreview(): null {
      return null; // Pan tool has no preview
    }
  
    destroy(): void {
      // Cleanup if needed
    }
  
    // Pan-specific method for screen delta updates
    updatePan(clientX: number, clientY: number): void {
      if (!this.isDragging) return;

      if (this.lastClient) {
        const dx = clientX - this.lastClient.x;
        const dy = clientY - this.lastClient.y;

        const { scale, pan, setPan } = useCameraStore.getState();
        setPan({
          x: pan.x - dx / scale,
          y: pan.y - dy / scale,
        });

        this.onInvalidateOverlay();
      }

      this.lastClient = { x: clientX, y: clientY };
    }
}