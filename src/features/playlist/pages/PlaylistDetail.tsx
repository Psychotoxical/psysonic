import { updatePlaylist } from '@/lib/api/subsonicPlaylists';
import type { SubsonicPlaylist, SubsonicSong } from '@/lib/api/subsonicTypes';
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, useLocation, useSearchParams } from 'react-router';
import { useTracklistColumns, type ColDef, TRACK_TITLE_FLEX_COL } from '@/lib/hooks/useTracklistColumns';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useShallow } from 'zustand/react/shallow';
import { usePlaylistStore } from '@/features/playlist/store/playlistStore';
import { usePlaylistMembershipStore } from '@/store/playlistMembershipStore';
import { useOfflineStore } from '@/features/offline';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { useAlbumOfflineState } from '@/features/album';
import { useAuthStore } from '@/store/authStore';
import { useDownloadModalStore } from '@/features/offline';
import { useZipDownloadStore } from '@/features/offline';
import { useDragDrop } from '@/lib/dnd/DragDropContext';
import { useTranslation } from 'react-i18next';
import type { SpotifyCsvTrack } from '@/features/playlist/utils/spotifyCsvImport';
import { runPlaylistCsvImport } from '@/features/playlist/utils/runPlaylistCsvImport';
import PlaylistEditModal from '@/features/playlist/components/PlaylistEditModal';
import CsvImportReportModal from '@/features/playlist/components/CsvImportReportModal';
import PlaylistSongSearchPanel from '@/features/playlist/components/PlaylistSongSearchPanel';
import PlaylistSuggestions from '@/features/playlist/components/PlaylistSuggestions';
import PlaylistHero from '@/features/playlist/components/PlaylistHero';
import PlaylistTracklist from '@/features/playlist/components/PlaylistTracklist';
import PlaylistFilterToolbar from '@/features/playlist/components/PlaylistFilterToolbar';
import type { PlaylistSortKey, PlaylistSortDir } from '@/features/playlist/utils/playlistDisplayedSongs';
import { runPlaylistZipDownload } from '@/features/playlist/utils/runPlaylistZipDownload';
import { runPlaylistSaveMeta } from '@/features/playlist/utils/runPlaylistSaveMeta';
import { runPlaylistLoad } from '@/features/playlist/utils/runPlaylistLoad';
import { startPlaylistRowDrag } from '@/features/playlist/utils/startPlaylistRowDrag';
import { usePlaylistCovers } from '@/features/playlist/hooks/usePlaylistCovers';
import { usePlaylistSelection } from '@/features/playlist/hooks/usePlaylistSelection';
import { usePlaylistSuggestions } from '@/features/playlist/hooks/usePlaylistSuggestions';
import { usePlaylistSongSearch } from '@/features/playlist/hooks/usePlaylistSongSearch';
import { usePlaylistSongMutations } from '@/features/playlist/hooks/usePlaylistSongMutations';
import { usePlaylistStarRating } from '@/features/playlist/hooks/usePlaylistStarRating';
import { usePlaylistPreview } from '@/features/playlist/hooks/usePlaylistPreview';
import { usePlaylistBulkPlayCallbacks } from '@/features/playlist/hooks/usePlaylistBulkPlayCallbacks';
import { usePlaylistDerived } from '@/features/playlist/hooks/usePlaylistDerived';
import { usePlaylistRouteEffects } from '@/features/playlist/hooks/usePlaylistRouteEffects';
import { useBulkPlPickerOutsideClick } from '@/features/playlist/hooks/useBulkPlPickerOutsideClick';
import { usePlaylistDnDReorder } from '@/features/playlist/hooks/usePlaylistDnDReorder';
import { useOfflineBrowseContext } from '@/features/offline';
import { offlineActionPolicy } from '@/features/offline';
import { readDetailServerId } from '@/lib/navigation/detailServerScope';
import { ownedEntityKey } from '@/lib/util/ownedEntityKey';

// ── Column configuration ──────────────────────────────────────────────────────
const PL_COLUMNS: readonly ColDef[] = [
  { key: 'num',        i18nKey: null,              minWidth: 60,  defaultWidth: 60,  required: true  },
  { key: 'title',      i18nKey: 'trackTitle',      ...TRACK_TITLE_FLEX_COL, required: true },
  { key: 'artist',     i18nKey: 'trackArtist',     minWidth: 80,  defaultWidth: 180, required: false },
  { key: 'album',      i18nKey: 'trackAlbum',      minWidth: 80,  defaultWidth: 180, required: false },
  { key: 'genre',      i18nKey: 'trackGenre',      minWidth: 60,  defaultWidth: 120, required: false },
  { key: 'favorite',   i18nKey: 'trackFavorite',   minWidth: 50,  defaultWidth: 70,  required: false },
  { key: 'rating',     i18nKey: 'trackRating',     minWidth: 80,  defaultWidth: 120, required: false },
  { key: 'duration',   i18nKey: 'trackDuration',   minWidth: 72,  defaultWidth: 92,  required: false },
  { key: 'format',     i18nKey: 'trackFormat',     minWidth: 60,  defaultWidth: 90,  required: false },
  { key: 'playCount',  i18nKey: 'trackPlayCount', minWidth: 60,  defaultWidth: 80,  required: false },
  { key: 'lastPlayed', i18nKey: 'trackLastPlayed', minWidth: 90,  defaultWidth: 130, required: false },
  { key: 'bpm',        i18nKey: 'trackBpm',        minWidth: 50,  defaultWidth: 70,  required: false },
  { key: 'delete',     i18nKey: null,              minWidth: 36,  defaultWidth: 36,  required: true  },
];

