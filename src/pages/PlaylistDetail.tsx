import { getPlaylist, updatePlaylist, updatePlaylistMeta, uploadPlaylistCoverArt } from '../api/subsonicPlaylists';
import { buildDownloadUrl, coverArtCacheKey, buildCoverArtUrl } from '../api/subsonicStreamUrl';
import { setRating, star, unstar } from '../api/subsonicStarRating';
import { search } from '../api/subsonicSearch';
import { getRandomSongs, filterSongsToActiveLibrary } from '../api/subsonicLibrary';
import type { SubsonicPlaylist, SubsonicSong } from '../api/subsonicTypes';
import { songToTrack } from '../utils/songToTrack';
import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
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
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { useZipDownloadStore } from '../store/zipDownloadStore';
import { useDragDrop } from '../contexts/DragDropContext';
import CachedImage, { useCachedUrl } from '../components/CachedImage';
import { useTranslation } from 'react-i18next';
import { showToast } from '../utils/toast';
import { formatHumanHoursMinutes } from '../utils/formatHumanDuration';
import StarRating from '../components/StarRating';
import Papa from 'papaparse';

function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .substring(0, 200) || 'download';
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function totalDurationLabel(songs: SubsonicSong[]): string {
  const total = songs.reduce((acc, s) => acc + (s.duration ?? 0), 0);
  return formatHumanHoursMinutes(total);
}

const SMART_PREFIX = 'psy-smart-';

function isSmartPlaylistName(name: string): boolean {
  return (name ?? '').toLowerCase().startsWith(SMART_PREFIX);
}

function displayPlaylistName(name: string): string {
  const n = name ?? '';
  if (isSmartPlaylistName(n)) return n.slice(SMART_PREFIX.length);
  return n;
}

function codecLabel(song: SubsonicSong, showBitrate: boolean): string {
  const parts: string[] = [];
  if (song.suffix) parts.push(song.suffix.toUpperCase());
  if (showBitrate && song.bitRate) parts.push(`${song.bitRate} kbps`);
  return parts.join(' · ');
}

// ── CSV Import helpers ──────────────────────────────────────────────────────
interface SpotifyCsvTrack {
  trackName: string;
  artistName: string;
  artistNames: string[];  // Array of all artists for better matching
  albumName: string;
  isrc?: string;
  score?: number;           // Match score when track not found
  thresholdNeeded?: number; // Threshold required to pass
}

// Header mapping to canonical fields (supports English and Spanish)
const HEADER_MAPPINGS: Record<string, string> = {
  // Track name
  'track name': 'trackName',
  'track name(s)': 'trackName',
  'track': 'trackName',
  'name': 'trackName',
  'nombre de la cancion': 'trackName',
  'nombre de cancion': 'trackName',
  'nombre de la canci\u00f3n': 'trackName',
  'nombre cancion': 'trackName',
  't\u00edtulo': 'trackName',
  'titulo': 'trackName',
  // Artist name
  'artist name': 'artistName',
  'artist name(s)': 'artistName',
  'artists name': 'artistName',
  'artists name(s)': 'artistName',
  'artist': 'artistName',
  'artists': 'artistName',
  'nombre del artista': 'artistName',
  'nombres del artista': 'artistName',
  'nombre artista': 'artistName',
  'artista': 'artistName',
  // Album name
  'album name': 'albumName',
  'album name(s)': 'albumName',
  'album': 'albumName',
  'nombre del album': 'albumName',
  'nombre del \u00e1lbum': 'albumName',
  'nombre album': 'albumName',
  // ISRC
  'isrc': 'isrc',
  'isrc code': 'isrc',
  'codigo isrc': 'isrc',
  'c\u00f3digo isrc': 'isrc',
};

function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/\(s\)/g, '')
    .replace(/[()]/g, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function findColumnField(header: string): string | undefined {
  const normalized = normalizeHeader(header);
  return HEADER_MAPPINGS[normalized];
}

function parseArtists(artistField: string): string[] {
  // Spotify uses commas in extended format, semicolons in simple format
  const separator = artistField.includes(';') ? ';' : ',';
  return artistField
    .split(separator)
    .map(a => a.trim())
    .filter(a => a.length > 0);
}

function extractFeaturedArtists(title: string): string[] {
  const patterns = [
    /\(feat\.?\s+([^)]+)\)/i,
    /\(ft\.?\s+([^)]+)\)/i,
    /\(featuring\s+([^)]+)\)/i,
    /\(with\s+([^)]+)\)/i,
  ];
  for (const regex of patterns) {
    const match = title.match(regex);
    if (match) {
      return match[1].split(/,|\sand\s|\s&\s/).map(s => s.trim()).filter(Boolean);
    }
  }
  return [];
}

