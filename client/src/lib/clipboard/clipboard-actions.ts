/**
 * Clipboard Actions - Copy, paste, cut, duplicate, selectAll
 *
 * Uses nonce-based clipboard ordering to distinguish internal paste
 * (full fidelity from in-memory data) from external text paste.
 * Supports rich text (bold/italic/highlight) from external HTML.
 *
 * @module lib/clipboard/clipboard-actions
 */

import * as Y from 'yjs';
import { ulid } from 'ulid';
import { generateJSON } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import Bold from '@tiptap/extension-bold';
import Italic from '@tiptap/extension-italic';
import Highlight from '@tiptap/extension-highlight';
import { getActiveRoomDoc, getCurrentSnapshot } from '@/canvas/room-runtime';
import { getCurrentTool } from '@/canvas/tool-registry';
import { useSelectionStore } from '@/stores/selection-store';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { invalidateOverlay } from '@/canvas/invalidation-helpers';
import { getLastCursorWorld } from '@/canvas/cursor-tracking';
import { getVisibleWorldBounds, useCameraStore } from '@/stores/camera-store';
import { animateToFit } from '@/canvas/animation/ZoomAnimator';
import { deleteSelected } from '@/lib/utils/selection-actions';
import { userProfileManager } from '@/lib/user-profile-manager';
import type { WorldBounds } from '@avlo/shared';
import {
  serializeObjects,
  deserializeFragment,
  extractPlainText,
  type ClipboardPayload,
} from './clipboard-serializer';
import { createImageFromBlob } from '@/lib/image/image-actions';
import { requestLoad, enqueue } from '@/lib/image/image-manager';

// === Constants ===

const PASTE_CHAR_LIMIT = 50_000;
const PASTE_EXTENSIONS = [
  Document, Paragraph, Text, Bold, Italic,
  Highlight.configure({ multicolor: true }),
];

// === Nonce State ===

let clipboardNonce: string | null = null;
let clipboardPayload: ClipboardPayload | null = null;

// === Copy ===

export async function copySelected(): Promise<void> {
  const { selectedIds } = useSelectionStore.getState();
  if (selectedIds.length === 0) return;

  const payload = serializeObjects(selectedIds);
  if (!payload) return;

  const nonce = crypto.randomUUID();
  clipboardNonce = nonce;
  clipboardPayload = payload;

  const plainText = extractPlainText(payload.objects) || 'Avlo objects';

  try {
    const htmlContent = `<!-- avlo:${nonce} -->${escapeHtml(plainText)}`;
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([plainText], { type: 'text/plain' }),
        'text/html': new Blob([htmlContent], { type: 'text/html' }),
      }),
    ]);
  } catch {
    // Fallback: writeText
    try {
      await navigator.clipboard.writeText(plainText);
    } catch {
      // Clipboard API unavailable
    }
  }
}

// === Paste ===

export async function pasteFromClipboard(): Promise<void> {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      // Check for image types first
      const imageType = item.types.find((t) => t.startsWith('image/'));
      if (imageType) {
        const blob = await item.getType(imageType);
        await pasteImage(blob);
        return;
      }

      // Check for HTML with nonce
      if (item.types.includes('text/html')) {
        const blob = await item.getType('text/html');
        const html = await blob.text();
        const match = html.match(/<!-- avlo:([a-f0-9-]+) -->/);

        if (match && match[1] === clipboardNonce && clipboardPayload) {
          pasteInternal(clipboardPayload);
          return;
        }

        // Nonce mismatch — external HTML
        clipboardNonce = null;
        clipboardPayload = null;

        pasteExternalHtml(html);
        return;
      }

      // Fallback: plain text
      if (item.types.includes('text/plain')) {
        const blob = await item.getType('text/plain');
        const text = await blob.text();
        pasteExternalText(text);
        return;
      }
    }
  } catch {
    // Fallback: readText
    try {
      const text = await navigator.clipboard.readText();
      if (text) pasteExternalText(text);
    } catch {
      // Clipboard API unavailable
    }
  }
}

// === Internal Paste ===