export default function PlaylistDetail() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { playTrack, enqueue } = usePlayerStore(
    useShallow(s => ({
      playTrack: s.playTrack,
      enqueue: s.enqueue,
    }))
  );
  const touchPlaylist = usePlaylistStore((s) => s.touchPlaylist);
  const { startDrag } = useDragDrop();
  const downloadPlaylist = useOfflineStore(s => s.downloadPlaylist);
  const deleteAlbum = useOfflineStore(s => s.deleteAlbum);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const serverId = readDetailServerId(searchParams, activeServerId) ?? '';
  void useLocalPlaybackStore(s => s.entries);
  const downloadFolder = useAuthStore(s => s.downloadFolder);
  const requestDownloadFolder = useDownloadModalStore(s => s.requestFolder);

  const [playlist, setPlaylist] = useState<SubsonicPlaylist | null>(null);
  const [songs, setSongs] = useState<SubsonicSong[]>([]);
  const offlineSongIds = useMemo(() => songs.map(s => s.id), [songs]);
  const { resolvedOfflineStatus, offlineProgress } = useAlbumOfflineState(id ?? '', serverId, offlineSongIds);
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
  const [contextMenuSongId, setContextMenuSongId] = useState<string | null>(null);
  const zipDownloads = useZipDownloadStore(s => s.downloads);
  const [zipDownloadId, setZipDownloadId] = useState<string | null>(null);
  const activeZip = zipDownloadId ? zipDownloads.find(d => d.id === zipDownloadId) : undefined;
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const saveOwnerGenerationRef = useRef(0);
  const saveSequenceRef = useRef(0);

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
  const savePlaylist = useCallback((updatedSongs: SubsonicSong[], prevCount = 0) => {
    if (!id || !serverId) return Promise.resolve();
    const ownerGeneration = saveOwnerGenerationRef.current;
    const sequence = ++saveSequenceRef.current;
    setSaving(true);
    const songIds = updatedSongs.map(song => song.id);
    const operation = saveChainRef.current.then(async () => {
      if (saveOwnerGenerationRef.current !== ownerGeneration) return;
      try {
        await updatePlaylist(id, songIds, prevCount, serverId);
        if (saveOwnerGenerationRef.current !== ownerGeneration) return;
        usePlaylistMembershipStore.getState().replacePlaylistSongIds(id, songIds, serverId);
        touchPlaylist(id, serverId);
      } catch {
        if (saveOwnerGenerationRef.current === ownerGeneration) {
          usePlaylistMembershipStore.getState().invalidatePlaylistSongIds(id, serverId);
        }
      }
    });
    saveChainRef.current = operation;
    return operation.finally(() => {
      if (
        saveOwnerGenerationRef.current === ownerGeneration
        && saveSequenceRef.current === sequence
      ) {
        setSaving(false);
      }
    });
  }, [id, serverId, touchPlaylist]);

  // ── Bulk select ───────────────────────────────────────────────────
  const [showBulkPlPicker, setShowBulkPlPicker] = useState(false);
  const { selectedIds, setSelectedIds, allSelected, toggleAll, toggleSelect, bulkRemove } =
    usePlaylistSelection(songs, setSongs, savePlaylist);
  useBulkPlPickerOutsideClick(showBulkPlPicker, setShowBulkPlPicker);

  // ── 2×2 cover quad (first 4 unique album covers) ─────────────
  const { coverQuadIds, resolvedBgUrl } = usePlaylistCovers(songs, customCoverId, serverId || undefined);

  // Song search
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSearchIds, setSelectedSearchIds] = useState<Set<string>>(new Set());
  const [searchPlPickerOpen, setSearchPlPickerOpen] = useState(false);
  const { searchResults, setSearchResults, searching } =
    usePlaylistSongSearch(songs, searchOpen, searchQuery, serverId || undefined);

  // Suggestions
  const { suggestions, setSuggestions, loadingSuggestions, loadSuggestions } =
    usePlaylistSuggestions(songs, playlist?.id, serverId || undefined);

  // ── Column resize/visibility ──────────────────────────────────────────────
  const {
    colVisible, visibleCols, gridStyle,
    startResize, startFlexColumnResize, toggleColumn, resetColumns,
    pickerOpen, setPickerOpen, pickerRef, tracklistRef,
  } = useTracklistColumns(PL_COLUMNS, 'psysonic_playlist_columns');

  usePlaylistRouteEffects({ setContextMenuSongId, setEditingMeta, location, navigate });

  // ── Load ─────────────────────────────────────────────────────
  const lastModified = usePlaylistStore(s => (
    id ? s.lastModified[ownedEntityKey({ id, serverId })] : undefined
  ));
  const { active: offlineBrowseActive } = useOfflineBrowseContext();
  const actionPolicy = offlineActionPolicy('playlistDetail', offlineBrowseActive);

  const loadGenerationRef = useRef(0);
  const loadedOwnerKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!id) return;
    const generation = ++loadGenerationRef.current;
    const ownerKey = ownedEntityKey({ id, serverId });
    const ownerChanged = loadedOwnerKeyRef.current !== ownerKey;
    loadedOwnerKeyRef.current = ownerKey;
    if (ownerChanged) {
      saveOwnerGenerationRef.current += 1;
      saveSequenceRef.current += 1;
    }
    runPlaylistLoad({
      id, serverId, setLoading, setPlaylist, setSongs, setCustomCoverId, setRatings, setStarredSongs,
      resetForOwnerChange: ownerChanged ? () => {
        setSaving(false);
        setEditingMeta(false);
        setFilterText('');
        setSortKey('natural');
        setSortDir('asc');
        setSortClickCount(0);
        setHoveredSuggestionId(null);
        setContextMenuSongId(null);
        setZipDownloadId(null);
        setCsvImporting(false);
        setCsvImportReport(null);
        setShowBulkPlPicker(false);
        setSelectedIds(new Set());
        setSearchOpen(false);
        setSearchQuery('');
        setSelectedSearchIds(new Set());
        setSearchPlPickerOpen(false);
        setSearchResults([]);
        setSuggestions([]);
      } : undefined,
      isCurrent: () => loadGenerationRef.current === generation,
    });
  }, [
    id, serverId, lastModified, offlineBrowseActive, setSelectedIds, setSearchResults, setSuggestions,
  ]);

  // ── Meta edit ─────────────────────────────────────────────────
  const handleSaveMeta = async (opts: {
    name: string; comment: string; isPublic: boolean;
    coverFile: File | null; coverRemoved: boolean;
  }) => {
    if (!id || !playlist) return;
    const ownerKey = ownedEntityKey({ id, serverId });
    await runPlaylistSaveMeta(
      {
        id, serverId: serverId || undefined, playlist, t, setPlaylist, setCustomCoverId, setEditingMeta,
        isCurrent: () => loadedOwnerKeyRef.current === ownerKey,
      },
      opts,
    );
  };

  // ── ZIP Download ──────────────────────────────────────────────
  const handleDownload = async () => {
    if (!playlist || !id) return;
    await runPlaylistZipDownload({
      playlist, id, serverId: serverId || undefined,
      downloadFolder, requestDownloadFolder, setZipDownloadId,
    });
  };

  // ── CSV Import ────────────────────────────────────────────────
  const handleImportCsv = async () => {
    if (!id || csvImporting) return;
    const ownerKey = ownedEntityKey({ id, serverId });
    await runPlaylistCsvImport({
      songs, t, savePlaylist,
      setSongs, setCsvImporting, setCsvImportReport,
      serverId: serverId || undefined,
      isCurrent: () => loadedOwnerKeyRef.current === ownerKey,
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
    ratings, setRatings, starredSongs, setStarredSongs, serverId: serverId || undefined,
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
    songsLength: songs.length, id, tracks, playTrack, enqueue,
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
        coverQuadIds={coverQuadIds}
        resolvedBgUrl={resolvedBgUrl}
        saving={saving}
        searchOpen={searchOpen}
        csvImporting={csvImporting}
        activeZip={activeZip}
        offlineStatus={resolvedOfflineStatus}
        offlineProgress={offlineProgress}
        activeServerId={serverId}
        actionPolicy={actionPolicy}
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
          serverId={serverId || undefined}
        />
      )}

      {/* ── Filter / sort toolbar ── */}
      {songs.length > 0 && (
        <PlaylistFilterToolbar
          filterText={filterText}
          setFilterText={setFilterText}
          sortKey={sortKey}
          sortDir={sortDir}
          setSortKey={setSortKey}
          setSortDir={setSortDir}
          setSortClickCount={setSortClickCount}
        />
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
        startFlexColumnResize={startFlexColumnResize}
        tracklistRef={tracklistRef}
        songs={songs}
        displayedSongs={displayedSongs}
        displayedTracks={displayedTracks}
        isFiltered={isFiltered}
        hasActiveFilter={filterText.trim().length > 0}
        id={id}
        serverId={serverId || undefined}
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
        ratings={ratings}
        starredSongs={starredSongs}
        handleRate={handleRate}
        handleToggleStar={handleToggleStar}
      />

      {editingMeta && playlist && (
        <PlaylistEditModal
          playlist={playlist}
          customCoverId={customCoverId}
          coverQuadIds={coverQuadIds}
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
