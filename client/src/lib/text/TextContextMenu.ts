/**
 * TEXT CONTEXT MENU
 *
 * Plain DOM overlay that appears during text editing.
 * Positioned above/below the text container with 150ms settle behavior on pan/zoom.
 *
 * ARCHITECTURE:
 * - Imperative DOM management (no React)
 * - Camera store subscription for hide/reposition on pan/zoom
 * - Tiptap editor integration for Bold/Italic state
 * - 150ms settle delay after camera changes
 */

import type { Editor } from '@tiptap/core';
import { getCanvasRect, useCameraStore } from '@/stores/camera-store';
import { useDeviceUIStore, TEXT_FONT_SIZE_PRESETS, type TextFontSizePreset } from '@/stores/device-ui-store';
import { getTextToolInstance } from '@/lib/tools/TextTool';
import {
  createBoldIcon,
  createItalicIcon,
  createAlignLeftIcon,
  createAlignCenterIcon,
  createAlignRightIcon,
  createTextColorIcon,
  createMinusIcon,
  createPlusIcon,
  createChevronDownIcon,
  createMoreIcon,
} from './text-menu-icons';

// Settle delay after camera changes before showing menu
const CAMERA_SETTLE_MS = 150;

class TextContextMenu {
  private container: HTMLDivElement | null = null;
  private editorContainer: HTMLDivElement | null = null;
  private editor: Editor | null = null;

  // DOM element references for updates
  private boldBtn: HTMLButtonElement | null = null;
  private italicBtn: HTMLButtonElement | null = null;
  private alignLeftBtn: HTMLButtonElement | null = null;
  private alignCenterBtn: HTMLButtonElement | null = null;
  private alignRightBtn: HTMLButtonElement | null = null;
  private colorBtn: HTMLButtonElement | null = null;
  private sizeValueBtn: HTMLButtonElement | null = null;
  private sizeMinusBtn: HTMLButtonElement | null = null;
  private sizePlusBtn: HTMLButtonElement | null = null;

  // Submenus
  private colorSubmenu: HTMLDivElement | null = null;
  private sizeSubmenu: HTMLDivElement | null = null;

  // Subscriptions
  private cameraUnsub: (() => void) | null = null;
  private settleTimeout: number | null = null;

  // Track camera state for change detection
  private lastPan = { x: 0, y: 0 };
  private lastScale = 1;

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * Mount the context menu for a text editing session.
   */
  mount(host: HTMLDivElement, editorContainer: HTMLDivElement, editor: Editor, _objectId: string): void {
    // Cleanup any existing menu
    this.destroy();

    this.editorContainer = editorContainer;
    this.editor = editor;

    // Build and append DOM
    this.container = this.buildDOM();
    host.appendChild(this.container);

    // Initial position
    this.updatePosition();

    // Setup subscriptions
    this.setupCameraSubscription();
    this.setupEditorSubscription();
  }

  /**
   * Cleanup the context menu.
   */
  destroy(): void {
    // Clear timeout
    if (this.settleTimeout !== null) {
      clearTimeout(this.settleTimeout);
      this.settleTimeout = null;
    }

    // Unsubscribe from camera
    if (this.cameraUnsub) {
      this.cameraUnsub();
      this.cameraUnsub = null;
    }

    // Remove DOM
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }

