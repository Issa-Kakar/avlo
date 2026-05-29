import { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { SelectionStore } from '@/stores/selection-store';
import { useSelectionStore } from '@/stores/selection-store';
import {
  decrementCodeFontSize,
  incrementCodeFontSize,
  setSelectedCodeFontSize,
  toggleCodeHeader,
  toggleCodeLineNumbers,
  toggleCodeOutput,
} from '@/tools/selection/selection-actions';
import { ButtonGroup } from '../ButtonGroup';
import { FontSizeStepper } from '../FontSizeStepper';
import { IconCodeHeader, IconCodeLines, IconCodeOutput } from '../icons';
import { LanguageDropdown } from '../LanguageDropdown';
import { MenuButton } from '../MenuButton';

const selectCodeStyles = (s: SelectionStore) => ({
  fontSize: s.selectedStyles.fontSize,
  headerVisible: s.selectedStyles.codeHeaderVisible,
  outputVisible: s.selectedStyles.codeOutputVisible,
});

export const CodeMenu = memo(function CodeMenu() {
  const { fontSize, headerVisible, outputVisible } = useSelectionStore(useShallow(selectCodeStyles));
  const effectiveFontSize = fontSize ?? 14;
  return (
    <ButtonGroup>
      <LanguageDropdown />
      <div className="ctx-divider" />
      <FontSizeStepper
        value={effectiveFontSize}
        onDecrement={decrementCodeFontSize}
        onIncrement={incrementCodeFontSize}
        onSelectSize={setSelectedCodeFontSize}
      />
      <div className="ctx-divider" />
      <MenuButton className="ctx-btn-sq" onMouseDown={toggleCodeLineNumbers}>
        <IconCodeLines className="w-[22px] h-4" />
      </MenuButton>
      <MenuButton className="ctx-btn-sq ctx-btn-fmt" active={headerVisible === true} onMouseDown={toggleCodeHeader}>
        <IconCodeHeader className="size-4" />
      </MenuButton>
      <MenuButton className="ctx-btn-sq ctx-btn-fmt" active={outputVisible === true} onMouseDown={toggleCodeOutput}>
        <IconCodeOutput className="size-4" />
      </MenuButton>
    </ButtonGroup>
  );
});
