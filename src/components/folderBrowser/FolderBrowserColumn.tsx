import React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Folder, FolderOpen, Music } from 'lucide-react';
import type { SubsonicDirectoryEntry } from '../../api/subsonicTypes';
import type { Track } from '../../store/playerStoreTypes';
import {
  folderBrowserHasKeyModifiers, isFolderBrowserArrowKey,
  type Column,
} from '../../utils/folderBrowserHelpers';

interface Props {
  col: Column;
  colIndex: number;
  isCompact: boolean;
  filterValue: string;
  filterVisible: boolean;
  filteredItems: SubsonicDirectoryEntry[];
  keyboardRowIndex: number | null;
  contextRowIndex: number | null;
  currentTrack: Track | null;
  isPlaying: boolean;
  isSelectedPathForCurrentTrack: boolean;
  playingPathIds: string[];
  registerFilterInput: (el: HTMLInputElement | null) => void;
  onFilterFocus: () => void;
  onFilterBlur: () => void;
  onFilterEscape: () => void;
  onFilterArrowDown: () => void;
  onFilterChange: (value: string) => void;
  onRowClick: (item: SubsonicDirectoryEntry, rowIndex: number) => void;
  onRowContextMenu: (
    e: React.MouseEvent,
    rowIndex: number,
    col: Column,
    item: SubsonicDirectoryEntry,
  ) => void;
}

export default function FolderBrowserColumn({
  col, colIndex, isCompact, filterValue, filterVisible, filteredItems,
  keyboardRowIndex, contextRowIndex, currentTrack, isPlaying,
  isSelectedPathForCurrentTrack, playingPathIds,
  registerFilterInput, onFilterFocus, onFilterBlur, onFilterEscape, onFilterArrowDown, onFilterChange,
  onRowClick, onRowContextMenu,
}: Props) {
  const { t } = useTranslation();

  return (
    <div
      className={`folder-col${isCompact ? ' folder-col--compact' : ''}`}
      data-folder-col-index={colIndex}
    >
      {filterVisible && (
        <div className="folder-col-filter">
          <input
            ref={registerFilterInput}
            data-folder-filter-input="true"
            className="folder-col-filter-input"
            value={filterValue}
            placeholder={t('playlists.searchPlaceholder')}
            onFocus={onFilterFocus}
            onBlur={onFilterBlur}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onFilterEscape();
                return;
              }
              if (e.key === 'ArrowDown' && !folderBrowserHasKeyModifiers(e)) {
                e.preventDefault();
                e.stopPropagation();
                onFilterArrowDown();
              }
            }}
            onChange={e => onFilterChange(e.target.value)}
          />
        </div>
      )}
      {col.loading ? (
        <div className="folder-col-status">
          <div className="spinner" style={{ width: 20, height: 20 }} />
        </div>
      ) : col.error ? (
        <div className="folder-col-status folder-col-error">
          {t('folderBrowser.error')}
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="folder-col-status">{t('folderBrowser.empty')}</div>
      ) : (
        filteredItems.map((item, rowIndex) => {
          const isSelected = col.selectedId === item.id;
          const isContextRow = contextRowIndex === rowIndex;
          const isKeyboardRow = keyboardRowIndex === rowIndex;
          const isNowPlayingTrack = !item.isDir && currentTrack?.id === item.id;
          const isPathPlayingIcon = !!(isSelectedPathForCurrentTrack && playingPathIds.includes(item.id));
          return (
            <button
              key={item.id}
              type="button"
              title={item.title}
              data-col-index={colIndex}
              data-row-index={rowIndex}
              data-item-id={item.id}
              className={`folder-col-row${isSelected ? ' selected' : ''}${isContextRow ? ' context-active' : ''}${isKeyboardRow ? ' keyboard-active' : ''}${isNowPlayingTrack ? ' now-playing' : ''}`}
              onClick={() => onRowClick(item, rowIndex)}
              onKeyDown={e => {
                if (!isFolderBrowserArrowKey(e) || folderBrowserHasKeyModifiers(e)) return;
                e.preventDefault();
              }}
              onContextMenu={e => onRowContextMenu(e, rowIndex, col, item)}
            >
              <span className={`folder-col-icon${isPathPlayingIcon ? ' folder-col-path-playing-icon' : ''}`}>
                {item.isDir ? (
                  isSelected ? (
                    <FolderOpen size={14} />
                  ) : (
                    <Folder size={14} />
                  )
                ) : (
                  <Music
                    size={14}
                    strokeWidth={isNowPlayingTrack ? 2.5 : 2}
                    className={isNowPlayingTrack && isPlaying ? 'folder-col-playing-icon' : undefined}
                  />
                )}
              </span>
              <span className="folder-col-name">{item.title}</span>
              {item.isDir && <ChevronRight size={12} className="folder-col-chevron" />}
            </button>
          );
        })
      )}
    </div>
  );
}
