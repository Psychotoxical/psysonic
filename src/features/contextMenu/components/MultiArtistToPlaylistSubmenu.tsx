import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListMusic, Plus } from 'lucide-react';
import { resolveAlbum, resolveArtist, resolveMediaServerId } from '@/features/offline';
import { getPlaylists, getPlaylistsForServer } from '@/lib/api/subsonicPlaylists';
import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';
import { usePlaylistStore } from '@/features/playlist';
import { addTracksToPlaylistWithDedup, showAddTracksDedupToast } from '@/features/playlist';
import { showToast } from '@/lib/dom/toast';
import { ownedEntityKey } from '@/lib/util/ownedEntityKey';
import { isSmartPlaylist } from '@/lib/format/playlistClassification';

interface Props {
  artists: Array<{ id: string; serverId?: string }>;
  onDone: () => void;
  triggerId?: string;
}

export function MultiArtistToPlaylistSubmenu({ artists, onDone, triggerId: _triggerId }: Props) {
  const { t } = useTranslation();
  const [resolvedIds, setResolvedIds] = useState<string[] | null>(null);
  const [totalArtists, setTotalArtists] = useState(0);
  const [showLoading, setShowLoading] = useState(false);
  const [resolvedServerId] = useState(() => resolveMediaServerId(artists[0]?.serverId) ?? undefined);

  useEffect(() => {
    // React Compiler set-state-in-effect rule: state set from a timer/animation callback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTotalArtists(artists.length);
    const loadingTimeout = setTimeout(() => setShowLoading(true), 300);
    (async () => {
      const allSongs: string[] = [];
      const serverId = resolvedServerId;
      if (!serverId) {
        setResolvedIds([]);
        return;
      }
      for (const artist of artists) {
        try {
          const artistData = await resolveArtist(serverId, artist.id);
          if (!artistData) continue;
          const albumSongs = await Promise.all(
            artistData.albums.map(a => resolveAlbum(serverId, a.id).then(r => r?.songs ?? []).catch(() => [])),
          );
          allSongs.push(...albumSongs.flat().map(s => s.id));
        } catch {
          // Skip failed artists
        }
      }
      setResolvedIds(allSongs);
    })().catch(() => setResolvedIds([]));
    return () => clearTimeout(loadingTimeout);
  }, [artists, resolvedServerId]);

  const handleAddWithToast = async (pl: SubsonicPlaylist, songIds: string[]) => {
    if (!resolvedServerId) return;
    const touchPlaylist = usePlaylistStore.getState().touchPlaylist;

    try {
      const result = await addTracksToPlaylistWithDedup(pl.id, pl.name, songIds, t, resolvedServerId);
      showAddTracksDedupToast(t, pl.name, result);
      if (result.outcome !== 'skipped') touchPlaylist(pl.id, resolvedServerId);
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
      const request = resolvedServerId ? getPlaylistsForServer(resolvedServerId) : getPlaylists();
      request.then((all) => {
        setPlaylists(
          all.filter(p => !isSmartPlaylist(p)).sort((a, b) => a.name.localeCompare(b.name)),
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
      setAdding(ownedEntityKey(pl));
      await handleAddWithToast(pl, songIds);
      setAdding(null);
    };

    const handleCreate = async () => {
      if (!resolvedServerId) return;
      const name = newName.trim() || t('playlists.unnamed');
      try {
        const { createPlaylist } = await import('@/lib/api/subsonicPlaylists');
        const pl = await createPlaylist(name, songIds, resolvedServerId);
        if (pl?.id) {
          usePlaylistStore.getState().touchPlaylist(pl.id, resolvedServerId);
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
            key={ownedEntityKey(pl)}
            className="context-menu-item"
            onClick={() => handleAdd(pl)}
            style={{ opacity: adding === ownedEntityKey(pl) ? 0.5 : 1, pointerEvents: adding ? 'none' : undefined }}
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
  // React Compiler rule: component intentionally defined inline for closure access.
  // eslint-disable-next-line react-hooks/static-components
  return <MultiAddToPlaylistSubmenu songIds={resolvedIds} onDone={onDone} />;
}
