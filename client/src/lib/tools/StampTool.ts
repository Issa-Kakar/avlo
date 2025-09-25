import { ulid } from 'ulid';
import * as Y from 'yjs';
import type { StampPreview } from './types';

export interface StampToolConfig {
  selected: 'circle' | 'square' | 'triangle' | 'star' | 'heart';
  scale: number;
  color?: string; // Optional fill color
}

interface StampState {
  isPreviewing: boolean;
  previewPosition: { x: number; y: number } | null;
}

export class StampTool {
  private state: StampState = {
    isPreviewing: false,
    previewPosition: null,
  };

  constructor(
    private room: any, // RoomDoc type
    private config: StampToolConfig,
    private userId: string,
    private onInvalidate?: () => void,
  ) {}

  canBegin(): boolean {
    return true;
  }

  begin(_pointerId: number, worldX: number, worldY: number): void {
    // Immediate commit on click
    this.placeStamp(worldX, worldY);
  }

  move(worldX: number, worldY: number): void {
    // Update preview position
    this.state.previewPosition = { x: worldX, y: worldY };
    this.state.isPreviewing = true;
    this.onInvalidate?.();
  }

  end(): void {
    // Already committed on begin
  }

  cancel(): void {
    this.state.isPreviewing = false;
    this.state.previewPosition = null;
    this.onInvalidate?.();
  }

  isActive(): boolean {
    return false; // Stamps are instant, not modal
  }

  getPointerId(): number | null {
    return null;
  }

  getPreview(): StampPreview | null {
    if (!this.state.isPreviewing || !this.state.previewPosition) return null;

    return {
      kind: 'stamp',
      position: this.state.previewPosition,
      stampType: this.config.selected,
      size: 32 * this.config.scale, // Base size * scale
      color: this.config.color || '#666666',
      opacity: 0.5, // Preview opacity
    };
  }

  destroy(): void {
    this.cancel();
  }

  clearHover(): void {
    // Clear preview when pointer leaves canvas
    this.state.isPreviewing = false;
    this.state.previewPosition = null;
    this.onInvalidate?.();
  }

  private placeStamp(worldX: number, worldY: number): void {
    const stampId = ulid();
    const size = 32 * this.config.scale; // World units

    try {
      this.room.mutate((ydoc: Y.Doc) => {
        const root = ydoc.getMap('root');
        const strokes = root.get('strokes') as Y.Array<any>;
        const meta = root.get('meta') as Y.Map<any>;

        // Get current scene
        const sceneTicks = meta.get('scene_ticks') as Y.Array<number>;
        const currentScene = sceneTicks ? sceneTicks.length : 0;

        // Store stamp as special stroke (for MVP)
        strokes.push([
          {
            id: stampId,
            tool: 'stamp', // Special tool type
            stampType: this.config.selected, // Shape type
            color: this.config.color || '#666666', // Fill color
            size, // Stamp size in world units
            opacity: 1,
            points: [worldX, worldY], // Just center point
            bbox: [worldX - size / 2, worldY - size / 2, worldX + size / 2, worldY + size / 2],
            scene: currentScene,
            createdAt: Date.now(),
            userId: this.userId,
          },
        ]);
      });
    } catch (err) {
      console.error('Failed to place stamp:', err);
    } finally {
      // Clear preview
      this.state.isPreviewing = false;
      this.state.previewPosition = null;
      this.onInvalidate?.();
    }
  }
}
