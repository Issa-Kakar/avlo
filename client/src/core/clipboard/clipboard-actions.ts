/**
 * Clipboard Actions - Copy, paste, cut, duplicate, selectAll
 *
 * Uses nonce-based clipboard ordering to distinguish internal paste
 * (full fidelity from in-memory data) from external text paste.
 * Supports rich text (bold/italic/highlight) from external HTML.
 *
 * @module lib/clipboard/clipboard-actions
 */

import { normalizeUrl } from '@avlo/shared';
import { generateJSON } from '@tiptap/core';
import Bold from '@tiptap/extension-bold';
import Document from '@tiptap/extension-document';
import Highlight from '@tiptap/extension-highlight';
import Italic from '@tiptap/extension-italic';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { ulid } from 'ulid';
import * as Y from 'yjs';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import { getLastCursorWorld } from '@/runtime/cursor-tracking';
import { getObjects, getObjectsById, getSpatialIndex, transact } from '@/runtime/room-runtime';
import { getCurrentTool } from '@/runtime/tool-registry';
import { animateToFit } from '@/runtime/viewport/zoom';
import { getVisibleBoundsTuple, useCameraStore } from '@/stores/camera-store';
import { getUserId, useDeviceUIStore } from '@/stores/device-ui-store';
import { useSelectionStore } from '@/stores/selection-store';
import { deleteSelected } from '@/tools/selection/selection-actions';
import { beginUnfurl, canCreateBookmark } from '../bookmark/bookmark-unfurl';
import { bboxCenter, bboxSize, translateBBox, translateFrame, translatePoint, translatePoints } from '../geometry/bounds';
import { createImageFromBlob } from '../image/image-actions';
import { enqueue } from '../image/image-manager';
import { anchorFactor } from '../text/text-system';
import { type BBoxTuple, bboxTupleToWorldBounds, type FrameTuple, type Point } from '../types/geometry';
import type { ConnectorEndpoint, StoredAnchor } from '../types/objects';
import {
  type ClipboardPayload,
  DEFAULT_HIGHLIGHT,
  deserializeFragment,
  extractPlainText,
  isSerializedPayload,
  type MarkAttrs,
  serializeObjects,
} from './clipboard-serializer';

// === Constants ===

const PASTE_CHAR_LIMIT = 50_000;
const PASTE_EXTENSIONS = [Document, Paragraph, Text, Bold, Italic, Highlight.configure({ multicolor: true })];

// === ProseMirror JSON shape (from @tiptap/core generateJSON) ===

interface PMMark {
  type: string;
  attrs?: { color?: string };
}
interface PMNode {
  type: string;
  text?: string;
  content?: PMNode[];
  marks?: PMMark[];
}
interface PMDoc {
  content?: PMNode[];
}

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

  const plainText = extractPlainText(payload.objects) || ' ';

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
  if (!isSerializedPayload(payload)) return;

  const idMap = new Map<string, string>();
  for (const obj of payload.objects) {
    idMap.set(obj.props.id, ulid());
  }

  // Compute position offset
  let dx: number, dy: number;
  if (offset) {
    [dx, dy] = offset;
  } else {
    const [tx, ty] = getPasteTarget();
    const [cx, cy] = bboxCenter(payload.bounds);
    dx = tx - cx;
    dy = ty - cy;
  }

  const userId = getUserId();
  const now = Date.now();

  transact(() => {
    const objects = getObjects();
    for (const obj of payload.objects) {
      const newId = idMap.get(obj.props.id)!;
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
          case 'frame':
            yObj.set('frame', translateFrame(value as FrameTuple, dx, dy));
            break;
          case 'origin':
            yObj.set('origin', translatePoint(value as Point, dx, dy));
            break;
          case 'points':
            // Strokes still use `points`; connectors no longer do.
            yObj.set('points', translatePoints(value as Point[], dx, dy));
            break;
          case 'start':
          case 'end': {
            // Connector endpoint union. Free Point → translate. StoredAnchor:
            //   remap → in paste set → write remapped anchor.
            //   else target exists in canvas → keep anchor (rebinds correctly).
            //   else cached endpoint → translate cached point as a free Point (no
            //     dangling anchor.id leaks into the connector layer).
            //   else last-ditch payload bbox center as a free Point.
            // NOTE: deferred — offline/online sync corruption (peer A binds, peer B
            //   deletes the shape pre-sync) will be handled deterministically once
            //   the shadow-POJO-for-props refactor lands.
            const ep = value as ConnectorEndpoint;
            if (Array.isArray(ep)) {
              yObj.set(key, translatePoint(ep as Point, dx, dy));
            } else {
              const stored = ep as StoredAnchor;
              const remapped = remapAnchor(stored, idMap);
              if (remapped) {
                yObj.set(key, remapped);
              } else if (getObjectsById().has(stored.id)) {
                yObj.set(key, stored);
              } else {
                const cached = key === 'start' ? obj.cachedStart : obj.cachedEnd;
                const fallback: Point = cached ? translatePoint(cached, dx, dy) : translatePoint(bboxCenter(payload.bounds), dx, dy);
                yObj.set(key, fallback);
              }
            }
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
      if (obj.textContent !== undefined) {
        const yText = new Y.Text();
        yText.insert(0, obj.textContent);
        yObj.set('content', yText);
      }

      objects.set(newId, yObj);
    }
  });

  // Enqueue image assets for upload (viewport management handles decode)
  for (const obj of payload.objects) {
    if (obj.kind === 'image' && typeof obj.props.assetId === 'string') {
      enqueue(obj.props.assetId);
    }
    // v2: internal-pasted bookmarks have all data present. No re-unfurl needed.
  }

  // Only switch tool + select when no gesture is active
  const newIds = payload.objects.map((obj) => idMap.get(obj.props.id)!);
  if (!getCurrentTool()?.isActive()) {
    useDeviceUIStore.getState().setActiveTool('select');
    useSelectionStore.getState().setSelection(newIds);
    invalidateOverlay();
  }

  // Zoom-to-fit if placed bounds are off-screen
  ensureVisible(translateBBox(payload.bounds, dx, dy));
}

