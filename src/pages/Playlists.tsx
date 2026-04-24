import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ListMusic, Play, Plus, Trash2, CheckSquare2, Check, Clock3, Sparkles, Pencil } from 'lucide-react';
import { deletePlaylist, SubsonicPlaylist, getPlaylist, buildCoverArtUrl, coverArtCacheKey, updatePlaylist, getGenres, SubsonicGenre, filterSongsToActiveLibrary } from '../api/subsonic';
import { usePlayerStore, songToTrack } from '../store/playerStore';
import { usePlaylistStore } from '../store/playlistStore';
import { useAuthStore } from '../store/authStore';
import CachedImage from '../components/CachedImage';
import StarRating from '../components/StarRating';
import { useTranslation } from 'react-i18next';
import { formatHumanHoursMinutes } from '../utils/formatHumanDuration';
import { showToast } from '../utils/toast';
import { ndCreateSmartPlaylist, ndGetSmartPlaylist, ndListSmartPlaylists, ndUpdateSmartPlaylist } from '../api/navidromeSmart';

function formatDuration(seconds: number): string {
  return formatHumanHoursMinutes(seconds);
}

const SMART_PREFIX = 'psy-smart-';
const LIMIT_MAX = 500;
const YEAR_MIN = 1950;
const YEAR_MAX = new Date().getFullYear() + 1;

type GenreMode = 'include' | 'exclude';
type YearMode = 'include' | 'exclude';

type SmartFilters = {
  name: string;
  limit: string;
  sort: string;
  artistContains: string;
  albumContains: string;
  titleContains: string;
  minRating: number;
  excludeUnrated: boolean;
  compilationOnly: boolean;
  selectedGenres: string[];
  genreMode: GenreMode;
  yearFrom: number;
  yearTo: number;
  yearMode: YearMode;
};

type PendingSmartPlaylist = {
  name: string;
  id?: string;
  firstSeenCoverArt?: string;
  attempts: number;
};

type NdSmartRuleNode = Record<string, unknown>;

const defaultSmartFilters: SmartFilters = {
  name: '',
  limit: '50',
  sort: '+random',
  artistContains: '',
  albumContains: '',
  titleContains: '',
  minRating: 0,
  excludeUnrated: false,
  compilationOnly: false,
  selectedGenres: [],
  genreMode: 'include',
  yearFrom: YEAR_MIN,
  yearTo: YEAR_MAX,
  yearMode: 'include',
};

function clampYear(v: number): number {
  return Math.max(YEAR_MIN, Math.min(YEAR_MAX, v));
}

function isSmartPlaylistName(name: string): boolean {
  return (name ?? '').toLowerCase().startsWith(SMART_PREFIX);
}

