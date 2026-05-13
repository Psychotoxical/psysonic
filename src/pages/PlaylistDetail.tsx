import { getPlaylist, updatePlaylist, updatePlaylistMeta, uploadPlaylistCoverArt } from '../api/subsonicPlaylists';
import { buildDownloadUrl, coverArtCacheKey, buildCoverArtUrl } from '../api/subsonicStreamUrl';
import { setRating, star, unstar } from '../api/subsonicStarRating';
import { search } from '../api/subsonicSearch';
import { getRandomSongs, filterSongsToActiveLibrary } from '../api/subsonicLibrary';
import type { SubsonicPlaylist, SubsonicSong } from '../api/subsonicTypes';
import { songToTrack } from '../utils/songToTrack';
import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { ChevronDown, ChevronLeft, ChevronRight, Play, ListPlus, Trash2, Search, X, Loader2, Plus, GripVertical, Star, RefreshCw, Shuffle, Heart, HardDriveDownload, Check, Pencil, Globe, Lock, Camera, Download, FileUp, RotateCcw, Sparkles, Square, AudioLines } from 'lucide-react';
import { useTracklistColumns, type ColDef } from '../utils/useTracklistColumns';
import { AddToPlaylistSubmenu } from '../components/ContextMenu';
import { usePlayerStore } from '../store/playerStore';
import { useShallow } from 'zustand/react/shallow';
import { usePlaylistStore } from '../store/playlistStore';
import { usePreviewStore } from '../store/previewStore';
import { useOfflineStore } from '../store/offlineStore';
import { useOfflineJobStore } from '../store/offlineJobStore';
import { useAuthStore } from '../store/authStore';
import { useThemeStore } from '../store/themeStore';
import { useDownloadModalStore } from '../store/downloadModalStore';
import { useOrbitSongRowBehavior } from '../hooks/useOrbitSongRowBehavior';
import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { useZipDownloadStore } from '../store/zipDownloadStore';
import { useDragDrop } from '../contexts/DragDropContext';
import CachedImage, { useCachedUrl } from '../components/CachedImage';
import { useTranslation } from 'react-i18next';
import { showToast } from '../utils/toast';
import StarRating from '../components/StarRating';
import {
  sanitizeFilename,
  formatDuration,
  formatSize,
  totalDurationLabel,
  isSmartPlaylistName,
  displayPlaylistName,
  codecLabel,
} from '../utils/playlistDetailHelpers';
import type { SpotifyCsvTrack } from '../utils/spotifyCsvImport';
import { runPlaylistCsvImport } from '../utils/runPlaylistCsvImport';
import PlaylistEditModal from '../components/playlist/PlaylistEditModal';
import CsvImportReportModal from '../components/playlist/CsvImportReportModal';
import PlaylistSongSearchPanel from '../components/playlist/PlaylistSongSearchPanel';
import PlaylistSuggestions from '../components/playlist/PlaylistSuggestions';

// ── Column configuration ──────────────────────────────────────────────────────
const PL_COLUMNS: readonly ColDef[] = [
  { key: 'num',      i18nKey: null,            minWidth: 60,  defaultWidth: 60,  required: true  },
  { key: 'title',    i18nKey: 'trackTitle',    minWidth: 150, defaultWidth: 0,   required: true,  flex: true },
  { key: 'artist',   i18nKey: 'trackArtist',   minWidth: 80,  defaultWidth: 180, required: false },
  { key: 'album',    i18nKey: 'trackAlbum',    minWidth: 80,  defaultWidth: 180, required: false },
  { key: 'favorite', i18nKey: 'trackFavorite', minWidth: 50,  defaultWidth: 70,  required: false },
  { key: 'rating',   i18nKey: 'trackRating',   minWidth: 80,  defaultWidth: 120, required: false },
  { key: 'duration', i18nKey: 'trackDuration', minWidth: 72,  defaultWidth: 92,  required: false },
  { key: 'format',   i18nKey: 'trackFormat',   minWidth: 60,  defaultWidth: 90,  required: false },
  { key: 'delete',   i18nKey: null,            minWidth: 36,  defaultWidth: 36,  required: true  },
];

const PL_CENTERED = new Set(['favorite', 'rating', 'duration']);

