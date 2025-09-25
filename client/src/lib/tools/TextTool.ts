import { ulid } from 'ulid';
import * as Y from 'yjs';
import type { TextPreview } from './types';
import type { ViewTransform } from '@avlo/shared';

export interface TextToolConfig {
  size: number;
  color: string;
}

export interface CanvasHandle {
  worldToClient: (worldX: number, worldY: number) => [number, number];
  getView: () => ViewTransform; // REQUIRED for live transforms
  getEditorHost: () => HTMLElement | null; // REQUIRED for DOM mounting
}

interface TextState {
  isEditing: boolean;
  editBox: HTMLDivElement | null;
  worldPosition: { x: number; y: number } | null;
  content: string;
}

export class TextTool {
  private state: TextState = {
    isEditing: false,
    editBox: null,
    worldPosition: null,
    content: '',
  };

  constructor(
    private room: any, // RoomDoc type
    private config: TextToolConfig,
    private userId: string,
    private canvasHandle: CanvasHandle,
    private onInvalidate?: () => void,
  ) {}

  canBegin(): boolean {
    return !this.state.isEditing;
  }

  begin(_pointerId: number, worldX: number, worldY: number): void {
    if (this.state.isEditing) return;

    // Store world position
    this.state.worldPosition = { x: worldX, y: worldY };

    // Convert to screen coordinates
    const [clientX, clientY] = this.canvasHandle.worldToClient(worldX, worldY);

    // Create DOM editor overlay
    this.createEditor(clientX, clientY);

    // Update awareness
    this.room.updateActivity('typing');
  }

  move(_worldX: number, _worldY: number): void {
    // Text tool doesn't track movement during editing
  }

  end(): void {
    // Commit happens on blur/Enter, not pointer up
  }

  cancel(): void {
    this.closeEditor(false);
  }

  isActive(): boolean {
    return this.state.isEditing;
  }

  getPointerId(): number | null {
    return null; // Text tool doesn't track pointer
  }

  getPreview(): TextPreview | null {
    // Don't show preview box - the actual DOM editor IS the preview
    // This makes the experience cohesive: what you type is exactly where it will be
    return null;
  }

  destroy(): void {
    this.closeEditor(false);
  }

  // Update config without recreating tool (useful when slider changes)
  updateConfig(newConfig: TextToolConfig): void {
    this.config = newConfig;

    // Update live editor if it exists
    if (this.state.editBox) {
      const view = this.canvasHandle.getView();
      const scaledFontSize = newConfig.size * view.scale;
      this.state.editBox.style.fontSize = `${scaledFontSize}px`;
      this.state.editBox.style.color = newConfig.color;
    }
  }

  // Called when view transforms change (pan/zoom)
  onViewChange(): void {
    if (!this.state.isEditing || !this.state.worldPosition || !this.state.editBox) return;

    // Get current view transform
    const view = this.canvasHandle.getView();

    // Recompute screen position from world position using live view
    const [clientX, clientY] = this.canvasHandle.worldToClient(
      this.state.worldPosition.x,
      this.state.worldPosition.y,
    );

    // CRITICAL FIX: Convert screen coordinates to host-relative coordinates
    const host = this.canvasHandle.getEditorHost?.() || document.body;
    const hostRect = host.getBoundingClientRect();
    const hostRelativeX = clientX - hostRect.left;
    const hostRelativeY = clientY - hostRect.top;

    // CRITICAL: Scale all dimensions with zoom to maintain world-space size
    // This ensures the text appears at the correct size relative to the canvas
    const scaledFontSize = this.config.size * view.scale;
    const scaledPadding = 4 * view.scale;
    const scaledMinWidth = 200 * view.scale;
    const scaledMinHeight = 30 * view.scale;
    const scaledBorderWidth = Math.max(1, 2 * view.scale);
    const scaledBorderRadius = 4 * view.scale;

    // Apply the same offset as in createEditor
    // This maintains the alignment between editor text and committed text position
    const totalOffset = scaledBorderWidth + scaledPadding;
    const adjustedX = hostRelativeX - totalOffset;
    const adjustedY = hostRelativeY - totalOffset;

    // Update DOM editor position with offset
    this.state.editBox.style.left = `${adjustedX}px`;
    this.state.editBox.style.top = `${adjustedY}px`;

    // Update all scaled properties
    this.state.editBox.style.fontSize = `${scaledFontSize}px`;
    this.state.editBox.style.padding = `${scaledPadding}px`;
    this.state.editBox.style.minWidth = `${scaledMinWidth}px`;
    this.state.editBox.style.minHeight = `${scaledMinHeight}px`;
    this.state.editBox.style.borderWidth = `${scaledBorderWidth}px`;
    this.state.editBox.style.borderRadius = `${scaledBorderRadius}px`;
  }

