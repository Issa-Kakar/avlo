import {
  type AiAction,
  type AiActionResult,
  type AiSimpleObject,
  type AiUpdatableProps,
  CanvasToolInput,
  generateNZAtTop,
  ulid,
  type ZKey,
} from '@avlo/shared';
import * as Y from 'yjs';
import { getContent } from '@/core/accessors';
import { insertConnector } from '@/core/connectors/connector-actions';
import type { ConnectorEndpoint, ObjectHandle } from '@/core/types/objects';
import { getActiveRoomDoc, getHandle, getObjects, getZOrder, transact } from '@/runtime/room-runtime';
import { getUserId } from '@/stores/auth-store';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { chatToWorldX, chatToWorldY, registerCreated, ulidFor } from './short-ids';

/**
 * The `canvas` tool executor — the "hands" of the AI. Model output is
 * UNTRUSTED at this boundary: re-parsed against the shared Zod schema, short
 * ids resolved through the conversation map (unknown ⇒ the action is DROPPED
 * with a reason, never guessed), and every mutation flows the canonical
 * creation pattern (`clipboard-actions` precedent: build Y.Map field-by-field,
 * z-keys minted once via `generateNZAtTop`, `getObjects().set`) inside ONE
 * `transact()` — one AI tool call = ONE undo step. `stopCapturing()` first so
 * the 500ms captureTimeout can't merge the AI turn with the user's own edits.
 *
 * The observer pipeline does everything downstream (handles, spatial index,
 * caches, dirty rects) — this file only writes Y state.
 */

/** Fixed AI defaults — deliberately NOT the user's toolbar settings. */
const AI_STROKE_WIDTH = 2;
const AI_INK = '#1b1f22';
const AI_NOTE_FILL = '#FEF3AC';
const AI_TEXT_SIZE = 16;

/** assetIds granted by generate_image tool results this conversation. */
const grantedAssets = new Set<string>();
export function grantAiAsset(assetId: string): void {
  grantedAssets.add(assetId);
}
export function resetAiGrants(): void {
  grantedAssets.clear();
}

/**
 * Plain text → paragraph elements, built in arrays and batch-inserted — never
 * read from an unattached Y type (the pending-type gotcha; `{}` not undefined
 * on XmlText.insert so no mark inheritance).
 */
function buildParagraphElements(text: string): Y.XmlElement[] {
  const elements: Y.XmlElement[] = [];
  for (const line of text.split('\n')) {
    const element = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    if (line) t.insert(0, line, {});
    element.insert(0, [t]);
    elements.push(element);
  }
  return elements;
}

function plainToFragment(text: string): Y.XmlFragment {
  const fragment = new Y.XmlFragment();
  fragment.insert(0, buildParagraphElements(text));
  return fragment;
}

/** Replace a LIVE fragment's children in place (nested observer path — same as editor edits). */
function replaceFragmentText(fragment: Y.XmlFragment, text: string): void {
  fragment.delete(0, fragment.length);
  fragment.insert(0, buildParagraphElements(text));
}

function resolveEndpoint(anchorId: string | undefined, x: number | undefined, y: number | undefined): ConnectorEndpoint | null {
  if (anchorId) {
    const target = ulidFor(anchorId);
    if (!target || !getHandle(target)) return null;
    return { id: target, anchor: [0.5, 0.5] };
  }
  if (x !== undefined && y !== undefined) return [chatToWorldX(x), chatToWorldY(y)];
  return null;
}

