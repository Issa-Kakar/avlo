/**
 * Clipboard Serializer - Serialize/deserialize whiteboard objects for clipboard
 *
 * Handles conversion between live Y.Map objects and JSON-safe representations.
 * Y.XmlFragment content is serialized as delta arrays per paragraph.
 *
 * @module lib/clipboard/clipboard-serializer
 */

import * as Y from 'yjs';
import type { ObjectKind, ObjectHandle } from '../types/objects';
import type { WorldBounds } from '../types/geometry';
import { getCurrentSnapshot } from '@/runtime/room-runtime';

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
  textContent?: string;
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
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  for (const id of ids) {
    const handle = objectsById.get(id);
    if (!handle) continue;
    objects.push(serializeHandle(handle));
    // Canonical bbox from snapshot — correct for all kinds including text/code
    const b = handle.bbox;
    minX = Math.min(minX, b[0]);
    minY = Math.min(minY, b[1]);
    maxX = Math.max(maxX, b[2]);
    maxY = Math.max(maxY, b[3]);
  }

  if (objects.length === 0) return null;

  return {
    version: 1,
    objects,
    bounds: isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  };
}

function serializeHandle(handle: ObjectHandle): SerializedObject {
  const props: Record<string, unknown> = {};
  let content: SerializedContent | undefined;

  let textContent: string | undefined;

  for (const [key, value] of handle.y.entries()) {
    if (key === 'content' && value instanceof Y.XmlFragment) {
      content = serializeFragment(value);
    } else if (key === 'content' && value instanceof Y.Text) {
      textContent = value.toString();
    } else {
      props[key] = value;
    }
  }

  return { kind: handle.kind, props, content, textContent };
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
    if (obj.textContent) {
      parts.push(obj.textContent);
    } else if (obj.content) {
      const text = obj.content.paragraphs.map((p) => p.delta.map((d) => d.insert).join('')).join('\n');
      if (text) parts.push(text);
    }
  }

  return parts.join('\n\n');
}