function pasteInternal(payload: ClipboardPayload, offset?: [number, number]): void {
  const idMap = new Map<string, string>();
  for (const obj of payload.objects) {
    const oldId = obj.props.id as string;
    idMap.set(oldId, ulid());
  }

  // Compute position offset
  let dx: number, dy: number;
  if (offset) {
    dx = offset[0];
    dy = offset[1];
  } else {
    const target = getPasteTarget();
    const cx = (payload.bounds.minX + payload.bounds.maxX) / 2;
    const cy = (payload.bounds.minY + payload.bounds.maxY) / 2;
    dx = target[0] - cx;
    dy = target[1] - cy;
  }

  const userId = userProfileManager.getIdentity().userId;
  const now = Date.now();

  getActiveRoomDoc().mutate((ydoc) => {
    const objects = ydoc.getMap('root').get('objects') as Y.Map<Y.Map<unknown>>;

    for (const obj of payload.objects) {
      const oldId = obj.props.id as string;
      const newId = idMap.get(oldId)!;
      const yObj = new Y.Map<unknown>();

      // Copy all props with remapping
      for (const [key, value] of Object.entries(obj.props)) {
        switch (key) {
          case 'id':
            yObj.set('id', newId);
            break;
          case 'ownerId':
            yObj.set('ownerId', userId);
            break;
          case 'createdAt':
            yObj.set('createdAt', now);
            break;
          case 'frame': {
            const [fx, fy, fw, fh] = value as [number, number, number, number];
            yObj.set('frame', [fx + dx, fy + dy, fw, fh]);
            break;
          }
          case 'origin': {
            const [ox, oy] = value as [number, number];
            yObj.set('origin', [ox + dx, oy + dy]);
            break;
          }
          case 'points': {
            const pts = (value as [number, number][]).map(([px, py]) => [px + dx, py + dy]);
            yObj.set('points', pts);
            break;
          }
          case 'start': {
            const [sx, sy] = value as [number, number];
            yObj.set('start', [sx + dx, sy + dy]);
            break;
          }
          case 'end': {
            const [ex, ey] = value as [number, number];
            yObj.set('end', [ex + dx, ey + dy]);
            break;
          }
          case 'startAnchor':
          case 'endAnchor': {
            const anchor = value as { id: string; side: string; anchor: [number, number] };
            const remappedId = idMap.get(anchor.id);
            if (remappedId) {
              yObj.set(key, { ...anchor, id: remappedId });
            }
            // Strip anchor if referencing object not in paste set
            break;
          }
          default:
            yObj.set(key, value);
        }
      }

      // Deserialize content
      if (obj.content) {
        yObj.set('content', deserializeFragment(obj.content));
      }

      objects.set(newId, yObj);
    }
  });

  // Ensure image assets are loaded + enqueued for pasted image objects
  for (const obj of payload.objects) {
    if (obj.kind === 'image' && typeof obj.props.assetId === 'string') {
      requestLoad(obj.props.assetId);
      enqueue(obj.props.assetId);
    }
  }

  // Only switch tool + select when no gesture is active
  const newIds = payload.objects.map((obj) => idMap.get(obj.props.id as string)!);
  if (getCurrentTool()?.isActive()) {
    // Mid-gesture: just create objects, don't interrupt
  } else {
    useDeviceUIStore.getState().setActiveTool('select');
    useSelectionStore.getState().setSelection(newIds);
    invalidateOverlay();
  }

  // Zoom-to-fit if placed bounds are off-screen
  const placedBounds: WorldBounds = {
    minX: payload.bounds.minX + dx,
    minY: payload.bounds.minY + dy,
    maxX: payload.bounds.maxX + dx,
    maxY: payload.bounds.maxY + dy,
  };
  ensureVisible(placedBounds);
}

// === External HTML Paste ===

