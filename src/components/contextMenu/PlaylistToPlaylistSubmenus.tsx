import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListMusic, Plus } from 'lucide-react';
import { usePlaylistStore } from '../../store/playlistStore';
import { showToast } from '../../utils/ui/toast';
import { isSmartPlaylistName } from '../../utils/componentHelpers/contextMenuHelpers';

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
    const { createPlaylist } = await import('../../api/subsonicPlaylists');
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
    const { getPlaylist, updatePlaylist } = await import('../../api/subsonicPlaylists');
    const touchPlaylist = usePlaylistStore.getState().touchPlaylist;

    try {
      const { songs: sourceSongs } = await getPlaylist(playlist.id);
      if (sourceSongs.length > 0) {
        await updatePlaylist(targetId, sourceSongs.map((s: { id: string }) => s.id));
        touchPlaylist(targetId);
        showToast(t('playlists.createAndAddSuccess', { count: sourceSongs.length, playlist: targetName }), 3000, 'info');
      }
      onDone();
    } catch {
      showToast(t('playlists.addToPlaylistError'), 4000, 'error');
      onDone();
    }
  };

  const handleAdd = async (targetId: string, targetName: string) => {
    const { getPlaylist, updatePlaylist } = await import('../../api/subsonicPlaylists');
    const touchPlaylist = usePlaylistStore.getState().touchPlaylist;

    try {
      const { songs: targetSongs } = await getPlaylist(targetId);
      const targetIds = new Set(targetSongs.map((s: { id: string }) => s.id));
      const { songs: sourceSongs } = await getPlaylist(playlist.id);
      const newSongs = sourceSongs.filter((s: { id: string }) => !targetIds.has(s.id));

      if (newSongs.length > 0) {
        newSongs.forEach((s: { id: string }) => targetIds.add(s.id));
        await updatePlaylist(targetId, Array.from(targetIds));
        touchPlaylist(targetId);
        showToast(t('playlists.addToPlaylistSuccess', { count: newSongs.length, playlist: targetName }), 3000, 'info');
      } else {
        showToast(t('playlists.addToPlaylistNoNew', { playlist: targetName }), 3000, 'info');
      }
      onDone();
    } catch {
      showToast(t('playlists.addToPlaylistError'), 4000, 'error');
      onDone();
    }
  };

  const subStyle: React.CSSProperties = flipLeft
    ? { right: 'calc(100% + 4px)', left: 'auto', top: flipUp ? 'auto' : -4, bottom: flipUp ? 0 : 'auto' }
    : { left: 'calc(100% + 4px)', right: 'auto', top: flipUp ? 'auto' : -4, bottom: flipUp ? 0 : 'auto' };

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
    const { createPlaylist } = await import('../../api/subsonicPlaylists');
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
    const { getPlaylist, updatePlaylist } = await import('../../api/subsonicPlaylists');
    const touchPlaylist = usePlaylistStore.getState().touchPlaylist;

    try {
      const targetIds = new Set<string>();
      let totalAdded = 0;

      for (const pl of playlists) {
        const { songs } = await getPlaylist(pl.id);
        const newSongs = songs.filter((s: { id: string }) => !targetIds.has(s.id));
        if (newSongs.length > 0) {
          newSongs.forEach((s: { id: string }) => targetIds.add(s.id));
          totalAdded += newSongs.length;
        }
      }

      if (totalAdded > 0) {
        await updatePlaylist(targetId, Array.from(targetIds));
        touchPlaylist(targetId);
        showToast(t('playlists.createAndAddSuccess', { count: totalAdded, playlist: targetName }), 3000, 'info');
      }
      onDone();
    } catch {
      showToast(t('playlists.mergeError'), 4000, 'error');
      onDone();
    }
  };

  const handleMerge = async (targetId: string, targetName: string) => {
    const { getPlaylist, updatePlaylist } = await import('../../api/subsonicPlaylists');
    const touchPlaylist = usePlaylistStore.getState().touchPlaylist;

    try {
      const { songs: targetSongs } = await getPlaylist(targetId);
      const targetIds = new Set(targetSongs.map((s: { id: string }) => s.id));
      let totalAdded = 0;

      for (const pl of playlists) {
        const { songs } = await getPlaylist(pl.id);
        const newSongs = songs.filter((s: { id: string }) => !targetIds.has(s.id));
        if (newSongs.length > 0) {
          newSongs.forEach((s: { id: string }) => targetIds.add(s.id));
          totalAdded += newSongs.length;
        }
      }

      if (totalAdded > 0) {
        await updatePlaylist(targetId, Array.from(targetIds));
        touchPlaylist(targetId);
        showToast(t('playlists.mergeSuccess', { count: totalAdded, playlist: targetName }), 3000, 'info');
      } else {
        showToast(t('playlists.mergeNoNewSongs'), 3000, 'info');
      }
      onDone();
    } catch {
      showToast(t('playlists.mergeError'), 4000, 'error');
      onDone();
    }
  };

  const subStyle: React.CSSProperties = flipLeft
    ? { right: 'calc(100% + 4px)', left: 'auto', top: flipUp ? 'auto' : -4, bottom: flipUp ? 0 : 'auto' }
    : { left: 'calc(100% + 4px)', right: 'auto', top: flipUp ? 'auto' : -4, bottom: flipUp ? 0 : 'auto' };

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
