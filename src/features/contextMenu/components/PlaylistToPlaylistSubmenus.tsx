import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListMusic, Plus } from 'lucide-react';
import {
  usePlaylistStore,
  addTracksToPlaylistWithDedup,
  collectMergeSongIds,
  resolvePlaylistSongIds,
} from '@/features/playlist';
import { usePlaylistMembershipStore } from '@/store/playlistMembershipStore';
import { showToast } from '@/lib/dom/toast';
import { isSmartPlaylistName } from '@/features/contextMenu/utils/contextMenuHelpers';

interface SingleProps {
  playlist: { id: string; name: string };
  onDone: () => void;
  triggerId?: string;
}

export function SinglePlaylistToPlaylistSubmenu({ playlist, onDone, triggerId }: SingleProps) {
  const { t } = useTranslation();
  const subRef = useRef<HTMLDivElement>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const newNameRef = useRef<HTMLInputElement>(null);
  const [flipLeft, setFlipLeft] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const storePlaylists = usePlaylistStore((s) => s.playlists);

  const allPlaylists = useMemo(() => {
    return storePlaylists.filter(
      (p) => p.id !== playlist.id && !isSmartPlaylistName(p.name),
    );
  }, [storePlaylists, playlist.id]);

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

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const createPlaylist = usePlaylistStore.getState().createPlaylist;
    try {
      const newPl = await createPlaylist(newName.trim(), []);
      if (newPl?.id) {
        await handleAddToNewPlaylist(newPl.id, newPl.name || newName.trim());
      }
      setCreating(false);
      setNewName('');
    } catch {
      showToast(t('playlists.createError'), 3000, 'error');
    }
  };

  const handleAddToNewPlaylist = async (targetId: string, targetName: string) => {
    const touchPlaylist = usePlaylistStore.getState().touchPlaylist;

    try {
      const { getPlaylist } = await import('@/lib/api/subsonicPlaylists');
      const sourceIds = await resolvePlaylistSongIds(playlist.id, async () => {
        const { songs } = await getPlaylist(playlist.id);
        return songs.map(s => s.id);
      });
      if (sourceIds.length > 0) {
        const result = await addTracksToPlaylistWithDedup(targetId, targetName, sourceIds, t);
        if (result.addedCount > 0) {
          showToast(t('playlists.createAndAddSuccess', { count: result.addedCount, playlist: targetName }), 3000, 'info');
          touchPlaylist(targetId);
        }
      }
      onDone();
    } catch {
      showToast(t('playlists.addToPlaylistError'), 4000, 'error');
      onDone();
    }
  };

  const handleAdd = async (targetId: string, targetName: string) => {
    const touchPlaylist = usePlaylistStore.getState().touchPlaylist;

    try {
      const { getPlaylist } = await import('@/lib/api/subsonicPlaylists');
      const sourceIds = await resolvePlaylistSongIds(playlist.id, async () => {
        const { songs } = await getPlaylist(playlist.id);
        return songs.map(s => s.id);
      });
      const result = await addTracksToPlaylistWithDedup(targetId, targetName, sourceIds, t);
      if (result.outcome === 'skipped') {
        showToast(t('playlists.addToPlaylistNoNew', { playlist: targetName }), 3000, 'info');
      } else {
        showToast(t('playlists.addToPlaylistSuccess', { count: result.addedCount, playlist: targetName }), 3000, 'info');
        touchPlaylist(targetId);
      }
      onDone();
    } catch {
      showToast(t('playlists.addToPlaylistError'), 4000, 'error');
      onDone();
    }
  };

  const subStyle: React.CSSProperties = flipLeft
    ? { right: '100%', left: 'auto', top: flipUp ? 'auto' : -4, bottom: flipUp ? 0 : 'auto' }
    : { left: '100%', right: 'auto', top: flipUp ? 'auto' : -4, bottom: flipUp ? 0 : 'auto' };

  return (
    <div ref={subRef} className="context-submenu" data-submenu-for={triggerId} style={{ ...subStyle, minWidth: 190 }}>
      {!creating ? (
        <div className="context-menu-item context-submenu-new" onClick={e => { e.stopPropagation(); setCreating(true); }}>
          <Plus size={13} /> {t('playlists.newPlaylist')}
        </div>
      ) : (
        <div className="context-submenu-create" onClick={e => e.stopPropagation()}>
          <input
            ref={newNameRef}
            className="context-submenu-input"
            placeholder={t('playlists.createName')}
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
      {allPlaylists.length === 0 && (
        <div className="context-submenu-empty">{t('playlists.noOtherPlaylists')}</div>
      )}
      {allPlaylists.map(pl => (
        <div
          key={pl.id}
          className="context-menu-item"
          onClick={() => handleAdd(pl.id, pl.name)}
        >
          <ListMusic size={13} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pl.name}</span>
        </div>
      ))}
    </div>
  );
}

