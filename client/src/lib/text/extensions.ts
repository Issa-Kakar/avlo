import { Extension } from '@tiptap/core';
import { ySyncPlugin, yUndoPlugin, yUndoPluginKey, undo, redo } from '@tiptap/y-tiptap';
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
}

export const TextCollaboration = Extension.create<TextCollaborationOptions>({
  name: 'textCollaboration',

  priority: 1000,

  addOptions() {
    return { fragment: null };
  },

  addCommands() {
    return {
      undo:
        () =>
        ({ tr, state, dispatch }) => {
          tr.setMeta('preventDispatch', true);
          const um = yUndoPluginKey.getState(state).undoManager;
          if (um.undoStack.length === 0) return false;
          if (!dispatch) return true;
          return undo(state);
        },
      redo:
        () =>
        ({ tr, state, dispatch }) => {
          tr.setMeta('preventDispatch', true);
          const um = yUndoPluginKey.getState(state).undoManager;
          if (um.redoStack.length === 0) return false;
          if (!dispatch) return true;
          return redo(state);
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
    return [ySyncPlugin(this.options.fragment!), yUndoPlugin()];
  },
});
