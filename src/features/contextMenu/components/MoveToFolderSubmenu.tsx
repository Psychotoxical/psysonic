import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Folder, FolderMinus, Plus } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { EMPTY_SERVER_FOLDERS, usePlaylistFolderStore } from '@/features/playlist';

interface Props {
  playlistId: string;
  onDone: () => void;
  triggerId?: string;
}

/**
 * Submenu for assigning a single playlist to a (local) folder. Mirrors the
 * "Add to playlist" submenu's layout/positioning so it shares the context-menu
 * hover machinery. Folder assignment is purely local state, so it stays
 * available offline.
 */
export default function MoveToFolderSubmenu({ playlistId, onDone, triggerId }: Props) {
  const { t } = useTranslation();
  const subRef = useRef<HTMLDivElement>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const newNameRef = useRef<HTMLInputElement>(null);
  const [flipLeft, setFlipLeft] = useState(false);
  const [flipUp, setFlipUp] = useState(false);

  const serverId = useAuthStore(s => s.activeServerId);
  const bucket =
    usePlaylistFolderStore(s => (serverId ? s.byServer[serverId] : undefined)) ?? EMPTY_SERVER_FOLDERS;
  const createFolder = usePlaylistFolderStore(s => s.createFolder);
  const setPlaylistFolder = usePlaylistFolderStore(s => s.setPlaylistFolder);

  const currentFolderId = bucket.assignments[playlistId];
  const folders = useMemo(
    () => [...bucket.folders].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
    [bucket.folders],
  );

  useLayoutEffect(() => {
    if (subRef.current) {
      const rect = subRef.current.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) setFlipLeft(true);
      if (rect.bottom > window.innerHeight - 8) setFlipUp(true);
    }
  }, []);

  useEffect(() => {
    if (creating && newNameRef.current) newNameRef.current.focus();
  }, [creating]);

  const assign = (folderId: string | null) => {
    if (!serverId) return;
    setPlaylistFolder(serverId, playlistId, folderId);
    onDone();
  };

  const handleCreate = () => {
    const name = newName.trim();
    if (!name || !serverId) return;
    const id = createFolder(serverId, name);
    setPlaylistFolder(serverId, playlistId, id);
    setCreating(false);
    setNewName('');
    onDone();
  };

  const subStyle: React.CSSProperties = flipLeft
    ? { right: '100%', left: 'auto', top: flipUp ? 'auto' : -4, bottom: flipUp ? 0 : 'auto' }
    : { left: '100%', right: 'auto', top: flipUp ? 'auto' : -4, bottom: flipUp ? 0 : 'auto' };

  return (
    <div ref={subRef} className="context-submenu" data-submenu-for={triggerId} style={{ ...subStyle, minWidth: 190 }}>
      {!creating ? (
        <div className="context-menu-item context-submenu-new" onClick={e => { e.stopPropagation(); setCreating(true); }}>
          <Plus size={13} /> {t('playlists.folders.newFolder')}
        </div>
      ) : (
        <div className="context-submenu-create" onClick={e => e.stopPropagation()}>
          <input
            ref={newNameRef}
            className="context-submenu-input"
            placeholder={t('playlists.folders.namePlaceholder')}
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleCreate();
              if (e.key === 'Escape') { setCreating(false); setNewName(''); }
            }}
          />
          <button className="context-submenu-create-btn" onClick={handleCreate}>
            <Plus size={13} />
          </button>
        </div>
      )}
      <div className="context-menu-divider" />
      {currentFolderId != null && (
        <div className="context-menu-item" onClick={() => assign(null)}>
          <FolderMinus size={13} /> {t('playlists.folders.removeFromFolder')}
        </div>
      )}
      {folders.map(f => (
        <div key={f.id} className="context-menu-item" onClick={() => assign(f.id)}>
          <Folder size={13} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{f.name}</span>
          {currentFolderId === f.id && <Check size={13} style={{ marginLeft: 'auto' }} />}
        </div>
      ))}
    </div>
  );
}
