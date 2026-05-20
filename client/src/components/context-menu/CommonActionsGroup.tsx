import { memo } from 'react';
import { deleteSelected } from '@/tools/selection/selection-actions';
import { ButtonGroup } from './ButtonGroup';
import { IconTrash } from './icons';
import { MenuButton } from './MenuButton';

export const CommonActionsGroup = memo(function CommonActionsGroup() {
  return (
    <ButtonGroup>
      <MenuButton className="ctx-btn-sq ctx-btn-danger" onClick={deleteSelected}>
        <IconTrash />
      </MenuButton>
    </ButtonGroup>
  );
});
