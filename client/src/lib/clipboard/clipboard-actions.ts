/**
 * Clipboard Actions - Copy, paste, cut, duplicate, selectAll
 *
 * Uses nonce-based clipboard ordering to distinguish internal paste
 * (full fidelity from in-memory data) from external text paste.
 *
 * @module lib/clipboard/clipboard-actions
 */

import * as Y from 'yjs';
import { ulid } from 'ulid';
import { getActiveRoomDoc, getCurrentSnapshot } from '@/canvas/room-runtime';
import { getCurrentTool } from '@/canvas/tool-registry';
import { useSelectionStore } from '@/stores/selection-store';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { invalidateOverlay } from '@/canvas/invalidation-helpers';
import { getLastCursorWorld } from '@/canvas/cursor-tracking';
import { getVisibleWorldBounds } from '@/stores/camera-store';
import { deleteSelected } from '@/lib/utils/selection-actions';
import { userProfileManager } from '@/lib/user-profile-manager';
import {
  serializeObjects,
  deserializeFragment,
  extractPlainText,
  type ClipboardPayload,
} from './clipboard-serializer';

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
      // Check for HTML with nonce
      if (item.types.includes('text/html')) {
        const blob = await item.getType('text/html');
        const html = await blob.text();
        const match = html.match(/<!-- avlo:([a-f0-9-]+) -->/);

        if (match && match[1] === clipboardNonce && clipboardPayload) {
          pasteInternal(clipboardPayload);
          return;
        }

        // Nonce mismatch — clipboard was overwritten externally
        clipboardNonce = null;
        clipboardPayload = null;
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

  // Only switch tool + select when no gesture is active
  const newIds = payload.objects.map((obj) => idMap.get(obj.props.id as string)!);
  if (getCurrentTool()?.isActive()) {
    // Mid-gesture: just create objects, don't interrupt
  } else {
    useDeviceUIStore.getState().setActiveTool('select');
    useSelectionStore.getState().setSelection(newIds);
    invalidateOverlay();
  }
}

// === External Text Paste ===

function pasteExternalText(text: string): void {
  if (!text.trim()) return;

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
    yObj.set('width', 'auto');

    // Build content from text lines
    const fragment = new Y.XmlFragment();
    const lines = text.split('\n');
    for (const line of lines) {
      const para = new Y.XmlElement('paragraph');
      const xmlText = new Y.XmlText();
      if (line) xmlText.insert(0, line);
      para.insert(0, [xmlText]);
      fragment.insert(fragment.length, [para]);
    }
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

  pasteInternal(payload, [20, 20]);
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