    // Clear references
    this.container = null;
    this.editorContainer = null;
    this.editor = null;
    this.boldBtn = null;
    this.italicBtn = null;
    this.alignLeftBtn = null;
    this.alignCenterBtn = null;
    this.alignRightBtn = null;
    this.colorBtn = null;
    this.sizeValueBtn = null;
    this.sizeMinusBtn = null;
    this.sizePlusBtn = null;
    this.colorSubmenu = null;
    this.sizeSubmenu = null;
  }

  /**
   * Called by TextTool.onViewChange() when camera changes.
   */
  onViewChange(): void {
    // The camera subscription handles this - this method exists for explicit calls
  }

  // =========================================================================
  // DOM Building
  // =========================================================================

  private buildDOM(): HTMLDivElement {
    const container = document.createElement('div');
    container.className = 'text-context-menu';

    const uiState = useDeviceUIStore.getState();

    // === Font dropdown ===
    const fontBtn = this.createButton('tcm-btn tcm-btn-font', () => {
      // Font dropdown - only Grandstander for now, so no-op
    });
    const fontName = document.createElement('span');
    fontName.className = 'tcm-font-name';
    fontName.textContent = 'Draw';
    fontBtn.appendChild(fontName);
    const fontChevron = document.createElement('span');
    fontChevron.className = 'tcm-chevron';
    fontChevron.appendChild(createChevronDownIcon());
    fontBtn.appendChild(fontChevron);
    container.appendChild(fontBtn);

    container.appendChild(this.createSeparator());

    // === Size group ===
    const sizeGroup = document.createElement('div');
    sizeGroup.className = 'tcm-size-group';

    this.sizeMinusBtn = this.createButton('tcm-btn tcm-size-btn', () => this.handleSizeDecrement());
    this.sizeMinusBtn.appendChild(createMinusIcon());
    sizeGroup.appendChild(this.sizeMinusBtn);

    this.sizeValueBtn = this.createButton('tcm-size-value', () => this.toggleSizeSubmenu());
    // Get actual fontSize from TextTool's editorState
    const textTool = getTextToolInstance();
    const actualSize = textTool?.getEditorState()?.fontSize ?? uiState.textSize;
    this.sizeValueBtn.textContent = String(actualSize);
    sizeGroup.appendChild(this.sizeValueBtn);

    this.sizePlusBtn = this.createButton('tcm-btn tcm-size-btn', () => this.handleSizeIncrement());
    this.sizePlusBtn.appendChild(createPlusIcon());
    sizeGroup.appendChild(this.sizePlusBtn);

    container.appendChild(sizeGroup);

    container.appendChild(this.createSeparator());

    // === Bold/Italic ===
    this.boldBtn = this.createButton('tcm-btn tcm-btn-format', () => this.handleBoldClick());
    this.boldBtn.appendChild(createBoldIcon());
    container.appendChild(this.boldBtn);

    this.italicBtn = this.createButton('tcm-btn tcm-btn-format', () => this.handleItalicClick());
    this.italicBtn.appendChild(createItalicIcon());
    container.appendChild(this.italicBtn);

    container.appendChild(this.createSeparator());

    // === Alignment ===
    const alignGroup = document.createElement('div');
    alignGroup.className = 'tcm-align-group';

    this.alignLeftBtn = this.createButton('tcm-btn tcm-btn-format', () => this.handleAlignClick('left'));
    this.alignLeftBtn.appendChild(createAlignLeftIcon());
    alignGroup.appendChild(this.alignLeftBtn);

    this.alignCenterBtn = this.createButton('tcm-btn tcm-btn-format', () => this.handleAlignClick('center'));
    this.alignCenterBtn.appendChild(createAlignCenterIcon());
    alignGroup.appendChild(this.alignCenterBtn);

    this.alignRightBtn = this.createButton('tcm-btn tcm-btn-format', () => this.handleAlignClick('right'));
    this.alignRightBtn.appendChild(createAlignRightIcon());
    alignGroup.appendChild(this.alignRightBtn);

    container.appendChild(alignGroup);

    container.appendChild(this.createSeparator());

    // === Color ===
    this.colorBtn = this.createButton('tcm-btn tcm-btn-color', () => this.toggleColorSubmenu());
    const colorIcon = document.createElement('span');
    colorIcon.className = 'tcm-color-icon';
    // Get actual color from TextTool's editorState
    const actualColor = textTool?.getEditorState()?.color ?? uiState.textColor;
    colorIcon.appendChild(createTextColorIcon(actualColor));
    this.colorBtn.appendChild(colorIcon);
    container.appendChild(this.colorBtn);

    container.appendChild(this.createSeparator());

    // === More ===
    const moreBtn = this.createButton('tcm-btn tcm-btn-more', () => {
      // More menu - no-op for now
    });
    moreBtn.appendChild(createMoreIcon());
    container.appendChild(moreBtn);

    // Build submenus (hidden by default)
    this.colorSubmenu = this.buildColorSubmenu();
    container.appendChild(this.colorSubmenu);

    this.sizeSubmenu = this.buildSizeSubmenu();
    container.appendChild(this.sizeSubmenu);

    // Update button states
    this.updateFormatButtons();
    this.updateAlignButtons();

    return container;
  }

  private createButton(className: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = className;
    btn.type = 'button';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    // Prevent focus stealing from editor
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });
    return btn;
  }

  private createSeparator(): HTMLDivElement {
    const sep = document.createElement('div');
    sep.className = 'tcm-separator';
    return sep;
  }

  private buildColorSubmenu(): HTMLDivElement {
    const submenu = document.createElement('div');
    submenu.className = 'tcm-submenu tcm-submenu-color tcm-hidden';

    const uiState = useDeviceUIStore.getState();
    const colors = uiState.fixedColors;
    const currentColor = uiState.textColor;

    for (const color of colors) {
      const swatch = document.createElement('button');
      swatch.className = 'tcm-color-swatch';
      if (color.toLowerCase() === currentColor.toLowerCase()) {
        swatch.classList.add('active');
      }
      swatch.style.backgroundColor = color;
      swatch.type = 'button';
      swatch.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.handleColorSelect(color);
      });
      swatch.addEventListener('mousedown', (e) => e.preventDefault());
      submenu.appendChild(swatch);
    }

    return submenu;
  }

  private buildSizeSubmenu(): HTMLDivElement {
    const submenu = document.createElement('div');
    submenu.className = 'tcm-submenu tcm-submenu-size tcm-hidden';

    const uiState = useDeviceUIStore.getState();
    const currentSize = uiState.textSize;

    for (const size of TEXT_FONT_SIZE_PRESETS) {
      const option = document.createElement('button');
      option.className = 'tcm-size-option';
      if (size === currentSize) {
        option.classList.add('active');
      }
      option.textContent = String(size);
      option.type = 'button';
      option.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.handleSizeSelect(size);
      });
      option.addEventListener('mousedown', (e) => e.preventDefault());
      submenu.appendChild(option);
    }

    return submenu;
  }

  // =========================================================================
  // Positioning
  // =========================================================================

  updatePosition(): void {
    if (!this.container || !this.editorContainer) return;

    const canvasRect = getCanvasRect();
    if (canvasRect.width === 0) return; // Canvas not mounted

    const editorRect = this.editorContainer.getBoundingClientRect();

    // Calculate visible portion (clipped to canvas)
    const visibleLeft = Math.max(editorRect.left, canvasRect.left);
    const visibleRight = Math.min(editorRect.right, canvasRect.right);
    const visibleTop = Math.max(editorRect.top, canvasRect.top);
    const visibleBottom = Math.min(editorRect.bottom, canvasRect.bottom);

    const visibleCenterX = (visibleLeft + visibleRight) / 2;
    const menuWidth = this.container.offsetWidth;
    const menuHeight = this.container.offsetHeight;
    const gap = 8;

    // Determine above vs below
    const spaceAbove = visibleTop - canvasRect.top;
    const spaceBelow = canvasRect.bottom - visibleBottom;

    let top: number;
    if (spaceAbove >= menuHeight + gap || spaceAbove > spaceBelow) {
      top = visibleTop - menuHeight - gap; // Above
    } else {
      top = visibleBottom + gap; // Below
    }

    // Horizontal: center on visible portion, clamp to canvas
    let left = visibleCenterX - menuWidth / 2;
    left = Math.max(canvasRect.left + 8, Math.min(left, canvasRect.right - menuWidth - 8));

    this.container.style.left = `${left}px`;
    this.container.style.top = `${top}px`;
  }

  private hideMenu(): void {
    if (!this.container) return;
    // Cancel any pending show timer
    if (this.settleTimeout !== null) {
      clearTimeout(this.settleTimeout);
      this.settleTimeout = null;
    }
    // Just hide - no position recalc
    this.container.classList.add('tcm-hidden');
    // Also hide any open submenus
    this.hideSubmenus();
  }

  private scheduleShow(): void {
    // This is the ONLY place updatePosition() is called during pan/zoom
    this.settleTimeout = window.setTimeout(() => {
      this.settleTimeout = null;
      this.updatePosition();
      this.container?.classList.remove('tcm-hidden');
    }, CAMERA_SETTLE_MS);
  }

  private hideSubmenus(): void {
    this.colorSubmenu?.classList.add('tcm-hidden');
    this.sizeSubmenu?.classList.add('tcm-hidden');
  }

  // =========================================================================
  // Subscriptions
  // =========================================================================

  private setupCameraSubscription(): void {
    const { scale, pan } = useCameraStore.getState();
    this.lastPan = { ...pan };
    this.lastScale = scale;

    this.cameraUnsub = useCameraStore.subscribe(
      (s) => ({ scale: s.scale, pan: s.pan }),
      ({ scale, pan }) => {
        const changed = scale !== this.lastScale || pan.x !== this.lastPan.x || pan.y !== this.lastPan.y;
        if (changed) {
          // Immediately hide (no position recalc)
          this.hideMenu();
          // Reset timer - position recalc happens ONLY after settle
          this.scheduleShow();
          this.lastPan = { ...pan };
          this.lastScale = scale;
        }
      }
    );
  }

  private setupEditorSubscription(): void {
    if (!this.editor) return;

    const syncFormatState = () => {
      const isBold = this.editor!.isActive('bold');
      const isItalic = this.editor!.isActive('italic');

      // Update local buttons
      this.boldBtn?.classList.toggle('active', isBold);
      this.italicBtn?.classList.toggle('active', isItalic);

      // Sync to UI store (for potential external consumers like ToolPanel)
      const uiStore = useDeviceUIStore.getState();
      uiStore.setTextIsBold(isBold);
      uiStore.setTextIsItalic(isItalic);
    };

    // Listen for selection/format changes
    this.editor.on('selectionUpdate', syncFormatState);
    this.editor.on('transaction', () => {
      syncFormatState();
      // Re-center menu on content change (auto-grow width)
      this.updatePosition();
    });
  }

  // =========================================================================
  // Button State Updates
  // =========================================================================

  private updateFormatButtons(): void {
    if (!this.editor) return;

    const isBold = this.editor.isActive('bold');
    const isItalic = this.editor.isActive('italic');

    this.boldBtn?.classList.toggle('active', isBold);
    this.italicBtn?.classList.toggle('active', isItalic);
  }

  private updateAlignButtons(): void {
    const uiState = useDeviceUIStore.getState();
    const align = uiState.textAlign;

    this.alignLeftBtn?.classList.toggle('active', align === 'left');
    this.alignCenterBtn?.classList.toggle('active', align === 'center');
    this.alignRightBtn?.classList.toggle('active', align === 'right');
  }

  private updateColorIcon(): void {
    if (!this.colorBtn) return;
    // Get actual color from TextTool's editorState
    const textTool = getTextToolInstance();
    const actualColor = textTool?.getEditorState()?.color ?? useDeviceUIStore.getState().textColor;
    const iconContainer = this.colorBtn.querySelector('.tcm-color-icon');
    if (iconContainer) {
      iconContainer.innerHTML = '';
      iconContainer.appendChild(createTextColorIcon(actualColor));
    }
  }

  private updateSizeValue(): void {
    if (!this.sizeValueBtn) return;
    // Get actual fontSize from TextTool's editorState
    const textTool = getTextToolInstance();
    const actualSize = textTool?.getEditorState()?.fontSize ?? useDeviceUIStore.getState().textSize;
    this.sizeValueBtn.textContent = String(actualSize);
  }

  // =========================================================================
  // Event Handlers
  // =========================================================================

  private handleBoldClick(): void {
    if (!this.editor) return;
    this.editor.chain().focus().toggleBold().run();
    this.updateFormatButtons();
  }

  private handleItalicClick(): void {
    if (!this.editor) return;
    this.editor.chain().focus().toggleItalic().run();
    this.updateFormatButtons();
  }

  private handleAlignClick(align: 'left' | 'center' | 'right'): void {
    useDeviceUIStore.getState().setTextAlign(align);
    this.updateAlignButtons();
    // TODO: Apply to editor when TextAlign extension is enabled
    this.editor?.chain().focus().run();
  }

  private handleColorSelect(color: string): void {
    // Use TextTool's updateColor method to mutate Y.Map and update DOM
    const textTool = getTextToolInstance();
    if (textTool) {
      textTool.updateColor(color);
    }

    this.updateColorIcon();
    this.hideSubmenus();
    // Refocus editor
    this.editor?.chain().focus().run();
  }

  private handleSizeSelect(size: TextFontSizePreset): void {
    // Use TextTool's updateFontSize method to mutate Y.Map and update DOM
    const textTool = getTextToolInstance();
    if (textTool) {
      textTool.updateFontSize(size);
    }

    this.updateSizeValue();
    this.hideSubmenus();

    // Reposition menu after font size change
    requestAnimationFrame(() => this.updatePosition());

    this.editor?.chain().focus().run();
  }

  private handleSizeDecrement(): void {
    const uiState = useDeviceUIStore.getState();
    const currentSize = uiState.textSize;
    const presets = TEXT_FONT_SIZE_PRESETS;
    const currentIndex = presets.indexOf(currentSize as TextFontSizePreset);
    if (currentIndex > 0) {
      this.handleSizeSelect(presets[currentIndex - 1]);
    }
    this.editor?.chain().focus().run();
  }

  private handleSizeIncrement(): void {
    const uiState = useDeviceUIStore.getState();
    const currentSize = uiState.textSize;
    const presets = TEXT_FONT_SIZE_PRESETS;
    const currentIndex = presets.indexOf(currentSize as TextFontSizePreset);
    if (currentIndex < presets.length - 1 && currentIndex !== -1) {
      this.handleSizeSelect(presets[currentIndex + 1]);
    }
    this.editor?.chain().focus().run();
  }

  private toggleColorSubmenu(): void {
    if (!this.colorSubmenu || !this.colorBtn || !this.container) return;

    const isHidden = this.colorSubmenu.classList.contains('tcm-hidden');
    this.hideSubmenus();

    if (isHidden) {
      // Position submenu below the color button
      const btnRect = this.colorBtn.getBoundingClientRect();
      const containerRect = this.container.getBoundingClientRect();

      this.colorSubmenu.style.left = `${btnRect.left - containerRect.left}px`;
      this.colorSubmenu.style.top = `${btnRect.bottom - containerRect.top + 4}px`;
      this.colorSubmenu.classList.remove('tcm-hidden');

      // Update active state
      const uiState = useDeviceUIStore.getState();
      const swatches = this.colorSubmenu.querySelectorAll('.tcm-color-swatch');
      swatches.forEach((swatch) => {
        const btn = swatch as HTMLButtonElement;
        const isActive = btn.style.backgroundColor.toLowerCase() === uiState.textColor.toLowerCase() ||
          this.rgbToHex(btn.style.backgroundColor).toLowerCase() === uiState.textColor.toLowerCase();
        btn.classList.toggle('active', isActive);
      });
    }
  }

  private toggleSizeSubmenu(): void {
    if (!this.sizeSubmenu || !this.sizeValueBtn || !this.container) return;

    const isHidden = this.sizeSubmenu.classList.contains('tcm-hidden');
    this.hideSubmenus();

    if (isHidden) {
      // Position submenu below the size value
      const btnRect = this.sizeValueBtn.getBoundingClientRect();
      const containerRect = this.container.getBoundingClientRect();

      this.sizeSubmenu.style.left = `${btnRect.left - containerRect.left}px`;
      this.sizeSubmenu.style.top = `${btnRect.bottom - containerRect.top + 4}px`;
      this.sizeSubmenu.classList.remove('tcm-hidden');

      // Update active state
      const uiState = useDeviceUIStore.getState();
      const options = this.sizeSubmenu.querySelectorAll('.tcm-size-option');
      options.forEach((option) => {
        const btn = option as HTMLButtonElement;
        const size = parseInt(btn.textContent || '0', 10);
        btn.classList.toggle('active', size === uiState.textSize);
      });
    }
  }

  private rgbToHex(rgb: string): string {
    // Convert "rgb(r, g, b)" to "#rrggbb"
    const match = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (!match) return rgb;
    const r = parseInt(match[1], 10).toString(16).padStart(2, '0');
    const g = parseInt(match[2], 10).toString(16).padStart(2, '0');
    const b = parseInt(match[3], 10).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  }
}

// Module-level singleton
export const textContextMenu = new TextContextMenu();