interface MultiProps {
  playlists: { id: string; name: string }[];
  onDone: () => void;
  triggerId?: string;
}

export function MultiPlaylistToPlaylistSubmenu({ playlists, onDone, triggerId }: MultiProps) {
  const { t } = useTranslation();
  const subRef = useRef<HTMLDivElement>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const newNameRef = useRef<HTMLInputElement>(null);
  const [flipLeft, setFlipLeft] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const storePlaylists = usePlaylistStore((s) => s.playlists);

  const allPlaylists = useMemo(() => {
    const selectedIds = new Set(playlists.map(p => p.id));
    return storePlaylists.filter(
      (p) => !selectedIds.has(p.id) && !isSmartPlaylistName(p.name),
    );
  }, [storePlaylists, playlists]);

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

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const createPlaylist = usePlaylistStore.getState().createPlaylist;
    try {
      const newPl = await createPlaylist(newName.trim(), []);
      if (newPl?.id) {
        await handleMergeToNewPlaylist(newPl.id, newPl.name || newName.trim());
      }
      setCreating(false);
      setNewName('');
    } catch {
      showToast(t('playlists.createError'), 3000, 'error');
    }
  };

  const handleMergeToNewPlaylist = async (targetId: string, targetName: string) => {
    const { addSongsToPlaylist } = await import('@/lib/api/subsonicPlaylists');
    const touchPlaylist = usePlaylistStore.getState().touchPlaylist;
    const membership = usePlaylistMembershipStore.getState();

    try {
      const idsToAdd = await collectMergeSongIds(targetId, playlists.map(p => p.id));
      if (idsToAdd.length > 0) {
        await addSongsToPlaylist(targetId, idsToAdd);
        membership.appendPlaylistSongIds(targetId, idsToAdd);
        touchPlaylist(targetId);
        showToast(t('playlists.createAndAddSuccess', { count: idsToAdd.length, playlist: targetName }), 3000, 'info');
      }
      onDone();
    } catch {
      membership.invalidatePlaylistSongIds(targetId);
      showToast(t('playlists.mergeError'), 4000, 'error');
      onDone();
    }
  };

  const handleMerge = async (targetId: string, targetName: string) => {
    const { addSongsToPlaylist } = await import('@/lib/api/subsonicPlaylists');
    const touchPlaylist = usePlaylistStore.getState().touchPlaylist;
    const membership = usePlaylistMembershipStore.getState();

    try {
      const idsToAdd = await collectMergeSongIds(targetId, playlists.map(p => p.id));
      if (idsToAdd.length > 0) {
        await addSongsToPlaylist(targetId, idsToAdd);
        membership.appendPlaylistSongIds(targetId, idsToAdd);
        touchPlaylist(targetId);
        showToast(t('playlists.mergeSuccess', { count: idsToAdd.length, playlist: targetName }), 3000, 'info');
      } else {
        showToast(t('playlists.mergeNoNewSongs'), 3000, 'info');
      }
      onDone();
    } catch {
      membership.invalidatePlaylistSongIds(targetId);
      showToast(t('playlists.mergeError'), 4000, 'error');
      onDone();
    }
  };

  const subStyle: React.CSSProperties = flipLeft
    ? { right: '100%', left: 'auto', top: flipUp ? 'auto' : -4, bottom: flipUp ? 0 : 'auto' }
    : { left: '100%', right: 'auto', top: flipUp ? 'auto' : -4, bottom: flipUp ? 0 : 'auto' };

  return (
    <div ref={subRef} className="context-submenu" data-submenu-for={triggerId} style={{ ...subStyle, minWidth: 190 }}>
      {!creating ? (
        <div className="context-menu-item context-submenu-new" onClick={e => { e.stopPropagation(); setCreating(true); }}>
          <Plus size={13} /> {t('playlists.newPlaylist')}
        </div>
      ) : (
        <div className="context-submenu-create" onClick={e => e.stopPropagation()}>
          <input
            ref={newNameRef}
            className="context-submenu-input"
            placeholder={t('playlists.createName')}
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
      {allPlaylists.length === 0 && (
        <div className="context-submenu-empty">{t('playlists.noOtherPlaylists')}</div>
      )}
      {allPlaylists.map(pl => (
        <div
          key={pl.id}
          className="context-menu-item"
          onClick={() => handleMerge(pl.id, pl.name)}
        >
          <ListMusic size={13} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pl.name}</span>
        </div>
      ))}
    </div>
  );
}
