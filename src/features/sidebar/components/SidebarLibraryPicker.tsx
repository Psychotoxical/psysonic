import React, { useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronUp, GripVertical, Music2 } from 'lucide-react';
import { useDragSource } from '@/lib/dnd/DragDropContext';
import { useListReorderDnd } from '@/lib/hooks/useListReorderDnd';
import { applyListReorderById } from '@/lib/util/listReorder';
import type { ListReorderDropTarget } from '@/lib/util/listReorder';

interface MusicFolder { id: string; name: string }

const REORDER_TYPE = 'library_selection_reorder';

function LibrarySelectionGrip({ id, label }: { id: string; label: string }) {
  const { t } = useTranslation();
  const { onMouseDown } = useDragSource(() => ({
    data: JSON.stringify({ type: REORDER_TYPE, id }),
    label,
  }));

  return (
    <span
      className="nav-library-dropdown-grip"
      data-tooltip={t('sidebar.librarySelectionDrag')}
      data-tooltip-pos="right"
      onMouseDown={onMouseDown}
      onClick={e => e.stopPropagation()}
      aria-hidden
    >
      <GripVertical size={16} />
    </span>
  );
}

interface Props {
  selectedLibraryIds: string[];
  selectionSummary: string | null;
  libraryDropdownOpen: boolean;
  setLibraryDropdownOpen: (open: boolean) => void;
  dropdownRect: { top: number; left: number; width: number };
  libraryTriggerRef: React.RefObject<HTMLButtonElement | null>;
  musicFolders: MusicFolder[];
  onSelectionChange: (libraryIds: string[]) => void;
}

