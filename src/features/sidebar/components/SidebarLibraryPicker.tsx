import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Music2 } from 'lucide-react';

interface MusicFolder { id: string; name: string }

interface Props {
  filterId: string;
  selectedFolderName: string | null;
  libraryDropdownOpen: boolean;
  setLibraryDropdownOpen: (open: boolean) => void;
  dropdownRect: { top: number; left: number; width: number };
  libraryTriggerRef: React.RefObject<HTMLButtonElement | null>;
  musicFolders: MusicFolder[];
  pickLibrary: (id: 'all' | string) => void;
}

export default function SidebarLibraryPicker({
  filterId, selectedFolderName, libraryDropdownOpen, setLibraryDropdownOpen,
  dropdownRect, libraryTriggerRef, musicFolders, pickLibrary,
}: Props) {
  const { t } = useTranslation();
  const libraryTriggerPlain = filterId === 'all';

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
          {selectedFolderName ? (
            <span className="nav-library-scope-subtitle" data-tooltip={selectedFolderName} data-tooltip-pos="right">
              {selectedFolderName}
            </span>
          ) : null}
        </div>
        <ChevronDown size={16} strokeWidth={2.25} className="nav-library-scope-chevron" aria-hidden />
      </button>
      {libraryDropdownOpen &&
        createPortal(
          <div
            className={`nav-library-dropdown-panel${musicFolders.length > 10 ? ' nav-library-dropdown-panel--many-libraries' : ''}`}
            role="listbox"
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
              role="option"
              aria-selected={filterId === 'all'}
              className={`nav-library-dropdown-item ${filterId === 'all' ? 'nav-library-dropdown-item--selected' : ''}`}
              onClick={() => pickLibrary('all')}
            >
              <span className="nav-library-dropdown-item-label">{t('sidebar.allLibraries')}</span>
              {filterId === 'all' ? <Check size={16} className="nav-library-dropdown-check" strokeWidth={2.5} /> : <span className="nav-library-dropdown-check-spacer" />}
            </button>
            {musicFolders.map(f => (
              <button
                key={f.id}
                type="button"
                role="option"
                aria-selected={filterId === f.id}
                className={`nav-library-dropdown-item ${filterId === f.id ? 'nav-library-dropdown-item--selected' : ''}`}
                onClick={() => pickLibrary(f.id)}
              >
                <span className="nav-library-dropdown-item-label">{f.name}</span>
                {filterId === f.id ? <Check size={16} className="nav-library-dropdown-check" strokeWidth={2.5} /> : <span className="nav-library-dropdown-check-spacer" />}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
