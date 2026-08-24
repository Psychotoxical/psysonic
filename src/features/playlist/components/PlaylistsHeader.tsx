import React from 'react';
import { useTranslation } from 'react-i18next';
import { CheckSquare2, Plus, Sparkles, Trash2 } from 'lucide-react';
import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';
import {
  defaultSmartFilters, type SmartFilters,
} from '@/features/playlist/utils/playlistsSmart';
import { offlineActionPolicy, type OfflineActionPolicy } from '@/features/offline';
import PlaylistsNewFolderButton from '@/features/playlist/components/PlaylistsNewFolderButton';
import PlaylistsFolderViewToggle from '@/features/playlist/components/PlaylistsFolderViewToggle';
import PlaylistsOwnershipFilter from '@/features/playlist/components/PlaylistsOwnershipFilter';
import PlaylistCreateFields from '@/features/playlist/components/PlaylistCreateFields';
import type { PlaylistOwnershipBucket } from '@/features/playlist/utils/playlistOwnership';

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
  createServerId: string;
  setCreateServerId: (serverId: string) => void;
  createServerOptions: Array<{ id: string; label: string }>;
  smartCreateServerOptions: Array<{ id: string; label: string }>;
  setEditingSmartId: React.Dispatch<React.SetStateAction<string | null>>;
  setSmartFilters: React.Dispatch<React.SetStateAction<SmartFilters>>;
  setGenreQuery: React.Dispatch<React.SetStateAction<string>>;
  onEditorIntent: () => void;
  actionPolicy?: OfflineActionPolicy;
  foldersEnabled?: boolean;
  /** Bucket sizes across the whole list — the filter hides itself when nothing is shared. */
  ownershipCounts: Record<PlaylistOwnershipBucket, number>;
}

export default function PlaylistsHeader({
  selectionMode, selectedIds, selectedPlaylists, isPlaylistDeletable,
  toggleSelectionMode, handleDeleteSelected,
  creating, setCreating, setCreatingSmart,
  newName, setNewName, nameInputRef, handleCreate,
  createServerId, setCreateServerId, createServerOptions,
  smartCreateServerOptions, setEditingSmartId, setSmartFilters, setGenreQuery, onEditorIntent,
  actionPolicy,
  foldersEnabled = true,
  ownershipCounts,
}: Props) {
  const { t } = useTranslation();
  const policy = actionPolicy ?? offlineActionPolicy('playlistsHeader', false);
  const cancelCreate = () => {
    setCreating(false);
    setNewName('');
  };

  return (
    <div className="playlists-header-stack">
      <div className="playlists-header">
        <h1 className="page-title" style={{ marginBottom: 0 }}>
          {selectionMode && selectedIds.size > 0
            ? t('playlists.selectionCount', { count: selectedIds.size })
            : t('playlists.title')}
        </h1>
        <div className="compact-action-bar" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-start' }}>
          {policy.canEditPlaylist && !(selectionMode && selectedIds.size > 0) && (<>
            {!creating && (
              <button className="btn btn-primary" onClick={() => { onEditorIntent(); setCreatingSmart(false); setCreating(true); }} aria-label={t('playlists.newPlaylist')} data-tooltip={t('playlists.newPlaylist')}>
                <Plus size={15} /> <span className="compact-btn-label">{t('playlists.newPlaylist')}</span>
              </button>
            )}
            {!creating && smartCreateServerOptions.length > 0 && (
              <button className="btn btn-surface" onClick={() => {
                onEditorIntent();
                setCreating(false);
                if (!smartCreateServerOptions.some(server => server.id === createServerId)) {
                  setCreateServerId(smartCreateServerOptions[0].id);
                }
                setEditingSmartId(null);
                setSmartFilters(defaultSmartFilters);
                setGenreQuery('');
                setCreatingSmart(v => !v);
              }} aria-label={t('smartPlaylists.create')} data-tooltip={t('smartPlaylists.create')}>
                <Sparkles size={15} /> <span className="compact-btn-label">{t('smartPlaylists.create')}</span>
              </button>
            )}
          </>
          )}
          {foldersEnabled && !(selectionMode && selectedIds.size > 0) && <PlaylistsFolderViewToggle />}
          {foldersEnabled && !(selectionMode && selectedIds.size > 0) && <PlaylistsNewFolderButton />}
          {selectionMode && selectedIds.size > 0 && (() => {
            const deletableCount = selectedPlaylists.filter(isPlaylistDeletable).length;
            return (
              <button
                className="btn btn-danger"
                onClick={handleDeleteSelected}
                disabled={deletableCount === 0}
                aria-label={t('playlists.deleteSelected')}
                data-tooltip={deletableCount === selectedIds.size
                  ? undefined
                  : t('playlists.deleteSelectedPartial', { n: deletableCount, total: selectedIds.size })}
                data-tooltip-pos="bottom"
              >
                <Trash2 size={15} />
                <span className="compact-btn-label">{t('playlists.deleteSelected')}</span>
              </button>
            );
          })()}
          <button
            className={`btn btn-surface${selectionMode ? ' btn-sort-active' : ''}`}
            onClick={toggleSelectionMode}
            aria-label={selectionMode ? t('playlists.cancelSelect') : t('playlists.select')}
            data-tooltip={selectionMode ? t('playlists.cancelSelect') : t('playlists.startSelect')}
            data-tooltip-pos="bottom"
            style={selectionMode ? { background: 'var(--accent)', color: 'var(--text-on-accent)' } : {}}
          >
            <CheckSquare2 size={15} />
            <span className="compact-btn-label">{selectionMode ? t('playlists.cancelSelect') : t('playlists.select')}</span>
          </button>
        </div>
      </div>
      {!(selectionMode && selectedIds.size > 0) && (
        <PlaylistsOwnershipFilter counts={ownershipCounts} />
      )}
      {creating && (
        <form
          className="playlist-create-panel"
          onSubmit={event => {
            event.preventDefault();
            void handleCreate();
          }}
        >
          <div className="playlist-create-panel__heading">
            <Plus size={16} />
            <span>{t('playlists.newPlaylist')}</span>
          </div>
          <PlaylistCreateFields
            name={newName}
            nameLabel={t('queue.playlistName')}
            namePlaceholder={t('playlists.createName')}
            onNameChange={setNewName}
            onNameKeyDown={event => {
              if (event.key === 'Escape') cancelCreate();
            }}
            nameInputRef={nameInputRef}
            serverId={createServerId}
            onServerChange={setCreateServerId}
            serverOptions={createServerOptions}
          />
          <div className="playlist-create-panel__actions">
            <button type="button" className="btn btn-surface" onClick={cancelCreate}>
              {t('playlists.cancel')}
            </button>
            <button type="submit" className="btn btn-primary" disabled={!createServerId}>
              {t('playlists.create')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
