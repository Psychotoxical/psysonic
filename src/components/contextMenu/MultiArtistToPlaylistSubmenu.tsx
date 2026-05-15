import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListMusic, Plus } from 'lucide-react';
import { getAlbum } from '../../api/subsonicLibrary';
import { getArtist } from '../../api/subsonicArtists';
import { getPlaylists } from '../../api/subsonicPlaylists';
import type { SubsonicPlaylist } from '../../api/subsonicTypes';
import { usePlaylistStore } from '../../store/playlistStore';
import { showToast } from '../../utils/ui/toast';
import {
  confirmAddAllDuplicates,
  isSmartPlaylistName,
} from '../../utils/componentHelpers/contextMenuHelpers';

interface Props {
  artistIds: string[];
  onDone: () => void;
  triggerId?: string;
}

export function MultiArtistToPlaylistSubmenu({ artistIds, onDone, triggerId: _triggerId }: Props) {
  const { t } = useTranslation();
  const [resolvedIds, setResolvedIds] = useState<string[] | null>(null);
  const [totalArtists, setTotalArtists] = useState(0);
  const [showLoading, setShowLoading] = useState(false);

  useEffect(() => {
    setTotalArtists(artistIds.length);
    const loadingTimeout = setTimeout(() => setShowLoading(true), 300);
    (async () => {
      const allSongs: string[] = [];
      for (const artistId of artistIds) {
        try {
          const { albums } = await getArtist(artistId);
          const albumSongs = await Promise.all(albums.map(a => getAlbum(a.id).then(r => r.songs).catch(() => [])));
          allSongs.push(...albumSongs.flat().map(s => s.id));
        } catch {
          // Skip failed artists
        }
      }
      setResolvedIds(allSongs);
    })().catch(() => setResolvedIds([]));
    return () => clearTimeout(loadingTimeout);
  }, [artistIds]);

  const handleAddWithToast = async (pl: SubsonicPlaylist, songIds: string[]) => {
    const { getPlaylist, updatePlaylist } = await import('../../api/subsonicPlaylists');
    const touchPlaylist = usePlaylistStore.getState().touchPlaylist;

    try {
      const { songs: existingSongs } = await getPlaylist(pl.id);
      const existingIds = new Set(existingSongs.map((s) => s.id));

      const newIds: string[] = [];
      const duplicateIds: string[] = [];

      for (const id of songIds) {
        if (existingIds.has(id)) duplicateIds.push(id);
        else newIds.push(id);
      }

      const addedCount = newIds.length;
      const duplicateCount = duplicateIds.length;

      if (addedCount > 0) {
        await updatePlaylist(pl.id, [...existingSongs.map((s) => s.id), ...newIds]);
        touchPlaylist(pl.id);
        if (duplicateCount > 0) {
          showToast(t('playlists.addPartial', { added: addedCount, skipped: duplicateCount, playlist: pl.name }), 4000, 'info');
        } else {
          showToast(t('playlists.addSuccess', { count: addedCount, playlist: pl.name }), 3000, 'info');
        }
      } else if (duplicateCount > 0) {
        const accepted = await confirmAddAllDuplicates(pl.name, duplicateCount, t);
        if (accepted) {
          await updatePlaylist(pl.id, [...existingSongs.map((s) => s.id), ...songIds]);
          touchPlaylist(pl.id);
          showToast(t('playlists.addedAsDuplicates', { count: duplicateCount, playlist: pl.name }), 3000, 'info');
        } else {
          showToast(t('playlists.addAllSkipped', { count: duplicateCount, playlist: pl.name }), 4000, 'info');
        }
      }
    } catch {
      showToast(t('playlists.addError'), 4000, 'error');
    }
    onDone();
  };

  // Custom AddToPlaylistSubmenu with toast notifications for multiple artists
  function MultiAddToPlaylistSubmenu({ songIds, onDone: innerOnDone }: { songIds: string[]; onDone: () => void }) {
    const subRef = useRef<HTMLDivElement>(null);
    const newNameRef = useRef<HTMLInputElement>(null);
    const [playlists, setPlaylists] = useState<SubsonicPlaylist[]>([]);
    const [adding, setAdding] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const [flipLeft, setFlipLeft] = useState(false);
    const [flipUp, setFlipUp] = useState(false);

    useEffect(() => {
      getPlaylists().then((all) => {
        setPlaylists(
          all.filter(p => !isSmartPlaylistName(p.name)).sort((a, b) => a.name.localeCompare(b.name)),
        );
      }).catch(() => {});
    }, []);

    useLayoutEffect(() => {
      if (subRef.current) {
        const rect = subRef.current.getBoundingClientRect();
        if (rect.right > window.innerWidth - 8) setFlipLeft(true);
        if (rect.bottom > window.innerHeight - 8) setFlipUp(true);
      }
    }, []);

    useEffect(() => {
      if (creating) newNameRef.current?.focus();
    }, [creating]);

    const handleAdd = async (pl: SubsonicPlaylist) => {
      setAdding(pl.id);
      await handleAddWithToast(pl, songIds);
      setAdding(null);
    };

    const handleCreate = async () => {
      const name = newName.trim() || t('playlists.unnamed');
      try {
        const { createPlaylist } = await import('../../api/subsonicPlaylists');
        const pl = await createPlaylist(name, songIds);
        if (pl?.id) {
          usePlaylistStore.getState().touchPlaylist(pl.id);
          showToast(t('playlists.createAndAddSuccess', { count: songIds.length, playlist: pl.name || name }), 3000, 'info');
        }
      } catch {
        showToast(t('playlists.createError'), 4000, 'error');
      }
      innerOnDone();
    };

    const subStyle: React.CSSProperties = flipLeft
      ? { right: '100%', left: 'auto', top: flipUp ? 'auto' : -4, bottom: flipUp ? 0 : 'auto' }
      : { left: '100%', right: 'auto', top: flipUp ? 'auto' : -4, bottom: flipUp ? 0 : 'auto' };

    return (
      <div className="context-submenu" ref={subRef} style={subStyle}>
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
        {playlists.length === 0 && (
          <div className="context-submenu-empty">{t('playlists.empty')}</div>
        )}
        {playlists.map((pl) => (
          <div
            key={pl.id}
            className="context-menu-item"
            onClick={() => handleAdd(pl)}
            style={{ opacity: adding === pl.id ? 0.5 : 1, pointerEvents: adding ? 'none' : undefined }}
          >
            <ListMusic size={13} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pl.name}</span>
          </div>
        ))}
      </div>
    );
  }

  if (resolvedIds === null) {
    if (!showLoading) {
      return <div className="context-submenu" style={{ minWidth: 190 }} />;
    }
    return (
      <div className="context-submenu" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0.75rem', gap: '0.5rem', minWidth: 190 }}>
        <div className="spinner" style={{ width: 16, height: 16 }} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {t('playlists.loadingArtists', { count: totalArtists })}
        </span>
      </div>
    );
  }
  if (resolvedIds.length === 0) return null;
  return <MultiAddToPlaylistSubmenu songIds={resolvedIds} onDone={onDone} />;
}
