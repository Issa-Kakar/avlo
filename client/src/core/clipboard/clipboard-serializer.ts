/**
 * Clipboard Serializer - Serialize/deserialize whiteboard objects for clipboard
 *
 * Handles conversion between live Y.Map objects and JSON-safe representations.
 * Y.XmlFragment content is serialized as delta arrays per paragraph.
 *
 * @module lib/clipboard/clipboard-serializer
 */

import * as Y from 'yjs';
import { getObjectsById } from '@/runtime/room-runtime';
import { getConnectorRoute } from '../connectors/connector-router';
import { expandBBoxEnvelope } from '../geometry/bounds';
import type { BBoxTuple, Point } from '../types/geometry';
import type { ObjectHandle, ObjectKind } from '../types/objects';

// === Types ===

/** Inline text mark attributes — canonical set for clipboard + PM parsing. */
export type MarkAttrs = { bold?: true; italic?: true; highlight?: string };

/** Default highlight color when PM `highlight` mark has no attrs.color. */
export const DEFAULT_HIGHLIGHT = '#ffd43b';

/** Y.Map entries minus `content` — meta fields are always present on every kind. */
export type SerializedProps = { id: string; kind: ObjectKind; ownerId: string; createdAt: number } & Record<string, unknown>;

export interface ClipboardPayload {
  version: 1;
  objects: SerializedObject[];
  bounds: BBoxTuple;
}

export interface SerializedObject {
  kind: ObjectKind;
  props: SerializedProps;
  content?: SerializedContent;
  textContent?: string;
  /** Connectors only: cached endpoint positions captured from the route at copy time.
   * Used as paste-fallback when an anchored target shape isn't present (cross-room paste,
   * or copied → deleted → pasted in same room). Cloned to insulate from pooled route buffer. */
  cachedStart?: Point;
  cachedEnd?: Point;
}

export interface SerializedContent {
  paragraphs: SerializedParagraph[];
}

export interface SerializedParagraph {
  delta: { insert: string; attributes?: MarkAttrs }[];
}

// === Serialize ===

export function serializeObjects(ids: string[]): ClipboardPayload | null {
  const objectsById = getObjectsById();
  const objects: SerializedObject[] = [];
  let envelope: BBoxTuple | null = null;

  for (const id of ids) {
    const handle = objectsById.get(id);
    if (!handle) continue;
    objects.push(serializeHandle(handle));
    envelope = expandBBoxEnvelope(envelope, handle.bbox);
  }

  if (objects.length === 0) return null;

  return { version: 1, objects, bounds: envelope ?? [0, 0, 0, 0] };
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

  let cachedStart: Point | undefined;
  let cachedEnd: Point | undefined;
  if (handle.kind === 'connector') {
    const route = getConnectorRoute(handle.id);
    if (route && route.length >= 1) {
      const first = route[0];
      const last = route[route.length - 1];
      // Clone — router's route buffer is pooled and mutated in place.
      cachedStart = [first[0], first[1]];
      cachedEnd = [last[0], last[1]];
    }
  }

  return { kind: handle.kind, props: props as SerializedProps, content, textContent, cachedStart, cachedEnd };
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
                entry.attributes = op.attributes as MarkAttrs;
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
  // Build children in plain arrays and batch-insert at index 0. Avoids reading
  // `.length` on pending (unattached) Y.XmlFragment / Y.XmlText — Yjs warns on
  // those reads; writes on pending types queue fine and are integrated as one
  // unit when the root fragment is later attached via yObj.set('content', …).
  const elements: Y.XmlElement[] = [];

  for (const para of content.paragraphs) {
    const element = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();

    let textPos = 0;
    for (const op of para.delta) {
      text.insert(textPos, op.insert, op.attributes);
      textPos += op.insert.length;
    }

    element.insert(0, [text]);
    elements.push(element);
  }

  const fragment = new Y.XmlFragment();
  fragment.insert(0, elements);
  return fragment;
}

// === Runtime guard ===

export function isSerializedPayload(v: unknown): v is ClipboardPayload {
  if (!v || typeof v !== 'object') return false;
  const p = v as ClipboardPayload;
  return p.version === 1 && Array.isArray(p.objects) && Array.isArray(p.bounds) && p.bounds.length === 4;
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