function parseSpotifyCsv(csvContent: string): SpotifyCsvTrack[] {
  // Strip BOM and parse with Papa Parse
  const cleanContent = csvContent.replace(/^\uFEFF/, '');

  const parseResult = Papa.parse(cleanContent, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header: string) => {
      const field = findColumnField(header);
      return field || header;
    },
  });

  if (parseResult.errors.length > 0) {
    console.warn('CSV parse warnings:', parseResult.errors);
  }

  const data = parseResult.data as Record<string, string>[];

  // Verify required columns
  if (!data.length || !data[0].trackName || !data[0].artistName) {
    console.error('CSV columns not found. Available headers:', Object.keys(data[0] || {}));
    return [];
  }

  console.log('CSV parsed with Papa Parse:', {
    rows: data.length,
    sample: data[0],
  });

  const tracks: SpotifyCsvTrack[] = [];
  for (const row of data) {
    const trackName = row.trackName?.trim();
    const artistField = row.artistName?.trim() || '';

    if (!trackName || !artistField) continue;

    // Parse multiple artists from field + extract collaborators from title
    const artistNames = parseArtists(artistField);
    const featuredArtists = extractFeaturedArtists(trackName);
    const allArtists = [...new Set([...artistNames, ...featuredArtists])];
    const primaryArtist = allArtists[0] || '';

    tracks.push({
      trackName,
      artistName: primaryArtist,
      artistNames: allArtists,
      albumName: row.albumName?.trim() || '',
      isrc: row.isrc?.trim() || undefined,
    });
  }

  return tracks;
}

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