function pasteExternalHtml(html: string): void {
  // Strip avlo nonce comment if present
  const cleaned = html.replace(/<!-- avlo:[a-f0-9-]+ -->/, '');

  // Extract plain text for char limit check
  const plainText = cleaned.replace(/<[^>]*>/g, '');
  if (!plainText.trim()) return;

  if (plainText.length > PASTE_CHAR_LIMIT) {
    // Over limit — fall back to truncated plain text
    pasteExternalText(plainText.slice(0, PASTE_CHAR_LIMIT));
    return;
  }

  // Parse HTML to ProseMirror JSON
  let doc: Record<string, any>;
  try {
    doc = generateJSON(cleaned, PASTE_EXTENSIONS);
  } catch {
    // Parse failure — fall back to plain text
    pasteExternalText(plainText);
    return;
  }

  const fragment = prosemirrorJsonToFragment(doc);
  if (!fragment) {
    pasteExternalText(plainText);
    return;
  }

  createPastedTextObject(fragment, plainText.length);
}

// === ProseMirror JSON → Y.XmlFragment ===

function prosemirrorJsonToFragment(doc: Record<string, any>): Y.XmlFragment | null {
  if (!doc.content || !Array.isArray(doc.content)) return null;

  const fragment = new Y.XmlFragment();
  let hasContent = false;

  for (const node of doc.content) {
    if (node.type !== 'paragraph') continue;

    const para = new Y.XmlElement('paragraph');
    const xmlText = new Y.XmlText();

    if (node.content && Array.isArray(node.content)) {
      for (const inline of node.content) {
        if (inline.type !== 'text' || typeof inline.text !== 'string') continue;

        const attrs: Record<string, any> = {};
        if (inline.marks && Array.isArray(inline.marks)) {
          for (const mark of inline.marks) {
            switch (mark.type) {
              case 'bold':
                attrs.bold = true;
                break;
              case 'italic':
                attrs.italic = true;
                break;
              case 'highlight':
                attrs.highlight = mark.attrs?.color || '#ffd43b';
                break;
            }
          }
        }

        xmlText.insert(xmlText.length, inline.text, Object.keys(attrs).length > 0 ? attrs : undefined);
        if (inline.text) hasContent = true;
      }
    }

    para.insert(0, [xmlText]);
    fragment.insert(fragment.length, [para]);
  }

  return hasContent ? fragment : null;
}

// === Shared Text Object Creation ===

function createPastedTextObject(fragment: Y.XmlFragment, charCount: number): void {
  const {
    textSize: fontSize,
    textFontFamily: fontFamily,
    textColor: color,
    textAlign: align,
    textFillColor,
  } = useDeviceUIStore.getState();

  const [worldX, worldY] = getPasteTarget();
  const objectId = ulid();
  const userId = userProfileManager.getIdentity().userId;
  const pasteWidth: number | 'auto' = charCount < 65 ? 'auto' : Math.max(300, fontSize * 34);

  getActiveRoomDoc().mutate((ydoc) => {
    const objects = ydoc.getMap('root').get('objects') as Y.Map<Y.Map<unknown>>;

    const yObj = new Y.Map<unknown>();
    yObj.set('id', objectId);
    yObj.set('kind', 'text');
    yObj.set('origin', [worldX, worldY]);
    yObj.set('fontSize', fontSize);
    yObj.set('fontFamily', fontFamily);
    yObj.set('color', color);
    yObj.set('align', align);
    yObj.set('width', pasteWidth);
    yObj.set('content', fragment);

    if (textFillColor) yObj.set('fillColor', textFillColor);
    yObj.set('ownerId', userId);
    yObj.set('createdAt', Date.now());

    objects.set(objectId, yObj);
  });

  if (!getCurrentTool()?.isActive()) {
    useDeviceUIStore.getState().setActiveTool('select');
    useSelectionStore.getState().setSelection([objectId]);
    invalidateOverlay();
  }

  // Zoom-to-fit for fixed-width pastes (auto = short text, already near viewport)
  if (typeof pasteWidth === 'number') {
    ensureVisible({ minX: worldX, minY: worldY, maxX: worldX + pasteWidth, maxY: worldY });
  }
}

// === External Text Paste ===

