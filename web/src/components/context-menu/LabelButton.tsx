import { memo } from 'react';
import { textTool } from '@/runtime/tool-registry';
import { useSelectionStore } from '@/stores/selection-store';
import { IconLabel } from './icons';
import { MenuButton } from './MenuButton';

// Connector-label entry point. Mounts the rich-text editor on the sole selected
// connector (the button + its divider render only when exactly one connector is
// selected, so `selectedIds[0]` is that connector). startEditing creates the
// label fields on first use and re-opens an existing label otherwise.
export const LabelButton = memo(function LabelButton() {
  return (
    <MenuButton
      className="ctx-btn-sq ctx-btn-label"
      aria-label="Add label"
      onMouseDown={() => {
        const id = useSelectionStore.getState().selectedIds[0];
        if (id) textTool.startEditing(id);
      }}
    >
      <IconLabel />
    </MenuButton>
  );
});
