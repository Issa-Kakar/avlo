/**
 * Clipboard Serializer - Serialize/deserialize whiteboard objects for clipboard
 *
 * Handles conversion between live Y.Map objects and JSON-safe representations.
 * Y.XmlFragment content is serialized as delta arrays per paragraph.
 *
 * @module lib/clipboard/clipboard-serializer
 */

import * as Y from 'yjs';
import type { ObjectKind, WorldBounds, ObjectHandle } from '@avlo/shared';
import { getCurrentSnapshot } from '@/canvas/room-runtime';

// === Types ===

export interface ClipboardPayload {
  version: 1;
  objects: SerializedObject[];
  bounds: WorldBounds;
}

export interface SerializedObject {
  kind: ObjectKind;
  props: Record<string, unknown>;
  content?: SerializedContent;
}

export interface SerializedContent {
  paragraphs: SerializedParagraph[];
}

export interface SerializedParagraph {
  delta: { insert: string; attributes?: Record<string, unknown> }[];
}

// === Serialize ===

export function serializeObjects(ids: string[]): ClipboardPayload | null {
  const { objectsById } = getCurrentSnapshot();
  const objects: SerializedObject[] = [];

  for (const id of ids) {
    const handle = objectsById.get(id);
    if (!handle) continue;
    objects.push(serializeHandle(handle));
  }

  if (objects.length === 0) return null;

  return {
    version: 1,
    objects,
    bounds: computePayloadBounds(objects),
  };
}

function serializeHandle(handle: ObjectHandle): SerializedObject {
  const props: Record<string, unknown> = {};
  let content: SerializedContent | undefined;

  for (const [key, value] of handle.y.entries()) {
    if (key === 'content' && value instanceof Y.XmlFragment) {
      content = serializeFragment(value);
    } else {
      props[key] = value;
    }
  }

  return { kind: handle.kind, props, content };
}

export function serializeFragment(fragment: Y.XmlFragment): SerializedContent {
  const paragraphs: SerializedParagraph[] = [];

  fragment.forEach((node) => {
    if (node instanceof Y.XmlElement && node.nodeName === 'paragraph') {
      const delta: SerializedParagraph['delta'] = [];
      node.forEach((child) => {
        if (child instanceof Y.XmlText) {
          for (const op of child.toDelta()) {
            if (typeof op.insert === 'string') {
              const entry: SerializedParagraph['delta'][0] = { insert: op.insert };
              if (op.attributes && Object.keys(op.attributes).length > 0) {
                entry.attributes = op.attributes;
              }
              delta.push(entry);
            }
          }
        }
      });
      paragraphs.push({ delta });
    }
  });

  return { paragraphs };
}

// === Deserialize ===

export function deserializeFragment(content: SerializedContent): Y.XmlFragment {
  const fragment = new Y.XmlFragment();

  for (const para of content.paragraphs) {
    const element = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();

    for (const op of para.delta) {
      text.insert(text.length, op.insert, op.attributes);
    }

    element.insert(0, [text]);
    fragment.insert(fragment.length, [element]);
  }

  return fragment;
}

// === Plain Text Extraction ===

export function extractPlainText(objects: SerializedObject[]): string {
  const parts: string[] = [];

  for (const obj of objects) {
    if (!obj.content) continue;
    const text = obj.content.paragraphs
      .map((p) => p.delta.map((d) => d.insert).join(''))
      .join('\n');
    if (text) parts.push(text);
  }

  return parts.join('\n\n');
}

// === Bounds Computation ===

export function computePayloadBounds(objects: SerializedObject[]): WorldBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const obj of objects) {
    const { props } = obj;

    if (props.frame) {
      const [x, y, w, h] = props.frame as [number, number, number, number];
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    } else if (props.origin) {
      const [ox, oy] = props.origin as [number, number];
      minX = Math.min(minX, ox);
      minY = Math.min(minY, oy);
      maxX = Math.max(maxX, ox);
      maxY = Math.max(maxY, oy);
    } else if (props.points) {
      for (const [px, py] of props.points as [number, number][]) {
        minX = Math.min(minX, px);
        minY = Math.min(minY, py);
        maxX = Math.max(maxX, px);
        maxY = Math.max(maxY, py);
      }
    }

    // Also include connector start/end
    if (props.start) {
      const [sx, sy] = props.start as [number, number];
      minX = Math.min(minX, sx);
      minY = Math.min(minY, sy);
      maxX = Math.max(maxX, sx);
      maxY = Math.max(maxY, sy);
    }
    if (props.end) {
      const [ex, ey] = props.end as [number, number];
      minX = Math.min(minX, ex);
      minY = Math.min(minY, ey);
      maxX = Math.max(maxX, ex);
      maxY = Math.max(maxY, ey);
    }
  }

  // Fallback if no geometry found
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  return { minX, minY, maxX, maxY };
}