function pasteExternalText(text: string): void {
  if (!text.trim()) return;

  // Character limit
  const truncated = text.length > PASTE_CHAR_LIMIT ? text.slice(0, PASTE_CHAR_LIMIT) : text;

  // Build plain Y.XmlFragment from text lines
  const fragment = new Y.XmlFragment();
  const lines = truncated.split('\n');
  for (const line of lines) {
    const para = new Y.XmlElement('paragraph');
    const xmlText = new Y.XmlText();
    if (line) xmlText.insert(0, line);
    para.insert(0, [xmlText]);
    fragment.insert(fragment.length, [para]);
  }

  createPastedTextObject(fragment, truncated.length);
}

// === Cut ===

export async function cutSelected(): Promise<void> {
  await copySelected();
  deleteSelected();
}

// === Duplicate ===

export function duplicateSelected(): void {
  const { selectedIds } = useSelectionStore.getState();
  if (selectedIds.length === 0) return;

  const payload = serializeObjects(selectedIds);
  if (!payload) return;

  const offset = computeSmartOffset(payload.bounds, new Set(selectedIds));
  pasteInternal(payload, offset);
}

// === Select All ===

export function selectAll(): void {
  const { objectsById } = getCurrentSnapshot();
  const ids = Array.from(objectsById.keys());
  if (ids.length === 0) return;

  useDeviceUIStore.getState().setActiveTool('select');
  useSelectionStore.getState().setSelection(ids);
  invalidateOverlay();
}

// === Image Paste ===

async function pasteImage(blob: Blob): Promise<void> {
  const [worldX, worldY] = getPasteTarget();
  await createImageFromBlob(blob, worldX, worldY, {
    selectAfter: !getCurrentTool()?.isActive(),
  });
}

/** Public API for pasting an image blob (used by drag-drop). */
export { pasteImage };

// === Smart Duplicate Offset ===

function computeSmartOffset(bounds: WorldBounds, excludeIds: Set<string>): [number, number] {
  const { spatialIndex } = getCurrentSnapshot();
  if (!spatialIndex) return [40, 40];
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  const gap = 20;
  const eps = 2;

  // Try: right, below, above, left
  const candidates: [number, number, WorldBounds][] = [
    [w + gap, 0, { minX: bounds.maxX + gap - eps, minY: bounds.minY - eps, maxX: bounds.maxX + gap + w + eps, maxY: bounds.maxY + eps }],
    [0, h + gap, { minX: bounds.minX - eps, minY: bounds.maxY + gap - eps, maxX: bounds.maxX + eps, maxY: bounds.maxY + gap + h + eps }],
    [0, -(h + gap), { minX: bounds.minX - eps, minY: bounds.minY - gap - h - eps, maxX: bounds.maxX + eps, maxY: bounds.minY - gap + eps }],
    [-(w + gap), 0, { minX: bounds.minX - gap - w - eps, minY: bounds.minY - eps, maxX: bounds.minX - gap + eps, maxY: bounds.maxY + eps }],
  ];

  for (const [dx, dy, queryBounds] of candidates) {
    const results = spatialIndex.query(queryBounds);
    const hasCollision = results.some((r) => !excludeIds.has(r.id));
    if (!hasCollision) return [dx, dy];
  }

  // Fallback
  return [40, 40];
}

// === Visibility ===

function ensureVisible(bounds: WorldBounds): void {
  const vp = getVisibleWorldBounds();
  // Already fully contained — nothing to do
  if (bounds.minX >= vp.minX && bounds.maxX <= vp.maxX &&
      bounds.minY >= vp.minY && bounds.maxY <= vp.maxY) return;
  const { scale } = useCameraStore.getState();
  // Only zoom out (cap at current scale), floor at 25% to avoid extreme zoom-out
  animateToFit(bounds, 80, scale, 0.25);
}

// === Helpers ===

function getPasteTarget(): [number, number] {
  const cursor = getLastCursorWorld();
  if (cursor) return cursor;

  const vp = getVisibleWorldBounds();
  return [(vp.minX + vp.maxX) / 2, (vp.minY + vp.maxY) / 2];
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