function displayPlaylistName(name: string): string {
  const n = name ?? '';
  if (isSmartPlaylistName(n)) return n.slice(SMART_PREFIX.length);
  return n;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseSmartRulesToFilters(
  rules: Record<string, unknown> | undefined,
  playlistName: string,
): SmartFilters {
  const next: SmartFilters = {
    ...defaultSmartFilters,
    name: displayPlaylistName(playlistName),
  };
  if (!rules) return next;

  if (typeof rules.limit === 'number' && Number.isFinite(rules.limit)) {
    next.limit = String(Math.max(1, Math.min(LIMIT_MAX, Number(rules.limit))));
  }
  if (typeof rules.sort === 'string' && rules.sort.trim()) next.sort = rules.sort;

  const includeGenres: string[] = [];
  const excludeGenres: string[] = [];
  const all = Array.isArray(rules.all) ? rules.all : [];
  for (const node of all) {
    const obj = asRecord(node);
    if (!obj) continue;

    const contains = asRecord(obj.contains);
    if (contains) {
      if (typeof contains.artist === 'string') next.artistContains = contains.artist;
      if (typeof contains.album === 'string') next.albumContains = contains.album;
      if (typeof contains.title === 'string') next.titleContains = contains.title;
    }

    const gt = asRecord(obj.gt);
    if (gt && typeof gt.rating === 'number') {
      if (gt.rating > 0) next.minRating = Math.max(0, Math.min(5, Math.floor(gt.rating)));
      else if (gt.rating === 0) next.excludeUnrated = true;
    }

    const is = asRecord(obj.is);
    if (is?.compilation === true) next.compilationOnly = true;

    const notContains = asRecord(obj.notContains);
    if (notContains && typeof notContains.genre === 'string') excludeGenres.push(notContains.genre);

    const inTheRange = asRecord(obj.inTheRange);
    if (inTheRange && Array.isArray(inTheRange.year) && inTheRange.year.length === 2) {
      const from = Number(inTheRange.year[0]);
      const to = Number(inTheRange.year[1]);
      if (Number.isFinite(from) && Number.isFinite(to)) {
        next.yearMode = 'include';
        next.yearFrom = clampYear(Math.min(from, to));
        next.yearTo = clampYear(Math.max(from, to));
      }
    }

    const any = Array.isArray(obj.any) ? (obj.any as NdSmartRuleNode[]) : [];
    if (any.length > 0) {
      const parsedGenreIncludes = any
        .map((item) => asRecord(asRecord(item)?.contains)?.genre)
        .filter((v): v is string => typeof v === 'string');
      if (parsedGenreIncludes.length > 0) includeGenres.push(...parsedGenreIncludes);

      const ltYear = any.map((item) => asRecord(asRecord(item)?.lt)?.year).find((v) => typeof v === 'number');
      const gtYear = any.map((item) => asRecord(asRecord(item)?.gt)?.year).find((v) => typeof v === 'number');
      if (typeof ltYear === 'number' && typeof gtYear === 'number') {
        next.yearMode = 'exclude';
        next.yearFrom = clampYear(Math.min(ltYear, gtYear));
        next.yearTo = clampYear(Math.max(ltYear, gtYear));
      }
    }
  }

  if (includeGenres.length > 0) {
    next.genreMode = 'include';
    next.selectedGenres = [...new Set(includeGenres)];
  } else if (excludeGenres.length > 0) {
    next.genreMode = 'exclude';
    next.selectedGenres = [...new Set(excludeGenres)];
  }

  return next;
}

export default function Playlists() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const playTrack = usePlayerStore(s => s.playTrack);
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const touchPlaylist = usePlaylistStore((s) => s.touchPlaylist);
  const removeId = usePlaylistStore((s) => s.removeId);
  const playlists = usePlaylistStore((s) => s.playlists);
  const fetchPlaylists = usePlaylistStore((s) => s.fetchPlaylists);
  const playlistsLoading = usePlaylistStore((s) => s.playlistsLoading);
  const activeUsername = useAuthStore(s => s.getActiveServer()?.username ?? '');
  const activeServerId = useAuthStore(s => s.activeServerId);
  const subsonicIdentityByServer = useAuthStore(s => s.subsonicServerIdentityByServer);
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);

  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [creatingSmart, setCreatingSmart] = useState(false);
  const [newName, setNewName] = useState('');
  const [smartFilters, setSmartFilters] = useState<SmartFilters>(defaultSmartFilters);
  const [genres, setGenres] = useState<SubsonicGenre[]>([]);
  const [genreQuery, setGenreQuery] = useState('');
  const [creatingSmartBusy, setCreatingSmartBusy] = useState(false);
  const [editingSmartId, setEditingSmartId] = useState<string | null>(null);
  const [pendingSmart, setPendingSmart] = useState<PendingSmartPlaylist[]>([]);
  const [smartCoverIdsByPlaylist, setSmartCoverIdsByPlaylist] = useState<Record<string, string[]>>({});
  const [filteredSongCountByPlaylist, setFilteredSongCountByPlaylist] = useState<Record<string, number>>({});
  const [filteredDurationByPlaylist, setFilteredDurationByPlaylist] = useState<Record<string, number>>({});
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // ── Multi-selection ──────────────────────────────────────────────────────
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const isNavidromeServer = Boolean(
    activeServerId &&
    (subsonicIdentityByServer[activeServerId]?.type ?? '').toLowerCase() === 'navidrome',
  );

  const toggleSelectionMode = () => {
    setSelectionMode(v => !v);
    setSelectedIds(new Set());
  };

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  const selectedPlaylists = playlists.filter(p => selectedIds.has(p.id));
  const isPlaylistDeletable = useCallback((pl: SubsonicPlaylist) => {
    if (!pl.owner) return true;
    if (!activeUsername) return false;
    return pl.owner === activeUsername;
  }, [activeUsername]);

  useEffect(() => {
    fetchPlaylists().finally(() => setLoading(false));
    getGenres().then(setGenres).catch(() => {});
  }, [fetchPlaylists]);

  // Smart playlists: build 2x2 cover collage from tracks inside the active library scope.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const smart = playlists.filter(pl => isSmartPlaylistName(pl.name));
      if (smart.length === 0) {
        if (!cancelled) setSmartCoverIdsByPlaylist({});
        return;
      }
      const rows = await Promise.all(
        smart.map(async (pl) => {
          try {
            const { songs } = await getPlaylist(pl.id);
            const filtered = await filterSongsToActiveLibrary(songs);
            const ids: string[] = [];
            const seen = new Set<string>();
            for (const s of filtered) {
              const cid = s.coverArt;
              if (!cid || seen.has(cid)) continue;
              seen.add(cid);
              ids.push(cid);
              if (ids.length >= 4) break;
            }
            return [pl.id, ids] as const;
          } catch {
            return [pl.id, [] as string[]] as const;
          }
        }),
      );
      if (cancelled) return;
      const next: Record<string, string[]> = {};
      for (const [id, ids] of rows) next[id] = ids;
      setSmartCoverIdsByPlaylist(next);
    };
    run();
    return () => { cancelled = true; };
  }, [playlists, musicLibraryFilterVersion]);

  // Playlist list should reflect active library scope for song counts.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (playlists.length === 0) {
        if (!cancelled) {
          setFilteredSongCountByPlaylist({});
          setFilteredDurationByPlaylist({});
        }
        return;
      }
      const ids = playlists.map((pl) => pl.id);
      const next: Record<string, number> = {};
      const nextDuration: Record<string, number> = {};
      for (let i = 0; i < ids.length; i += 4) {
        const chunk = ids.slice(i, i + 4);
        const rows = await Promise.all(
          chunk.map(async (id) => {
            try {
              const { songs } = await getPlaylist(id);
              const filtered = await filterSongsToActiveLibrary(songs);
              const duration = filtered.reduce((acc, s) => acc + (s.duration ?? 0), 0);
              return [id, filtered.length, duration] as const;
            } catch {
              return [id, -1, -1] as const;
            }
          }),
        );
        for (const [id, count, duration] of rows) {
          if (count >= 0) next[id] = count;
          if (duration >= 0) nextDuration[id] = duration;
        }
      }
      if (!cancelled) {
        setFilteredSongCountByPlaylist(next);
        setFilteredDurationByPlaylist(nextDuration);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [playlists, musicLibraryFilterVersion]);

  useEffect(() => {
    if (creating) nameInputRef.current?.focus();
  }, [creating]);

  const createPlaylist = usePlaylistStore(s => s.createPlaylist);

  const availableGenres = genres
    .map(g => g.value)
    .filter(v => !smartFilters.selectedGenres.includes(v))
    .filter(v => !genreQuery.trim() || v.toLowerCase().includes(genreQuery.trim().toLowerCase()))
    .sort((a, b) => a.localeCompare(b));

  const handleCreate = async () => {
    const name = newName.trim() || t('playlists.unnamed');
    await createPlaylist(name);
    // Refresh playlists from API to get the new one
    await fetchPlaylists();
    setCreating(false);
    setNewName('');
  };

  const buildSmartRulesPayload = (): Record<string, unknown> => {
    const all: Record<string, unknown>[] = [];
    if (smartFilters.artistContains.trim()) all.push({ contains: { artist: smartFilters.artistContains.trim() } });
    if (smartFilters.albumContains.trim()) all.push({ contains: { album: smartFilters.albumContains.trim() } });
    if (smartFilters.titleContains.trim()) all.push({ contains: { title: smartFilters.titleContains.trim() } });

    const minRating = Number(smartFilters.minRating);
    if (Number.isFinite(minRating) && minRating > 0) all.push({ gt: { rating: minRating } });
    else if (smartFilters.excludeUnrated) all.push({ gt: { rating: 0 } });
    if (smartFilters.compilationOnly) all.push({ is: { compilation: true } });

    if (smartFilters.selectedGenres.length > 0) {
      if (smartFilters.genreMode === 'include') {
        all.push({ any: smartFilters.selectedGenres.map(v => ({ contains: { genre: v } })) });
      } else {
        for (const g of smartFilters.selectedGenres) all.push({ notContains: { genre: g } });
      }
    }

    if (smartFilters.yearMode === 'include') {
      all.push({ inTheRange: { year: [smartFilters.yearFrom, smartFilters.yearTo] } });
    } else {
      all.push({ any: [{ lt: { year: smartFilters.yearFrom } }, { gt: { year: smartFilters.yearTo } }] });
    }

    const rules: Record<string, unknown> = { all };
    rules.limit = Math.max(1, Math.min(LIMIT_MAX, Number(smartFilters.limit) || 50));
    rules.sort = smartFilters.sort;
    return rules;
  };

  const handleOpenSmartEditor = async (pl: SubsonicPlaylist) => {
    if (!isNavidromeServer || !isSmartPlaylistName(pl.name)) return;
    setCreatingSmartBusy(true);
    try {
      let target: { id: string; name: string; rules?: Record<string, unknown> } | null = null;
      try {
        // Prefer direct endpoint for this playlist: returns freshest rules.
        const direct = await ndGetSmartPlaylist(pl.id);
        if (direct.id && (direct.rules || isSmartPlaylistName(direct.name))) target = direct;
      } catch {
        // Fallback to list endpoint below.
      }
      if (!target) {
        const smart = await ndListSmartPlaylists();
        target = smart.find((v) =>
          v.id === pl.id ||
          v.name === pl.name ||
          displayPlaylistName(v.name) === displayPlaylistName(pl.name),
        ) ?? null;
      }
      if (target) {
        setSmartFilters(parseSmartRulesToFilters(target.rules, target.name));
        setEditingSmartId(target.id);
      } else {
        // Fallback: allow editing even if Navidrome smart list endpoint
        // doesn't return this playlist (shared/migrated/legacy edge cases).
        setSmartFilters({
          ...defaultSmartFilters,
          name: displayPlaylistName(pl.name),
        });
        setEditingSmartId(pl.id);
      }
      setGenreQuery('');
      setCreating(false);
      setCreatingSmart(true);
    } catch {
      // Degrade gracefully instead of blocking the editor on transient/API errors.
      setSmartFilters({
        ...defaultSmartFilters,
        name: displayPlaylistName(pl.name),
      });
      setGenreQuery('');
      setEditingSmartId(pl.id);
      setCreating(false);
      setCreatingSmart(true);
      showToast(t('smartPlaylists.loadFailed'), 3500, 'warning');
    } finally {
      setCreatingSmartBusy(false);
    }
  };

  const handleCreateSmart = async () => {
    if (!isNavidromeServer) {
      showToast(t('smartPlaylists.navidromeOnly'), 3500, 'error');
      return;
    }
    setCreatingSmartBusy(true);
    try {
      let baseName = smartFilters.name.trim() || `mix-${new Date().toISOString().slice(0, 10)}`;
      if (!editingSmartId) {
        const existingNames = new Set(playlists.map((p) => (p.name ?? '').toLowerCase()));
        const requestedBaseName = baseName;
        let ordinal = 2;
        while (existingNames.has(`${SMART_PREFIX}${baseName}`.toLowerCase())) {
          baseName = `${requestedBaseName}-${ordinal}`;
          ordinal += 1;
        }
      }
      const rules = buildSmartRulesPayload();
      const fullName = `${SMART_PREFIX}${baseName}`;
      if (editingSmartId) {
        await ndUpdateSmartPlaylist(editingSmartId, fullName, rules, true);
      } else {
        await ndCreateSmartPlaylist(fullName, rules, true);
      }
      await fetchPlaylists();
      const createdName = fullName;
      const updatedId = editingSmartId;
      setPendingSmart(prev => {
        const existing = prev.find(p => p.id === updatedId || p.name === createdName);
        if (existing) return prev;
        const created = usePlaylistStore.getState().playlists.find((p) => p.id === updatedId || p.name === createdName);
        return [
          ...prev,
          {
            name: createdName,
            id: updatedId ?? created?.id,
            firstSeenCoverArt: created?.coverArt,
            attempts: 0,
          },
        ];
      });
      setCreatingSmart(false);
      setEditingSmartId(null);
      setSmartFilters(defaultSmartFilters);
      setGenreQuery('');
      if (updatedId) showToast(t('smartPlaylists.updated', { name: createdName }), 3500, 'success');
      else showToast(t('smartPlaylists.created', { name: createdName }), 3500, 'success');
    } catch {
      showToast(editingSmartId ? t('smartPlaylists.updateFailed') : t('smartPlaylists.createFailed'), 3500, 'error');
    } finally {
      setCreatingSmartBusy(false);
    }
  };

  // Smart playlist rules are processed asynchronously on server.
  // Poll list every 10s and keep waiting through Navidrome placeholder cover.
  useEffect(() => {
    if (pendingSmart.length === 0) return;
    const interval = window.setInterval(async () => {
      await fetchPlaylists();
      const listNow = usePlaylistStore.getState().playlists;
      const hydrated = pendingSmart.map(item => {
        if (item.id) return item;
        const found = listNow.find(p => p.name === item.name);
        return found ? { ...item, id: found.id } : item;
      });
      // Detail endpoint tends to reflect fresh metadata earlier than list endpoint.
      const ids = hydrated.map(p => p.id).filter((v): v is string => Boolean(v));
      const details = await Promise.all(
        ids.map(async (id) => {
          try {
            const { playlist } = await getPlaylist(id);
            return playlist;
          } catch {
            return null;
          }
        }),
      );
      const freshById = new Map(
        details.filter((p): p is SubsonicPlaylist => p !== null).map(p => [p.id, p]),
      );
      if (freshById.size > 0) {
        usePlaylistStore.setState((s) => ({
          playlists: s.playlists.map((p) => {
            const fresh = freshById.get(p.id);
            return fresh ? { ...p, ...fresh } : p;
          }),
        }));
      }
      const current = usePlaylistStore.getState().playlists;
      setPendingSmart(() => {
        const next: PendingSmartPlaylist[] = [];
        for (const item of hydrated) {
          const pl = item.id
            ? current.find(p => p.id === item.id)
            : current.find(p => p.name === item.name);
          if (!pl) {
            next.push({ ...item, attempts: item.attempts + 1 });
            continue;
          }
          const songCount = pl.songCount ?? 0;
          const currentCover = pl.coverArt;
          const firstCover = item.firstSeenCoverArt ?? currentCover;
          const placeholderStillThere = Boolean(firstCover) && currentCover === firstCover;
          // Wait until we see actual content and cover changed from the first placeholder-ish cover.
          // Fallback timeout keeps UI from waiting forever on servers that never update cover id.
          const hardTimeoutReached = item.attempts >= 18; // ~3 minutes (18 * 10s)
          const ready = songCount > 0 && (!placeholderStillThere || hardTimeoutReached);
          if (!ready) {
            next.push({
              ...item,
              id: pl.id,
              firstSeenCoverArt: firstCover,
              attempts: item.attempts + 1,
            });
          }
        }
        return next;
      });
    }, 10000);
    return () => window.clearInterval(interval);
  }, [pendingSmart, fetchPlaylists]);

  const handlePlay = async (e: React.MouseEvent, pl: SubsonicPlaylist) => {
    e.stopPropagation();
    if (playingId === pl.id) return;
    setPlayingId(pl.id);
    try {
      const data = await getPlaylist(pl.id);
      const filteredSongs = await filterSongsToActiveLibrary(data.songs);
      const tracks = filteredSongs.map(songToTrack);
      if (tracks.length > 0) {
        touchPlaylist(pl.id);
        playTrack(tracks[0], tracks);
      }
    } catch {}
    setPlayingId(null);
  };

  const handleDelete = async (e: React.MouseEvent, pl: SubsonicPlaylist) => {
    e.stopPropagation();
    if (deleteConfirmId !== pl.id) {
      setDeleteConfirmId(pl.id);
      const btn = e.currentTarget as HTMLElement;
      requestAnimationFrame(() => {
        btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      return;
    }
    try {
      await deletePlaylist(pl.id);
      removeId(pl.id);
      usePlaylistStore.setState((s) => ({
        playlists: s.playlists.filter((p) => p.id !== pl.id),
      }));
      showToast(t('playlists.deleteSuccess', { count: 1 }), 3000, 'info');
    } catch {
      showToast(t('playlists.deleteFailed', { name: pl.name }), 3000, 'error');
    }
    setDeleteConfirmId(null);
  };

  const handleDeleteSelected = async () => {
    const deletable = selectedPlaylists.filter(isPlaylistDeletable);
    if (deletable.length === 0) return;
    let deleted = 0;
    for (const pl of deletable) {
      try {
        await deletePlaylist(pl.id);
        removeId(pl.id);
        deleted++;
      } catch {
        showToast(t('playlists.deleteFailed', { name: pl.name }), 3000, 'error');
      }
    }
    usePlaylistStore.setState((s) => ({
      playlists: s.playlists.filter((p) => !(selectedIds.has(p.id) && isPlaylistDeletable(p))),
    }));
    clearSelection();
    if (deleted > 0) {
      showToast(t('playlists.deleteSuccess', { count: deleted }), 3000, 'info');
    }
  };

  const handleMergeSelected = async (targetPlaylist: SubsonicPlaylist) => {
    if (selectedPlaylists.length === 0) return;
    try {
      const { songs: targetSongs } = await getPlaylist(targetPlaylist.id);
      const targetIds = new Set(targetSongs.map(s => s.id));
      let totalAdded = 0;

      for (const pl of selectedPlaylists) {
        if (pl.id === targetPlaylist.id) continue;
        const { songs } = await getPlaylist(pl.id);
        const newSongs = songs.filter(s => !targetIds.has(s.id));
        if (newSongs.length > 0) {
          newSongs.forEach(s => targetIds.add(s.id));
          totalAdded += newSongs.length;
        }
      }

      if (totalAdded > 0) {
        await updatePlaylist(targetPlaylist.id, Array.from(targetIds));
        touchPlaylist(targetPlaylist.id);
        showToast(t('playlists.mergeSuccess', { count: totalAdded, playlist: targetPlaylist.name }), 3000, 'info');
      } else {
        showToast(t('playlists.mergeNoNewSongs'), 3000, 'info');
      }
      clearSelection();
    } catch {
      showToast(t('playlists.mergeError'), 4000, 'error');
    }
  };

  if (loading) {
    return (
      <div className="content-body" style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="content-body animate-fade-in">
      <style>{`
        .dual-year-range {
          position: relative;
          height: 34px;
        }
        .dual-year-range__track,
        .dual-year-range__selected {
          position: absolute;
          left: 0;
          right: 0;
          top: 50%;
          height: 4px;
          transform: translateY(-50%);
          border-radius: 999px;
        }
        .dual-year-range__track { background: var(--border); }
        .dual-year-range__selected { background: var(--accent); }
        .dual-year-range input[type='range'] {
          position: absolute;
          left: 0;
          top: 0;
          width: 100%;
          height: 34px;
          margin: 0;
          background: transparent;
          -webkit-appearance: none;
          appearance: none;
          pointer-events: none;
        }
        .dual-year-range input[type='range']::-webkit-slider-runnable-track { height: 4px; background: transparent; }
        .dual-year-range input[type='range']::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 14px;
          height: 14px;
          margin-top: -5px;
          border-radius: 999px;
          border: 1px solid var(--border);
          background: var(--bg-card);
          pointer-events: auto;
          cursor: pointer;
        }
      `}</style>

      {/* ── Header row ── */}
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
      {creatingSmart && (
        <div style={{ marginBottom: '1rem', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.9rem', background: 'var(--bg-card)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <section style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.75rem' }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: '0.65rem' }}>{t('smartPlaylists.sectionBasic')}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                <input className="input" placeholder={t('smartPlaylists.name')} value={smartFilters.name} onChange={e => setSmartFilters(v => ({ ...v, name: e.target.value }))} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  <input className="input" type="number" min={1} max={LIMIT_MAX} placeholder={t('smartPlaylists.limit')} value={smartFilters.limit} onChange={e => setSmartFilters(v => ({ ...v, limit: e.target.value }))} />
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('smartPlaylists.limitHint', { max: LIMIT_MAX })}</span>
                </div>
                <select className="input" value={smartFilters.sort} onChange={e => setSmartFilters(v => ({ ...v, sort: e.target.value }))}>
                  <option value="+random">{t('smartPlaylists.sortRandom')}</option>
                  <option value="+title">{t('smartPlaylists.sortTitleAsc')}</option>
                  <option value="-title">{t('smartPlaylists.sortTitleDesc')}</option>
                  <option value="-year">{t('smartPlaylists.sortYearDesc')}</option>
                  <option value="+year">{t('smartPlaylists.sortYearAsc')}</option>
                  <option value="-playcount">{t('smartPlaylists.sortPlayCountDesc')}</option>
                </select>
              </div>
            </section>
            <section style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.75rem' }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: '0.65rem' }}>{t('smartPlaylists.sectionGenres')}</div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('smartPlaylists.genreMode')}</span>
                <button className={`btn ${smartFilters.genreMode === 'include' ? 'btn-primary' : 'btn-surface'}`} onClick={() => setSmartFilters(v => ({ ...v, genreMode: 'include' }))}>{t('smartPlaylists.genreModeInclude')}</button>
                <button className={`btn ${smartFilters.genreMode === 'exclude' ? 'btn-primary' : 'btn-surface'}`} onClick={() => setSmartFilters(v => ({ ...v, genreMode: 'exclude' }))}>{t('smartPlaylists.genreModeExclude')}</button>
              </div>
              <input className="input" placeholder={t('smartPlaylists.genreSearchPlaceholder')} value={genreQuery} onChange={e => setGenreQuery(e.target.value)} style={{ marginBottom: '0.75rem' }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.5rem', minHeight: 120 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.5rem' }}>{t('smartPlaylists.availableGenres')}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                    {availableGenres.map(g => (
                      <button key={g} className="btn btn-surface" style={{ fontSize: 12, padding: '2px 8px' }} onClick={() => setSmartFilters(v => ({ ...v, selectedGenres: [...v.selectedGenres, g] }))}>{g}</button>
                    ))}
                  </div>
                </div>
                <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.5rem', minHeight: 120 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.5rem' }}>{t('smartPlaylists.selectedGenres')}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                    {smartFilters.selectedGenres.map(g => (
                      <button key={g} className="btn btn-surface" style={{ fontSize: 12, padding: '2px 8px' }} onClick={() => setSmartFilters(v => ({ ...v, selectedGenres: v.selectedGenres.filter(x => x !== g) }))}>× {g}</button>
                    ))}
                  </div>
                </div>
              </div>
            </section>
            <section style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.75rem' }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: '0.65rem' }}>{t('smartPlaylists.sectionYearsAndFilters')}</div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('smartPlaylists.yearMode')}</span>
                <button className={`btn ${smartFilters.yearMode === 'include' ? 'btn-primary' : 'btn-surface'}`} onClick={() => setSmartFilters(v => ({ ...v, yearMode: 'include' }))}>{t('smartPlaylists.yearModeInclude')}</button>
                <button className={`btn ${smartFilters.yearMode === 'exclude' ? 'btn-primary' : 'btn-surface'}`} onClick={() => setSmartFilters(v => ({ ...v, yearMode: 'exclude' }))}>{t('smartPlaylists.yearModeExclude')}</button>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-muted)' }}>
                <span>{t('smartPlaylists.fromYear')}: {smartFilters.yearFrom}</span>
                <span>{t('smartPlaylists.toYear')}: {smartFilters.yearTo}</span>
              </div>
              <div className="dual-year-range">
                <div className="dual-year-range__track" />
                <div className="dual-year-range__selected" style={{ left: `${((smartFilters.yearFrom - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100}%`, right: `${100 - ((smartFilters.yearTo - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100}%` }} />
                <input type="range" min={YEAR_MIN} max={YEAR_MAX} value={smartFilters.yearFrom} onChange={e => setSmartFilters(v => ({ ...v, yearFrom: Math.min(clampYear(Number(e.target.value)), v.yearTo) }))} />
                <input type="range" min={YEAR_MIN} max={YEAR_MAX} value={smartFilters.yearTo} onChange={e => setSmartFilters(v => ({ ...v, yearTo: Math.max(clampYear(Number(e.target.value)), v.yearFrom) }))} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', marginTop: '0.75rem' }}>
                <input className="input" placeholder={t('smartPlaylists.artistContains')} value={smartFilters.artistContains} onChange={e => setSmartFilters(v => ({ ...v, artistContains: e.target.value }))} />
                <input className="input" placeholder={t('smartPlaylists.albumContains')} value={smartFilters.albumContains} onChange={e => setSmartFilters(v => ({ ...v, albumContains: e.target.value }))} />
                <input className="input" placeholder={t('smartPlaylists.titleContains')} value={smartFilters.titleContains} onChange={e => setSmartFilters(v => ({ ...v, titleContains: e.target.value }))} />
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('smartPlaylists.minRating')}: {smartFilters.minRating}★</div>
                <StarRating value={smartFilters.minRating} onChange={rating => setSmartFilters(v => ({ ...v, minRating: rating }))} ariaLabel={t('smartPlaylists.minRatingAria')} />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('smartPlaylists.minRatingHint')}</span>
              </div>
              <div style={{ marginTop: '0.75rem', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                  <input type="checkbox" checked={smartFilters.excludeUnrated} onChange={e => setSmartFilters(v => ({ ...v, excludeUnrated: e.target.checked }))} />
                  {t('smartPlaylists.excludeUnrated')}
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                  <input type="checkbox" checked={smartFilters.compilationOnly} onChange={e => setSmartFilters(v => ({ ...v, compilationOnly: e.target.checked }))} />
                  {t('smartPlaylists.compilationOnly')}
                </label>
              </div>
            </section>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button
                className="btn btn-surface"
                onClick={() => {
                  setCreatingSmart(false);
                  setEditingSmartId(null);
                  setSmartFilters(defaultSmartFilters);
                  setGenreQuery('');
                }}
              >
                {t('playlists.cancel')}
              </button>
              <button className="btn btn-primary" onClick={handleCreateSmart} disabled={creatingSmartBusy}>
                <Plus size={15} /> {editingSmartId ? t('smartPlaylists.save') : t('smartPlaylists.create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Grid ── */}
      {playlists.length === 0 ? (
        <div className="empty-state">{t('playlists.empty')}</div>
      ) : (
        <div className="album-grid-wrap">
          {playlists.map((pl) => (
            <div
              key={pl.id}
              className={`album-card${selectionMode && selectedIds.has(pl.id) ? ' selected' : ''}`}
              onClick={() => {
                if (selectionMode) {
                  toggleSelect(pl.id);
                } else {
                  navigate(`/playlists/${pl.id}`);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (selectionMode && selectedIds.size > 0) {
                  openContextMenu(e.clientX, e.clientY, selectedPlaylists, 'multi-playlist');
                } else {
                  openContextMenu(e.clientX, e.clientY, pl, 'playlist');
                }
              }}
              onMouseLeave={() => { if (deleteConfirmId === pl.id) setDeleteConfirmId(null); }}
              style={selectionMode && selectedIds.has(pl.id) ? {
                position: 'relative',
                outline: '2px solid var(--accent)',
                outlineOffset: '2px',
                borderRadius: 'var(--radius-md)'
              } : { position: 'relative' }}
            >
              {!selectionMode && (
                <div className="playlist-card-actions">
                  {isPlaylistDeletable(pl) && (
                    <button
                      className="playlist-card-action playlist-card-action--edit"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isSmartPlaylistName(pl.name)) {
                          void handleOpenSmartEditor(pl);
                          return;
                        }
                        navigate(`/playlists/${pl.id}`, { state: { openEditMeta: true } });
                      }}
                      data-tooltip={t('playlists.editMeta')}
                    >
                      <Pencil size={13} />
                    </button>
                  )}
                  {isPlaylistDeletable(pl) && (
                    <button
                      className={`playlist-card-action playlist-card-action--delete${deleteConfirmId === pl.id ? ' playlist-card-action--delete-confirm' : ''}`}
                      onClick={(e) => handleDelete(e, pl)}
                      data-tooltip={deleteConfirmId === pl.id ? t('playlists.confirmDelete') : t('common.delete')}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              )}
              {selectionMode && (
                <div className={`album-card-select-check${selectedIds.has(pl.id) ? ' album-card-select-check--on' : ''}`}>
                  {selectedIds.has(pl.id) && <Check size={14} strokeWidth={3} />}
                </div>
              )}
              {/* Cover area — server collage or fallback icon */}
              <div className="album-card-cover">
                {isSmartPlaylistName(pl.name) && (smartCoverIdsByPlaylist[pl.id]?.length ?? 0) > 0 ? (
                  <div className="playlist-cover-grid">
                    {Array.from({ length: 4 }, (_, i) => {
                      const id = smartCoverIdsByPlaylist[pl.id][i % smartCoverIdsByPlaylist[pl.id].length];
                      return id ? (
                        <CachedImage
                          key={i}
                          className="playlist-cover-cell"
                          src={buildCoverArtUrl(id, 200)}
                          cacheKey={coverArtCacheKey(id, 200)}
                          alt=""
                        />
                      ) : (
                        <div key={i} className="playlist-cover-cell playlist-cover-cell--empty" />
                      );
                    })}
                  </div>
                ) : pl.coverArt ? (
                  <CachedImage
                    src={buildCoverArtUrl(pl.coverArt, 256)}
                    cacheKey={coverArtCacheKey(pl.coverArt, 256)}
                    alt={pl.name}
                    className="album-card-cover-img"
                  />
                ) : (
                  <div className="album-card-cover-placeholder playlist-card-icon">
                    <ListMusic size={48} strokeWidth={1.2} />
                  </div>
                )}
                {pendingSmart.some(p => p.id === pl.id || p.name === pl.name) && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 8,
                      left: 8,
                      width: 24,
                      height: 24,
                      borderRadius: 999,
                      background: 'rgba(0,0,0,0.45)',
                      border: '1px solid rgba(255,255,255,0.25)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'white',
                      zIndex: 8,
                      pointerEvents: 'none',
                    }}
                    data-tooltip={t('common.loading')}
                  >
                    <Clock3 size={13} />
                  </div>
                )}

                {/* Play overlay — same pattern as AlbumCard */}
                <div className="album-card-play-overlay">
                  <button
                    className="album-card-details-btn"
                    onClick={(e) => handlePlay(e, pl)}
                    disabled={playingId === pl.id}
                  >
                    {playingId === pl.id
                      ? <span className="spinner" style={{ width: 14, height: 14 }} />
                      : <Play size={15} fill="currentColor" />
                    }
                  </button>
                </div>

              </div>

              <div className="album-card-info">
                <div className="album-card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {isSmartPlaylistName(pl.name) && <Sparkles size={14} style={{ color: 'var(--text-muted)', flex: '0 0 auto' }} />}
                  <span>{displayPlaylistName(pl.name)}</span>
                </div>
                <div className="album-card-artist">
                  {t('playlists.songs', { n: filteredSongCountByPlaylist[pl.id] ?? pl.songCount })}
                  {(filteredDurationByPlaylist[pl.id] ?? pl.duration) > 0 && (
                    <> · {formatDuration(filteredDurationByPlaylist[pl.id] ?? pl.duration)}</>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

    </div>
  );
}
