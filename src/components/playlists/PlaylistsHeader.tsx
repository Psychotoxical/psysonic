import React from 'react';
import { useTranslation } from 'react-i18next';
import { CheckSquare2, Plus, Trash2 } from 'lucide-react';
import type { SubsonicPlaylist } from '../../api/subsonicTypes';
import {
  defaultSmartFilters, type SmartFilters,
} from '../../utils/playlist/playlistsSmart';

interface Props {
  selectionMode: boolean;
  selectedIds: Set<string>;
  selectedPlaylists: SubsonicPlaylist[];
  isPlaylistDeletable: (pl: SubsonicPlaylist) => boolean;
  toggleSelectionMode: () => void;
  handleDeleteSelected: () => void;
  creating: boolean;
  setCreating: React.Dispatch<React.SetStateAction<boolean>>;
  setCreatingSmart: React.Dispatch<React.SetStateAction<boolean>>;
  newName: string;
  setNewName: React.Dispatch<React.SetStateAction<string>>;
  nameInputRef: React.RefObject<HTMLInputElement | null>;
  handleCreate: () => Promise<void>;
  isNavidromeServer: boolean;
  setEditingSmartId: React.Dispatch<React.SetStateAction<string | null>>;
  setSmartFilters: React.Dispatch<React.SetStateAction<SmartFilters>>;
  setGenreQuery: React.Dispatch<React.SetStateAction<string>>;
}

export default function PlaylistsHeader({
  selectionMode, selectedIds, selectedPlaylists, isPlaylistDeletable,
  toggleSelectionMode, handleDeleteSelected,
  creating, setCreating, setCreatingSmart,
  newName, setNewName, nameInputRef, handleCreate,
  isNavidromeServer, setEditingSmartId, setSmartFilters, setGenreQuery,
}: Props) {
  const { t } = useTranslation();

  return (
    <div className="playlists-header">
      <h1 className="page-title" style={{ marginBottom: 0 }}>
        {selectionMode && selectedIds.size > 0
          ? t('playlists.selectionCount', { count: selectedIds.size })
          : t('playlists.title')}
      </h1>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        {!(selectionMode && selectedIds.size > 0) && (<>
            {creating ? (
              <>
                <input
                  ref={nameInputRef}
                  className="input"
                  style={{ width: 220 }}
                  placeholder={t('playlists.createName')}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreate();
                    if (e.key === 'Escape') { setCreating(false); setNewName(''); }
                  }}
                />
                <button className="btn btn-primary" onClick={handleCreate}>
                  {t('playlists.create')}
                </button>
                <button className="btn btn-surface" onClick={() => { setCreating(false); setNewName(''); }}>
                  {t('playlists.cancel')}
                </button>
              </>
            ) : (
              <button className="btn btn-primary" onClick={() => { setCreatingSmart(false); setCreating(true); }}>
                <Plus size={15} /> {t('playlists.newPlaylist')}
              </button>
            )}
            {!creating && isNavidromeServer && (
              <button className="btn btn-surface" onClick={() => {
                setCreating(false);
                setEditingSmartId(null);
                setSmartFilters(defaultSmartFilters);
                setGenreQuery('');
                setCreatingSmart(v => !v);
              }}>
                <Plus size={15} /> {t('smartPlaylists.create')}
              </button>
            )}
          </>
        )}
        {selectionMode && selectedIds.size > 0 && (() => {
          const deletableCount = selectedPlaylists.filter(isPlaylistDeletable).length;
          return (
            <button
              className="btn btn-danger"
              onClick={handleDeleteSelected}
              disabled={deletableCount === 0}
              data-tooltip={deletableCount === selectedIds.size
                ? undefined
                : t('playlists.deleteSelectedPartial', { n: deletableCount, total: selectedIds.size })}
              data-tooltip-pos="bottom"
            >
              <Trash2 size={15} />
              {t('playlists.deleteSelected')}
            </button>
          );
        })()}
        <button
          className={`btn btn-surface${selectionMode ? ' btn-sort-active' : ''}`}
          onClick={toggleSelectionMode}
          data-tooltip={selectionMode ? t('playlists.cancelSelect') : t('playlists.startSelect')}
          data-tooltip-pos="bottom"
          style={selectionMode ? { background: 'var(--accent)', color: 'var(--ctp-crust)' } : {}}
        >
          <CheckSquare2 size={15} />
          {selectionMode ? t('playlists.cancelSelect') : t('playlists.select')}
        </button>
      </div>
    </div>
  );
}
