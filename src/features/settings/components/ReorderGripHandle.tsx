import { useTranslation } from 'react-i18next';
import { GripVertical } from 'lucide-react';
import { useDragSource } from '@/lib/dnd/DragDropContext';

/**
 * Drag handle shared by the reorder customizers. Emits an id-based payload
 * (`{ type, id, section? }`) consumed by `useListReorderDnd`.
 */
export function ReorderGripHandle({
  id, type, section, label,
}: { id: string; type: string; section?: string; label: string }) {
  const { t } = useTranslation();
  const { onMouseDown } = useDragSource(() => ({
    data: JSON.stringify(section ? { type, id, section } : { type, id }),
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
