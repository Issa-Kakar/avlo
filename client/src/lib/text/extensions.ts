/**
 * Custom TextCollaboration extension — replaces @tiptap/extension-collaboration.
 *
 * WHY: The official Collaboration extension wraps yUndoPlugin's view lifecycle to
 * "suspend" the UndoManager across Tiptap's plugin-reconfigure cycle. On destroy it
 * captures `_observers` (the Map of event listener callbacks that close over the
 * EditorView and its DOM) into a restore closure, then replays them on the next
 * view() call. This keeps the UndoManager alive across editor remounts — useful for
 * long-lived document sessions, but fatal for our canvas app where editors are
 * short-lived (mount per click, destroy on blur).
 *
 * The captured _observers prevent GC of every prior EditorView and its contenteditable
 * DOM tree, producing a linear leak of detached <div contenteditable> nodes.
 *
 * The Yjs UndoManager is also anchored to the Y.Doc via an anonymous doc.on('destroy')
 * handler registered in the UndoManager constructor — this reference chain
 * (Y.Doc → UndoManager → _observers → EditorView → DOM) is the full leak path.
 *
 * This extension registers ySyncPlugin + yUndoPlugin directly from @tiptap/y-tiptap
 * without any view suspend/restore wrapper. The UndoManager is destroyed normally
 * when the editor unmounts, and we call undoManager.clear() in TextTool.commitAndClose()
 * to release CRDT-level GC protection held by undo stack items.
 *
 * CURSOR FIX: yUndoPlugin stores cursor positions as Y.js RelativePositions and restores
 * them via relativePositionToAbsolutePosition — which is buggy (y-prosemirror #210, #101).
 * We bypass this by storing raw PM positions on stack item meta via a selectionFix plugin,
 * then correcting the selection in the undo/redo commands after the Y.js operation completes.
 * (appendTransaction can't work because stack-item-popped fires AFTER doc.transact() returns,
 * which is after _typeChanged already dispatched the PM transaction with the wrong selection.)
 */
import { Extension } from '@tiptap/core';
import {
  ySyncPlugin,
  ySyncPluginKey,
  yUndoPlugin,
  yUndoPluginKey,
  undo,
  redo,
} from '@tiptap/y-tiptap';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';
import type { XmlFragment } from 'yjs';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    textCollaboration: {
      undo: () => ReturnType;
      redo: () => ReturnType;
    };
  }
}

export interface TextCollaborationOptions {
  fragment: XmlFragment | null;
  yObj: Y.Map<unknown> | null;
  userId: string | null;
  mainUndoManager: Y.UndoManager | null;
  onPropsSync: ((keys: Set<string>) => void) | null;
}

const selectionFixKey = new PluginKey('textSelectionFix');

// Mutable slot: set by stack-item-popped, consumed by undo/redo commands
let pendingSelection: { anchor: number; head: number } | null = null;

/** After undo/redo, correct the selection using our stored PM position. */
function applyPendingSelection(view: import('@tiptap/pm/view').EditorView): void {
  const pos = pendingSelection;
  pendingSelection = null;
  if (!pos) return;

  const { doc } = view.state;
  const anchor = Math.max(0, Math.min(pos.anchor, doc.content.size));
  const head = Math.max(0, Math.min(pos.head, doc.content.size));
  try {
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.between(doc.resolve(anchor), doc.resolve(head)))
        .setMeta('addToHistory', false),
    );
  } catch {
    // Position out of range — let the buggy selection stand
  }
}