function createObject(obj: AiSimpleObject, z: ZKey): { ok: true; id: string } | { ok: false; reason: string } {
  const userId = getUserId();
  const objects = getObjects();

  switch (obj.kind) {
    case 'shape': {
      const id = ulid();
      const m = new Y.Map<unknown>();
      m.set('id', id);
      m.set('kind', 'shape');
      m.set('shapeType', obj.shape);
      m.set('color', obj.color ?? AI_INK);
      m.set('width', AI_STROKE_WIDTH);
      m.set('opacity', 1);
      if (obj.fill) m.set('fillColor', obj.fill);
      m.set('frame', [chatToWorldX(obj.x), chatToWorldY(obj.y), obj.w, obj.h]);
      if (obj.text) {
        const ui = useDeviceUIStore.getState();
        m.set('content', plainToFragment(obj.text));
        m.set('fontSize', AI_TEXT_SIZE);
        m.set('fontFamily', ui.text.fontFamily);
        m.set('align', 'center');
      }
      m.set('ownerId', userId);
      m.set('createdAt', Date.now());
      m.set('z', z);
      objects.set(id, m);
      return { ok: true, id };
    }
    case 'note': {
      const id = ulid();
      const ui = useDeviceUIStore.getState();
      const m = new Y.Map<unknown>();
      m.set('id', id);
      m.set('kind', 'note');
      m.set('origin', [chatToWorldX(obj.x), chatToWorldY(obj.y)]);
      m.set('content', plainToFragment(obj.text));
      m.set('scale', 1);
      m.set('fontFamily', ui.note.fontFamily);
      m.set('align', ui.note.align);
      m.set('alignV', ui.note.alignV);
      m.set('fillColor', obj.fill ?? AI_NOTE_FILL);
      m.set('ownerId', userId);
      m.set('createdAt', Date.now());
      m.set('z', z);
      objects.set(id, m);
      return { ok: true, id };
    }
    case 'text': {
      const id = ulid();
      const ui = useDeviceUIStore.getState();
      const m = new Y.Map<unknown>();
      m.set('id', id);
      m.set('kind', 'text');
      m.set('origin', [chatToWorldX(obj.x), chatToWorldY(obj.y)]);
      m.set('content', plainToFragment(obj.text));
      m.set('fontSize', obj.size ?? AI_TEXT_SIZE);
      m.set('fontFamily', ui.text.fontFamily);
      m.set('color', obj.color ?? AI_INK);
      m.set('align', 'left');
      m.set('width', 'auto');
      m.set('ownerId', userId);
      m.set('createdAt', Date.now());
      m.set('z', z);
      objects.set(id, m);
      return { ok: true, id };
    }
    case 'connector': {
      const start = resolveEndpoint(obj.fromId, obj.x1, obj.y1);
      const end = resolveEndpoint(obj.toId, obj.x2, obj.y2);
      if (!start || !end) return { ok: false, reason: 'connector needs fromId/toId or x1,y1/x2,y2 for both ends' };
      const id = insertConnector(
        {
          start,
          end,
          startCap: obj.startCap ?? 'none',
          endCap: obj.endCap ?? 'arrow',
          connectorType: 'elbow',
          color: obj.color ?? AI_INK,
          width: AI_STROKE_WIDTH,
        },
        z,
      );
      return { ok: true, id };
    }
    case 'image': {
      if (!grantedAssets.has(obj.assetId)) return { ok: false, reason: 'unknown assetId — generate_image first' };
      const id = ulid();
      const m = new Y.Map<unknown>();
      m.set('id', id);
      m.set('kind', 'image');
      m.set('assetId', obj.assetId);
      m.set('frame', [chatToWorldX(obj.x), chatToWorldY(obj.y), obj.w, obj.h]);
      m.set('naturalWidth', obj.w);
      m.set('naturalHeight', obj.h);
      m.set('mimeType', 'image/jpeg');
      m.set('ownerId', userId);
      m.set('createdAt', Date.now());
      m.set('z', z);
      objects.set(id, m);
      return { ok: true, id };
    }
  }
}

function updateObject(handle: ObjectHandle, props: AiUpdatableProps): { ok: true } | { ok: false; reason: string } {
  const y = handle.y;
  const framed = handle.kind === 'shape' || handle.kind === 'image';
  const originBased = handle.kind === 'text' || handle.kind === 'note' || handle.kind === 'code';

  if (props.x !== undefined || props.y !== undefined || props.w !== undefined || props.h !== undefined) {
    if (framed) {
      const frame = (y.get('frame') as [number, number, number, number] | undefined) ?? [0, 0, 100, 100];
      y.set('frame', [
        props.x !== undefined ? chatToWorldX(props.x) : frame[0],
        props.y !== undefined ? chatToWorldY(props.y) : frame[1],
        props.w ?? frame[2],
        props.h ?? frame[3],
      ]);
    } else if (originBased && props.w === undefined && props.h === undefined) {
      const origin = (y.get('origin') as [number, number] | undefined) ?? [0, 0];
      y.set('origin', [
        props.x !== undefined ? chatToWorldX(props.x) : origin[0],
        props.y !== undefined ? chatToWorldY(props.y) : origin[1],
      ]);
    } else {
      return { ok: false, reason: `cannot resize a ${handle.kind}` };
    }
  }

  if (props.color !== undefined) {
    if (handle.kind === 'note') return { ok: false, reason: 'notes derive text color from fill' };
    y.set('color', props.color);
  }
  if (props.fill !== undefined) {
    if (handle.kind === 'shape' || handle.kind === 'note' || handle.kind === 'text') y.set('fillColor', props.fill);
    else return { ok: false, reason: `${handle.kind} has no fill` };
  }
  if (props.text !== undefined) {
    const result = setObjectText(handle, props.text);
    if (!result.ok) return result;
  }
  return { ok: true };
}

