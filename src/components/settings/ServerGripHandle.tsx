import { useTranslation } from 'react-i18next';
import { GripVertical } from 'lucide-react';
import { useDragSource } from '../../contexts/DragDropContext';

export function ServerGripHandle({ idx, label }: { idx: number; label: string }) {
  const { t } = useTranslation();
  const { onMouseDown } = useDragSource(() => ({
    data: JSON.stringify({ type: 'server_reorder', index: idx }),
    label,
  }));
  return (
    <span
      className="sidebar-customizer-grip"
      data-tooltip={t('settings.sidebarDrag')}
      data-tooltip-pos="right"
      onMouseDown={onMouseDown}
      onClick={e => e.stopPropagation()}
    >
      <GripVertical size={16} />
    </span>
  );
}
