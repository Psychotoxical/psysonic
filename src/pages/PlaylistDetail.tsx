import { getPlaylist, updatePlaylist, updatePlaylistMeta, uploadPlaylistCoverArt } from '../api/subsonicPlaylists';
import { coverArtCacheKey, buildCoverArtUrl } from '../api/subsonicStreamUrl';
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
import { useZipDownloadStore } from '../store/zipDownloadStore';
import { useDragDrop } from '../contexts/DragDropContext';
import CachedImage, { useCachedUrl } from '../components/CachedImage';
import { useTranslation } from 'react-i18next';
import { showToast } from '../utils/toast';
import StarRating from '../components/StarRating';
import {
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
import PlaylistHero from '../components/playlist/PlaylistHero';
import PlaylistTracklist from '../components/playlist/PlaylistTracklist';
import PlaylistFilterToolbar from '../components/playlist/PlaylistFilterToolbar';
import { getDisplayedSongs, type PlaylistSortKey, type PlaylistSortDir } from '../utils/playlistDisplayedSongs';
import { runPlaylistZipDownload } from '../utils/runPlaylistZipDownload';
import { playPlaylistAll, shufflePlaylistAll, enqueuePlaylistAll } from '../utils/playlistBulkPlayActions';
import { startPlaylistRowDrag } from '../utils/startPlaylistRowDrag';
import { runPlaylistReorderDrop } from '../utils/runPlaylistReorderDrop';

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
  const [sortKey, setSortKey] = useState<PlaylistSortKey>('natural');
  const [sortDir, setSortDir] = useState<PlaylistSortDir>('asc');
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
    await runPlaylistZipDownload({
      playlist, id, downloadFolder, requestDownloadFolder, setZipDownloadId,
    });
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
      runPlaylistReorderDrop({ e, songs, savePlaylist, setDropTargetIdx, setSongs });
    };

    container.addEventListener('psy-drop', onPsyDrop);
    return () => container.removeEventListener('psy-drop', onPsyDrop);
  }, [songs, savePlaylist, tracklistRef]);

  // ── Row mousedown: threshold drag for reorder (from anywhere on the row) ──
  const handleRowMouseDown = (e: React.MouseEvent, idx: number) => {
    startPlaylistRowDrag({ e, idx, songs, selectedIds, isFiltered, startDrag });
  };

  // ── Memoized derivations ──────────────────────────────────────
  const existingIds = useMemo(() => new Set(songs.map(s => s.id)), [songs]);
  const tracks = useMemo(() => songs.map(songToTrack), [songs]);

  const displayedSongs = useMemo(
    () => getDisplayedSongs(songs, {
      filterText, sortKey, sortDir,
      ratings, userRatingOverrides, starredOverrides, starredSongs,
    }),
    [songs, filterText, sortKey, sortDir, ratings, userRatingOverrides, starredOverrides, starredSongs],
  );
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
  const handlePlayAll = useCallback(
    () => playPlaylistAll({ songsLength: songs.length, id, tracks, touchPlaylist, playTrack, enqueue }),
    [songs.length, id, tracks, touchPlaylist, playTrack, enqueue],
  );

  const handleShuffleAll = useCallback(
    () => shufflePlaylistAll({ songsLength: songs.length, id, tracks, touchPlaylist, playTrack, enqueue }),
    [songs.length, id, tracks, touchPlaylist, playTrack, enqueue],
  );

  const handleEnqueueAll = useCallback(
    () => enqueuePlaylistAll({ songsLength: songs.length, id, tracks, touchPlaylist, playTrack, enqueue }),
    [songs.length, id, tracks, touchPlaylist, playTrack, enqueue],
  );

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
      <PlaylistHero
        playlist={playlist}
        songs={songs}
        id={id}
        customCoverId={customCoverId}
        customCoverFetchUrl={customCoverFetchUrl}
        customCoverCacheKey={customCoverCacheKey}
        coverQuadUrls={coverQuadUrls}
        resolvedBgUrl={resolvedBgUrl}
        saving={saving}
        searchOpen={searchOpen}
        csvImporting={csvImporting}
        activeZip={activeZip}
        isCached={isCached}
        isDownloading={isDownloading}
        offlineProgress={offlineProgress}
        activeServerId={activeServerId}
        setEditingMeta={setEditingMeta}
        setSearchOpen={setSearchOpen}
        setSearchQuery={setSearchQuery}
        setSearchResults={setSearchResults}
        setSelectedSearchIds={setSelectedSearchIds}
        setSearchPlPickerOpen={setSearchPlPickerOpen}
        handlePlayAll={handlePlayAll}
        handleShuffleAll={handleShuffleAll}
        handleEnqueueAll={handleEnqueueAll}
        handleImportCsv={handleImportCsv}
        handleDownload={handleDownload}
        deleteAlbum={deleteAlbum}
        downloadPlaylist={downloadPlaylist}
      />

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
        <PlaylistFilterToolbar filterText={filterText} setFilterText={setFilterText} />
      )}

      {/* ── Tracklist ── */}
      <PlaylistTracklist
        allColumns={PL_COLUMNS}
        visibleCols={visibleCols}
        gridStyle={gridStyle}
        colVisible={colVisible}
        toggleColumn={toggleColumn}
        resetColumns={resetColumns}
        pickerOpen={pickerOpen}
        setPickerOpen={setPickerOpen}
        pickerRef={pickerRef}
        startResize={startResize}
        tracklistRef={tracklistRef}
        songs={songs}
        displayedSongs={displayedSongs}
        displayedTracks={displayedTracks}
        isFiltered={isFiltered}
        id={id}
        sortKey={sortKey}
        setSortKey={setSortKey}
        sortDir={sortDir}
        setSortDir={setSortDir}
        sortClickCount={sortClickCount}
        setSortClickCount={setSortClickCount}
        selectedIds={selectedIds}
        setSelectedIds={setSelectedIds}
        allSelected={allSelected}
        toggleAll={toggleAll}
        toggleSelect={toggleSelect}
        showBulkPlPicker={showBulkPlPicker}
        setShowBulkPlPicker={setShowBulkPlPicker}
        bulkRemove={bulkRemove}
        contextMenuSongId={contextMenuSongId}
        setContextMenuSongId={setContextMenuSongId}
        dropTargetIdx={dropTargetIdx}
        ratings={ratings}
        starredSongs={starredSongs}
        handleRate={handleRate}
        handleToggleStar={handleToggleStar}
        handleRowMouseDown={handleRowMouseDown}
        handleRowMouseEnter={handleRowMouseEnter}
        removeSong={removeSong}
        setSearchOpen={setSearchOpen}
      />

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

