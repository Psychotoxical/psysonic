import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Music2 } from 'lucide-react';

interface MusicFolder { id: string; name: string }

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
  const allLibrariesSelected = selectedLibraryIds.length === 0;
  const libraryTriggerPlain = allLibrariesSelected;
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const allLibrariesLabel = t('sidebar.allLibraries');

  useLayoutEffect(() => {
    if (!libraryDropdownOpen) {
      // React Compiler set-state-in-effect rule: panel width is measured from layout after open.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPanelWidth(null);
      return;
    }
    const measure = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const minW = dropdownRect.width;
      const maxW = Math.max(minW, window.innerWidth - dropdownRect.left - 8);
      panel.dataset.measure = 'true';
      panel.style.width = 'max-content';
      panel.style.minWidth = `${minW}px`;
      const measured = panel.offsetWidth;
      delete panel.dataset.measure;
      panel.style.width = '';
      panel.style.minWidth = '';
      setPanelWidth(Math.min(Math.max(minW, measured), maxW));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [
    libraryDropdownOpen,
    dropdownRect.left,
    dropdownRect.width,
    musicFolders,
    allLibrariesLabel,
  ]);

  const selectAllLibraries = () => {
    setLibraryDropdownOpen(false);
    requestAnimationFrame(() => onSelectionChange([]));
  };

  const exclusiveSelect = (id: string) => {
    setLibraryDropdownOpen(false);
    requestAnimationFrame(() => onSelectionChange([id]));
  };

  const toggleFolder = (id: string) => {
    if (allLibrariesSelected) {
      onSelectionChange([id]);
      return;
    }
    if (selectedLibraryIds.includes(id)) {
      onSelectionChange(selectedLibraryIds.filter(x => x !== id));
      return;
    }
    onSelectionChange([...selectedLibraryIds, id]);
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
        aria-haspopup="listbox"
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
            ref={panelRef}
            className={`nav-library-dropdown-panel${musicFolders.length > 10 ? ' nav-library-dropdown-panel--many-libraries' : ''}`}
            role="listbox"
            aria-label={t('sidebar.libraryScope')}
            style={{
              position: 'fixed',
              top: dropdownRect.top,
              left: dropdownRect.left,
              minWidth: dropdownRect.width,
              width: panelWidth ?? 'max-content',
              boxSizing: 'border-box',
            }}
          >
            <div
              role="option"
              aria-selected={allLibrariesSelected}
              className={`nav-library-dropdown-item ${allLibrariesSelected ? 'nav-library-dropdown-item--selected' : ''}`}
            >
              <button
                type="button"
                className="nav-library-dropdown-item-main"
                onClick={selectAllLibraries}
              >
                <span className="nav-library-dropdown-item-label">{allLibrariesLabel}</span>
              </button>
              <span
                className={`nav-library-dropdown-item-toggle ${allLibrariesSelected ? 'nav-library-dropdown-item-toggle--on' : 'nav-library-dropdown-item-toggle--align-only'}`}
                aria-hidden
              >
                {allLibrariesSelected ? <Check size={16} strokeWidth={2.5} /> : null}
              </span>
            </div>
            {musicFolders.map(folder => {
              const selected = selectedLibraryIds.includes(folder.id);
              return (
                <div
                  key={folder.id}
                  role="option"
                  aria-selected={selected}
                  className={`nav-library-dropdown-item ${selected ? 'nav-library-dropdown-item--selected' : ''}`}
                >
                  <button
                    type="button"
                    className="nav-library-dropdown-item-main"
                    onClick={() => exclusiveSelect(folder.id)}
                  >
                    <span className="nav-library-dropdown-item-label">{folder.name}</span>
                  </button>
                  <button
                    type="button"
                    className={`nav-library-dropdown-item-toggle ${selected ? 'nav-library-dropdown-item-toggle--on' : ''}`}
                    aria-label={
                      selected
                        ? t('sidebar.libraryDeselect', { name: folder.name })
                        : t('sidebar.librarySelect', { name: folder.name })
                    }
                    aria-pressed={selected}
                    onClick={e => {
                      e.stopPropagation();
                      toggleFolder(folder.id);
                    }}
                  >
                    {selected ? (
                      <Check size={16} strokeWidth={2.5} />
                    ) : (
                      <span className="nav-library-dropdown-item-toggle-box" aria-hidden />
                    )}
                  </button>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