export default function SidebarLibraryPicker({
  selectedLibraryIds,
  selectionSummary,
  libraryDropdownOpen,
  setLibraryDropdownOpen,
  dropdownRect,
  libraryTriggerRef,
  musicFolders,
  onSelectionChange,
}: Props) {
  const { t } = useTranslation();
  const allLibraries = selectedLibraryIds.length === 0;
  const libraryTriggerPlain = allLibraries;

  const folderById = useMemo(
    () => new Map(musicFolders.map(f => [f.id, f])),
    [musicFolders],
  );

  const selectedFolders = useMemo(
    () =>
      selectedLibraryIds
        .map(id => folderById.get(id))
        .filter((f): f is MusicFolder => f != null),
    [selectedLibraryIds, folderById],
  );

  const unselectedFolders = useMemo(
    () => musicFolders.filter(f => !selectedLibraryIds.includes(f.id)),
    [musicFolders, selectedLibraryIds],
  );

  const applyReorder = useCallback((draggedId: string, target: ListReorderDropTarget) => {
    const items = selectedLibraryIds.map(id => ({ id }));
    const next = applyListReorderById(items, draggedId, target);
    if (next) onSelectionChange(next.map(x => x.id));
  }, [selectedLibraryIds, onSelectionChange]);

  const { isDragging, setContainer, onMouseMove, dropEdge } = useListReorderDnd({
    type: REORDER_TYPE,
    apply: applyReorder,
  });

  const selectAllLibraries = () => {
    onSelectionChange([]);
  };

  const toggleFolder = (id: string) => {
    if (selectedLibraryIds.includes(id)) {
      onSelectionChange(selectedLibraryIds.filter(x => x !== id));
      return;
    }
    onSelectionChange([...selectedLibraryIds, id]);
  };

  const moveInSelection = (id: string, direction: -1 | 1) => {
    const idx = selectedLibraryIds.indexOf(id);
    if (idx < 0) return;
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= selectedLibraryIds.length) return;
    const next = [...selectedLibraryIds];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    onSelectionChange(next);
  };

  const renderFolderToggle = (folder: MusicFolder, opts: { priority?: boolean }) => {
    const checked = selectedLibraryIds.includes(folder.id);
    const priority = opts.priority === true;
    const idx = priority ? selectedLibraryIds.indexOf(folder.id) : -1;
    const edge = priority && isDragging ? dropEdge(folder.id) : null;

    return (
      <div
        key={folder.id}
        data-reorder-id={priority ? folder.id : undefined}
        className={[
          'nav-library-dropdown-item',
          checked ? 'nav-library-dropdown-item--selected' : '',
          priority ? 'nav-library-dropdown-item--priority' : '',
        ].filter(Boolean).join(' ')}
        style={{
          borderTop: edge === 'before' ? '2px solid var(--accent)' : undefined,
          borderBottom: edge === 'after' ? '2px solid var(--accent)' : undefined,
        }}
      >
        {priority ? (
          <LibrarySelectionGrip id={folder.id} label={folder.name} />
        ) : (
          <span className="nav-library-dropdown-grip-spacer" aria-hidden />
        )}
        <label className="nav-library-dropdown-toggle">
          <input
            type="checkbox"
            checked={checked}
            onChange={() => toggleFolder(folder.id)}
            aria-label={
              checked
                ? t('sidebar.librarySelectionExclude', { name: folder.name })
                : t('sidebar.librarySelectionInclude', { name: folder.name })
            }
          />
          <span className="nav-library-dropdown-item-label">{folder.name}</span>
        </label>
        {priority ? (
          <span className="nav-library-dropdown-priority-actions">
            <button
              type="button"
              className="nav-library-dropdown-move"
              disabled={idx <= 0}
              aria-label={t('sidebar.librarySelectionMoveUp', { name: folder.name })}
              onClick={() => moveInSelection(folder.id, -1)}
            >
              <ChevronUp size={15} strokeWidth={2.25} aria-hidden />
            </button>
            <button
              type="button"
              className="nav-library-dropdown-move"
              disabled={idx < 0 || idx >= selectedLibraryIds.length - 1}
              aria-label={t('sidebar.librarySelectionMoveDown', { name: folder.name })}
              onClick={() => moveInSelection(folder.id, 1)}
            >
              <ChevronDown size={15} strokeWidth={2.25} aria-hidden />
            </button>
          </span>
        ) : (
          <span className="nav-library-dropdown-check-spacer" aria-hidden />
        )}
      </div>
    );
  };

  return (
    <>
      <button
        ref={libraryTriggerRef}
        type="button"
        className={`nav-library-scope-trigger ${libraryTriggerPlain ? 'nav-library-scope-trigger--plain' : ''} ${libraryDropdownOpen ? 'nav-library-scope-trigger--open' : ''}`}
        onClick={() => setLibraryDropdownOpen(!libraryDropdownOpen)}
        aria-label={t('sidebar.libraryScope')}
        aria-expanded={libraryDropdownOpen}
        aria-haspopup="dialog"
        data-tooltip={libraryDropdownOpen ? undefined : t('sidebar.libraryScope')}
        data-tooltip-pos="bottom"
      >
        {!libraryTriggerPlain ? (
          <Music2 size={16} className="nav-library-scope-icon" strokeWidth={2} aria-hidden />
        ) : null}
        <div className="nav-library-scope-text">
          <span className="nav-library-scope-title">{t('sidebar.library')}</span>
          {selectionSummary ? (
            <span className="nav-library-scope-subtitle" data-tooltip={selectionSummary} data-tooltip-pos="right">
              {selectionSummary}
            </span>
          ) : null}
        </div>
        <ChevronDown size={16} strokeWidth={2.25} className="nav-library-scope-chevron" aria-hidden />
      </button>
      {libraryDropdownOpen &&
        createPortal(
          <div
            className={`nav-library-dropdown-panel${musicFolders.length > 10 ? ' nav-library-dropdown-panel--many-libraries' : ''}`}
            role="dialog"
            aria-label={t('sidebar.libraryScope')}
            style={{
              position: 'fixed',
              top: dropdownRect.top,
              left: dropdownRect.left,
              width: dropdownRect.width,
              minWidth: dropdownRect.width,
              maxWidth: dropdownRect.width,
              boxSizing: 'border-box',
            }}
          >
            <button
              type="button"
              aria-pressed={allLibraries}
              className={`nav-library-dropdown-item ${allLibraries ? 'nav-library-dropdown-item--selected' : ''}`}
              onClick={selectAllLibraries}
            >
              <span className="nav-library-dropdown-item-label">{t('sidebar.allLibraries')}</span>
              {allLibraries ? (
                <Check size={16} className="nav-library-dropdown-check" strokeWidth={2.5} aria-hidden />
              ) : (
                <span className="nav-library-dropdown-check-spacer" aria-hidden />
              )}
            </button>
            {selectedFolders.length > 0 ? (
              <div
                ref={setContainer}
                className="nav-library-dropdown-priority-group"
                role="group"
                aria-label={t('sidebar.librarySelectionPriority')}
                onMouseMove={onMouseMove}
              >
                {selectedFolders.map(folder => renderFolderToggle(folder, { priority: true }))}
              </div>
            ) : null}
            {unselectedFolders.length > 0 ? (
              <div
                className="nav-library-dropdown-available-group"
                role="group"
                aria-label={t('sidebar.librarySelectionAvailable')}
              >
                {unselectedFolders.map(folder => renderFolderToggle(folder, {}))}
              </div>
            ) : null}
          </div>,
          document.body,
        )}
    </>
  );
}
