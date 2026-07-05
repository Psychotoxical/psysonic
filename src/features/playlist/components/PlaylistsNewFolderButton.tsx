import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderPlus } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { usePlaylistFolderStore } from '@/features/playlist/store/playlistFolderStore';

/**
 * "New folder" action for the Playlists header row. Self-contained: toggles an
 * inline name input and creates a local folder for the active server. Folder
 * state is local-only, so this stays available offline.
 */
export default function PlaylistsNewFolderButton() {
  const { t } = useTranslation();
  const serverId = useAuthStore(s => s.activeServerId);
  const createFolder = usePlaylistFolderStore(s => s.createFolder);
  const folderCount = usePlaylistFolderStore(
    s => (serverId ? s.byServer[serverId]?.folders.length ?? 0 : 0),
  );
  const groupView = usePlaylistFolderStore(s => s.groupView);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  if (!serverId) return null;
  // Only offer folder creation in the grouped view; keep it available before the
  // first folder exists (the toggle is hidden then, so this is the only entry).
  if (folderCount > 0 && !groupView) return null;

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed) createFolder(serverId, trimmed);
    setName('');
    setCreating(false);
  };

  if (creating) {
    return (
      <>
        <input
          ref={inputRef}
          className="input"
          style={{ width: 180 }}
          placeholder={t('playlists.folders.namePlaceholder')}
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') { setCreating(false); setName(''); }
          }}
        />
        <button className="btn btn-primary" onClick={submit}>{t('playlists.folders.create')}</button>
        <button className="btn btn-surface" onClick={() => { setCreating(false); setName(''); }}>
          {t('playlists.cancel')}
        </button>
      </>
    );
  }

  return (
    <button className="btn btn-surface" onClick={() => setCreating(true)} aria-label={t('playlists.folders.newFolder')} data-tooltip={t('playlists.folders.newFolder')}>
      <FolderPlus size={15} /> <span className="compact-btn-label">{t('playlists.folders.newFolder')}</span>
    </button>
  );
}
