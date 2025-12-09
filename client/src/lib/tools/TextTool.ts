import { ulid } from 'ulid';
import * as Y from 'yjs';
import type { TextPreview } from './types';
import { useDeviceUIStore } from '../../stores/device-ui-store';
import { useCameraStore, worldToClient as cameraWorldToClient } from '@/stores/camera-store';

export interface TextToolConfig {
  size: number;
  color: string;
}

export interface CanvasHandle {
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
  private committing = false;

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
    const [clientX, clientY] = cameraWorldToClient(worldX, worldY);

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
    this.cancelEdit();
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
    this.teardownEditor();
  }

  // Update config without recreating tool (useful when slider changes)
  updateConfig(newConfig: TextToolConfig): void {
    this.config = newConfig;

    // Update live editor if it exists
    if (this.state.editBox) {
      const { scale } = useCameraStore.getState();
      const scaledFontSize = newConfig.size * scale;
      this.state.editBox.style.fontSize = `${scaledFontSize}px`;
      this.state.editBox.style.color = newConfig.color;
    }
  }

  // Called when view transforms change (pan/zoom)
  onViewChange(): void {
    if (!this.state.isEditing || !this.state.worldPosition || !this.state.editBox) return;

    // Get current scale from camera store
    const { scale } = useCameraStore.getState();

    // Recompute screen position from world position using camera store
    const [clientX, clientY] = cameraWorldToClient(
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
    const scaledFontSize = this.config.size * scale;
    const scaledPadding = 4 * scale;
    const scaledMinWidth = 200 * scale;
    const scaledMinHeight = 30 * scale;
    const scaledBorderWidth = Math.max(1, 2 * scale);
    const scaledBorderRadius = 4 * scale;

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

    // Get current scale from camera store
    const { scale } = useCameraStore.getState();

    // CRITICAL: Scale font-size and dimensions by scale
    // This ensures the text editor appears at the correct size relative to world space
    const scaledFontSize = this.config.size * scale;
    const scaledPadding = 4 * scale;
    const scaledMinWidth = 200 * scale;
    const scaledMinHeight = 30 * scale;
    const scaledBorderWidth = Math.max(1, 2 * scale); // Ensure at least 1px border
    const scaledBorderRadius = 4 * scale;

    // Offset the editor position by border + padding so text content aligns with committed position
    const totalOffset = scaledBorderWidth + scaledPadding;
    const adjustedX = hostRelativeX - totalOffset;
    const adjustedY = hostRelativeY - totalOffset;

    // Calculate max width to prevent infinite horizontal growth
    const maxWidth = Math.max(24, hostRect.width - adjustedX - 8); // 8px safety margin

    // Create contenteditable div
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.className = 'text-editor-overlay';
    editor.style.cssText = `
      position: absolute;
      left: ${adjustedX}px;
      top: ${adjustedY}px;
      min-width: ${scaledMinWidth}px;
      max-width: ${maxWidth}px;
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
      overflow-wrap: break-word;
    `;

    // Handle Enter key - just blur to trigger commit
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        // Let blur be the single commit path
        (e.currentTarget as HTMLDivElement).blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelEdit();
      }
    };

    // Handle blur - single commit path
    const onBlur = () => this.commitTextOnce();

    // Handle input - store content for preview
    const onInput = () => {
      // Store content temporarily for preview purposes
      this.state.content = editor.textContent || '';
      this.onInvalidate?.();
    };

    editor.addEventListener('keydown', onKeyDown);
    editor.addEventListener('blur', onBlur, { once: true }); // Fire only once
    editor.addEventListener('input', onInput);

    host.appendChild(editor);
    editor.focus();

    this.state.editBox = editor;
    this.state.isEditing = true;

    // Notify store that text editing has started (hides ColorSizeDock)
    useDeviceUIStore.getState().setIsTextEditing(true);
  }

  private teardownEditor(): void {
    const el = this.state.editBox;
    if (el) {
      // Defensive: remove listeners/pointer events before removing
      el.style.pointerEvents = 'none';
      // Safe remove even if parent changed
      try {
        el.remove();
      } catch {
        /* ignore */
      }
    }
    this.state.editBox = null;
    this.state.isEditing = false;
    this.state.content = '';
    this.state.worldPosition = null;
    this.room.updateActivity('idle');
    this.onInvalidate?.();
    useDeviceUIStore.getState().setIsTextEditing(false);
  }

  private cancelEdit(): void {
    // Cancel without commit
    this.teardownEditor();
  }

  // Back-compat shim
  private closeEditor(_commit: boolean): void {
    this.teardownEditor();
  }

  private commitTextOnce(): void {
    if (this.committing) return;
    this.committing = true;
    try {
      this.commitTextCore();
    } finally {
      this.teardownEditor();
      this.committing = false;
    }
  }

  private commitTextCore(): void {
    if (!this.state.worldPosition || !this.state.editBox) return;

    // Use textContent to get raw text (innerText doesn't actually capture soft wraps)
    const raw = this.state.editBox.textContent ?? '';
    const content = raw.replace(/\r\n?/g, '\n'); // don't .trim() to keep trailing blank lines
    if (!content.replace(/\s+/g, '')) return; // empty/whitespace-only → cancel

    // Measure DOM box for width/height in world units
    const rect = this.state.editBox.getBoundingClientRect();
    const { scale } = useCameraStore.getState();
    const w = rect.width / scale;
    const h = rect.height / scale;

    const id = ulid();
    this.room.mutate((ydoc: Y.Doc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Y.Map<Y.Map<any>>;

      const textMap = new Y.Map();
      textMap.set('id', id);
      textMap.set('kind', 'text');
      textMap.set('frame', [this.state.worldPosition!.x, this.state.worldPosition!.y, w, h]); // [x, y, w, h]
      textMap.set('text', content); // For now, using string. TODO: Use Y.Text in future for collaborative editing
      textMap.set('color', this.config.color);
      textMap.set('fontSize', this.config.size);  // Renamed from 'size' to 'fontSize' per migration spec
      textMap.set('fontFamily', 'sans-serif');
      textMap.set('fontWeight', 'normal');
      textMap.set('fontStyle', 'normal');
      textMap.set('textAlign', 'left');
      textMap.set('opacity', 1);
      textMap.set('ownerId', this.userId);
      textMap.set('createdAt', Date.now());

      objects.set(id, textMap);
    });
  }
}
