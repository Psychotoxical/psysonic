import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Play, ListPlus, Radio, Heart, Download, ChevronRight, User, Disc3, ListMusic, Plus, Info, Sparkles, Star, Trash2, HeartCrack, Share2 } from 'lucide-react';
import LastfmIcon from './LastfmIcon';
import StarRating from './StarRating';
import { lastfmLoveTrack, lastfmUnloveTrack } from '../api/lastfm';
import { usePlayerStore, Track, songToTrack } from '../store/playerStore';
import { useShallow } from 'zustand/react/shallow';
import { SubsonicAlbum, SubsonicArtist, star, unstar, getSimilarSongs2, getSimilarSongs, getTopSongs, buildDownloadUrl, getAlbum, getArtist, getPlaylists, getPlaylist, updatePlaylist, SubsonicPlaylist, setRating } from '../api/subsonic';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { useDownloadModalStore } from '../store/downloadModalStore';
import { usePlaylistStore } from '../store/playlistStore';
import { open } from '@tauri-apps/plugin-shell';
import { join } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';
import { useZipDownloadStore } from '../store/zipDownloadStore';
import { useTranslation } from 'react-i18next';
import { showToast } from '../utils/toast';
import type { EntityShareKind } from '../utils/shareLink';
import { copyEntityShareLink } from '../utils/copyEntityShareLink';

function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .substring(0, 200) || 'download';
}