export const TextCollaboration = Extension.create<TextCollaborationOptions>({
  name: 'textCollaboration',

  priority: 1000,

  addOptions() {
    return { fragment: null, yObj: null, userId: null, mainUndoManager: null, onPropsSync: null };
  },

  addStorage() {
    return { yObjUnobserve: null as (() => void) | null };
  },

  addCommands() {
    return {
      undo:
        () =>
        ({ tr, state, dispatch, view }) => {
          tr.setMeta('preventDispatch', true);
          const um = yUndoPluginKey.getState(state).undoManager;
          if (um.undoStack.length === 0) return false;
          if (!dispatch) return true;
          const result = undo(state);
          if (result) applyPendingSelection(view);
          return result;
        },
      redo:
        () =>
        ({ tr, state, dispatch, view }) => {
          tr.setMeta('preventDispatch', true);
          const um = yUndoPluginKey.getState(state).undoManager;
          if (um.redoStack.length === 0) return false;
          if (!dispatch) return true;
          const result = redo(state);
          if (result) applyPendingSelection(view);
          return result;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-z': () => this.editor.commands.undo(),
      'Mod-y': () => this.editor.commands.redo(),
      'Shift-Mod-z': () => this.editor.commands.redo(),
    };
  },

  addProseMirrorPlugins() {
    const { fragment, yObj, userId } = this.options;
    if (!fragment) return [];

    // Build scope: always includes fragment, optionally includes yObj for property undo
    const scope: (XmlFragment | Y.Map<unknown>)[] = [fragment];
    if (yObj) scope.push(yObj);

    // Build tracked origins: always ySyncPluginKey, optionally userId for mutate() changes
    const origins = new Set<unknown>([ySyncPluginKey]);
    if (userId) origins.add(userId);

    const undoManager = new Y.UndoManager(scope, {
      trackedOrigins: origins,
      captureTimeout: 500,
      captureTransaction: (tr) => tr.meta.get('addToHistory') !== false,
    });

    const selectionFixPlugin = new Plugin({
      key: selectionFixKey,

      // Track previous selection on every transaction (mirrors yUndoPlugin's prevSel
      // but stores raw PM positions instead of Y.js RelativePositions)
      state: {
        init: () => ({ anchor: 0, head: 0 }),
        apply: (_tr, _val, oldState) => ({
          anchor: oldState.selection.anchor,
          head: oldState.selection.head,
        }),
      },

      // Register UndoManager listeners to save/restore PM positions on stack items
      view: (editorView) => {
        const um = yUndoPluginKey.getState(editorView.state)?.undoManager;
        if (!um) return {};

        const onAdded = ({ stackItem }: { stackItem: { meta: Map<unknown, unknown> } }) => {
          const saved = selectionFixKey.getState(editorView.state);
          if (saved) stackItem.meta.set(selectionFixKey, saved);
        };

        const onPopped = ({ stackItem }: { stackItem: { meta: Map<unknown, unknown> } }) => {
          pendingSelection =
            (stackItem.meta.get(selectionFixKey) as typeof pendingSelection) ?? null;
        };

        um.on('stack-item-added', onAdded);
        um.on('stack-item-popped', onPopped);

        return {
          destroy: () => {
            um.off('stack-item-added', onAdded);
            um.off('stack-item-popped', onPopped);
          },
        };
      },
    });

    return [ySyncPlugin(fragment), yUndoPlugin({ undoManager }), selectionFixPlugin];
  },

  onCreate() {
    const { yObj, mainUndoManager, onPropsSync } = this.options;

    // Begin atomic session on main UndoManager — merge entire editing session into one item
    if (mainUndoManager) {
      mainUndoManager.stopCapturing();
      mainUndoManager.captureTimeout = 600_000; // 10 min
    }

    // Y.Map observer: sync DOM overlay on undo/redo property changes
    if (yObj && onPropsSync) {
      const observer = (evt: Y.YMapEvent<unknown>) => {
        const keys = evt.keysChanged;
        if (
          keys.has('origin') ||
          keys.has('fontSize') ||
          keys.has('fontFamily') ||
          keys.has('color') ||
          keys.has('fillColor') ||
          keys.has('align') ||
          keys.has('alignV') ||
          keys.has('width') ||
          keys.has('labelColor') ||
          keys.has('frame') ||
          keys.has('shapeType')
        ) {
          onPropsSync(keys);
        }
      };
      yObj.observe(observer);
      this.storage.yObjUnobserve = () => yObj.unobserve(observer);
    }
  },

  onDestroy() {
    // 1. Clean up Y.Map observer
    this.storage.yObjUnobserve?.();
    this.storage.yObjUnobserve = null;

    // 2. Seal main UndoManager session
    const { mainUndoManager } = this.options;
    if (mainUndoManager) {
      mainUndoManager.stopCapturing();
      mainUndoManager.captureTimeout = 500;
    }

    // 3. Clear per-session UndoManager (releases CRDT GC protection)
    // onDestroy fires before view.destroy(), so plugin state is still accessible
    const um = yUndoPluginKey.getState(this.editor.view.state)?.undoManager;
    if (um) um.clear();
  },
});
