import { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { SelectionStore } from '@/stores/selection-store';
import { filterSelectionByKind, useSelectionStore } from '@/stores/selection-store';
import { FilterObjectsDropdown } from '../FilterObjectsDropdown';

const selectKindCounts = (s: SelectionStore) => s.kindCounts;

export const MixedMenu = memo(function MixedMenu() {
  const kindCounts = useSelectionStore(useShallow(selectKindCounts));
  return <FilterObjectsDropdown kindCounts={kindCounts} onFilterByKind={filterSelectionByKind} />;
});
