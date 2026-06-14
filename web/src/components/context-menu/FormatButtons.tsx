import { memo } from 'react';
import { selectInlineBold, selectInlineItalic, useSelectionStore } from '@/stores/selection-store';
import { toggleSelectedBold, toggleSelectedItalic } from '@/tools/selection/selection-actions';
import { IconBold, IconItalic } from './icons';
import { MenuButton } from './MenuButton';

export const BoldButton = memo(function BoldButton() {
  const bold = useSelectionStore(selectInlineBold);
  return (
    <MenuButton className="ctx-btn-sq ctx-btn-fmt" active={bold} onClick={toggleSelectedBold}>
      <IconBold />
    </MenuButton>
  );
});

export const ItalicButton = memo(function ItalicButton() {
  const italic = useSelectionStore(selectInlineItalic);
  return (
    <MenuButton className="ctx-btn-sq ctx-btn-fmt" active={italic} onClick={toggleSelectedItalic}>
      <IconItalic />
    </MenuButton>
  );
});
