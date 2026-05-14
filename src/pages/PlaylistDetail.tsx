import { updatePlaylist } from '../api/subsonicPlaylists';
import type { SubsonicPlaylist, SubsonicSong } from '../api/subsonicTypes';
import React, { useEffect, useState, useCallback } from 'react';
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
import { useTranslation } from 'react-i18next';
import StarRating from '../components/StarRating';
import {
  formatSize,
  totalDurationLabel,
  isSmartPlaylistName,
  displayPlaylistName,
  codecLabel,
} from '../utils/componentHelpers/playlistDetailHelpers';
import type { SpotifyCsvTrack } from '../utils/playlist/spotifyCsvImport';
import { runPlaylistCsvImport } from '../utils/playlist/runPlaylistCsvImport';
import PlaylistEditModal from '../components/playlist/PlaylistEditModal';
import CsvImportReportModal from '../components/playlist/CsvImportReportModal';
import PlaylistSongSearchPanel from '../components/playlist/PlaylistSongSearchPanel';
import PlaylistSuggestions from '../components/playlist/PlaylistSuggestions';
import PlaylistHero from '../components/playlist/PlaylistHero';
import PlaylistTracklist from '../components/playlist/PlaylistTracklist';
import PlaylistFilterToolbar from '../components/playlist/PlaylistFilterToolbar';
import type { PlaylistSortKey, PlaylistSortDir } from '../utils/playlist/playlistDisplayedSongs';
import { runPlaylistZipDownload } from '../utils/playlist/runPlaylistZipDownload';
import { runPlaylistSaveMeta } from '../utils/playlist/runPlaylistSaveMeta';
import { runPlaylistLoad } from '../utils/playlist/runPlaylistLoad';
import { startPlaylistRowDrag } from '../utils/playlist/startPlaylistRowDrag';
import { usePlaylistCovers } from '../hooks/usePlaylistCovers';
import { usePlaylistSelection } from '../hooks/usePlaylistSelection';
import { usePlaylistSuggestions } from '../hooks/usePlaylistSuggestions';
import { usePlaylistSongSearch } from '../hooks/usePlaylistSongSearch';
import { usePlaylistSongMutations } from '../hooks/usePlaylistSongMutations';
import { usePlaylistStarRating } from '../hooks/usePlaylistStarRating';
import { usePlaylistPreview } from '../hooks/usePlaylistPreview';
import { usePlaylistBulkPlayCallbacks } from '../hooks/usePlaylistBulkPlayCallbacks';
import { usePlaylistDerived } from '../hooks/usePlaylistDerived';
import { usePlaylistRouteEffects } from '../hooks/usePlaylistRouteEffects';
import { useBulkPlPickerOutsideClick } from '../hooks/useBulkPlPickerOutsideClick';
import { usePlaylistDnDReorder } from '../hooks/usePlaylistDnDReorder';

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

  // ── Bulk select ───────────────────────────────────────────────────
  const [showBulkPlPicker, setShowBulkPlPicker] = useState(false);
  const { selectedIds, setSelectedIds, allSelected, toggleAll, toggleSelect, bulkRemove } =
    usePlaylistSelection(songs, setSongs, savePlaylist);
  useBulkPlPickerOutsideClick(showBulkPlPicker, setShowBulkPlPicker);

  // ── 2×2 cover quad (first 4 unique album covers) ─────────────
  const { coverQuadUrls, customCoverFetchUrl, customCoverCacheKey, resolvedBgUrl } =
    usePlaylistCovers(songs, customCoverId);

  // Song search
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSearchIds, setSelectedSearchIds] = useState<Set<string>>(new Set());
  const [searchPlPickerOpen, setSearchPlPickerOpen] = useState(false);
  const { searchResults, setSearchResults, searching } =
    usePlaylistSongSearch(songs, searchOpen, searchQuery);

  // Suggestions
  const { suggestions, setSuggestions, loadingSuggestions, loadSuggestions } =
    usePlaylistSuggestions(songs, playlist?.id);

  // ── Column resize/visibility ──────────────────────────────────────────────
  const {
    colVisible, visibleCols, gridStyle,
    startResize, toggleColumn, resetColumns,
    pickerOpen, setPickerOpen, pickerRef, tracklistRef,
  } = useTracklistColumns(PL_COLUMNS, 'psysonic_playlist_columns');

  usePlaylistRouteEffects({ setContextMenuSongId, setEditingMeta, location, navigate });

  // ── Load ─────────────────────────────────────────────────────
  const lastModified = usePlaylistStore(s => (id ? s.lastModified[id] : undefined));

  useEffect(() => {
    if (!id) return;
    runPlaylistLoad({
      id, setLoading, setPlaylist, setSongs, setCustomCoverId, setRatings, setStarredSongs,
    });
  }, [id, lastModified]);

  // ── Meta edit ─────────────────────────────────────────────────
  const handleSaveMeta = async (opts: {
    name: string; comment: string; isPublic: boolean;
    coverFile: File | null; coverRemoved: boolean;
  }) => {
    if (!id || !playlist) return;
    await runPlaylistSaveMeta(
      { id, playlist, t, setPlaylist, setCustomCoverId, setEditingMeta },
      opts,
    );
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
  const { removeSong, addSong } = usePlaylistSongMutations({
    songs, setSongs, savePlaylist, setSuggestions, setSearchResults, playlist, t,
  });

  // ── Preview (30s mid-song sample via Rust audio engine) ────────
  const { startPreview } = usePlaylistPreview();

  // ── Rating / Star ─────────────────────────────────────────────
  const { handleRate, handleToggleStar } = usePlaylistStarRating({
    ratings, setRatings, starredSongs, setStarredSongs,
  });

  // ── DnD reorder listener + drag-over visual feedback ──────────
  const { dropTargetIdx, handleRowMouseEnter } = usePlaylistDnDReorder({
    tracklistRef, songs, savePlaylist, setSongs,
  });

  // ── Row mousedown: threshold drag for reorder (from anywhere on the row) ──
  const handleRowMouseDown = (e: React.MouseEvent, idx: number) => {
    startPlaylistRowDrag({ e, idx, songs, selectedIds, isFiltered, startDrag });
  };

  // ── Memoized derivations ──────────────────────────────────────
  const { existingIds, tracks, displayedSongs, displayedTracks, isFiltered } = usePlaylistDerived(songs, {
    filterText, sortKey, sortDir, ratings, starredSongs,
  });

  // ── Playback actions (encapsulated like AlbumHeader) ─────────
  const { handlePlayAll, handleShuffleAll, handleEnqueueAll } = usePlaylistBulkPlayCallbacks({
    songsLength: songs.length, id, tracks, touchPlaylist, playTrack, enqueue,
  });

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