function PlaylistSearchResultThumb({ coverArt }: { coverArt: string }) {
  const src = useMemo(() => buildCoverArtUrl(coverArt, 40), [coverArt]);
  const cacheKey = useMemo(() => coverArtCacheKey(coverArt, 40), [coverArt]);
  return <CachedImage src={src} cacheKey={cacheKey} alt="" className="playlist-search-thumb" />;
}

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

  // ── CSV Import ──────────────────────────────────────────────
  // Normalize strings for matching: remove accents, special chars, lowercase, trim
  const normalizeForMatching = (s: string): string =>
    s.toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[ø]/gi, 'o')
      .replace(/[æ]/gi, 'ae')
      .trim();

  // Clean common title suffixes (remastered, live, editions, etc.)
  const cleanTrackTitle = (title: string): string => {
    const suffixes = [
      // Remastered variants
      /\s*-\s*remasterizado$/i,
      /\s*-\s*remaster$/i,
      /\s*-\s*remastered$/i,
      /\s*\(remasterizado\)$/i,
      /\s*\(remaster\)$/i,
      /\s*\(remastered\)$/i,
      /\s*\[remasterizado\]$/i,
      /\s*\[remaster\]$/i,
      /\s*\[remastered\]$/i,
      /\s*-\s*remasterizado\s+\d{4}$/i,
      /\s*-\s*remastered\s+\d{4}$/i,
      /\s*\(\d{4}\s+remaster\)$/i,
      /\s*\(\d{4}\s+remastered\)$/i,
      // Live variants
      /\s*-\s*en vivo$/i,
      /\s*-\s*live$/i,
      /\s*-\s*version en vivo$/i,
      /\s*-\s*studio version$/i,
      /\s*-\s*version de estudio$/i,
      /\s*\(en vivo\)$/i,
      /\s*\(live\)$/i,
      /\s*\(live .*\)$/i,
      /\s*\[en vivo\]$/i,
      /\s*\[live\]$/i,
      /\s*\[live .*\]$/i,
      /\s*-\s*live at.*$/i,
      /\s*\(live at.*\)$/i,
      // Version/Edition variants
      /\s*-\s*version$/i,
      /\s*-\s*versión$/i,
      /\s*\(version\)$/i,
      /\s*\(versión\)$/i,
      /\s*\[version\]$/i,
      /\s*\[versión\]$/i,
      /\s*-\s*album version$/i,
      /\s*\(album version\)$/i,
      /\s*\[album version\]$/i,
      // Radio/Edit variants
      /\s*-\s*radio edit$/i,
      /\s*-\s*radio version$/i,
      /\s*\(radio edit\)$/i,
      /\s*\(radio version\)$/i,
      /\s*\[radio edit\]$/i,
      /\s*\[radio version\]$/i,
      /\s*-\s*edit$/i,
      /\s*\(edit\)$/i,
      /\s*\[edit\]$/i,
      // Acoustic/Instrumental variants
      /\s*-\s*acoustic$/i,
      /\s*-\s*acústico$/i,
      /\s*\(acoustic\)$/i,
      /\s*\(acústico\)$/i,
      /\s*\[acoustic\]$/i,
      /\s*\[acústico\]$/i,
      /\s*-\s*instrumental$/i,
      /\s*\(instrumental\)$/i,
      /\s*\[instrumental\]$/i,
      // Featuring/Feat/Ft/With variants
      /\s*\(feat\.?\s+.*\)$/i,
      /\s*\[feat\.?\s+.*\]$/i,
      /\s*-\s*feat\.?\s+.*$/i,
      /\s*\(featuring\s+.*\)$/i,
      /\s*\[featuring\s+.*\]$/i,
      /\s*\(ft\.?\s+.*\)$/i,
      /\s*\[ft\.?\s+.*\]$/i,
      /\s*-\s*ft\.?\s+.*$/i,
      /\s*\(with\s+.*\)$/i,
      /\s*\[with\s+.*\]$/i,
      /\s*-\s*with\s+.*$/i,
      /\s*ft\.?\s+.*$/i,
      // Explicit/Clean tags
      /\s*\(explicit\)$/i,
      /\s*\[explicit\]$/i,
      /\s*\(clean\)$/i,
      /\s*\[clean\]$/i,
      // Mono/Stereo
      /\s*\(mono\)$/i,
      /\s*\[mono\]$/i,
      /\s*\(stereo\)$/i,
      /\s*\[stereo\]$/i,
      // Deluxe/Special editions
      /\s*-\s*deluxe$/i,
      /\s*\(deluxe\)$/i,
      /\s*\[deluxe\]$/i,
      /\s*-\s*special edition$/i,
      /\s*\(special edition\)$/i,
      /\s*\[special edition\]$/i,
      // Year in parentheses (common in remasters)
      /\s*\(\d{4}\)$/i,
    ];
    let cleaned = title.trim();
    // Apply patterns multiple times for nested cases
    for (let i = 0; i < 3; i++) {
      const previous = cleaned;
      for (const regex of suffixes) {
        cleaned = cleaned.replace(regex, '');
      }
      cleaned = cleaned.trim();
      if (previous === cleaned) break; // No more changes
    }
    return cleaned;
  };

  // Levenshtein distance for similarity scoring
  const levenshtein = (a: string, b: string): number => {
    const matrix: number[][] = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        matrix[i][j] = b[i - 1] === a[j - 1]
          ? matrix[i - 1][j - 1]
          : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
      }
    }
    return matrix[b.length][a.length];
  };

  const similarityScore = (a: string, b: string): number => {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    // Use normalized strings (without accents) for comparison
    const dist = levenshtein(normalizeForMatching(a), normalizeForMatching(b));
    return 1 - dist / maxLen;
  };

  // Calculate dynamic threshold based on match quality signals
  const calculateDynamicThreshold = (
    bestMatch: { score: number; artistScore: number },
    secondMatch: { score: number } | undefined,
    titleWords: number
  ): number => {
    const baseThreshold = 0.6; // Minimum acceptable score

    // Bonus if there's a large gap between best and second match (clear winner)
    const gap = secondMatch ? bestMatch.score - secondMatch.score : 0.3;
    const gapBonus = gap > 0.15 ? 0.1 : gap > 0.08 ? 0.05 : 0;

    // Short titles (< 3 words) are more ambiguous, need higher threshold
    // Long titles (> 4 words) are more specific, can use lower threshold
    const lengthBonus = titleWords > 4 ? 0.05 : titleWords < 3 ? -0.05 : 0;

    // Strong artist match gives confidence to accept lower overall score
    const artistBonus = bestMatch.artistScore > 0.85 ? 0.08 : bestMatch.artistScore > 0.7 ? 0.04 : 0;

    // Calculate final threshold, clamp between 0.55 and 0.75
    return Math.max(0.55, Math.min(0.75, baseThreshold - gapBonus - lengthBonus - artistBonus));
  };

  // Process searches in batches to avoid overloading the server
  const processBatch = async <T, R>(
    items: T[],
    batchSize: number,
    processor: (item: T) => Promise<R | null>
  ): Promise<(R | null)[]> => {
    const results: (R | null)[] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(processor));
      results.push(...batchResults);
    }
    return results;
  };

  const handleImportCsv = async () => {
    if (!id || csvImporting) return;

    try {
      const selected = await openDialog({
        filters: [{ name: 'CSV Files', extensions: ['csv'] }],
        multiple: false,
        title: 'Import Spotify Playlist CSV',
      });

      if (!selected || typeof selected !== 'string') return;

      setCsvImporting(true);
      const content = await readTextFile(selected);
      const csvTracks = parseSpotifyCsv(content);

      if (csvTracks.length === 0) {
        showToast(t('playlists.csvImportNoValidTracks'), 3000, 'error');
        setCsvImporting(false);
        return;
      }

      const existingIds = new Set(songs.map(s => s.id));
      const addedSongs: SubsonicSong[] = [];
      const notFound: SpotifyCsvTrack[] = [];
      const searchErrors: SpotifyCsvTrack[] = [];
      const duplicateTracks: SpotifyCsvTrack[] = [];
      let duplicateCount = 0;

      // Process in batches of 10 to balance speed/server load
      await processBatch(csvTracks, 10, async (track) => {
        try {
          // Retry: 2 attempts in case of network error
          let searchResult;
          let attempts = 0;
          const maxAttempts = 2;

          // Clean title before search to find matches despite version suffixes
          const cleanTitleForSearch = cleanTrackTitle(track.trackName);

          while (attempts < maxAttempts) {
            try {
              searchResult = await search(cleanTitleForSearch, { songCount: 40, artistCount: 0, albumCount: 0 });
              break;
            } catch (err) {
              attempts++;
              if (attempts >= maxAttempts) throw err;
              // Wait 500ms before retrying
              await new Promise(r => setTimeout(r, 500));
            }
          }

          if (!searchResult || searchResult.songs.length === 0) {
            notFound.push({
              ...track,
              score: 0,
              thresholdNeeded: 0.6, // Minimum threshold, nothing to compare
            });
            return null;
          }

          // Confidence scoring for each result
          // Clean CSV title for fair comparison
          const cleanCsvTitle = cleanTrackTitle(track.trackName);

          const scoredMatches = searchResult.songs.map(s => {
            // Fast ISRC path: if both have ISRC and they match, perfect score
            if (track.isrc && s.isrc && typeof s.isrc === 'string' && track.isrc.toUpperCase() === s.isrc.toUpperCase()) {
              return { song: s, score: 1.0, titleScore: 1.0, artistScore: 1.0, isrcMatch: true };
            }

            // Clean the result title as well
            const cleanResultTitle = cleanTrackTitle(s.title);

            const titleScore = similarityScore(cleanResultTitle, cleanCsvTitle);
            // Artist scoring: maximum score against any of the CSV artists
            const artistScore = s.artist
              ? Math.max(...track.artistNames.map(csvArtist =>
                  similarityScore(s.artist || '', csvArtist)
                ))
              : 0;
            // If no album in CSV or local, use 1.0 (neutral) to avoid penalizing
            const albumScore = (s.album && track.albumName)
              ? similarityScore(s.album, track.albumName)
              : 1.0;

            // Dynamic weight: specific titles (>4 words) → more weight to title
            const titleWords = cleanCsvTitle.split(/\s+/).length;
            const isSpecificTitle = titleWords > 4;
            const titleWeight = isSpecificTitle ? 0.55 : 0.4;
            const artistWeight = isSpecificTitle ? 0.25 : 0.4;

            const totalScore = artistScore * artistWeight + titleScore * titleWeight + albumScore * 0.2;

            return { song: s, score: totalScore, titleScore, artistScore, albumScore, isrcMatch: false };
          }).sort((a, b) => b.score - a.score);

          // Use dynamic threshold based on match quality signals
          const bestMatch = scoredMatches[0];
          const secondMatch = scoredMatches[1];
          const titleWords = cleanCsvTitle.split(/\s+/).length;

          const threshold = calculateDynamicThreshold(bestMatch, secondMatch, titleWords);

          if (bestMatch.score < threshold) {
            notFound.push({
              ...track,
              score: bestMatch.score,
              thresholdNeeded: threshold,
            });
            return null;
          }

          // Check for duplicates
          if (existingIds.has(bestMatch.song.id)) {
            duplicateCount++;
            duplicateTracks.push(track);
            return null;
          }

          // Check for duplicates in tracks already queued for addition
          if (addedSongs.some(s => s.id === bestMatch.song.id)) {
            duplicateCount++;
            duplicateTracks.push(track);
            return null;
          }

          addedSongs.push(bestMatch.song);
          existingIds.add(bestMatch.song.id);
          return bestMatch.song;
        } catch {
          searchErrors.push(track);
          return null;
        }
      });

      if (addedSongs.length > 0) {
        const next = [...songs, ...addedSongs];
        setSongs(next);
        await savePlaylist(next);
      }

      // Auto-show report if there are not found tracks, duplicates, or search errors
      if (notFound.length > 0 || duplicateCount > 0 || searchErrors.length > 0) {
        // Small delay to let the toast appear first
        setTimeout(() => {
          setCsvImportReport({
            added: addedSongs.length,
            notFound,
            duplicates: duplicateCount,
            duplicateTracks,
            total: csvTracks.length,
            searchErrors,
          });
        }, 500);
      }

      const errorMsg = searchErrors.length > 0
        ? ` (${searchErrors.length} network errors - may retry)`
        : '';

      // Determine toast type based on results:
      // - success: all songs were added successfully
      // - warning: at least one added, but some not found/duplicates
      // - error: none added (all duplicates or not found)
      const hasAdded = addedSongs.length > 0;
      const hasIssues = notFound.length > 0 || duplicateCount > 0 || searchErrors.length > 0;

      let toastVariant: 'success' | 'warning' | 'error';
      if (hasAdded && !hasIssues) {
        toastVariant = 'success';
      } else if (hasAdded && hasIssues) {
        toastVariant = 'warning';
      } else {
        toastVariant = 'error';
      }

      showToast(
        t('playlists.csvImportToast', { added: addedSongs.length, notFound: notFound.length, duplicates: duplicateCount }) + errorMsg,
        5000,
        toastVariant
      );
    } catch (err) {
      console.error('CSV import failed:', err);
      showToast(t('playlists.csvImportFailed'), 3000, 'error');
    } finally {
      setCsvImporting(false);
    }
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
        <div className="playlist-search-panel">
          <div className="playlist-search-input-wrap">
            <input
              className="input"
              placeholder={t('playlists.searchPlaceholder')}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              autoFocus
            />
            {searchQuery && (
              <button className="live-search-clear" onClick={() => { setSearchQuery(''); setSearchResults([]); }}>
                <X size={14} />
              </button>
            )}
          </div>
          {searching && <div style={{ textAlign: 'center', padding: '0.75rem' }}><div className="spinner" /></div>}
          {!searching && searchQuery && searchResults.length === 0 && (
            <div className="empty-state" style={{ padding: '0.5rem 0' }}>{t('playlists.noResults')}</div>
          )}
          {selectedSearchIds.size > 0 && (
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0.75rem', background: 'color-mix(in srgb, var(--accent) 10%, transparent)', borderRadius: 'var(--radius-sm)', margin: '0.25rem 0' }}>
              <span style={{ fontSize: 13, color: 'var(--accent)', fontWeight: 600, flex: 1 }}>
                {t('common.bulkSelected', { count: selectedSearchIds.size })}
              </span>
              <button
                className="btn btn-sm btn-ghost"
                style={{ fontSize: 12 }}
                onClick={() => setSelectedSearchIds(new Set())}
              >
                {t('common.clearSelection')}
              </button>
              <div style={{ position: 'relative' }}>
                <button
                  className="btn btn-sm btn-primary"
                  style={{ fontSize: 12 }}
                  onClick={() => setSearchPlPickerOpen(v => !v)}
                >
                  <ListPlus size={13} /> {t('contextMenu.addToPlaylist')}
                </button>
                {searchPlPickerOpen && (
                  <AddToPlaylistSubmenu
                    songIds={[...selectedSearchIds]}
                    dropDown
                    onDone={() => { setSearchPlPickerOpen(false); setSelectedSearchIds(new Set()); }}
                  />
                )}
              </div>
              <button
                className="btn btn-sm btn-primary"
                style={{ fontSize: 12 }}
                onClick={() => {
                  searchResults
                    .filter(s => selectedSearchIds.has(s.id))
                    .forEach(s => addSong(s));
                  setSelectedSearchIds(new Set());
                }}
              >
                <Check size={13} /> {t('playlists.addSelected')}
              </button>
            </div>
          )}
          {searchResults.map(song => {
            const isSelected = selectedSearchIds.has(song.id);
              return (
                <div
                  key={song.id}
                  className={`playlist-search-row${isSelected ? ' playlist-search-row--selected' : ''}${contextMenuSongId === song.id ? ' context-active' : ''}`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => addSong(song)}
                  onContextMenu={e => {
                    e.preventDefault();
                    setContextMenuSongId(song.id);
                    openContextMenu(e.clientX, e.clientY, songToTrack(song), 'album-song');
                  }}
                >
                <input
                  type="checkbox"
                  className="playlist-search-checkbox"
                  checked={isSelected}
                  onClick={e => e.stopPropagation()}
                  onChange={() => setSelectedSearchIds(prev => {
                    const next = new Set(prev);
                    next.has(song.id) ? next.delete(song.id) : next.add(song.id);
                    return next;
                  })}
                />
                <PlaylistSearchResultThumb coverArt={song.coverArt ?? ''} />
                <div className="playlist-search-info">
                  <span className="playlist-search-title">{song.title}</span>
                  <span className="playlist-search-artist">{song.artist} · <span className="playlist-search-album">{song.album}</span></span>
                </div>
                <span className="playlist-search-duration">{formatDuration(song.duration ?? 0)}</span>
              </div>
            );
          })}
        </div>
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
      <div className="playlist-suggestions tracklist" data-preview-loc="suggestions">
        <div className="playlist-suggestions-header">
          <div className="playlist-suggestions-title">
            <h2 className="section-title" style={{ marginBottom: 0 }}>{t('playlists.suggestions')}</h2>
            <span className="playlist-suggestions-hint">{t('playlists.suggestionsHint')}</span>
          </div>
          <button
            className="btn btn-surface"
            onClick={() => loadSuggestions(songs)}
            disabled={loadingSuggestions || songs.length === 0}
            data-tooltip={t('playlists.refreshSuggestions')}
          >
            <RefreshCw size={14} className={loadingSuggestions ? 'spin-slow' : ''} />
            {t('playlists.refreshSuggestions')}
          </button>
        </div>

        {!loadingSuggestions && suggestions.filter(s => !existingIds.has(s.id)).length === 0 && (
          <div className="empty-state" style={{ padding: '1.5rem 0', fontSize: '0.85rem' }}>{t('playlists.noSuggestions')}</div>
        )}

        {suggestions.filter(s => !existingIds.has(s.id)).length > 0 && (
          <>
            <div className="tracklist-header tracklist-va" style={{ ...gridStyle, marginTop: 'var(--space-3)' }}>
              {visibleCols.map((colDef, colIndex) => {
                const key = colDef.key;
                const isCentered = PL_CENTERED.has(key);
                const label = colDef.i18nKey ? t(`albumDetail.${colDef.i18nKey}`) : '';
                if (key === 'num') return <div key="num" className="col-center">#</div>;
                if (key === 'title') return <div key="title" style={{ paddingLeft: 12 }}>{label}</div>;
                if (key === 'delete') return <div key="delete" />;
                if (key === 'favorite' || key === 'rating') return <div key={key} />;
                return <div key={key} className={isCentered ? 'col-center' : ''} style={!isCentered ? { paddingLeft: 12 } : undefined}>{label}</div>;
              })}
            </div>

            {suggestions.filter(s => !existingIds.has(s.id)).map((song, idx) => (
              <div
                key={song.id}
                className={`track-row track-row-va tracklist-playlist${contextMenuSongId === song.id ? ' context-active' : ''}`}
                style={gridStyle}
                onMouseEnter={() => setHoveredSuggestionId(song.id)}
                onMouseLeave={() => setHoveredSuggestionId(null)}
                onDoubleClick={e => {
                  if ((e.target as HTMLElement).closest('button, a, input')) return;
                  addSong(song);
                }}
                onContextMenu={e => {
                  e.preventDefault();
                  setContextMenuSongId(song.id);
                  openContextMenu(e.clientX, e.clientY, songToTrack(song), 'album-song');
                }}
              >
                {visibleCols.map(colDef => {
                  switch (colDef.key) {
                    case 'num': return <div key="num" className="track-num" style={{ color: 'var(--text-muted)' }}>{idx + 1}</div>;
                    case 'title': return (
                      <div key="title" className="track-info track-info-suggestion">
                        <button
                          className="playlist-suggestion-play-btn"
                          onClick={e => {
                            e.stopPropagation();
                            const { queue, queueIndex, currentTrack, playTrack } = usePlayerStore.getState();
                            const track = songToTrack(song);
                            if (!currentTrack || queue.length === 0) {
                              playTrack(track, [track]);
                              return;
                            }
                            const insertAt = Math.min(queueIndex + 1, queue.length);
                            const newQueue = [
                              ...queue.slice(0, insertAt),
                              track,
                              ...queue.slice(insertAt),
                            ];
                            playTrack(track, newQueue);
                          }}
                          data-tooltip={t('playlists.playNextSuggestion')}
                          aria-label={t('playlists.playNextSuggestion')}
                        >
                          <Play size={10} fill="currentColor" strokeWidth={0} className="playlist-suggestion-play-icon" />
                        </button>
                        <button
                          className={`playlist-suggestion-preview-btn${previewingId === song.id ? ' is-previewing' : ''}${previewingId === song.id && previewAudioStarted ? ' audio-started' : ''}`}
                          onClick={e => { e.stopPropagation(); startPreview(song); }}
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
                    case 'favorite': return <div key="favorite" />;
                    case 'rating': return <div key="rating" />;
                    case 'duration': return <div key="duration" className="track-duration">{formatDuration(song.duration ?? 0)}</div>;
                    case 'format': return (
                      <div key="format" className="track-meta">
                        {(song.suffix || (showBitrate && song.bitRate)) && <span className="track-codec">{codecLabel(song, showBitrate)}</span>}
                      </div>
                    );
                    case 'delete': return (
                      <div key="delete" className="playlist-row-delete-cell">
                        <button className="playlist-row-delete-btn" style={{ color: hoveredSuggestionId === song.id ? 'var(--accent)' : undefined }} onClick={e => { e.stopPropagation(); addSong(song); }} data-tooltip={t('playlists.addSong')} data-tooltip-pos="left">
                          <Plus size={13} />
                        </button>
                      </div>
                    );
                    default: return null;
                  }
                })}
              </div>
            ))}
          </>
        )}
      </div>

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

// ── Playlist Edit Modal ───────────────────────────────────────────────────────

interface EditModalProps {
  playlist: SubsonicPlaylist;
  customCoverId: string | null;
  customCoverFetchUrl: string | null;
  customCoverCacheKey: string | null;
  coverQuadUrls: ({ src: string; cacheKey: string } | null)[];
  onClose: () => void;
  onSave: (opts: { name: string; comment: string; isPublic: boolean; coverFile: File | null; coverRemoved: boolean }) => Promise<void>;
}

function PlaylistEditModal({
  playlist, customCoverId, customCoverFetchUrl, customCoverCacheKey,
  coverQuadUrls, onClose, onSave,
}: EditModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(playlist.name);
  const [comment, setComment] = useState(playlist.comment ?? '');
  const [isPublic, setIsPublic] = useState(playlist.public ?? false);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [coverRemoved, setCoverRemoved] = useState(false);
  const [saving, setSaving] = useState(false);
  const coverInputRef = useRef<HTMLInputElement>(null);

  const hasExistingCover = !coverRemoved && (coverPreview || customCoverId);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setCoverFile(file);
    setCoverRemoved(false);
    const reader = new FileReader();
    reader.onload = ev => setCoverPreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleRemoveCover = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCoverFile(null);
    setCoverPreview(null);
    setCoverRemoved(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({ name, comment, isPublic, coverFile, coverRemoved });
    } finally {
      setSaving(false);
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal-content playlist-edit-modal" onClick={e => e.stopPropagation()}>
        <button className="btn btn-ghost modal-close" onClick={onClose} style={{ top: 16, right: 16 }}>
          <X size={18} />
        </button>

        <h2 className="modal-title" style={{ fontSize: 22 }}>{t('playlists.editMeta')}</h2>

        <div className="playlist-edit-body">
          {/* Left: cover */}
          <div
            className="playlist-edit-cover-wrap"
            onClick={() => coverInputRef.current?.click()}
          >
            {coverPreview ? (
              <img src={coverPreview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            ) : !coverRemoved && customCoverFetchUrl && customCoverCacheKey ? (
              <CachedImage
                src={customCoverFetchUrl}
                cacheKey={customCoverCacheKey}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            ) : (
              <div className="playlist-cover-grid" style={{ width: '100%', height: '100%' }}>
                {coverQuadUrls.map((entry, i) =>
                  entry
                    ? <CachedImage key={i} className="playlist-cover-cell" src={entry.src} cacheKey={entry.cacheKey} alt="" />
                    : <div key={i} className="playlist-cover-cell playlist-cover-cell--empty" />
                )}
              </div>
            )}
            <div className="playlist-edit-cover-overlay">
              <div className="playlist-edit-cover-menu">
                <button
                  className="playlist-edit-cover-menu-item"
                  onClick={e => { e.stopPropagation(); coverInputRef.current?.click(); }}
                >
                  <Camera size={14} />
                  {t('playlists.changeCoverLabel')}
                </button>
                {hasExistingCover && (
                  <button
                    className="playlist-edit-cover-menu-item playlist-edit-cover-menu-item--danger"
                    onClick={handleRemoveCover}
                  >
                    {t('playlists.removeCover')}
                  </button>
                )}
              </div>
            </div>
            <input ref={coverInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileChange} />
          </div>

          {/* Right: fields */}
          <div className="playlist-edit-fields">
            <input
              className="input playlist-edit-name-input"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('playlists.editNamePlaceholder')}
              autoFocus
            />
            <textarea
              className="input playlist-edit-desc-input"
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder={t('playlists.editCommentPlaceholder')}
            />
          </div>
        </div>

        <div className="playlist-edit-footer">
          <label className="toggle-label" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
            <label className="toggle-switch" style={{ marginBottom: 0 }}>
              <input type="checkbox" checked={isPublic} onChange={e => setIsPublic(e.target.checked)} />
              <span className="toggle-track" />
            </label>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('playlists.editPublic')}</span>
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-surface" onClick={onClose}>
              {t('playlists.editCancel')}
            </button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving || !name.trim()}>
              {saving ? <Loader2 size={14} className="spin-slow" /> : null}
              {t('playlists.editSave')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── CSV Import Report Modal ───────────────────────────────────────────────────

interface CsvReportModalProps {
  report: {
    added: number;
    notFound: SpotifyCsvTrack[];
    duplicates: number;
    duplicateTracks: SpotifyCsvTrack[];
    total: number;
    searchErrors?: SpotifyCsvTrack[];
  };
  playlistName: string;
  onClose: () => void;
}

function CsvImportReportModal({ report, playlistName, onClose }: CsvReportModalProps) {
  const { t } = useTranslation();
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const downloadReport = () => {
    try {
      const content = [
        'CSV Import Report',
        `Playlist: ${playlistName}`,
        `Date: ${new Date().toLocaleString()}`,
        `Total: ${report.total}, Added: ${report.added}, Duplicates: ${report.duplicates}, Not Found: ${report.notFound.length}${report.searchErrors ? `, Network Errors: ${report.searchErrors.length}` : ''}`,
        '',
        ...(report.duplicateTracks.length > 0 ? ['Duplicate Tracks (skipped):', ...report.duplicateTracks.map(t => `- ${t.trackName} by ${t.artistName}${t.albumName ? ` (${t.albumName})` : ''}`), ''] : []),
        ...(report.notFound.length > 0 ? ['Not Found Tracks:', ...report.notFound.map(t => `  - ${t.trackName} | ${t.artistName} | ${t.albumName || 'N/A'} | Score: ${(t.score ?? 0).toFixed(2)} (threshold: ${(t.thresholdNeeded ?? 0).toFixed(2)})`), ''] : []),
        ...(report.searchErrors && report.searchErrors.length > 0 ? ['Network Error Tracks (may retry):', ...report.searchErrors.map(t => `- ${t.trackName} by ${t.artistName}`), ''] : []),
      ].join('\n');

      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');

      // Detailed name: playlist + date-time-seconds
      const timestamp = new Date().toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19);
      const safePlaylistName = playlistName.replace(/[/\\?%*:|"<>]/g, '-').substring(0, 50);
      a.download = `import-report-${safePlaylistName}-${timestamp}.txt`;

      a.href = url;
      a.click();
      URL.revokeObjectURL(url);

      showToast(t('playlists.csvImportDownloadSuccess'), 3000, 'info');
    } catch (err) {
      console.error('Failed to download report:', err);
      showToast(t('playlists.csvImportDownloadError'), 3000, 'error');
    }
  };

  return createPortal(
    <div
      className="modal-overlay modal-overlay--csv"
      onClick={handleOverlayClick}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 99999,
      }}
    >
      <div
        className="modal-content"
        style={{
          maxWidth: 500,
          maxHeight: '80vh',
          width: '90%',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
        }}
        onClick={e => e.stopPropagation()}
      >
        <button className="btn btn-ghost modal-close" onClick={onClose} style={{ position: 'absolute', top: 16, right: 16 }}>
          <X size={18} />
        </button>

        <h2 className="modal-title" style={{ fontSize: 20, marginBottom: 16 }}>{t('playlists.csvImportReport')}</h2>

        <div style={{ display: 'grid', gridTemplateColumns: report.searchErrors && report.searchErrors.length > 0 ? 'repeat(5, 1fr)' : 'repeat(4, 1fr)', gap: 12, marginBottom: 20, textAlign: 'center' }}>
          <div style={{ padding: 12, background: 'var(--surface)', borderRadius: 8 }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)' }}>{report.total}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('playlists.csvImportTotal')}</div>
          </div>
          <div style={{ padding: 12, background: 'var(--surface)', borderRadius: 8 }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--accent)' }}>{report.added}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('playlists.csvImportAdded')}</div>
          </div>
          <div style={{ padding: 12, background: 'var(--surface)', borderRadius: 8 }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-muted)' }}>{report.duplicates}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('playlists.csvImportDuplicates')}</div>
          </div>
          <div style={{ padding: 12, background: 'var(--surface)', borderRadius: 8 }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: report.notFound.length > 0 ? '#ff6b6b' : 'var(--text-muted)' }}>{report.notFound.length}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('playlists.csvImportNotFound')}</div>
          </div>
          {report.searchErrors && report.searchErrors.length > 0 && (
            <div style={{ padding: 12, background: 'var(--surface)', borderRadius: 8 }}>
              <div style={{ fontSize: 24, fontWeight: 700, color: '#ffa500' }}>{report.searchErrors.length}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('playlists.csvImportNetworkErrors')}</div>
            </div>
          )}
        </div>

        {report.duplicateTracks.length > 0 && (
          <>
            <h3 style={{ fontSize: 14, marginBottom: 8, color: 'var(--text-muted)' }}>{t('playlists.csvImportDuplicatesTitle')}</h3>
            <div style={{ overflowY: 'auto', maxHeight: 150, marginBottom: 16, border: '1px solid var(--surface)', borderRadius: 8 }}>
              {report.duplicateTracks.map((track, i) => (
                <div key={i} style={{ padding: '8px 12px', borderBottom: '1px solid var(--surface)', fontSize: 13 }}>
                  <div style={{ fontWeight: 500 }}>{track.trackName}</div>
                  <div style={{ color: 'var(--text-muted)' }}>{track.artistName}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {report.notFound.length > 0 && (
          <>
            <h3 style={{ fontSize: 14, marginBottom: 8, color: 'var(--text-muted)' }}>{t('playlists.csvImportNotFoundTitle')}</h3>
            <div style={{ overflowY: 'auto', maxHeight: 200, marginBottom: 16, border: '1px solid var(--surface)', borderRadius: 8 }}>
              {report.notFound.map((track, i) => (
                <div key={i} style={{ padding: '8px 12px', borderBottom: '1px solid var(--surface)', fontSize: 13 }}>
                  <div style={{ fontWeight: 500 }}>{track.trackName}</div>
                  <div style={{ color: 'var(--text-muted)' }}>{track.artistName}</div>
                  {track.albumName && <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>{track.albumName}</div>}
                  {track.score !== undefined && (
                    <div style={{ fontSize: 11, marginTop: 2 }}>
                      <span style={{ color: 'var(--text-muted)' }}>Score: </span>
                      <span style={{ color: track.score >= (track.thresholdNeeded ?? 0.6) ? '#4ade80' : '#f87171' }}>
                        {track.score.toFixed(2)}
                      </span>
                      <span style={{ color: 'var(--text-muted)' }}> (threshold: {(track.thresholdNeeded ?? 0.6).toFixed(2)})</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {report.searchErrors && report.searchErrors.length > 0 && (
          <>
            <h3 style={{ fontSize: 14, marginBottom: 8, color: '#ffa500' }}>{t('playlists.csvImportNetworkErrorsTitle')}</h3>
            <div style={{ overflowY: 'auto', maxHeight: 150, marginBottom: 16, border: '1px solid var(--surface)', borderRadius: 8 }}>
              {report.searchErrors.map((track, i) => (
                <div key={i} style={{ padding: '8px 12px', borderBottom: '1px solid var(--surface)', fontSize: 13 }}>
                  <div style={{ fontWeight: 500 }}>{track.trackName}</div>
                  <div style={{ color: 'var(--text-muted)' }}>{track.artistName}</div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="modal-actions" style={{ marginTop: 'auto', display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <button className="btn btn-surface" onClick={downloadReport}>
            <Download size={14} /> {t('playlists.csvImportDownloadReport')}
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            {t('playlists.csvImportClose')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