function remapAnchor(anchor: StoredAnchor, idMap: Map<string, string>): StoredAnchor | null {
  const newId = idMap.get(anchor.id);
  return newId ? { ...anchor, id: newId } : null;
}

// === External HTML Paste ===

function pasteExternalHtml(html: string): void {
  // Strip avlo nonce comment if present
  const cleaned = html.replace(/<!-- avlo:[a-f0-9-]+ -->/, '');

  // Extract plain text for char limit check
  const plainText = cleaned.replace(/<[^>]*>/g, '');
  if (!plainText.trim()) return;

  // URL detection — check if plain text starts with a URL
  const urlResult = extractLeadingUrl(plainText);
  if (urlResult) {
    createBookmarkFromUrl(urlResult.url);
    if (urlResult.remainder) {
      pasteExternalText(urlResult.remainder);
    }
    return;
  }

  if (plainText.length > PASTE_CHAR_LIMIT) {
    // Over limit — fall back to truncated plain text
    pasteExternalText(plainText.slice(0, PASTE_CHAR_LIMIT));
    return;
  }

  // Parse HTML to ProseMirror JSON
  let doc: PMDoc;
  try {
    doc = generateJSON(cleaned, PASTE_EXTENSIONS) as PMDoc;
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

function prosemirrorJsonToFragment(doc: PMDoc): Y.XmlFragment | null {
  if (!doc.content) return null;

  // Collect paragraphs into a plain array and batch-insert at index 0 to avoid
  // `.length` reads on the pending fragment / xmlText (see deserializeFragment).
  const paragraphs: Y.XmlElement[] = [];
  let hasContent = false;

  for (const node of doc.content) {
    if (node.type !== 'paragraph') continue;

    const para = new Y.XmlElement('paragraph');
    const xmlText = new Y.XmlText();
    let textPos = 0;

    if (node.content) {
      for (const inline of node.content) {
        if (inline.type !== 'text' || typeof inline.text !== 'string') continue;

        const attrs: MarkAttrs = {};
        if (inline.marks) {
          for (const mark of inline.marks) {
            if (mark.type === 'bold') attrs.bold = true;
            else if (mark.type === 'italic') attrs.italic = true;
            else if (mark.type === 'highlight') attrs.highlight = mark.attrs?.color || DEFAULT_HIGHLIGHT;
          }
        }

        // `{}` not undefined — Yjs treats undefined as "inherit currentAttributes" and leaks the prior segment's marks into this one.
        xmlText.insert(textPos, inline.text, attrs);
        textPos += inline.text.length;
        if (inline.text) hasContent = true;
      }
    }

    para.insert(0, [xmlText]);
    paragraphs.push(para);
  }

  if (!hasContent) return null;

  const fragment = new Y.XmlFragment();
  fragment.insert(0, paragraphs);
  return fragment;
}

// === Paste URL as Text ===

export function pasteUrlAsText(url: string, worldX: number, worldY: number, objectId?: string): void {
  const para = new Y.XmlElement('paragraph');
  const xmlText = new Y.XmlText();
  xmlText.insert(0, url);
  para.insert(0, [xmlText]);
  const fragment = new Y.XmlFragment();
  fragment.insert(0, [para]);
  createPastedTextObject(fragment, url.length, [worldX, worldY], objectId);
}

// === Shared Text Object Creation ===

function createPastedTextObject(fragment: Y.XmlFragment, charCount: number, position?: [number, number], existingId?: string): void {
  const { textSize: fontSize, textFontFamily: fontFamily, textColor: color, textAlign: align, textFillColor } = useDeviceUIStore.getState();

  const [worldX, worldY] = position ?? getPasteTarget();
  const objectId = existingId ?? ulid();
  const userId = getUserId();
  const pasteWidth: number | 'auto' = charCount < 65 ? 'auto' : Math.max(300, fontSize * 34);

  // Horizontally center the text box on worldX. Deterministic only when the
  // boxWidth is known (fixed-width pastes); auto-width left/right would need
  // a layout measurement, so we leave origin at worldX there. Center-align
  // collapses to worldX regardless of width (handled by the same formula).
  const originX = typeof pasteWidth === 'number' ? worldX + pasteWidth * (anchorFactor(align) - 0.5) : worldX;

  transact(() => {
    const yObj = new Y.Map<unknown>();
    yObj.set('id', objectId);
    yObj.set('kind', 'text');
    yObj.set('origin', [originX, worldY]);
    yObj.set('fontSize', fontSize);
    yObj.set('fontFamily', fontFamily);
    yObj.set('color', color);
    yObj.set('align', align);
    yObj.set('width', pasteWidth);
    yObj.set('content', fragment);

    if (textFillColor) yObj.set('fillColor', textFillColor);
    yObj.set('ownerId', userId);
    yObj.set('createdAt', Date.now());

    getObjects().set(objectId, yObj);
  });

  if (!getCurrentTool()?.isActive()) {
    useDeviceUIStore.getState().setActiveTool('select');
    useSelectionStore.getState().setSelection([objectId]);
    invalidateOverlay();
  }

  // Zoom-to-fit for fixed-width pastes (auto = short text, already near viewport).
  // Bbox is symmetric around worldX after the originX shift.
  if (typeof pasteWidth === 'number') {
    ensureVisible([worldX - pasteWidth / 2, worldY, worldX + pasteWidth / 2, worldY]);
  }
}

// === URL Detection ===

/**
 * Check if text starts with a standalone URL (possibly followed by more text on new lines).
 * Returns { url, remainder } if the first line is a valid URL, null otherwise.
 */
function extractLeadingUrl(text: string): { url: string; remainder: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const newlineIdx = trimmed.indexOf('\n');
  const firstLine = newlineIdx === -1 ? trimmed : trimmed.slice(0, newlineIdx).trim();
  const url = normalizeUrl(firstLine);
  if (!url) return null;
  const remainder = newlineIdx === -1 ? '' : trimmed.slice(newlineIdx + 1).trim();
  return { url, remainder };
}

function createBookmarkFromUrl(url: string): void {
  const [worldX, worldY] = getPasteTarget();
  if (!canCreateBookmark()) {
    pasteUrlAsText(url, worldX, worldY);
    return;
  }
  beginUnfurl(url, worldX, worldY);
}

// === External Text Paste ===

function pasteExternalText(text: string): void {
  if (!text.trim()) return;

  // URL detection — if text starts with a URL, create bookmark (+ paste remainder as text)
  const urlResult = extractLeadingUrl(text);
  if (urlResult) {
    createBookmarkFromUrl(urlResult.url);
    if (urlResult.remainder) {
      // Paste the remainder as a separate text object
      pasteExternalText(urlResult.remainder);
    }
    return;
  }

  // Character limit
  const truncated = text.length > PASTE_CHAR_LIMIT ? text.slice(0, PASTE_CHAR_LIMIT) : text;

  // Build paragraphs in a plain array, then batch-insert into the fragment at
  // index 0 — avoids reading `.length` on the pending fragment.
  const paragraphs: Y.XmlElement[] = [];
  for (const line of truncated.split('\n')) {
    const para = new Y.XmlElement('paragraph');
    const xmlText = new Y.XmlText();
    if (line) xmlText.insert(0, line);
    para.insert(0, [xmlText]);
    paragraphs.push(para);
  }
  const fragment = new Y.XmlFragment();
  fragment.insert(0, paragraphs);

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
  const objectsById = getObjectsById();
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

function computeSmartOffset(bounds: BBoxTuple, excludeIds: Set<string>): [number, number] {
  const spatialIndex = getSpatialIndex();
  const [w, h] = bboxSize(bounds);
  const gap = 20;
  const eps = 2;

  // Try: right, below, above, left
  const directions: Array<[number, number]> = [
    [w + gap, 0],
    [0, h + gap],
    [0, -(h + gap)],
    [-(w + gap), 0],
  ];

  for (const [dx, dy] of directions) {
    const query: BBoxTuple = [bounds[0] + dx - eps, bounds[1] + dy - eps, bounds[2] + dx + eps, bounds[3] + dy + eps];
    if (!spatialIndex.queryBBox(query).some((r) => !excludeIds.has(r.id))) return [dx, dy];
  }

  // Fallback
  return [40, 40];
}

// === Visibility ===

function ensureVisible(bounds: BBoxTuple): void {
  const vp = getVisibleBoundsTuple();
  // Already fully contained — nothing to do
  if (bounds[0] >= vp[0] && bounds[2] <= vp[2] && bounds[1] >= vp[1] && bounds[3] <= vp[3]) return;
  const { scale } = useCameraStore.getState();
  // Only zoom out (cap at current scale), floor at 25% to avoid extreme zoom-out
  animateToFit(bboxTupleToWorldBounds(bounds), 80, scale, 0.25);
}

// === Helpers ===

function getPasteTarget(): [number, number] {
  const cursor = getLastCursorWorld();
  if (cursor) return cursor;
  return bboxCenter(getVisibleBoundsTuple());
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