function setObjectText(handle: ObjectHandle, text: string): { ok: true } | { ok: false; reason: string } {
  if (handle.kind !== 'text' && handle.kind !== 'note' && handle.kind !== 'shape') {
    return { ok: false, reason: `${handle.kind} has no editable text` };
  }
  const existing = getContent(handle.y);
  if (existing) {
    replaceFragmentText(existing, text);
    return { ok: true };
  }
  if (handle.kind === 'shape') {
    // First label on a shape — label fields added on first edit (schema rule).
    const ui = useDeviceUIStore.getState();
    handle.y.set('content', plainToFragment(text));
    handle.y.set('fontSize', AI_TEXT_SIZE);
    handle.y.set('fontFamily', ui.text.fontFamily);
    handle.y.set('align', 'center');
    return { ok: true };
  }
  return { ok: false, reason: 'object has no content' };
}

/**
 * Execute one `canvas` tool call. Returns the compact per-action summary the
 * model reads back (AiActionResult[]). All mutations in ONE transact.
 */
export function executeCanvasActions(rawInput: unknown): { results: AiActionResult[] } | { error: string } {
  const parsed = CanvasToolInput.safeParse(rawInput);
  if (!parsed.success) return { error: 'invalid canvas tool input' };
  const actions = parsed.data.actions;

  // One undo step per AI turn — break out of any in-flight capture window first.
  getActiveRoomDoc().getUndoManager()?.stopCapturing();

  const creates = actions.filter((a): a is Extract<AiAction, { _type: 'create' }> => a._type === 'create');
  const results: AiActionResult[] = [];

  const applied = transact(() => {
    const zKeys = creates.length ? generateNZAtTop(getZOrder().maxZ(), creates.length) : [];
    let zIdx = 0;

    actions.forEach((action, i) => {
      switch (action._type) {
        case 'create': {
          const z = zKeys[zIdx++];
          if (ulidFor(action.object.id)) {
            results.push({ i, status: 'dropped', reason: 'id already in use — mint a new one' });
            return;
          }
          const created = createObject(action.object, z);
          if (!created.ok) {
            results.push({ i, status: 'dropped', reason: created.reason });
            return;
          }
          registerCreated(action.object.id, created.id);
          results.push({ i, status: 'ok', id: action.object.id });
          return;
        }
        case 'update':
        case 'move':
        case 'label': {
          const target = ulidFor(action.id);
          const handle = target ? getHandle(target) : undefined;
          if (!handle) {
            results.push({ i, status: 'dropped', reason: 'unknown id' });
            return;
          }
          const outcome =
            action._type === 'update'
              ? updateObject(handle, action.props)
              : action._type === 'move'
                ? updateObject(handle, { x: action.x, y: action.y })
                : setObjectText(handle, action.text);
          results.push(outcome.ok ? { i, status: 'ok' } : { i, status: 'dropped', reason: outcome.reason });
          return;
        }
        case 'delete': {
          const objects = getObjects();
          let removed = 0;
          for (const sid of action.ids) {
            const target = ulidFor(sid);
            if (target && objects.has(target)) {
              objects.delete(target);
              removed++;
            }
          }
          results.push(
            removed > 0
              ? { i, status: 'ok', reason: removed < action.ids.length ? `${removed}/${action.ids.length} deleted` : undefined }
              : { i, status: 'dropped', reason: 'no known ids' },
          );
          return;
        }
        default:
          results.push({ i, status: 'unsupported', reason: `${action._type} is not available yet — use create/update/move instead` });
          return;
      }
    });
    return true;
  });

  if (!applied) return { error: 'no active room' };
  return { results };
}