export default function PlaylistDetail() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { playTrack, enqueue, openContextMenu, currentTrack, isPlaying, starredOverrides, setStarredOverride, userRatingOverrides } = usePlayerStore(
    useShallow(s => ({
      playTrack: s.playTrack,
      enqueue: s.enqueue,
      openContextMenu: s.openContextMenu,
      currentTrack: s.currentTrack,
      isPlaying: s.isPlaying,
      starredOverrides: s.starredOverrides,
      setStarredOverride: s.setStarredOverride,
      userRatingOverrides: s.userRatingOverrides,
    }))
  );
  const { orbitActive, queueHint, addTrackToOrbit } = useOrbitSongRowBehavior();
  const touchPlaylist = usePlaylistStore((s) => s.touchPlaylist);
  const { startDrag, isDragging } = useDragDrop();
  const downloadPlaylist = useOfflineStore(s => s.downloadPlaylist);
  const deleteAlbum = useOfflineStore(s => s.deleteAlbum);
  const activeServerId = useAuthStore(s => s.activeServerId) ?? '';
  const isDownloading = useOfflineJobStore(s =>
    !!id && s.jobs.some(j => j.albumId === id && (j.status === 'queued' || j.status === 'downloading'))
  );
  const isCached = useOfflineStore(s => {
    if (!id) return false;
    const meta = s.albums[`${activeServerId}:${id}`];
    if (!meta || meta.trackIds.length === 0) return false;
    return meta.trackIds.every(tid => !!s.tracks[`${activeServerId}:${tid}`]);
  });
  const offlineProgressDone = useOfflineJobStore(s => {
    if (!id) return 0;
    return s.jobs.filter(j => j.albumId === id && (j.status === 'done' || j.status === 'error')).length;
  });
  const offlineProgressTotal = useOfflineJobStore(s => (!id ? 0 : s.jobs.filter(j => j.albumId === id).length));
  const offlineProgress = offlineProgressTotal > 0 ? { done: offlineProgressDone, total: offlineProgressTotal } : null;
  const downloadFolder = useAuthStore(s => s.downloadFolder);
  const setDownloadFolder = useAuthStore(s => s.setDownloadFolder);
  const requestDownloadFolder = useDownloadModalStore(s => s.requestFolder);
  const enableCoverArtBackground = useThemeStore(s => s.enableCoverArtBackground);
  const enablePlaylistCoverPhoto = useThemeStore(s => s.enablePlaylistCoverPhoto);
  const showBitrate = useThemeStore(s => s.showBitrate);

  const [playlist, setPlaylist] = useState<SubsonicPlaylist | null>(null);
  const [songs, setSongs] = useState<SubsonicSong[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [editingMeta, setEditingMeta] = useState(false);
  const [customCoverId, setCustomCoverId] = useState<string | null>(null);
  const [filterText, setFilterText] = useState('');
  const [sortKey, setSortKey] = useState<'natural' | 'title' | 'artist' | 'album' | 'favorite' | 'rating' | 'duration'>('natural');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [sortClickCount, setSortClickCount] = useState(0);
  const [starredSongs, setStarredSongs] = useState<Set<string>>(new Set());
  const [hoveredSuggestionId, setHoveredSuggestionId] = useState<string | null>(null);
  const previewingId = usePreviewStore(s => s.previewingId);
  const previewAudioStarted = usePreviewStore(s => s.audioStarted);
  const [contextMenuSongId, setContextMenuSongId] = useState<string | null>(null);
  const contextMenuOpen = usePlayerStore(s => s.contextMenu.isOpen);
  const zipDownloads = useZipDownloadStore(s => s.downloads);
  const [zipDownloadId, setZipDownloadId] = useState<string | null>(null);
  const activeZip = zipDownloadId ? zipDownloads.find(d => d.id === zipDownloadId) : undefined;

  // ── CSV Import ───────────────────────────────────────────────────
  const [csvImporting, setCsvImporting] = useState(false);
  const [csvImportReport, setCsvImportReport] = useState<{
    added: number;
    notFound: SpotifyCsvTrack[];
    duplicates: number;
    duplicateTracks: SpotifyCsvTrack[];
    total: number;
    searchErrors?: SpotifyCsvTrack[];
  } | null>(null);

  // ── Bulk select ───────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedIdx, setLastSelectedIdx] = useState<number | null>(null);
  const [showBulkPlPicker, setShowBulkPlPicker] = useState(false);

  const toggleSelect = (id: string, idx: number, shift: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (shift && lastSelectedIdx !== null) {
        const from = Math.min(lastSelectedIdx, idx);
        const to = Math.max(lastSelectedIdx, idx);
        songs.slice(from, to + 1).forEach(s => next.add(s.id));
      } else {
        next.has(id) ? next.delete(id) : next.add(id);
      }
      return next;
    });
    setLastSelectedIdx(idx);
  };

  const allSelected = selectedIds.size === songs.length && songs.length > 0;
  const toggleAll = () => setSelectedIds(allSelected ? new Set() : new Set(songs.map(s => s.id)));

  const bulkRemove = () => {
    const prevCount = songs.length;
    const next = songs.filter(s => !selectedIds.has(s.id));
    setSongs(next);
    savePlaylist(next, prevCount);
    setSelectedIds(new Set());
  };

  useEffect(() => {
    if (!showBulkPlPicker) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.bulk-pl-picker-wrap')) setShowBulkPlPicker(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showBulkPlPicker]);

  // ── 2×2 cover quad (first 4 unique album covers) ─────────────
  const coverQuad = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const s of songs) {
      if (s.coverArt && !seen.has(s.coverArt)) {
        seen.add(s.coverArt);
        result.push(s.coverArt);
        if (result.length === 4) break;
      }
    }
    return result;
  }, [songs]);

  // Stable fetch URLs + cache keys for the 2×2 grid and blurred background.
  // buildCoverArtUrl generates a new crypto salt on every call, so these MUST
  // be memoized — otherwise every render produces new URLs, useCachedUrl
  // re-triggers, state updates, another render → infinite flicker loop.
  const coverQuadUrls = useMemo(() =>
    Array.from({ length: 4 }, (_, i) => {
      const coverId = coverQuad[i % Math.max(1, coverQuad.length)];
      if (!coverId) return null;
      return { src: buildCoverArtUrl(coverId, 200), cacheKey: coverArtCacheKey(coverId, 200) };
    }),
  [coverQuad]);

  const effectiveBgId = customCoverId ?? coverQuad[0] ?? '';
  const bgFetchUrl = useMemo(() => buildCoverArtUrl(effectiveBgId, 300), [effectiveBgId]);
  const bgCacheKey = useMemo(() => coverArtCacheKey(effectiveBgId, 300), [effectiveBgId]);
  const resolvedBgUrl = useCachedUrl(bgFetchUrl, bgCacheKey);

  const customCoverFetchUrl = useMemo(
    () => customCoverId ? buildCoverArtUrl(customCoverId, 300) : null,
    [customCoverId],
  );
  const customCoverCacheKey = useMemo(
    () => customCoverId ? coverArtCacheKey(customCoverId, 300) : null,
    [customCoverId],
  );

  // Song search
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SubsonicSong[]>([]);
  const [searching, setSearching] = useState(false);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedSearchIds, setSelectedSearchIds] = useState<Set<string>>(new Set());
  const [searchPlPickerOpen, setSearchPlPickerOpen] = useState(false);

  // Suggestions
  const [suggestions, setSuggestions] = useState<SubsonicSong[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);

  // ── Column resize/visibility ──────────────────────────────────────────────
  const {
    colVisible, visibleCols, gridStyle,
    startResize, toggleColumn, resetColumns,
    pickerOpen, setPickerOpen, pickerRef, tracklistRef,
  } = useTracklistColumns(PL_COLUMNS, 'psysonic_playlist_columns');

  // DnD
  const [dropTargetIdx, setDropTargetIdx] = useState<{ idx: number; before: boolean } | null>(null);

  useEffect(() => {
    if (!contextMenuOpen) setContextMenuSongId(null);
  }, [contextMenuOpen]);

  useEffect(() => {
    const state = (location.state as { openEditMeta?: boolean } | null) ?? null;
    if (state?.openEditMeta) {
      setEditingMeta(true);
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.state, location.pathname, navigate]);

  // ── Load ─────────────────────────────────────────────────────
  const lastModified = usePlaylistStore(s => (id ? s.lastModified[id] : undefined));

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    getPlaylist(id)
      .then(async ({ playlist, songs }) => {
        const filteredSongs = await filterSongsToActiveLibrary(songs);
        setPlaylist(playlist);
        setSongs(filteredSongs);
        if (playlist.coverArt) setCustomCoverId(playlist.coverArt);
        const init: Record<string, number> = {};
        const starred = new Set<string>();
        filteredSongs.forEach(s => {
          if (s.userRating) init[s.id] = s.userRating;
          if (s.starred) starred.add(s.id);
        });
        setRatings(init);
        setStarredSongs(starred);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id, lastModified]);

  // ── Suggestions ───────────────────────────────────────────────
  const loadSuggestions = useCallback(async (currentSongs: SubsonicSong[]) => {
    if (!currentSongs.length) return;
    // Count genres across playlist songs, pick the most common one
    const genreCounts: Record<string, number> = {};
    for (const s of currentSongs) {
      if (s.genre) genreCounts[s.genre] = (genreCounts[s.genre] ?? 0) + 1;
    }
    const genres = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]);
    // Fall back to no genre filter if none of the songs have genre tags
    const genre = genres.length > 0 ? genres[Math.floor(Math.random() * Math.min(3, genres.length))][0] : undefined;
    const existingIds = new Set(currentSongs.map(s => s.id));
    setLoadingSuggestions(true);
    setSuggestions([]);
    try {
      const random = await getRandomSongs(25, genre);
      setSuggestions(random.filter(s => !existingIds.has(s.id)).slice(0, 10));
    } catch {}
    setLoadingSuggestions(false);
  }, []);

  useEffect(() => {
    if (songs.length > 0) loadSuggestions(songs);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlist?.id]);

  // ── Save ──────────────────────────────────────────────────────
  const savePlaylist = useCallback(async (updatedSongs: SubsonicSong[], prevCount = 0) => {
    if (!id) return;
    setSaving(true);
    try {
      await updatePlaylist(id, updatedSongs.map(s => s.id), prevCount);
      if (id) touchPlaylist(id);
    } catch {}
    setSaving(false);
  }, [id, touchPlaylist]);

  // ── Meta edit ─────────────────────────────────────────────────
  const handleSaveMeta = async (opts: {
    name: string; comment: string; isPublic: boolean;
    coverFile: File | null; coverRemoved: boolean;
  }) => {
    if (!id || !playlist) return;
    await updatePlaylistMeta(id, opts.name.trim() || playlist.name, opts.comment, opts.isPublic);
    setPlaylist(p => p
      ? { ...p, name: opts.name.trim() || p.name, comment: opts.comment, public: opts.isPublic }
      : p
    );
    if (opts.coverFile) {
      try {
        await uploadPlaylistCoverArt(id, opts.coverFile);
        const { playlist: refreshed } = await getPlaylist(id);
        setPlaylist(prev => prev ? { ...prev, coverArt: refreshed.coverArt } : prev);
        if (refreshed.coverArt) setCustomCoverId(refreshed.coverArt);
        showToast(t('playlists.coverUpdated'));
      } catch (err) {
        showToast(err instanceof Error ? err.message : t('playlists.coverUpdated'), 3000, 'error');
      }
    } else if (opts.coverRemoved) {
      setCustomCoverId(null);
    }
    showToast(t('playlists.metaSaved'));
    setEditingMeta(false);
  };

  // ── ZIP Download ──────────────────────────────────────────────
  const handleDownload = async () => {
    if (!playlist || !id) return;
    const folder = downloadFolder || await requestDownloadFolder();
    if (!folder) return;

    const filename = `${sanitizeFilename(playlist.name)}.zip`;
    const destPath = await join(folder, filename);
    const url = buildDownloadUrl(id);
    const downloadId = crypto.randomUUID();

    const { start, complete, fail } = useZipDownloadStore.getState();
    start(downloadId, filename);
    setZipDownloadId(downloadId);
    try {
      await invoke('download_zip', { id: downloadId, url, destPath });
      complete(downloadId);
    } catch (e) {
      fail(downloadId);
      console.error('ZIP download failed:', e);
    }
  };

  // ── CSV Import ────────────────────────────────────────────────
  const handleImportCsv = async () => {
    if (!id || csvImporting) return;
    await runPlaylistCsvImport({
      songs, t, savePlaylist,
      setSongs, setCsvImporting, setCsvImportReport,
    });
  };

  // ── Remove ────────────────────────────────────────────────────
  const removeSong = (idx: number) => {
    const prevCount = songs.length;
    const next = songs.filter((_, i) => i !== idx);
    setSongs(next);
    savePlaylist(next, prevCount);
  };

  // ── Add ───────────────────────────────────────────────────────
  const addSong = (song: SubsonicSong) => {
    if (songs.some(s => s.id === song.id)) return;
    const scrollHost = document.querySelector('.main-content') as HTMLElement | null;
    const savedScroll = scrollHost?.scrollTop ?? 0;
    const next = [...songs, song];
    setSongs(next);
    savePlaylist(next);
    setSuggestions(prev => prev.filter(s => s.id !== song.id));
    setSearchResults(prev => prev.filter(s => s.id !== song.id));
    if (scrollHost) {
      requestAnimationFrame(() => { scrollHost.scrollTop = savedScroll; });
    }
    showToast(t('playlists.addSuccess', { count: 1, playlist: playlist?.name }));
  };

  // ── Preview (30s mid-song sample via Rust audio engine) ────────
  // Pause/resume of the main player + timer + cancel-on-supersede are all
  // handled in `audio_preview_play` / `audio_preview_stop`. The store mirrors
  // engine events so we just dispatch here and read `previewingId` for UI.
  const startPreview = useCallback((song: SubsonicSong) => {
    usePreviewStore.getState().startPreview({
      id: song.id,
      title: song.title,
      artist: song.artist,
      coverArt: song.coverArt,
      duration: song.duration,
    }, 'suggestions').catch(() => { /* engine errored — store already rolled back */ });
  }, []);

  // Cancel any in-flight preview when the user navigates away.
  useEffect(() => () => {
    if (usePreviewStore.getState().previewingId) {
      usePreviewStore.getState().stopPreview();
    }
  }, []);

  // ── Rating / Star ─────────────────────────────────────────────
  const handleRate = (songId: string, rating: number) => {
    setRatings(prev => ({ ...prev, [songId]: rating }));
    usePlayerStore.getState().setUserRatingOverride(songId, rating);
    setRating(songId, rating).catch(() => {});
  };

  const handleToggleStar = (song: SubsonicSong, e: React.MouseEvent) => {
    e.stopPropagation();
    const isStarred = song.id in starredOverrides ? starredOverrides[song.id] : starredSongs.has(song.id);
    setStarredSongs(prev => {
      const next = new Set(prev);
      isStarred ? next.delete(song.id) : next.add(song.id);
      return next;
    });
    setStarredOverride(song.id, !isStarred);
    (isStarred ? unstar(song.id, 'song') : star(song.id, 'song')).catch(() => {});
  };

  // ── Search ────────────────────────────────────────────────────
  useEffect(() => {
    if (!searchOpen || !searchQuery.trim()) { setSearchResults([]); return; }
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await search(searchQuery, { songCount: 20, artistCount: 0, albumCount: 0 });
        const existingIds = new Set(songs.map(s => s.id));
        setSearchResults(res.songs.filter(s => !existingIds.has(s.id)));
      } catch {}
      setSearching(false);
    }, 350);
    return () => { if (searchDebounce.current) clearTimeout(searchDebounce.current); };
  }, [searchQuery, searchOpen, songs]);

  // ── psy-drop DnD reordering ───────────────────────────────────
  useEffect(() => {
    const container = tracklistRef.current;
    if (!container) return;

    const onPsyDrop = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.data) return;
      let parsed: any;
      try { parsed = JSON.parse(detail.data); } catch { return; }
      if (parsed.type !== 'playlist_reorder') return;

      setDropTargetIdx(null);

      const fromIdx: number = parsed.index;

      // Determine drop index from the event target row
      const target = (e.target as HTMLElement).closest('[data-track-idx]');
      let toIdx = songs.length;
      if (target) {
        const targetIdx = parseInt(target.getAttribute('data-track-idx') ?? '', 10);
        const rect = target.getBoundingClientRect();
        const cursorY = (e as CustomEvent & { clientY?: number }).clientY ?? (rect.top + rect.height / 2);
        const before = cursorY < rect.top + rect.height / 2;
        toIdx = before ? targetIdx : targetIdx + 1;
      }

      if (fromIdx === toIdx || fromIdx === toIdx - 1) return;

      setSongs(prev => {
        const next = [...prev];
        const [moved] = next.splice(fromIdx, 1);
        const insertAt = toIdx > fromIdx ? toIdx - 1 : toIdx;
        next.splice(insertAt, 0, moved);
        savePlaylist(next);
        return next;
      });
    };

    container.addEventListener('psy-drop', onPsyDrop);
    return () => container.removeEventListener('psy-drop', onPsyDrop);
  }, [songs, savePlaylist]);

  // ── Row mousedown: threshold drag for reorder (from anywhere on the row) ──
  const handleRowMouseDown = (e: React.MouseEvent, idx: number) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, input')) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const onMove = (me: MouseEvent) => {
      if (Math.abs(me.clientX - sx) > 5 || Math.abs(me.clientY - sy) > 5) {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (!isFiltered && selectedIds.has(songs[idx]?.id) && selectedIds.size > 1) {
          const bulkTracks = songs.filter(s => selectedIds.has(s.id)).map(songToTrack);
          startDrag({ data: JSON.stringify({ type: 'songs', tracks: bulkTracks }), label: `${bulkTracks.length} Songs` }, me.clientX, me.clientY);
        } else if (!isFiltered) {
          startDrag(
            { data: JSON.stringify({ type: 'playlist_reorder', index: idx }), label: songs[idx]?.title ?? '' },
            me.clientX, me.clientY
          );
        } else {
          // filtered view: single-song drag to queue
          startDrag(
            { data: JSON.stringify({ type: 'song', track: songToTrack(songs[idx]) }), label: songs[idx]?.title ?? '' },
            me.clientX, me.clientY
          );
        }
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // ── Memoized derivations ──────────────────────────────────────
  const existingIds = useMemo(() => new Set(songs.map(s => s.id)), [songs]);
  const tracks = useMemo(() => songs.map(songToTrack), [songs]);

  const displayedSongs = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q && sortKey === 'natural') return songs;
    let result = [...songs];
    if (q) result = result.filter(s => s.title.toLowerCase().includes(q) || (s.artist ?? '').toLowerCase().includes(q));
    if (sortKey !== 'natural') {
      result.sort((a, b) => {
        let av: string | number;
        let bv: string | number;
        const effectiveRating = (s: SubsonicSong) => ratings[s.id] ?? userRatingOverrides[s.id] ?? s.userRating ?? 0;
        const effectiveStarred = (s: SubsonicSong) => (s.id in starredOverrides ? starredOverrides[s.id] : starredSongs.has(s.id)) ? 1 : 0;
        switch (sortKey) {
          case 'title': av = a.title; bv = b.title; break;
          case 'artist': av = a.artist ?? ''; bv = b.artist ?? ''; break;
          case 'album': av = a.album ?? ''; bv = b.album ?? ''; break;
          case 'favorite': av = effectiveStarred(a); bv = effectiveStarred(b); break;
          case 'rating': av = effectiveRating(a); bv = effectiveRating(b); break;
          case 'duration': av = a.duration ?? 0; bv = b.duration ?? 0; break;
          default: av = a.title; bv = b.title;
        }
        if (typeof av === 'number' && typeof bv === 'number') {
          return sortDir === 'asc' ? av - bv : bv - av;
        }
        return sortDir === 'asc' ? (av as string).localeCompare(bv as string) : (bv as string).localeCompare(av as string);
      });
    }
    return result;
  }, [songs, filterText, sortKey, sortDir, ratings, userRatingOverrides, starredOverrides, starredSongs]);
  const displayedTracks = useMemo(
    () => displayedSongs === songs ? tracks : displayedSongs.map(songToTrack),
    [displayedSongs, songs, tracks],
  );
  const isFiltered = displayedSongs !== songs;

  // ── Drag-over visual feedback ─────────────────────────────────
  const handleRowMouseEnter = (idx: number, e: React.MouseEvent) => {
    if (!isDragging) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    setDropTargetIdx({ idx, before });
  };

  // ── Playback actions (encapsulated like AlbumHeader) ─────────
  const handlePlayAll = useCallback(() => {
    if (!songs.length || !id) return;
    touchPlaylist(id);
    playTrack(tracks[0], tracks);
  }, [songs.length, id, tracks, touchPlaylist, playTrack]);

  const handleShuffleAll = useCallback(() => {
    if (!songs.length || !id) return;
    touchPlaylist(id);
    const shuffled = [...tracks];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    playTrack(shuffled[0], shuffled);
  }, [songs.length, id, tracks, touchPlaylist, playTrack]);

  const handleEnqueueAll = useCallback(() => {
    if (!songs.length || !id) return;
    touchPlaylist(id);
    enqueue(tracks);
  }, [songs.length, id, tracks, touchPlaylist, enqueue]);

  // ── Render ────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="content-body" style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
        <div className="spinner" />
      </div>
    );
  }

  if (!playlist) {
    return <div className="content-body"><div className="empty-state">{t('playlists.notFound')}</div></div>;
  }

  return (
    <div className="album-detail animate-fade-in">

      {/* ── Hero ── */}
      <div className="album-detail-header">
        {resolvedBgUrl && enableCoverArtBackground && (
          <>
            <div className="album-detail-bg" style={{ backgroundImage: `url(${resolvedBgUrl})` }} aria-hidden="true" />
            <div className="album-detail-overlay" aria-hidden="true" />
          </>
        )}

        <div className="album-detail-content">
          <button className="btn btn-ghost album-detail-back" onClick={() => navigate('/playlists')}>
            <ChevronLeft size={16} /> {t('playlists.title')}
          </button>

          <div className="album-detail-hero">
            {/* Cover — click to open edit modal */}
            {enablePlaylistCoverPhoto && (
              <div
                className="playlist-hero-cover"
                onClick={() => setEditingMeta(true)}
              >
                {customCoverId && customCoverFetchUrl && customCoverCacheKey ? (
                  <CachedImage
                    src={customCoverFetchUrl}
                    cacheKey={customCoverCacheKey}
                    alt=""
                    className="playlist-cover-grid"
                    style={{ objectFit: 'cover', display: 'block' }}
                  />
                ) : (
                  <div className="playlist-cover-grid">
                    {coverQuadUrls.map((entry, i) =>
                      entry
                        ? <CachedImage key={i} className="playlist-cover-cell" src={entry.src} cacheKey={entry.cacheKey} alt="" />
                        : <div key={i} className="playlist-cover-cell playlist-cover-cell--empty" />
                    )}
                  </div>
                )}
                <div className="playlist-hero-cover-overlay">
                  <Camera size={28} />
                </div>
              </div>
            )}

            <div className="album-detail-meta">
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <h1 className="album-detail-title" style={{ marginBottom: 0, marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                    {isSmartPlaylistName(playlist.name) && <Sparkles size={16} style={{ color: 'var(--text-muted)' }} />}
                    <span>{displayPlaylistName(playlist.name)}</span>
                  </h1>
                  <button
                    className="btn btn-ghost"
                    onClick={() => setEditingMeta(true)}
                    data-tooltip={t('playlists.editMeta')}
                    style={{ padding: '4px 6px', opacity: 0.7, flexShrink: 0 }}
                  >
                    <Pencil size={14} />
                  </button>
                </div>
                {playlist.comment && (
                  <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>{playlist.comment}</div>
                )}
              </>
              <div className="album-detail-info">
                <span>{t('playlists.songs', { n: songs.length })}</span>
                {songs.length > 0 && <span>· {totalDurationLabel(songs)}</span>}
                {playlist.public !== undefined && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    · {playlist.public
                      ? <><Globe size={11} /> {t('playlists.publicLabel')}</>
                      : <><Lock size={11} /> {t('playlists.privateLabel')}</>}
                  </span>
                )}
                {saving && <Loader2 size={12} className="spin-slow" style={{ display: 'inline', marginLeft: 4 }} />}
              </div>
              <div className="album-detail-actions">
                <div className="album-detail-actions-primary">
                  <button className="btn btn-primary" disabled={songs.length === 0} onClick={handlePlayAll}>
                    <Play size={15} /> {t('common.play', 'Reproducir')}
                  </button>
                  <button
                    className="btn btn-ghost"
                    disabled={songs.length === 0}
                    onClick={handleShuffleAll}
                    data-tooltip={t('playlists.shuffle', 'Shuffle')}
                  >
                    <Shuffle size={16} />
                  </button>
                  <button
                    className="btn btn-ghost"
                    disabled={songs.length === 0}
                    onClick={handleEnqueueAll}
                    data-tooltip={t('playlists.addToQueue')}
                  >
                    <ListPlus size={16} />
                  </button>
                </div>
                <button
                  className={`btn btn-ghost ${searchOpen ? 'active' : ''}`}
                  onClick={() => { setSearchOpen(v => !v); setSearchQuery(''); setSearchResults([]); setSelectedSearchIds(new Set()); setSearchPlPickerOpen(false); }}
                >
                  <Search size={16} /> {t('playlists.addSongs')}
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={handleImportCsv}
                  disabled={csvImporting}
                  data-tooltip={t('playlists.importCSVTooltip')}
                >
                  {csvImporting ? <Loader2 size={16} className="spin-slow" /> : <FileUp size={16} />}
                  {t('playlists.importCSV')}
                </button>
                {/* search close resets selection */}
                {songs.length > 0 && (
                  activeZip && !activeZip.done && !activeZip.error ? (
                    <div className="download-progress-wrap">
                      <Download size={14} />
                      <div className="download-progress-bar">
                        <div className="download-progress-fill" style={{ width: `${activeZip.total ? Math.round((activeZip.bytes / activeZip.total) * 100) : 0}%` }} />
                      </div>
                      <span className="download-progress-pct">{activeZip.total ? Math.round((activeZip.bytes / activeZip.total) * 100) : '…'}%</span>
                    </div>
                  ) : (
                    <button className="btn btn-ghost" onClick={handleDownload} data-tooltip={t('playlists.downloadZip')}>
                      <Download size={16} /> {t('playlists.downloadZip')}{songs.reduce((acc, s) => acc + (s.size ?? 0), 0) > 0 ? ` · ${formatSize(songs.reduce((acc, s) => acc + (s.size ?? 0), 0))}` : ''}
                    </button>
                  )
                )}
                {songs.length > 0 && id && (
                  <button
                    className={`btn btn-ghost${isCached ? ' btn-danger' : ''}`}
                    disabled={isDownloading}
                    onClick={() => {
                      if (isCached) {
                        deleteAlbum(id, activeServerId);
                      } else if (playlist) {
                        downloadPlaylist(id, playlist.name, playlist.coverArt, songs, activeServerId);
                      }
                    }}
                    data-tooltip={isDownloading
                      ? t('albumDetail.offlineDownloading', { n: offlineProgress?.done ?? 0, total: offlineProgress?.total ?? 0 })
                      : isCached ? t('playlists.removeOffline') : t('playlists.cacheOffline')}
                  >
                    {isDownloading ? (
                      <>
                        <div className="spinner" style={{ width: 14, height: 14, borderTopColor: 'currentColor' }} />
                        {t('albumDetail.offlineDownloading', { n: offlineProgress?.done ?? 0, total: offlineProgress?.total ?? 0 })}
                      </>
                    ) : isCached ? (
                      <>
                        <Trash2 size={16} />
                        {t('playlists.removeOffline')}
                      </>
                    ) : (
                      <>
                        <HardDriveDownload size={16} />
                        {t('playlists.cacheOffline')}
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Song search panel ── */}
      {searchOpen && (
        <PlaylistSongSearchPanel
          query={searchQuery}
          setQuery={setSearchQuery}
          searching={searching}
          searchResults={searchResults}
          setSearchResults={setSearchResults}
          selectedSearchIds={selectedSearchIds}
          setSelectedSearchIds={setSelectedSearchIds}
          searchPlPickerOpen={searchPlPickerOpen}
          setSearchPlPickerOpen={setSearchPlPickerOpen}
          contextMenuSongId={contextMenuSongId}
          setContextMenuSongId={setContextMenuSongId}
          addSong={addSong}
        />
      )}

      {/* ── Filter / sort toolbar ── */}
      {songs.length > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 16px', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: '1 1 160px', maxWidth: 260 }}>
            <Search size={16} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
            <input
              className="input-search"
              style={{ width: '100%', paddingRight: filterText ? 28 : undefined }}
              placeholder={t('albumDetail.filterSongs')}
              value={filterText}
              onChange={e => setFilterText(e.target.value)}
            />
            {filterText && (
              <button
                style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onClick={() => setFilterText('')}
                aria-label="Clear filter"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Tracklist ── */}
      <div className="tracklist" data-preview-loc="playlists" ref={tracklistRef}>

        {/* Bulk action bar */}
        {selectedIds.size > 0 && (
          <div className="bulk-action-bar">
            <span className="bulk-action-count">
              {t('common.bulkSelected', { count: selectedIds.size })}
            </span>
            <div className="bulk-pl-picker-wrap">
              <button
                className="btn btn-surface btn-sm"
                onClick={() => setShowBulkPlPicker(v => !v)}
              >
                <ListPlus size={14} />
                {t('common.bulkAddToPlaylist')}
              </button>
              {showBulkPlPicker && (
                <AddToPlaylistSubmenu
                  songIds={[...selectedIds]}
                  onDone={() => { setShowBulkPlPicker(false); setSelectedIds(new Set()); }}
                  dropDown
                />
              )}
            </div>
            <button
              className="btn btn-surface btn-sm"
              style={{ color: 'var(--danger)' }}
              onClick={bulkRemove}
            >
              <Trash2 size={14} />
              {t('common.bulkRemoveFromPlaylist')}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setSelectedIds(new Set())}
            >
              <X size={13} />
              {t('common.bulkClear')}
            </button>
          </div>
        )}

        {/* Column visibility picker */}
        <div className="tracklist-col-picker-wrapper" ref={pickerRef}>
          <div className="tracklist-col-picker">
            <button
              className="tracklist-col-picker-btn"
              onClick={e => { e.stopPropagation(); setPickerOpen(v => !v); }}
              data-tooltip={t('albumDetail.columns')}
            >
              <ChevronDown size={14} />
            </button>
            {pickerOpen && (
              <div className="tracklist-col-picker-menu">
                <div className="tracklist-col-picker-label">{t('albumDetail.columns')}</div>
                {PL_COLUMNS.filter(c => !c.required).map(c => {
                  const label = c.i18nKey ? t(`albumDetail.${c.i18nKey}`) : c.key;
                  const isOn = colVisible.has(c.key);
                  return (
                    <button
                      key={c.key}
                      className={`tracklist-col-picker-item${isOn ? ' active' : ''}`}
                      onClick={() => toggleColumn(c.key)}
                    >
                      <span className="tracklist-col-picker-check">{isOn && <Check size={13} />}</span>
                      {label}
                    </button>
                  );
                })}
                <div className="tracklist-col-picker-divider" />
                <button className="tracklist-col-picker-reset" onClick={resetColumns}>
                  <RotateCcw size={13} />
                  {t('albumDetail.resetColumns')}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Header */}
        <div style={{ position: 'relative' }}>
          <div className="tracklist-header tracklist-va" style={gridStyle}>
            {visibleCols.map((colDef, colIndex) => {
              const key = colDef.key;
              const isLastCol = colIndex === visibleCols.length - 1;
              const isCentered = PL_CENTERED.has(key);
              const label = colDef.i18nKey ? t(`albumDetail.${colDef.i18nKey}`) : '';
              const sortableCols = new Set(['title', 'artist', 'favorite', 'rating', 'duration', 'album']);
              const canSort = sortableCols.has(key);
              const isSortActive = canSort && sortKey === key;

              const handleSortClick = () => {
                if (!canSort) return;
                if (sortKey === key) {
                  const nextCount = sortClickCount + 1;
                  if (nextCount >= 3) {
                    setSortKey('natural');
                    setSortDir('asc');
                    setSortClickCount(0);
                  } else {
                    setSortDir(d => d === 'asc' ? 'desc' : 'asc');
                    setSortClickCount(nextCount);
                  }
                } else {
                  setSortKey(key as typeof sortKey);
                  setSortDir('asc');
                  setSortClickCount(1);
                }
              };

              const renderSortIndicator = () => {
                if (!isSortActive) return null;
                return (
                  <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.7 }}>
                    {sortDir === 'asc' ? '▲' : '▼'}
                  </span>
                );
              };

              if (key === 'num') return (
                <div key="num" className="track-num">
                  <span
                    className={`bulk-check${allSelected ? ' checked' : ''}${selectedIds.size > 0 ? ' bulk-check-visible' : ''}`}
                    onClick={e => { e.stopPropagation(); toggleAll(); }}
                    style={{ cursor: 'pointer' }}
                  />
                  <span className="track-num-number">#</span>
                </div>
              );
              if (key === 'title') {
                const hasNextCol = colIndex + 1 < visibleCols.length;
                return (
                  <div
                    key="title"
                    onClick={handleSortClick}
                    style={{
                      position: 'relative',
                      padding: 0,
                      margin: 0,
                      minWidth: 0,
                      overflow: 'hidden',
                      cursor: canSort ? 'pointer' : 'default',
                      userSelect: 'none',
                    }}
                    className={isSortActive ? 'tracklist-header-cell-active' : ''}
                  >
                    <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'flex-start', paddingLeft: 12 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isSortActive ? 600 : 400 }}>{label}</span>
                      {canSort && renderSortIndicator()}
                    </div>
                    {hasNextCol && <div className="col-resize-handle" onMouseDown={e => startResize(e, colIndex + 1, -1)} />}
                  </div>
                );
              }
              if (key === 'delete') return <div key="delete" />;
              return (
                <div
                  key={key}
                  onClick={handleSortClick}
                  style={{
                    position: 'relative',
                    padding: 0,
                    margin: 0,
                    minWidth: 0,
                    overflow: 'hidden',
                    cursor: canSort ? 'pointer' : 'default',
                    userSelect: 'none',
                  }}
                  className={isSortActive ? 'tracklist-header-cell-active' : ''}
                >
                  <div
                    style={{
                      display: 'flex',
                      width: '100%',
                      height: '100%',
                      alignItems: 'center',
                      justifyContent: isCentered ? 'center' : 'flex-start',
                      paddingLeft: isCentered ? 0 : 12,
                    }}
                  >
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: isSortActive ? 600 : 400 }}>{label}</span>
                    {canSort && renderSortIndicator()}
                  </div>
                  {!isLastCol && key !== 'delete' && (
                    <div className="col-resize-handle" onMouseDown={e => startResize(e, colIndex, 1)} />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {songs.length === 0 && (
          <div className="empty-state" style={{ padding: '2rem 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
            <span>{t('playlists.emptyPlaylist')}</span>
            <button className="btn btn-primary" onClick={() => setSearchOpen(true)}>
              <Search size={15} />
              {t('playlists.addFirstSong')}
            </button>
          </div>
        )}

        {displayedSongs.map((song, i) => {
          const realIdx = isFiltered ? songs.indexOf(song) : i;
          return (
          <React.Fragment key={song.id + i}>
            {!isFiltered && isDragging && dropTargetIdx?.idx === i && dropTargetIdx.before && (
              <div className="playlist-drop-indicator" />
            )}
            <div
              data-track-idx={realIdx}
              className={`track-row track-row-va track-row-with-actions tracklist-playlist${currentTrack?.id === song.id ? ' active' : ''}${contextMenuSongId === song.id ? ' context-active' : ''}${selectedIds.has(song.id) ? ' bulk-selected' : ''}`}
              style={gridStyle}
              onMouseEnter={e => !isFiltered && handleRowMouseEnter(i, e)}
              onMouseDown={e => handleRowMouseDown(e, realIdx)}
              onClick={e => {
                if ((e.target as HTMLElement).closest('button, a, input')) return;
                if (e.ctrlKey || e.metaKey) {
                  toggleSelect(song.id, i, false);
                } else if (selectedIds.size > 0) {
                  toggleSelect(song.id, i, e.shiftKey);
                } else if (orbitActive) {
                  queueHint();
                } else {
                  playTrack(displayedTracks[i], displayedTracks);
                }
              }}
              onDoubleClick={orbitActive ? e => {
                if ((e.target as HTMLElement).closest('button, a, input')) return;
                if (e.ctrlKey || e.metaKey || selectedIds.size > 0) return;
                addTrackToOrbit(song.id);
              } : undefined}
              onContextMenu={e => {
                e.preventDefault();
                setContextMenuSongId(song.id);
                openContextMenu(e.clientX, e.clientY, songToTrack(song), 'album-song', undefined, id, realIdx);
              }}
            >
              {visibleCols.map(colDef => {
                const inSelectMode = selectedIds.size > 0;
                switch (colDef.key) {
                  case 'num': return (
                    <div key="num" className={`track-num${currentTrack?.id === song.id ? ' track-num-active' : ''}`}>
                      <span className={`bulk-check${selectedIds.has(song.id) ? ' checked' : ''}${inSelectMode ? ' bulk-check-visible' : ''}`} onClick={e => { e.stopPropagation(); toggleSelect(song.id, i, e.shiftKey); }} />
                      {currentTrack?.id === song.id && isPlaying ? (
                        <span className="track-num-eq"><AudioLines className="eq-bars" size={14} /></span>
                      ) : (
                        <span className="track-num-number">{i + 1}</span>
                      )}
                    </div>
                  );
                  case 'title': return (
                    <div key="title" className="track-info track-info-suggestion">
                      <button
                        type="button"
                        className="playlist-suggestion-play-btn"
                        onClick={e => { e.stopPropagation(); if (orbitActive) { queueHint(); return; } playTrack(displayedTracks[i], displayedTracks); }}
                        data-tooltip={t('common.play')}
                        aria-label={t('common.play')}
                      >
                        <Play size={10} fill="currentColor" strokeWidth={0} className="playlist-suggestion-play-icon" />
                      </button>
                      <button
                        type="button"
                        className={`playlist-suggestion-preview-btn${previewingId === song.id ? ' is-previewing' : ''}${previewingId === song.id && previewAudioStarted ? ' audio-started' : ''}`}
                        onClick={e => {
                          e.stopPropagation();
                          usePreviewStore.getState().startPreview({ id: song.id, title: song.title, artist: song.artist, coverArt: song.coverArt, duration: song.duration }, 'playlists');
                        }}
                        data-tooltip={previewingId === song.id ? t('playlists.previewStop') : t('playlists.preview')}
                        aria-label={previewingId === song.id ? t('playlists.previewStop') : t('playlists.preview')}
                      >
                        <svg className="playlist-suggestion-preview-ring" viewBox="0 0 24 24" aria-hidden="true">
                          <circle cx="12" cy="12" r="10.5" className="playlist-suggestion-preview-ring-track" />
                          <circle cx="12" cy="12" r="10.5" className="playlist-suggestion-preview-ring-progress" />
                        </svg>
                        {previewingId === song.id
                          ? <Square size={9} fill="currentColor" strokeWidth={0} className="playlist-suggestion-preview-icon" />
                          : <ChevronRight size={14} className="playlist-suggestion-preview-icon playlist-suggestion-preview-icon-play" />}
                      </button>
                      <span className="track-title">{song.title}</span>
                    </div>
                  );
                  case 'artist': return (
                    <div key="artist" className="track-artist-cell">
                      <span className={`track-artist${song.artistId ? ' track-artist-link' : ''}`} style={{ cursor: song.artistId ? 'pointer' : 'default' }} onClick={e => { if (song.artistId) { e.stopPropagation(); navigate(`/artist/${song.artistId}`); } }}>{song.artist}</span>
                    </div>
                  );
                  case 'album': return (
                    <div key="album" className="track-artist-cell">
                      <span className={`track-artist${song.albumId ? ' track-artist-link' : ''}`} style={{ cursor: song.albumId ? 'pointer' : 'default' }} onClick={e => { if (song.albumId) { e.stopPropagation(); navigate(`/album/${song.albumId}`); } }}>{song.album}</span>
                    </div>
                  );
                  case 'favorite': return (
                    <div key="favorite" className="track-star-cell">
                      <button className="btn btn-ghost track-star-btn" onClick={e => handleToggleStar(song, e)} style={{ color: (song.id in starredOverrides ? starredOverrides[song.id] : starredSongs.has(song.id)) ? 'var(--color-star-active, var(--accent))' : 'var(--color-star-inactive, var(--text-muted))' }}>
                        <Heart size={14} fill={(song.id in starredOverrides ? starredOverrides[song.id] : starredSongs.has(song.id)) ? 'currentColor' : 'none'} />
                      </button>
                    </div>
                  );
                  case 'rating': return <StarRating key="rating" value={ratings[song.id] ?? userRatingOverrides[song.id] ?? song.userRating ?? 0} onChange={r => handleRate(song.id, r)} />;
                  case 'duration': return <div key="duration" className="track-duration">{formatDuration(song.duration ?? 0)}</div>;
                  case 'format': return (
                    <div key="format" className="track-meta">
                      {(song.suffix || (showBitrate && song.bitRate)) && <span className="track-codec">{codecLabel(song, showBitrate)}</span>}
                    </div>
                  );
                  case 'delete': return (
                    <div key="delete" className="playlist-row-delete-cell">
                      <button className="playlist-row-delete-btn" onClick={e => { e.stopPropagation(); removeSong(realIdx); }} data-tooltip={t('playlists.removeSong')} data-tooltip-pos="left">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  );
                  default: return null;
                }
              })}
            </div>
            {!isFiltered && isDragging && dropTargetIdx?.idx === i && !dropTargetIdx.before && (
              <div className="playlist-drop-indicator" />
            )}
          </React.Fragment>
          );
        })}


      </div>

      {/* ── Suggestions ── */}
      <PlaylistSuggestions
        songs={songs}
        suggestions={suggestions}
        existingIds={existingIds}
        loadingSuggestions={loadingSuggestions}
        loadSuggestions={loadSuggestions}
        visibleCols={visibleCols}
        gridStyle={gridStyle}
        contextMenuSongId={contextMenuSongId}
        setContextMenuSongId={setContextMenuSongId}
        hoveredSuggestionId={hoveredSuggestionId}
        setHoveredSuggestionId={setHoveredSuggestionId}
        addSong={addSong}
        startPreview={startPreview}
      />

      {editingMeta && playlist && (
        <PlaylistEditModal
          playlist={playlist}
          customCoverId={customCoverId}
          customCoverFetchUrl={customCoverFetchUrl ?? null}
          customCoverCacheKey={customCoverCacheKey ?? null}
          coverQuadUrls={coverQuadUrls}
          onClose={() => setEditingMeta(false)}
          onSave={handleSaveMeta}
        />
      )}

      {csvImportReport && (
        <CsvImportReportModal
          report={csvImportReport}
          playlistName={playlist?.name || 'Unknown Playlist'}
          onClose={() => setCsvImportReport(null)}
        />
      )}
    </div>
  );
}