  private createEditor(clientX: number, clientY: number): void {
    // Get DOM overlay host from canvas
    const host = this.canvasHandle.getEditorHost?.() || document.body;

    // CRITICAL FIX: Convert screen coordinates to host-relative coordinates
    // clientX/clientY are screen coordinates, but we need coordinates relative to the host container
    const hostRect = host.getBoundingClientRect();
    const hostRelativeX = clientX - hostRect.left;
    const hostRelativeY = clientY - hostRect.top;

    // Get current view transform to scale the editor to world space
    const view = this.canvasHandle.getView();

    // CRITICAL: Scale font-size and dimensions by view.scale
    // This ensures the text editor appears at the correct size relative to world space
    const scaledFontSize = this.config.size * view.scale;
    const scaledPadding = 4 * view.scale;
    const scaledMinWidth = 200 * view.scale;
    const scaledMinHeight = 30 * view.scale;
    const scaledBorderWidth = Math.max(1, 2 * view.scale); // Ensure at least 1px border
    const scaledBorderRadius = 4 * view.scale;

    // Offset the editor position by border + padding so text content aligns with committed position
    const totalOffset = scaledBorderWidth + scaledPadding;
    const adjustedX = hostRelativeX - totalOffset;
    const adjustedY = hostRelativeY - totalOffset;

    // Create contenteditable div
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.className = 'text-editor-overlay';
    editor.style.cssText = `
      position: absolute;
      left: ${adjustedX}px;
      top: ${adjustedY}px;
      min-width: ${scaledMinWidth}px;
      min-height: ${scaledMinHeight}px;
      padding: ${scaledPadding}px;
      font-size: ${scaledFontSize}px;
      font-family: Inter, system-ui, -apple-system, sans-serif;
      line-height: 1.4;
      color: ${this.config.color};
      background: white;
      border: ${scaledBorderWidth}px solid #3b82f6;
      border-radius: ${scaledBorderRadius}px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      outline: none;
      cursor: text;
      pointer-events: auto;
      transform-origin: top left;
      white-space: pre-wrap;
      word-wrap: break-word;
    `;

    // Handle Enter key
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.commitText();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.closeEditor(false);
      }
    });

    // Handle blur
    editor.addEventListener('blur', () => {
      this.commitText();
    });

    // Handle input
    editor.addEventListener('input', () => {
      this.state.content = editor.textContent || '';
      this.onInvalidate?.();
    });

    host.appendChild(editor);
    editor.focus();

    this.state.editBox = editor;
    this.state.isEditing = true;
  }

  private closeEditor(commit: boolean): void {
    if (!this.state.editBox) return;

    if (commit) {
      this.commitText();
    }

    this.state.editBox.remove();
    this.state.editBox = null;
    this.state.isEditing = false;
    this.state.content = '';
    this.state.worldPosition = null;

    this.room.updateActivity('idle');
    this.onInvalidate?.();
  }

  private commitText(): void {
    if (!this.state.content || !this.state.worldPosition || !this.state.editBox) {
      this.closeEditor(false);
      return;
    }

    // Measure DOM element
    const rect = this.state.editBox.getBoundingClientRect();
    const viewTransform = this.canvasHandle.getView?.() || { scale: 1 };

    // Convert to world units
    const w = rect.width / viewTransform.scale;
    const h = rect.height / viewTransform.scale;

    // Commit to Y.Doc
    const textId = ulid();

    try {
      this.room.mutate((ydoc: Y.Doc) => {
        const root = ydoc.getMap('root');
        const texts = root.get('texts') as Y.Array<any>;
        const meta = root.get('meta') as Y.Map<any>;

        // Get current scene
        const sceneTicks = meta.get('scene_ticks') as Y.Array<number>;
        const currentScene = sceneTicks ? sceneTicks.length : 0;

        // Push new text
        texts.push([
          {
            id: textId,
            x: this.state.worldPosition!.x,
            y: this.state.worldPosition!.y,
            w,
            h,
            content: this.state.content,
            color: this.config.color,
            size: this.config.size,
            scene: currentScene,
            createdAt: Date.now(),
            userId: this.userId,
          },
        ]);
      });
    } catch (err) {
      console.error('Failed to commit text:', err);
    } finally {
      this.closeEditor(false);
    }
  }
}