/** Fisher-Yates in-place shuffle — returns a new array, does not mutate the input. */
function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ── Add-to-Playlist submenu ───────────────────────────────────────
export function AddToPlaylistSubmenu({ songIds, onDone, dropDown, triggerId }: { songIds: string[]; onDone: () => void; dropDown?: boolean; triggerId?: string }) {
  const { t } = useTranslation();
  const subRef = useRef<HTMLDivElement>(null);
  const newNameRef = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [flipLeft, setFlipLeft] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const storePlaylists = usePlaylistStore((s) => s.playlists);
  const recentIds = usePlaylistStore((s) => s.recentIds);
  const createPlaylist = usePlaylistStore((s) => s.createPlaylist);
  const touchPlaylist = usePlaylistStore((s) => s.touchPlaylist);
  const fetchPlaylists = usePlaylistStore((s) => s.fetchPlaylists);

  // Fetch playlists on first open if the store hasn't been populated yet
  useEffect(() => {
    if (storePlaylists.length === 0) fetchPlaylists();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sort playlists by recent usage
  const playlists = useMemo(() => {
    return [...storePlaylists].sort((a, b) => {
      const ai = recentIds.indexOf(a.id);
      const bi = recentIds.indexOf(b.id);
      if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }, [storePlaylists, recentIds]);

  // Flip submenu left if it would overflow the right edge of the viewport
  // Flip submenu up if it would overflow the bottom of the viewport
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
    try {
      const { songs } = await getPlaylist(pl.id);
      const existingIds = new Set(songs.map((s) => s.id));
      const newIds = songIds.filter((id) => !existingIds.has(id));
      if (newIds.length > 0) {
        await updatePlaylist(pl.id, [...songs.map((s) => s.id), ...newIds]);
        showToast(t('playlists.addSuccess', { count: newIds.length, playlist: pl.name }));
      } else {
        showToast(t('playlists.addAllSkipped', { count: songIds.length, playlist: pl.name }), 3000, 'info');
      }
      touchPlaylist(pl.id);
    } catch {
      showToast(t('playlists.addError'), 3000, 'error');
    }
    setAdding(null);
    onDone();
  };

  const handleCreate = async () => {
    const name = newName.trim() || t('playlists.unnamed');
    try {
      const pl = await createPlaylist(name, songIds);
      if (pl?.id) {
        showToast(t('playlists.createAndAddSuccess', { count: songIds.length, playlist: pl.name || name }));
      }
    } catch {
      showToast(t('playlists.createError'), 3000, 'error');
    }
    onDone();
  };

  const subStyle: React.CSSProperties = dropDown
    ? { top: 'calc(100% + 4px)', left: 0, right: 'auto' }
    : flipLeft
      ? { right: 'calc(100% + 4px)', left: 'auto', top: flipUp ? 'auto' : -4, bottom: flipUp ? 0 : 'auto' }
      : { left: 'calc(100% + 4px)', right: 'auto', top: flipUp ? 'auto' : -4, bottom: flipUp ? 0 : 'auto' };

  return (
    <div className="context-submenu" data-parent-trigger-id={triggerId ?? ''} ref={subRef} style={subStyle}>
      {/* New Playlist row */}
      {!creating ? (
        <div
          className="context-menu-item context-submenu-new"
          onClick={e => { e.stopPropagation(); setCreating(true); }}
        >
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
      {playlists.map((pl: SubsonicPlaylist) => (
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

// Same as AddToPlaylistSubmenu but resolves album songs first
function AlbumToPlaylistSubmenu({ albumId, onDone, triggerId }: { albumId: string; onDone: () => void; triggerId?: string }) {
  const [resolvedIds, setResolvedIds] = useState<string[] | null>(null);

  useEffect(() => {
    getAlbum(albumId).then((data) => {
      setResolvedIds(data.songs.map((s) => s.id));
    }).catch(() => setResolvedIds([]));
  }, [albumId]);

  if (resolvedIds === null) {
    return (
      <div className="context-submenu" style={{ display: 'flex', justifyContent: 'center', padding: '0.75rem' }}>
        <div className="spinner" style={{ width: 16, height: 16 }} />
      </div>
    );
  }
  if (resolvedIds.length === 0) return null;
  return <AddToPlaylistSubmenu songIds={resolvedIds} onDone={onDone} triggerId={triggerId} />;
}

// Resolves all songs from all of an artist's albums, then hands off to AddToPlaylistSubmenu.
function ArtistToPlaylistSubmenu({ artistId, onDone, triggerId }: { artistId: string; onDone: () => void; triggerId?: string }) {
  const [resolvedIds, setResolvedIds] = useState<string[] | null>(null);

  useEffect(() => {
    (async () => {
      const { albums } = await getArtist(artistId);
      const albumSongs = await Promise.all(albums.map(a => getAlbum(a.id).then(r => r.songs)));
      setResolvedIds(albumSongs.flat().map(s => s.id));
    })().catch(() => setResolvedIds([]));
  }, [artistId]);

  if (resolvedIds === null) {
    return (
      <div className="context-submenu" style={{ display: 'flex', justifyContent: 'center', padding: '0.75rem' }}>
        <div className="spinner" style={{ width: 16, height: 16 }} />
      </div>
    );
  }
  if (resolvedIds.length === 0) return null;
  return <AddToPlaylistSubmenu songIds={resolvedIds} onDone={onDone} triggerId={triggerId} />;
}

// Resolves all songs from multiple albums and adds them to playlist with detailed toast notifications
function MultiAlbumToPlaylistSubmenu({ albumIds, onDone, triggerId }: { albumIds: string[]; onDone: () => void; triggerId?: string }) {
  const { t } = useTranslation();
  const [resolvedIds, setResolvedIds] = useState<string[] | null>(null);
  const [totalAlbums, setTotalAlbums] = useState(0);
  const [showLoading, setShowLoading] = useState(false);

  useEffect(() => {
    setTotalAlbums(albumIds.length);
    // Delay showing loading state to avoid flash for fast loads
    const loadingTimeout = setTimeout(() => setShowLoading(true), 300);
    (async () => {
      const albumSongs = await Promise.all(albumIds.map(id => getAlbum(id).then(r => r.songs).catch(() => [])));
      const allSongs = albumSongs.flat();
      setResolvedIds(allSongs.map(s => s.id));
    })().catch(() => setResolvedIds([]));
    return () => clearTimeout(loadingTimeout);
  }, [albumIds]);

  const handleAddWithToast = async (pl: SubsonicPlaylist, songIds: string[]) => {
    const { getPlaylist, updatePlaylist } = await import('../api/subsonic');
    const { usePlaylistStore } = await import('../store/playlistStore');
    const { showToast } = await import('../utils/toast');
    const touchPlaylist = usePlaylistStore.getState().touchPlaylist;

    try {
      const { songs: existingSongs } = await getPlaylist(pl.id);
      const existingIds = new Set(existingSongs.map((s) => s.id));

      const newIds: string[] = [];
      const duplicateIds: string[] = [];

      for (const id of songIds) {
        if (existingIds.has(id)) {
          duplicateIds.push(id);
        } else {
          newIds.push(id);
        }
      }

      if (newIds.length > 0) {
        await updatePlaylist(pl.id, [...existingSongs.map((s) => s.id), ...newIds]);
        touchPlaylist(pl.id);
      }

      // Show detailed toast notification
      const totalSongs = songIds.length;
      const addedCount = newIds.length;
      const duplicateCount = duplicateIds.length;

      if (addedCount === 0 && duplicateCount > 0) {
        showToast(
          t('playlists.addAllSkipped', { count: duplicateCount, playlist: pl.name }),
          4000,
          'info'
        );
      } else if (duplicateCount > 0) {
        showToast(
          t('playlists.addPartial', { added: addedCount, skipped: duplicateCount, playlist: pl.name }),
          4000,
          'info'
        );
      } else {
        showToast(
          t('playlists.addSuccess', { count: addedCount, playlist: pl.name }),
          3000,
          'info'
        );
      }
    } catch (err) {
      showToast(t('playlists.addError'), 4000, 'error');
    }
    onDone();
  };

  const handleCreateWithToast = async (songIds: string[]) => {
    const { createPlaylist } = await import('../api/subsonic');
    const { usePlaylistStore } = await import('../store/playlistStore');
    const { showToast } = await import('../utils/toast');
    const touchPlaylist = usePlaylistStore.getState().touchPlaylist;

    try {
      const name = t('playlists.unnamed');
      const pl = await createPlaylist(name, songIds);
      if (pl?.id) {
        touchPlaylist(pl.id);
        showToast(
          t('playlists.createAndAddSuccess', { count: songIds.length, playlist: pl.name || name }),
          3000,
          'info'
        );
      }
    } catch {
      showToast(t('playlists.createError'), 4000, 'error');
    }
    onDone();
  };

  // Custom AddToPlaylistSubmenu with toast notifications for multiple albums
  function MultiAddToPlaylistSubmenu({ songIds, onDone }: { songIds: string[]; onDone: () => void }) {
    const { t } = useTranslation();
    const subRef = useRef<HTMLDivElement>(null);
    const newNameRef = useRef<HTMLInputElement>(null);
    const [adding, setAdding] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const [flipLeft, setFlipLeft] = useState(false);
    const [flipUp, setFlipUp] = useState(false);
    const [visible, setVisible] = useState(false);
    const storePlaylists = usePlaylistStore((s) => s.playlists);

    // Sort playlists from store (no fetch needed, prevents flash)
    const playlists = useMemo(() => {
      return [...storePlaylists].sort((a, b) => a.name.localeCompare(b.name));
    }, [storePlaylists]);

    useLayoutEffect(() => {
      if (subRef.current) {
        const rect = subRef.current.getBoundingClientRect();
        if (rect.right > window.innerWidth - 8) setFlipLeft(true);
        if (rect.bottom > window.innerHeight - 8) setFlipUp(true);
        // Show after position is calculated to prevent flash
        setVisible(true);
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
        const { createPlaylist } = await import('../api/subsonic');
        const pl = await createPlaylist(name, songIds);
        if (pl?.id) {
          const { usePlaylistStore } = await import('../store/playlistStore');
          usePlaylistStore.getState().touchPlaylist(pl.id);
          showToast(
            t('playlists.createAndAddSuccess', { count: songIds.length, playlist: pl.name || name }),
            3000,
            'info'
          );
        }
      } catch {
        showToast(t('playlists.createError'), 4000, 'error');
      }
      onDone();
    };

    const subStyle: React.CSSProperties = flipLeft
      ? { right: 'calc(100% + 4px)', left: 'auto', top: flipUp ? 'auto' : -4, bottom: flipUp ? 0 : 'auto' }
      : { left: 'calc(100% + 4px)', right: 'auto', top: flipUp ? 'auto' : -4, bottom: flipUp ? 0 : 'auto' };

    return (
      <div className="context-submenu" ref={subRef} style={{ ...subStyle, visibility: visible ? 'visible' : 'hidden' }}>
        {!creating ? (
          <div
            className="context-menu-item context-submenu-new"
            onClick={e => { e.stopPropagation(); setCreating(true); }}
          >
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
    // Only show loading UI if it takes more than 300ms (avoid flash)
    if (!showLoading) {
      return <div className="context-submenu" style={{ minWidth: 190 }} />;
    }
    return (
      <div className="context-submenu" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0.75rem', gap: '0.5rem', minWidth: 190 }}>
        <div className="spinner" style={{ width: 16, height: 16 }} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {t('playlists.loadingAlbums', { count: totalAlbums })}
        </span>
      </div>
    );
  }
  if (resolvedIds.length === 0) return null;
  return <MultiAddToPlaylistSubmenu songIds={resolvedIds} onDone={onDone} />;
}

// Resolves all songs from multiple artists and adds them to playlist with detailed toast notifications
function MultiArtistToPlaylistSubmenu({ artistIds, onDone, triggerId }: { artistIds: string[]; onDone: () => void; triggerId?: string }) {
  const { t } = useTranslation();
  const [resolvedIds, setResolvedIds] = useState<string[] | null>(null);
  const [totalArtists, setTotalArtists] = useState(0);
  const [showLoading, setShowLoading] = useState(false);

  useEffect(() => {
    setTotalArtists(artistIds.length);
    // Delay showing loading state to avoid flash for fast loads
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
    const { getPlaylist, updatePlaylist } = await import('../api/subsonic');
    const { usePlaylistStore } = await import('../store/playlistStore');
    const { showToast } = await import('../utils/toast');
    const touchPlaylist = usePlaylistStore.getState().touchPlaylist;

    try {
      const { songs: existingSongs } = await getPlaylist(pl.id);
      const existingIds = new Set(existingSongs.map((s) => s.id));

      const newIds: string[] = [];
      const duplicateIds: string[] = [];

      for (const id of songIds) {
        if (existingIds.has(id)) {
          duplicateIds.push(id);
        } else {
          newIds.push(id);
        }
      }

      if (newIds.length > 0) {
        await updatePlaylist(pl.id, [...existingSongs.map((s) => s.id), ...newIds]);
        touchPlaylist(pl.id);
      }

      // Show detailed toast notification
      const addedCount = newIds.length;
      const duplicateCount = duplicateIds.length;

      if (addedCount === 0 && duplicateCount > 0) {
        showToast(
          t('playlists.addAllSkipped', { count: duplicateCount, playlist: pl.name }),
          4000,
          'info'
        );
      } else if (duplicateCount > 0) {
        showToast(
          t('playlists.addPartial', { added: addedCount, skipped: duplicateCount, playlist: pl.name }),
          4000,
          'info'
        );
      } else {
        showToast(
          t('playlists.addSuccess', { count: addedCount, playlist: pl.name }),
          3000,
          'info'
        );
      }
    } catch (err) {
      showToast(t('playlists.addError'), 4000, 'error');
    }
    onDone();
  };

  // Custom AddToPlaylistSubmenu with toast notifications for multiple artists
  function MultiAddToPlaylistSubmenu({ songIds, onDone }: { songIds: string[]; onDone: () => void }) {
    const { t } = useTranslation();
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
        setPlaylists(all.sort((a, b) => a.name.localeCompare(b.name)));
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
        const { createPlaylist } = await import('../api/subsonic');
        const pl = await createPlaylist(name, songIds);
        if (pl?.id) {
          const { usePlaylistStore } = await import('../store/playlistStore');
          usePlaylistStore.getState().touchPlaylist(pl.id);
          showToast(
            t('playlists.createAndAddSuccess', { count: songIds.length, playlist: pl.name || name }),
            3000,
            'info'
          );
        }
      } catch {
        showToast(t('playlists.createError'), 4000, 'error');
      }
      onDone();
    };

    const subStyle: React.CSSProperties = flipLeft
      ? { right: 'calc(100% + 4px)', left: 'auto', top: flipUp ? 'auto' : -4, bottom: flipUp ? 0 : 'auto' }
      : { left: 'calc(100% + 4px)', right: 'auto', top: flipUp ? 'auto' : -4, bottom: flipUp ? 0 : 'auto' };

    return (
      <div className="context-submenu" ref={subRef} style={subStyle}>
        {!creating ? (
          <div
            className="context-menu-item context-submenu-new"
            onClick={e => { e.stopPropagation(); setCreating(true); }}
          >
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
    // Only show loading UI if it takes more than 300ms (avoid flash)
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

// Submenu for adding a single playlist to another playlist
function SinglePlaylistToPlaylistSubmenu({ playlist, onDone, triggerId }: { playlist: { id: string; name: string }; onDone: () => void; triggerId?: string }) {
  const { t } = useTranslation();
  const subRef = useRef<HTMLDivElement>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const newNameRef = useRef<HTMLInputElement>(null);
  const [flipLeft, setFlipLeft] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const storePlaylists = usePlaylistStore((s) => s.playlists);

  // Filter out the current playlist from the list
  const allPlaylists = useMemo(() => {
    return storePlaylists.filter((p) => p.id !== playlist.id);
  }, [storePlaylists, playlist.id]);

  useLayoutEffect(() => {
    if (subRef.current) {
      const rect = subRef.current.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) setFlipLeft(true);
      if (rect.bottom > window.innerHeight - 8) setFlipUp(true);
    }
  }, []);

  useEffect(() => {
    if (creating && newNameRef.current) {
      newNameRef.current.focus();
    }
  }, [creating]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const { createPlaylist } = await import('../api/subsonic');
    const { showToast } = await import('../utils/toast');
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
    const { getPlaylist, updatePlaylist } = await import('../api/subsonic');
    const { usePlaylistStore } = await import('../store/playlistStore');
    const { showToast } = await import('../utils/toast');
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
    const { getPlaylist, updatePlaylist } = await import('../api/subsonic');
    const { usePlaylistStore } = await import('../store/playlistStore');
    const { showToast } = await import('../utils/toast');
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
      {/* New Playlist row */}
      {!creating ? (
        <div
          className="context-menu-item context-submenu-new"
          onClick={e => { e.stopPropagation(); setCreating(true); }}
        >
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

// Submenu for merging multiple playlists into another playlist
function MultiPlaylistToPlaylistSubmenu({ playlists, onDone, triggerId }: { playlists: { id: string; name: string }[]; onDone: () => void; triggerId?: string }) {
  const { t } = useTranslation();
  const subRef = useRef<HTMLDivElement>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const newNameRef = useRef<HTMLInputElement>(null);
  const [flipLeft, setFlipLeft] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const storePlaylists = usePlaylistStore((s) => s.playlists);

  // Filter out the selected playlists from the list
  const allPlaylists = useMemo(() => {
    const selectedIds = new Set(playlists.map(p => p.id));
    return storePlaylists.filter((p) => !selectedIds.has(p.id));
  }, [storePlaylists, playlists]);

  useLayoutEffect(() => {
    if (subRef.current) {
      const rect = subRef.current.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) setFlipLeft(true);
      if (rect.bottom > window.innerHeight - 8) setFlipUp(true);
    }
  }, []);

  useEffect(() => {
    if (creating && newNameRef.current) {
      newNameRef.current.focus();
    }
  }, [creating]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const { createPlaylist } = await import('../api/subsonic');
    const { showToast } = await import('../utils/toast');
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
    const { getPlaylist, updatePlaylist } = await import('../api/subsonic');
    const { usePlaylistStore } = await import('../store/playlistStore');
    const { showToast } = await import('../utils/toast');
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
    const { getPlaylist, updatePlaylist } = await import('../api/subsonic');
    const { usePlaylistStore } = await import('../store/playlistStore');
    const { showToast } = await import('../utils/toast');
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
      {/* New Playlist row */}
      {!creating ? (
        <div
          className="context-menu-item context-submenu-new"
          onClick={e => { e.stopPropagation(); setCreating(true); }}
        >
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

export default function ContextMenu() {
  const { t } = useTranslation();
  const { contextMenu, closeContextMenu, playTrack, enqueue, queue, currentTrack, removeTrack, lastfmLovedCache, setLastfmLovedForSong, starredOverrides, setStarredOverride, openSongInfo, userRatingOverrides, setUserRatingOverride } = usePlayerStore(
    useShallow(s => ({
      contextMenu: s.contextMenu,
      closeContextMenu: s.closeContextMenu,
      playTrack: s.playTrack,
      enqueue: s.enqueue,
      queue: s.queue,
      currentTrack: s.currentTrack,
      removeTrack: s.removeTrack,
      lastfmLovedCache: s.lastfmLovedCache,
      setLastfmLovedForSong: s.setLastfmLovedForSong,
      starredOverrides: s.starredOverrides,
      setStarredOverride: s.setStarredOverride,
      openSongInfo: s.openSongInfo,
      userRatingOverrides: s.userRatingOverrides,
      setUserRatingOverride: s.setUserRatingOverride,
    }))
  );
  const auth = useAuthStore();
  const setEntityRatingSupport = useAuthStore(s => s.setEntityRatingSupport);
  const entityRatingSupport =
    auth.activeServerId ? auth.entityRatingSupportByServer[auth.activeServerId] ?? 'unknown' : 'unknown';
  const audiomuseNavidromeEnabled = !!(auth.activeServerId && auth.audiomuseNavidromeByServer[auth.activeServerId]);
  const requestDownloadFolder = useDownloadModalStore(s => s.requestFolder);
  const navigate = useNavigate();
  const menuRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Adjusted coordinates to keep menu on screen
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const [playlistSubmenuOpen, setPlaylistSubmenuOpen] = useState(false);
  const [playlistSongIds, setPlaylistSongIds] = useState<string[]>([]);
  const [keyboardRating, setKeyboardRating] = useState<{ kind: 'song' | 'album' | 'artist'; id: string; value: number } | null>(null);
  const [pendingSubmenuKeyboardFocus, setPendingSubmenuKeyboardFocus] = useState(false);

  useEffect(() => {
    if (contextMenu.isOpen) {
      setCoords({ x: contextMenu.x, y: contextMenu.y });
      setPlaylistSubmenuOpen(false);
      setPlaylistSongIds([]);
      setKeyboardRating(null);
      setPendingSubmenuKeyboardFocus(false);
    }
  }, [contextMenu.isOpen, contextMenu.x, contextMenu.y]);

  useEffect(() => {
    if (contextMenu.isOpen && menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const winW = window.innerWidth;
      const winH = window.innerHeight;
      let finalX = contextMenu.x;
      let finalY = contextMenu.y;
      if (finalX + rect.width > winW) finalX = winW - rect.width - 10;
      if (finalY + rect.height > winH) finalY = winH - rect.height - 10;
      setCoords({ x: finalX, y: finalY });
    }
  }, [contextMenu.isOpen, contextMenu.x, contextMenu.y]);

  useEffect(() => {
    if (contextMenu.isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      return;
    }
    // Clean up any keyboard focus styling when menu closes
    menuRef.current
      ?.querySelectorAll<HTMLElement>('.context-menu-keyboard-active')
      .forEach(el => el.classList.remove('context-menu-keyboard-active'));
    const prev = previousFocusRef.current;
    previousFocusRef.current = null;
    if (prev?.isConnected) {
      requestAnimationFrame(() => {
        prev.focus({ preventScroll: true });
      });
    }
  }, [contextMenu.isOpen, closeContextMenu]);

  const getMenuNavItems = useCallback(
    (scope: 'main' | 'submenu' = 'main') => {
      if (!menuRef.current) return [];
      if (scope === 'submenu') {
        const sub = menuRef.current.querySelector<HTMLElement>('.context-submenu');
        if (!sub || sub.offsetParent === null) return [];
        return Array.from(
          sub.querySelectorAll<HTMLElement>('.context-menu-item, .context-submenu-create-btn'),
        ).filter(el => el.offsetParent !== null);
      }
      return Array.from(menuRef.current.children)
        .filter((el): el is HTMLElement =>
          el instanceof HTMLElement &&
          (el.classList.contains('context-menu-item') || el.classList.contains('context-menu-rating-row')) &&
          el.offsetParent !== null,
        );
    },
    [],
  );

  const focusMenuItemAt = useCallback((scope: 'main' | 'submenu', index: number) => {
    const items = getMenuNavItems(scope);
    if (items.length === 0) return;
    menuRef.current
      ?.querySelectorAll<HTMLElement>('.context-menu-keyboard-active')
      .forEach(el => el.classList.remove('context-menu-keyboard-active'));
    const safeIdx = ((index % items.length) + items.length) % items.length;
    const target = items[safeIdx];
    target.classList.add('context-menu-keyboard-active');
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest' });
  }, [getMenuNavItems]);

  useEffect(() => {
    if (!contextMenu.isOpen) return;
    requestAnimationFrame(() => {
      menuRef.current?.focus({ preventScroll: true });
      // Do not pre-highlight any menu row; keyboard outline appears only
      // after explicit arrow navigation.
    });
  }, [contextMenu.isOpen]);

  useEffect(() => {
    if (!pendingSubmenuKeyboardFocus || !playlistSubmenuOpen) return;
    let cancelled = false;
    const tryFocus = (attemptsLeft: number) => {
      if (cancelled) return;
      const items = getMenuNavItems('submenu');
      if (items.length > 0) {
        focusMenuItemAt('submenu', 0);
        setPendingSubmenuKeyboardFocus(false);
        return;
      }
      if (attemptsLeft <= 0) {
        setPendingSubmenuKeyboardFocus(false);
        return;
      }
      requestAnimationFrame(() => tryFocus(attemptsLeft - 1));
    };
    requestAnimationFrame(() => tryFocus(8));
    return () => {
      cancelled = true;
    };
  }, [pendingSubmenuKeyboardFocus, playlistSubmenuOpen, getMenuNavItems, focusMenuItemAt]);

  const { type, item, queueIndex, playlistId, playlistSongIndex } = contextMenu;

  const isStarred = (id: string, itemStarred?: string) =>
    id in starredOverrides ? starredOverrides[id] : !!itemStarred;

  const applySongRating = useCallback((songId: string, rating: number) => {
    setUserRatingOverride(songId, rating);
    setRating(songId, rating).catch(() => {});
  }, [setUserRatingOverride]);

  const applyAlbumRating = useCallback((album: SubsonicAlbum, rating: number) => {
    setUserRatingOverride(album.id, rating);
    if (entityRatingSupport !== 'full') return;
    setRating(album.id, rating).catch(err => {
      if (auth.activeServerId) setEntityRatingSupport(auth.activeServerId, 'track_only');
      showToast(
        typeof err === 'string' ? err : err instanceof Error ? err.message : t('entityRating.saveFailed'),
        4500,
        'error',
      );
    });
  }, [setUserRatingOverride, entityRatingSupport, auth.activeServerId, setEntityRatingSupport, t]);

  const applyArtistRating = useCallback((artist: SubsonicArtist, rating: number) => {
    setUserRatingOverride(artist.id, rating);
    if (entityRatingSupport !== 'full') return;
    setRating(artist.id, rating).catch(err => {
      if (auth.activeServerId) setEntityRatingSupport(auth.activeServerId, 'track_only');
      showToast(
        typeof err === 'string' ? err : err instanceof Error ? err.message : t('entityRating.saveFailed'),
        4500,
        'error',
      );
    });
  }, [setUserRatingOverride, entityRatingSupport, auth.activeServerId, setEntityRatingSupport, t]);

  const getRatingValueByKind = useCallback((kind: 'song' | 'album' | 'artist', id: string): number => {
    if (kind === 'song' && (type === 'song' || type === 'album-song' || type === 'queue-item')) {
      const song = item as Track;
      if (song.id === id) return userRatingOverrides[id] ?? song.userRating ?? 0;
    }
    if (kind === 'album' && type === 'album') {
      const album = item as SubsonicAlbum;
      if (album.id === id) return userRatingOverrides[id] ?? album.userRating ?? 0;
    }
    if (kind === 'artist' && type === 'artist') {
      const artist = item as SubsonicArtist;
      if (artist.id === id) return userRatingOverrides[id] ?? artist.userRating ?? 0;
    }
    return userRatingOverrides[id] ?? 0;
  }, [type, item, userRatingOverrides]);

  const commitRatingByKind = useCallback((kind: 'song' | 'album' | 'artist', id: string, rating: number) => {
    if (kind === 'song') {
      applySongRating(id, rating);
      return;
    }
    if (kind === 'album' && type === 'album') {
      applyAlbumRating(item as SubsonicAlbum, rating);
      return;
    }
    if (kind === 'artist' && type === 'artist') {
      applyArtistRating(item as SubsonicArtist, rating);
    }
  }, [applySongRating, applyAlbumRating, applyArtistRating, type, item]);

  const onMenuKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const active = document.activeElement as HTMLElement | null;
    const ratingRow = active?.closest('.context-menu-rating-row') as HTMLElement | null;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeContextMenu();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (ratingRow) {
        const kind = ratingRow.dataset.ratingKind as ('song' | 'album' | 'artist' | undefined);
        const id = ratingRow.dataset.ratingId;
        if (!kind || !id) return;
        if (ratingRow.dataset.ratingDisabled === 'true') return;
        const value = keyboardRating && keyboardRating.kind === kind && keyboardRating.id === id
          ? keyboardRating.value
          : getRatingValueByKind(kind, id);
        commitRatingByKind(kind, id, value);
        setKeyboardRating({ kind, id, value });
        return;
      }
      active?.click();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (ratingRow) {
        const kind = ratingRow.dataset.ratingKind as ('song' | 'album' | 'artist' | undefined);
        const id = ratingRow.dataset.ratingId;
        if (!kind || !id) return;
        if (ratingRow.dataset.ratingDisabled === 'true') return;
        e.preventDefault();
        e.stopPropagation();
        const currentValue = keyboardRating && keyboardRating.kind === kind && keyboardRating.id === id
          ? keyboardRating.value
          : getRatingValueByKind(kind, id);
        const delta = e.key === 'ArrowRight' ? 1 : -1;
        const nextValue = Math.max(0, Math.min(5, currentValue + delta));
        setKeyboardRating({ kind, id, value: nextValue });
        return;
      }
    }
    if (e.key === 'ArrowRight') {
      const trigger = active?.closest('.context-menu-item--submenu') as HTMLElement | null;
      const triggerId = trigger?.dataset.playlistTriggerId;
      if (!trigger || !triggerId) return;
      e.preventDefault();
      e.stopPropagation();
      setPlaylistSongIds([triggerId]);
      setPlaylistSubmenuOpen(true);
      setPendingSubmenuKeyboardFocus(true);
      return;
    }
    if (e.key === 'ArrowLeft') {
      const sub = active?.closest('.context-submenu') as HTMLElement | null;
      if (!sub) return;
      e.preventDefault();
      e.stopPropagation();
      const triggerId = sub.dataset.parentTriggerId;
      setPlaylistSubmenuOpen(false);
      requestAnimationFrame(() => {
        const trigger = triggerId
          ? Array.from(menuRef.current?.querySelectorAll<HTMLElement>('.context-menu-item--submenu') ?? [])
              .find(el => el.dataset.playlistTriggerId === triggerId) ?? null
          : null;
        if (trigger) {
          menuRef.current
            ?.querySelectorAll<HTMLElement>('.context-menu-keyboard-active')
            .forEach(el => el.classList.remove('context-menu-keyboard-active'));
          trigger.classList.add('context-menu-keyboard-active');
          trigger.focus({ preventScroll: true });
        }
      });
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    const scope: 'main' | 'submenu' = active?.closest('.context-submenu') ? 'submenu' : 'main';
    const items = getMenuNavItems(scope);
    if (items.length === 0) return;
    const activeIdx = items.findIndex(el => el === document.activeElement);
    const nextIdx =
      activeIdx >= 0
        ? (e.key === 'ArrowDown' ? activeIdx + 1 : activeIdx - 1)
        : (e.key === 'ArrowDown' ? 0 : items.length - 1);
    focusMenuItemAt(scope, nextIdx);
  }, [closeContextMenu, keyboardRating, getRatingValueByKind, commitRatingByKind, getMenuNavItems, focusMenuItemAt]);

  const handleAction = async (action: () => void | Promise<void>) => {
    closeContextMenu();
    await action();
  };

  const copyShareLink = useCallback(async (kind: EntityShareKind, id: string) => {
    const ok = await copyEntityShareLink(kind, id);
    if (ok) showToast(t('contextMenu.shareCopied'));
    else showToast(t('contextMenu.shareCopyFailed'), 4000, 'error');
  }, [t]);

  const startRadio = async (artistId: string, artistName: string, seedTrack?: Track) => {
    if (seedTrack) {
      // Start playback immediately based on current state
      const state = usePlayerStore.getState();
      if (state.currentTrack?.id === seedTrack.id) {
        if (!state.isPlaying) state.resume();
        // Already playing this track — don't restart
      } else {
        playTrack(seedTrack, [seedTrack]);
      }
      // Load radio queue in background — enqueueRadio replaces any pending radio
      // tracks so clicking "Start Radio" again never stacks duplicate batches.
      // Shuffle so the follow-up tracks feel fresh instead of always being the
      // same "Top 5" in the same order every time.
      try {
        const [similar, top] = await Promise.all([getSimilarSongs2(artistId), getTopSongs(artistName)]);
        // Keep artist top songs and similar-by-artist in two blocks (each shuffled), not one blended pile —
        // otherwise this feels the same as Instant Mix (track-based similar only).
        const topTracks = shuffleArray(
          top.map(songToTrack).filter(t => t.id !== seedTrack.id).map(t => ({ ...t, radioAdded: true as const }))
        );
        const similarTracks = shuffleArray(
          similar.map(songToTrack).filter(t => t.id !== seedTrack.id).map(t => ({ ...t, radioAdded: true as const }))
        );
        const radioTracks = [...topTracks, ...similarTracks];
        if (radioTracks.length > 0) usePlayerStore.getState().enqueueRadio(radioTracks, artistId);
      } catch (e) {
        console.error('Failed to load radio queue', e);
      }
    } else {
      // Artist radio: fire both calls immediately but don't wait for the slow one.
      // getTopSongs is fast (local library) — start playback as soon as it resolves.
      // getSimilarSongs2 is slow (Last.fm) — enrich the queue in the background.
      const similarPromise = getSimilarSongs2(artistId).catch(() => [] as Awaited<ReturnType<typeof getSimilarSongs2>>);
      try {
        const top = await getTopSongs(artistName);
        // Shuffle so each Radio session starts from a different track rather
        // than always kicking off with the #1 most-played song.
        const topTracks = shuffleArray(
          top.map(t => ({ ...songToTrack(t), radioAdded: true as const }))
        );
        if (topTracks.length === 0) {
          // No local top songs — fall back to waiting for similar tracks
          const similar = await similarPromise;
          const fallback = shuffleArray(
            similar.map(t => ({ ...songToTrack(t), radioAdded: true as const }))
          );
          if (fallback.length === 0) return;
          const state = usePlayerStore.getState();
          if (state.currentTrack) {
            state.enqueueRadio(fallback, artistId);
          } else {
            state.setRadioArtistId(artistId);
            playTrack(fallback[0], fallback);
          }
          return;
        }
        // Start playback from the first shuffled top track only.
        // No other tracks are queued yet — positions 2+ will be filled
        // exclusively by the similar-songs result below.
        const state = usePlayerStore.getState();
        if (state.currentTrack) {
          state.enqueueRadio([topTracks[0]], artistId);
        } else {
          state.setRadioArtistId(artistId);
          playTrack(topTracks[0], [topTracks[0]]);
        }
        // Populate positions 2+ from similar songs only — never from the
        // remaining top tracks.  Mixing in topTracks.slice(1) meant that when
        // getSimilarSongs2 returned nothing (no Last.fm, small library, etc.)
        // the queue fell back to the same top-4 the user just heard.
        // If similarTracks is also empty, the proactive top-up in next()
        // will refill the queue when the first track nears its end.
        similarPromise.then(similar => {
          const similarTracks = shuffleArray(
            similar
              .map(t => ({ ...songToTrack(t), radioAdded: true as const }))
              .filter(t => t.id !== topTracks[0].id)
          );
          if (similarTracks.length === 0) return;
          const { queue, queueIndex } = usePlayerStore.getState();
          const pendingRadio = queue.slice(queueIndex + 1).filter(t => t.radioAdded);
          usePlayerStore.getState().enqueueRadio([...pendingRadio, ...similarTracks], artistId);
        });
      } catch (e) {
        console.error('Failed to start radio', e);
      }
    }
  };

  const startInstantMix = async (song: Track) => {
    usePlayerStore.getState().reseedQueueForInstantMix(song);
    const serverId = useAuthStore.getState().activeServerId;
    try {
      const similar = await getSimilarSongs(song.id, 50);
      if (serverId) useAuthStore.getState().setAudiomuseNavidromeIssue(serverId, false);
      const shuffled = shuffleArray(
        similar
          .filter(s => s.id !== song.id)
          .map(s => ({ ...songToTrack(s), radioAdded: true as const }))
      );
      if (shuffled.length > 0) {
        const aid = song.artistId?.trim() || undefined;
        usePlayerStore.getState().enqueueRadio(shuffled, aid);
      }
    } catch (e) {
      console.error('Instant mix failed', e);
      if (serverId) useAuthStore.getState().setAudiomuseNavidromeIssue(serverId, true);
      showToast(t('contextMenu.instantMixFailed'), 5000, 'error');
    }
  };

  const downloadAlbum = async (albumName: string, albumId: string) => {
    const folder = auth.downloadFolder || await requestDownloadFolder();
    if (!folder) return;

    const filename = `${sanitizeFilename(albumName)}.zip`;
    const destPath = await join(folder, filename);
    const url = buildDownloadUrl(albumId);
    const id = crypto.randomUUID();

    const { start, complete, fail } = useZipDownloadStore.getState();
    start(id, filename);
    try {
      await invoke('download_zip', { id, url, destPath });
      complete(id);
    } catch (e) {
      fail(id);
      console.error('ZIP download failed:', e);
    }
  };

  if (!contextMenu.isOpen || !contextMenu.item) return null;

  return (
    <>
      {/* Transparent backdrop — catches all outside clicks cleanly, preventing freeze */}
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 998 }}
        onMouseDown={() => closeContextMenu()}
      />
      <div
        ref={menuRef}
        className="context-menu animate-fade-in"
        style={{ left: coords.x, top: coords.y, zIndex: 999 }}
        tabIndex={-1}
        onKeyDown={onMenuKeyDown}
      >
        {(type === 'song' || type === 'album-song') && (() => {
          const song = item as Track;
          return (
            <>
              <div className="context-menu-item" onClick={() => handleAction(() => playTrack(song, [song]))}>
                <Play size={14} /> {t('contextMenu.playNow')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => {
                if (!currentTrack) {
                  playTrack(song, [song]);
                  return;
                }
                const currentIdx = usePlayerStore.getState().queueIndex;
                const newQueue = [...queue];
                newQueue.splice(currentIdx + 1, 0, song);
                usePlayerStore.setState({ queue: newQueue });
              })}>
                <ChevronRight size={14} /> {t('contextMenu.playNext')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => enqueue([song]))}>
                <ListPlus size={14} /> {t('contextMenu.addToQueue')}
              </div>
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === song.id ? 'active' : ''}`}
                data-playlist-trigger-id={song.id}
                onMouseEnter={() => { setPlaylistSongIds([song.id]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={() => setPlaylistSubmenuOpen(false)}
              >
                <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === song.id && (
                  <AddToPlaylistSubmenu songIds={[song.id]} triggerId={song.id} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
             {type === 'album-song' && (
                 <div className="context-menu-item" onClick={() => handleAction(async () => {
                   const albumData = await getAlbum(song.albumId);
                   const tracks = albumData.songs.map(songToTrack);
                   enqueue(tracks);
                 })}>
                  <ListPlus size={14} /> {t('contextMenu.enqueueAlbum')}
                </div>
              )}
              <div className="context-menu-divider" />
              {song.albumId && (
                <div className="context-menu-item" onClick={() => handleAction(() => navigate(`/album/${song.albumId}`))}>
                  <Disc3 size={14} /> {t('contextMenu.openAlbum')}
                </div>
              )}
              {song.artistId && (
                <div className="context-menu-item" onClick={() => handleAction(() => navigate(`/artist/${song.artistId}`))}>
                  <User size={14} /> {t('contextMenu.goToArtist')}
                </div>
              )}
              <div className="context-menu-item" onClick={() => handleAction(() => startRadio(song.artistId ?? song.artist, song.artist, song))}>
                <Radio size={14} /> {t('contextMenu.startRadio')}
              </div>
              {audiomuseNavidromeEnabled && (
                <div className="context-menu-item" onClick={() => handleAction(() => startInstantMix(song))}>
                  <Sparkles size={14} /> {t('contextMenu.instantMix')}
                </div>
              )}
              <div className="context-menu-item" onClick={() => handleAction(() => {
                const starred = isStarred(song.id, song.starred);
                setStarredOverride(song.id, !starred);
                return starred ? unstar(song.id, 'song') : star(song.id, 'song');
              })}>
                <Heart size={14} fill={isStarred(song.id, song.starred) ? 'currentColor' : 'none'} />
                {isStarred(song.id, song.starred) ? t('contextMenu.unfavorite') : t('contextMenu.favorite')}
              </div>
              {auth.lastfmSessionKey && (() => {
                const loveKey = `${song.title}::${song.artist}`;
                const loved = lastfmLovedCache[loveKey] ?? false;
                return (
                  <div className="context-menu-item" onClick={() => handleAction(() => {
                    const newLoved = !loved;
                    setLastfmLovedForSong(song.title, song.artist, newLoved);
                    if (newLoved) lastfmLoveTrack(song, auth.lastfmSessionKey);
                    else lastfmUnloveTrack(song, auth.lastfmSessionKey);
                  })}>
                    <LastfmIcon size={14} />
                    {loved ? t('contextMenu.lfmUnlove') : t('contextMenu.lfmLove')}
                  </div>
                );
              })()}
              <div
                className="context-menu-rating-row"
                data-rating-kind="song"
                data-rating-id={song.id}
                data-rating-disabled="false"
                onClick={e => e.stopPropagation()}
              >
                <Star size={14} className="context-menu-rating-icon" aria-hidden />
                <StarRating
                  value={keyboardRating?.kind === 'song' && keyboardRating.id === song.id
                    ? keyboardRating.value
                    : userRatingOverrides[song.id] ?? song.userRating ?? 0}
                  onChange={r => { setKeyboardRating({ kind: 'song', id: song.id, value: r }); applySongRating(song.id, r); }}
                  ariaLabel={t('albumDetail.ratingLabel')}
                />
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(() => copyShareLink('track', song.id))}>
                <Share2 size={14} /> {t('contextMenu.shareLink')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => openSongInfo(song.id))}>
                <Info size={14} /> {t('contextMenu.songInfo')}
              </div>
              {playlistId && playlistSongIndex !== undefined && (
                <div className="context-menu-item" style={{ color: 'var(--danger)' }} onClick={() => handleAction(async () => {
                  const { getPlaylist, updatePlaylist } = await import('../api/subsonic');
                  const { usePlaylistStore } = await import('../store/playlistStore');
                  const { showToast } = await import('../utils/toast');
                  const touchPlaylist = usePlaylistStore.getState().touchPlaylist;
                  try {
                    const { songs } = await getPlaylist(playlistId);
                    const prevCount = songs.length;
                    const updatedIds = songs.filter((_, i) => i !== playlistSongIndex).map(s => s.id);
                    await updatePlaylist(playlistId, updatedIds, prevCount);
                    touchPlaylist(playlistId);
                    showToast(t('playlists.removeSuccess'), 3000, 'info');
                  } catch {
                    showToast(t('playlists.removeError'), 4000, 'error');
                  }
                })}>
                  <Trash2 size={14} /> {t('contextMenu.removeFromPlaylist')}
                </div>
              )}
            </>
          );
        })()}

        {type === 'favorite-song' && (() => {
          const song = item as Track;
          return (
            <>
              <div className="context-menu-item" onClick={() => handleAction(() => playTrack(song, [song]))}>
                <Play size={14} /> {t('contextMenu.playNow')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => {
                if (!currentTrack) {
                  playTrack(song, [song]);
                  return;
                }
                const currentIdx = usePlayerStore.getState().queueIndex;
                const newQueue = [...queue];
                newQueue.splice(currentIdx + 1, 0, song);
                usePlayerStore.setState({ queue: newQueue });
              })}>
                <ChevronRight size={14} /> {t('contextMenu.playNext')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => enqueue([song]))}>
                <ListPlus size={14} /> {t('contextMenu.addToQueue')}
              </div>
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === song.id ? 'active' : ''}`}
                data-playlist-trigger-id={song.id}
                onMouseEnter={() => { setPlaylistSongIds([song.id]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={() => setPlaylistSubmenuOpen(false)}
              >
                <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === song.id && (
                  <AddToPlaylistSubmenu songIds={[song.id]} triggerId={song.id} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
              <div className="context-menu-divider" />
              {song.albumId && (
                <div className="context-menu-item" onClick={() => handleAction(() => navigate(`/album/${song.albumId}`))}>
                  <Disc3 size={14} /> {t('contextMenu.openAlbum')}
                </div>
              )}
              {song.artistId && (
                <div className="context-menu-item" onClick={() => handleAction(() => navigate(`/artist/${song.artistId}`))}>
                  <User size={14} /> {t('contextMenu.goToArtist')}
                </div>
              )}
              <div className="context-menu-item" onClick={() => handleAction(() => startRadio(song.artistId ?? song.artist, song.artist, song))}>
                <Radio size={14} /> {t('contextMenu.startRadio')}
              </div>
              {audiomuseNavidromeEnabled && (
                <div className="context-menu-item" onClick={() => handleAction(() => startInstantMix(song))}>
                  <Sparkles size={14} /> {t('contextMenu.instantMix')}
                </div>
              )}
              {auth.lastfmSessionKey && (() => {
                const loveKey = `${song.title}::${song.artist}`;
                const loved = lastfmLovedCache[loveKey] ?? false;
                return (
                  <div className="context-menu-item" onClick={() => handleAction(() => {
                    const newLoved = !loved;
                    setLastfmLovedForSong(song.title, song.artist, newLoved);
                    if (newLoved) lastfmLoveTrack(song, auth.lastfmSessionKey);
                    else lastfmUnloveTrack(song, auth.lastfmSessionKey);
                  })}>
                    <LastfmIcon size={14} />
                    {loved ? t('contextMenu.lfmUnlove') : t('contextMenu.lfmLove')}
                  </div>
                );
              })()}
              <div
                className="context-menu-rating-row"
                data-rating-kind="song"
                data-rating-id={song.id}
                data-rating-disabled="false"
                onClick={e => e.stopPropagation()}
              >
                <Star size={14} className="context-menu-rating-icon" aria-hidden />
                <StarRating
                  value={keyboardRating?.kind === 'song' && keyboardRating.id === song.id
                    ? keyboardRating.value
                    : userRatingOverrides[song.id] ?? song.userRating ?? 0}
                  onChange={r => { setKeyboardRating({ kind: 'song', id: song.id, value: r }); applySongRating(song.id, r); }}
                  ariaLabel={t('albumDetail.ratingLabel')}
                />
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(() => copyShareLink('track', song.id))}>
                <Share2 size={14} /> {t('contextMenu.shareLink')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => openSongInfo(song.id))}>
                <Info size={14} /> {t('contextMenu.songInfo')}
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" style={{ color: 'var(--danger)' }} onClick={() => handleAction(() => {
                setStarredOverride(song.id, false);
                return unstar(song.id, 'song');
              })}>
                <HeartCrack size={14} /> {t('contextMenu.unfavorite')}
              </div>
            </>
          );
        })()}

        {type === 'album' && (() => {
          const album = item as SubsonicAlbum;
          const albumRatingDisabled = entityRatingSupport === 'track_only';
          return (
            <>
              <div className="context-menu-item" onClick={() => handleAction(() => navigate(`/album/${album.id}`))}>
                <Play size={14} /> {t('contextMenu.openAlbum')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(async () => {
                const albumData = await getAlbum(album.id);
                enqueue(albumData.songs.map(songToTrack));
              })}>
                <ListPlus size={14} /> {t('contextMenu.enqueueAlbum')}
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(() => navigate(`/artist/${album.artistId}`))}>
                <User size={14} /> {t('contextMenu.goToArtist')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => {
                const starred = isStarred(album.id, album.starred);
                setStarredOverride(album.id, !starred);
                return starred ? unstar(album.id, 'album') : star(album.id, 'album');
              })}>
                <Heart size={14} fill={isStarred(album.id, album.starred) ? 'currentColor' : 'none'} />
                {isStarred(album.id, album.starred) ? t('contextMenu.unfavoriteAlbum') : t('contextMenu.favoriteAlbum')}
              </div>
              <div
                className="context-menu-rating-row"
                data-rating-kind="album"
                data-rating-id={album.id}
                data-rating-disabled={albumRatingDisabled ? 'true' : 'false'}
                onClick={e => e.stopPropagation()}
              >
                <Star size={14} className="context-menu-rating-icon" aria-hidden />
                <StarRating
                  value={keyboardRating?.kind === 'album' && keyboardRating.id === album.id
                    ? keyboardRating.value
                    : userRatingOverrides[album.id] ?? album.userRating ?? 0}
                  disabled={albumRatingDisabled}
                  labelKey="entityRating.albumAriaLabel"
                  onChange={r => { setKeyboardRating({ kind: 'album', id: album.id, value: r }); applyAlbumRating(album, r); }}
                />
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(() => copyShareLink('album', album.id))}>
                <Share2 size={14} /> {t('contextMenu.shareLink')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => downloadAlbum(album.name, album.id))}>
                <Download size={14} /> {t('contextMenu.download')}
              </div>
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === `album:${album.id}` ? 'active' : ''}`}
                data-playlist-trigger-id={`album:${album.id}`}
                onMouseEnter={() => { setPlaylistSongIds([`album:${album.id}`]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={() => setPlaylistSubmenuOpen(false)}
              >
                <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === `album:${album.id}` && (
                  <AlbumToPlaylistSubmenu albumId={album.id} triggerId={`album:${album.id}`} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
            </>
          );
        })()}

        {type === 'playlist' && (() => {
          const playlist = item as SubsonicPlaylist;
          return (
            <>
              <div className="context-menu-item" onClick={() => handleAction(() => navigate(`/playlists/${playlist.id}`))}>
                <Play size={14} /> {t('contextMenu.playNow')}
              </div>
              <div className="context-menu-divider" />
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === `playlist:${playlist.id}` ? 'active' : ''}`}
                data-playlist-trigger-id={`playlist:${playlist.id}`}
                onMouseEnter={() => { setPlaylistSongIds([`playlist:${playlist.id}`]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={() => setPlaylistSubmenuOpen(false)}
              >
                <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === `playlist:${playlist.id}` && (
                  <SinglePlaylistToPlaylistSubmenu playlist={playlist} triggerId={`playlist:${playlist.id}`} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" style={{ color: 'var(--danger)' }} onClick={() => handleAction(async () => {
                const { showToast } = await import('../utils/toast');
                const { deletePlaylist } = await import('../api/subsonic');
                const { usePlaylistStore } = await import('../store/playlistStore');
                const { removeId } = usePlaylistStore.getState();
                try {
                  await deletePlaylist(playlist.id);
                  removeId(playlist.id);
                  // Update local playlist state without page reload to preserve audio playback state
                  usePlaylistStore.setState((s) => ({
                    playlists: s.playlists.filter((p) => p.id !== playlist.id),
                  }));
                  showToast(t('playlists.deleteSuccess', { count: 1 }), 3000, 'info');
                } catch {
                  showToast(t('playlists.deleteFailed', { name: playlist.name }), 3000, 'error');
                }
              })}>
                <Trash2 size={14} /> {t('playlists.deletePlaylist')}
              </div>
            </>
          );
        })()}

        {type === 'multi-album' && (() => {
          const albums = item as SubsonicAlbum[];
          const albumIds = albums.map(a => a.id);
          return (
            <>
              <div className="context-menu-header" style={{ padding: '8px 12px', fontSize: 13, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
                {t('contextMenu.selectedAlbums', { count: albums.length })}
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(async () => {
                // Parallel — Navidrome handles concurrent getAlbum requests fine.
                const results = await Promise.all(albums.map(a => getAlbum(a.id)));
                const allTracks = results.flatMap(r => r.songs.map(songToTrack));
                enqueue(allTracks);
              })}>
                <ListPlus size={14} /> {t('contextMenu.enqueueAlbums', { count: albums.length })}
              </div>
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === `multi-album:${albumIds.join(',')}` ? 'active' : ''}`}
                data-playlist-trigger-id={`multi-album:${albumIds.join(',')}`}
                onMouseEnter={() => { setPlaylistSongIds([`multi-album:${albumIds.join(',')}`]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={() => setPlaylistSubmenuOpen(false)}
              >
                <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === `multi-album:${albumIds.join(',')}` && (
                  <MultiAlbumToPlaylistSubmenu albumIds={albumIds} triggerId={`multi-album:${albumIds.join(',')}`} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
            </>
          );
        })()}

        {type === 'artist' && (() => {
          const artist = item as SubsonicArtist;
          const artistRatingDisabled = entityRatingSupport === 'track_only';
          return (
            <>
              <div className="context-menu-item" onClick={() => handleAction(() => startRadio(artist.id, artist.name))}>
                <Radio size={14} /> {t('contextMenu.startRadio')}
              </div>
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === `artist:${artist.id}` ? 'active' : ''}`}
                data-playlist-trigger-id={`artist:${artist.id}`}
                onMouseEnter={() => { setPlaylistSongIds([`artist:${artist.id}`]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={() => setPlaylistSubmenuOpen(false)}
              >
                <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === `artist:${artist.id}` && (
                  <ArtistToPlaylistSubmenu artistId={artist.id} triggerId={`artist:${artist.id}`} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => copyShareLink('artist', artist.id))}>
                <Share2 size={14} /> {t('contextMenu.shareLink')}
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(() => {
                const starred = isStarred(artist.id, artist.starred);
                setStarredOverride(artist.id, !starred);
                return starred ? unstar(artist.id, 'artist') : star(artist.id, 'artist');
              })}>
                <Heart size={14} fill={isStarred(artist.id, artist.starred) ? 'currentColor' : 'none'} />
                {isStarred(artist.id, artist.starred) ? t('contextMenu.unfavoriteArtist') : t('contextMenu.favoriteArtist')}
              </div>
              <div
                className="context-menu-rating-row"
                data-rating-kind="artist"
                data-rating-id={artist.id}
                data-rating-disabled={artistRatingDisabled ? 'true' : 'false'}
                onClick={e => e.stopPropagation()}
              >
                <Star size={14} className="context-menu-rating-icon" aria-hidden />
                <StarRating
                  value={keyboardRating?.kind === 'artist' && keyboardRating.id === artist.id
                    ? keyboardRating.value
                    : userRatingOverrides[artist.id] ?? artist.userRating ?? 0}
                  disabled={artistRatingDisabled}
                  labelKey="entityRating.artistAriaLabel"
                  onChange={r => { setKeyboardRating({ kind: 'artist', id: artist.id, value: r }); applyArtistRating(artist, r); }}
                />
              </div>
            </>
          );
        })()}

        {type === 'multi-artist' && (() => {
          const artists = item as SubsonicArtist[];
          const artistIds = artists.map(a => a.id);
          return (
            <>
              <div className="context-menu-header" style={{ padding: '8px 12px', fontSize: 13, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
                {t('contextMenu.selectedArtists', { count: artists.length })}
              </div>
              <div className="context-menu-divider" />
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === `multi-artist:${artistIds.join(',')}` ? 'active' : ''}`}
                data-playlist-trigger-id={`multi-artist:${artistIds.join(',')}`}
                onMouseEnter={() => { setPlaylistSongIds([`multi-artist:${artistIds.join(',')}`]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={() => setPlaylistSubmenuOpen(false)}
              >
                <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === `multi-artist:${artistIds.join(',')}` && (
                  <MultiArtistToPlaylistSubmenu artistIds={artistIds} triggerId={`multi-artist:${artistIds.join(',')}`} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
            </>
          );
        })()}

        {type === 'multi-playlist' && (() => {
          const selectedPlaylists = item as SubsonicPlaylist[];
          const playlistIds = selectedPlaylists.map(p => p.id);
          return (
            <>
              <div className="context-menu-header" style={{ padding: '8px 12px', fontSize: 13, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
                {t('contextMenu.selectedPlaylists', { count: selectedPlaylists.length })}
              </div>
              <div className="context-menu-divider" />
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === `multi-playlist:${playlistIds.join(',')}` ? 'active' : ''}`}
                data-playlist-trigger-id={`multi-playlist:${playlistIds.join(',')}`}
                onMouseEnter={() => { setPlaylistSongIds([`multi-playlist:${playlistIds.join(',')}`]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={() => setPlaylistSubmenuOpen(false)}
              >
                <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === `multi-playlist:${playlistIds.join(',')}` && (
                  <MultiPlaylistToPlaylistSubmenu playlists={selectedPlaylists} triggerId={`multi-playlist:${playlistIds.join(',')}`} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
              <div className="context-menu-item" style={{ color: 'var(--danger)' }} onClick={() => handleAction(async () => {
                const { showToast } = await import('../utils/toast');
                const { usePlaylistStore } = await import('../store/playlistStore');
                const { deletePlaylist } = await import('../api/subsonic');
                const { removeId } = usePlaylistStore.getState();
                const deletedIds: string[] = [];
                for (const pl of selectedPlaylists) {
                  try {
                    await deletePlaylist(pl.id);
                    removeId(pl.id);
                    deletedIds.push(pl.id);
                  } catch {
                    showToast(t('playlists.deleteFailed', { name: pl.name }), 3000, 'error');
                  }
                }
                if (deletedIds.length > 0) {
                  // Update local playlist state without page reload to preserve audio playback state
                  usePlaylistStore.setState((s) => ({
                    playlists: s.playlists.filter((p) => !deletedIds.includes(p.id)),
                  }));
                  showToast(t('playlists.deleteSuccess', { count: deletedIds.length }), 3000, 'info');
                }
              })}>
                <Trash2 size={14} /> {t('playlists.deleteSelected')}
              </div>
            </>
          );
        })()}

        {type === 'queue-item' && (() => {
          const song = item as Track;
          return (
            <>
              <div className="context-menu-item" onClick={() => handleAction(() => playTrack(song, queue))}>
                <Play size={14} /> {t('contextMenu.playNow')}
              </div>
              <div className="context-menu-item" style={{ color: 'var(--danger)' }} onClick={() => handleAction(() => {
                if (queueIndex !== undefined) removeTrack(queueIndex);
              })}>
                <Trash2 size={14} /> {t('contextMenu.removeFromQueue')}
              </div>
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === song.id ? 'active' : ''}`}
                data-playlist-trigger-id={song.id}
                onMouseEnter={() => { setPlaylistSongIds([song.id]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={() => setPlaylistSubmenuOpen(false)}
              >
                <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === song.id && (
                  <AddToPlaylistSubmenu songIds={[song.id]} triggerId={song.id} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
              <div className="context-menu-divider" />
              {song.albumId && (
                <div className="context-menu-item" onClick={() => handleAction(() => navigate(`/album/${song.albumId}`))}>
                  <Disc3 size={14} /> {t('contextMenu.openAlbum')}
                </div>
              )}
              {song.artistId && (
                <div className="context-menu-item" onClick={() => handleAction(() => navigate(`/artist/${song.artistId}`))}>
                  <User size={14} /> {t('contextMenu.goToArtist')}
                </div>
              )}
              <div className="context-menu-item" onClick={() => handleAction(() => startRadio(song.artistId ?? song.artist, song.artist, song))}>
                <Radio size={14} /> {t('contextMenu.startRadio')}
              </div>
              {audiomuseNavidromeEnabled && (
                <div className="context-menu-item" onClick={() => handleAction(() => startInstantMix(song))}>
                  <Sparkles size={14} /> {t('contextMenu.instantMix')}
                </div>
              )}
              <div className="context-menu-item" onClick={() => handleAction(() => {
                const starred = isStarred(song.id, song.starred);
                setStarredOverride(song.id, !starred);
                return starred ? unstar(song.id, 'song') : star(song.id, 'song');
              })}>
                <Heart size={14} fill={isStarred(song.id, song.starred) ? 'currentColor' : 'none'} />
                {isStarred(song.id, song.starred) ? t('contextMenu.unfavorite') : t('contextMenu.favorite')}
              </div>
              {auth.lastfmSessionKey && (() => {
                const loveKey = `${song.title}::${song.artist}`;
                const loved = lastfmLovedCache[loveKey] ?? false;
                return (
                  <div className="context-menu-item" onClick={() => handleAction(() => {
                    const newLoved = !loved;
                    setLastfmLovedForSong(song.title, song.artist, newLoved);
                    if (newLoved) lastfmLoveTrack(song, auth.lastfmSessionKey);
                    else lastfmUnloveTrack(song, auth.lastfmSessionKey);
                  })}>
                    <LastfmIcon size={14} />
                    {loved ? t('contextMenu.lfmUnlove') : t('contextMenu.lfmLove')}
                  </div>
                );
              })()}
              <div
                className="context-menu-rating-row"
                data-rating-kind="song"
                data-rating-id={song.id}
                data-rating-disabled="false"
                onClick={e => e.stopPropagation()}
              >
                <Star size={14} className="context-menu-rating-icon" aria-hidden />
                <StarRating
                  value={keyboardRating?.kind === 'song' && keyboardRating.id === song.id
                    ? keyboardRating.value
                    : userRatingOverrides[song.id] ?? song.userRating ?? 0}
                  onChange={r => { setKeyboardRating({ kind: 'song', id: song.id, value: r }); applySongRating(song.id, r); }}
                  ariaLabel={t('albumDetail.ratingLabel')}
                />
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(() => copyShareLink('track', song.id))}>
                <Share2 size={14} /> {t('contextMenu.shareLink')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => openSongInfo(song.id))}>
                <Info size={14} /> {t('contextMenu.songInfo')}
              </div>
            </>
          );
        })()}
      </div>
    </>
  );
}
