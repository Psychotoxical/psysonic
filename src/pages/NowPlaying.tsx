import { useCoverArt } from '../cover/useCoverArt';
import { albumCoverRef } from '../cover/ref';
import { usePlaybackTrackCoverRef } from '../cover/useLibraryCoverRef';
import { coverArtIdFromRadio } from '../cover/ids';
import type { SubsonicArtistInfo, SubsonicSong } from '../api/subsonicTypes';
import React, { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import { usePlaybackLibraryNavigate } from '../hooks/usePlaybackLibraryNavigate';
import { usePlaybackServerId } from '../hooks/usePlaybackServerId';
import { useTranslation } from 'react-i18next';
import { Music, ExternalLink, Cast, Users, Radio, Clock, SkipForward, Info, Calendar, Disc3, Play, EyeOff, LayoutGrid, RotateCcw, Eye } from 'lucide-react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { usePlayerStore } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { useLyricsStore } from '../store/lyricsStore';
import { songToTrack } from '../utils/playback/songToTrack';
import { useRadioMetadata } from '../hooks/useRadioMetadata';
import { useDragSource, useDragDrop } from '../contexts/DragDropContext';
import OverlayScrollArea from '../components/OverlayScrollArea';
import {
  useNpLayoutStore, NP_CARD_IDS,
  type NpCardId, type NpColumn,
} from '../store/nowPlayingLayoutStore';

// ─── Helpers ──────────────────────────────────────────────────────────────────

import {
  formatTime, formatCompact, isoToParts,
  buildContributorRows,
  type ContributorRow,
} from '../utils/componentHelpers/nowPlayingHelpers';
import NpCardWrap from '../components/nowPlaying/NpCardWrap';
import NpColumnEl from '../components/nowPlaying/NpColumnEl';
import RadioView from '../components/nowPlaying/RadioView';
import Hero from '../components/nowPlaying/Hero';
import ArtistCard from '../components/nowPlaying/ArtistCard';
import AlbumCard from '../components/nowPlaying/AlbumCard';
import TopSongsCard from '../components/nowPlaying/TopSongsCard';
import CreditsCard from '../components/nowPlaying/CreditsCard';
import TourCard from '../components/nowPlaying/TourCard';
import DiscographyCard from '../components/nowPlaying/DiscographyCard';
import { useNowPlayingFetchers } from '../hooks/useNowPlayingFetchers';
import { useNowPlayingStarLove } from '../hooks/useNowPlayingStarLove';
import { useArtistInfoBatch } from '../hooks/useArtistInfoBatch';
import { primaryTrackArtistRef, resolveTrackArtistRefs } from '../utils/playback/trackArtistRefs';
import type { ArtistCardTab } from '../components/nowPlaying/ArtistCard';

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function NowPlaying() {
  const { t } = useTranslation();
  const stableNavigate = usePlaybackLibraryNavigate();
  const playbackServerId = usePlaybackServerId();
  const audiomuseNavidromeByServer = useAuthStore(s => s.audiomuseNavidromeByServer);
  const audiomuseNavidromeEnabled = Boolean(
    playbackServerId && audiomuseNavidromeByServer[playbackServerId],
  );

  const currentTrack            = usePlayerStore(s => s.currentTrack);
  const currentRadio            = usePlayerStore(s => s.currentRadio);
  const userRatingOverrides     = usePlayerStore(s => s.userRatingOverrides);
  const showLyrics              = useLyricsStore(s => s.showLyrics);
  const activeTab               = useLyricsStore(s => s.activeTab);
  const isQueueVisible          = usePlayerStore(s => s.isQueueVisible);
  const toggleQueue             = usePlayerStore(s => s.toggleQueue);
  const enableBandsintown    = useAuthStore(s => s.enableBandsintown);
  const setEnableBandsintown = useAuthStore(s => s.setEnableBandsintown);
  const lastfmUsername       = useAuthStore(s => s.lastfmUsername);
  const lastfmSessionKey     = useAuthStore(s => s.lastfmSessionKey);
  const playTrackFn          = usePlayerStore(s => s.playTrack);

  const radioMeta = useRadioMetadata(currentRadio ?? null);

  const songId    = currentTrack?.id;
  const albumId   = currentTrack?.albumId;
  const trackArtistRefs = useMemo(
    () => (currentTrack ? resolveTrackArtistRefs(currentTrack) : []),
    [currentTrack],
  );
  const primaryArtist = useMemo(
    () => (currentTrack ? primaryTrackArtistRef(currentTrack) : null),
    [currentTrack],
  );
  const artistId = primaryArtist?.id;
  const artistName = primaryArtist?.name ?? currentTrack?.artist ?? '';

  // Entity fetchers (8 cached useEffects + their state)
  const {
    songMeta, artistInfo, albumData, topSongs,
    tourEvents, tourLoading, discography,
    lfmTrack, lfmArtist,
  } = useNowPlayingFetchers({
    songId, artistId, albumId, artistName,
    enableBandsintown, audiomuseNavidromeEnabled,
    lastfmUsername, currentTrack,
    subsonicServerId: playbackServerId,
    // `fetchEnabled` = "we have a playback server id". The reachability decision
    // (online / server reachable, no trackId so local-cache playback still loads
    // metadata) lives in one place inside the hook — see its JSDoc.
    fetchEnabled: Boolean(playbackServerId),
  });

  // Star + Last.fm love + their toggle callbacks
  const lfmLoveEnabled = Boolean(lastfmUsername && lastfmSessionKey);
  const { starred, lfmLoved, toggleStar, toggleLfmLove } = useNowPlayingStarLove({
    currentTrack, songMeta, lfmTrack, lfmLoveEnabled, lastfmSessionKey,
  });

  const openLyrics = useCallback(() => {
    if (!isQueueVisible) toggleQueue();
    showLyrics();
  }, [isQueueVisible, toggleQueue, showLyrics]);

  const playbackCoverRef = usePlaybackTrackCoverRef(currentTrack ?? undefined);

  const radioCoverArtId = currentRadio?.coverArt ? coverArtIdFromRadio(currentRadio.id) : undefined;
  const radioCover = useCoverArt(
    radioCoverArtId ? albumCoverRef(radioCoverArtId, radioCoverArtId) : null,
    800,
    { surface: 'sparse' },
  );
  const resolvedRadioCover = radioCover.src;

  const contributorRows = useMemo(
    () => buildContributorRows(songMeta, currentTrack?.artist ?? ''),
    [songMeta, currentTrack?.artist],
  );

  // Merge Subsonic artistInfo with Last.fm fallback: if Subsonic has no bio,
  // use Last.fm's artist bio so the card doesn't show up empty.
  const effectiveArtistInfo = useMemo<SubsonicArtistInfo | null>(() => {
    if (!artistInfo && !lfmArtist?.bio) return null;
    if (artistInfo?.biography) return artistInfo;
    if (!lfmArtist?.bio) return artistInfo;
    return {
      ...(artistInfo ?? {}),
      biography: lfmArtist.bio,
    };
  }, [artistInfo, lfmArtist]);

  const artistInfoById = useArtistInfoBatch(
    playbackServerId,
    trackArtistRefs,
    audiomuseNavidromeEnabled ? 24 : undefined,
  );

  const artistTabs = useMemo((): ArtistCardTab[] | undefined => {
    const tabs = trackArtistRefs.filter(r => r.id?.trim());
    if (tabs.length <= 1) return undefined;
    return tabs.map((ref, index) => {
      const id = ref.id!.trim();
      const info = index === 0
        ? (effectiveArtistInfo ?? artistInfoById[id] ?? null)
        : (artistInfoById[id] ?? null);
      return {
        id,
        name: ref.name ?? id,
        artistInfo: info,
      };
    });
  }, [trackArtistRefs, artistInfoById, effectiveArtistInfo]);

  const handleEnableBandsintown = useCallback(() => setEnableBandsintown(true), [setEnableBandsintown]);

  const handlePlayTopSong = useCallback((song: SubsonicSong) => {
    if (topSongs.length === 0) return;
    const queue = topSongs.map(songToTrack);
    const hit = queue.find(q => q.id === song.id);
    if (hit) playTrackFn(hit, queue);
  }, [topSongs, playTrackFn]);

  // ── Widget layout (drag-to-reorder, hide/show, reset) ────────────────────
  const layoutCards   = useNpLayoutStore(s => s.cards);
  const moveCard      = useNpLayoutStore(s => s.moveCard);
  const setCardVisible = useNpLayoutStore(s => s.setVisible);
  const resetLayout   = useNpLayoutStore(s => s.reset);
  const { isDragging: dndActive, payload: dndPayload } = useDragDrop();

  const [dragOver, setDragOver] = useState<{ col: NpColumn; idx: number } | null>(null);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);

  // Parse the current drag payload to know whether it's an np-card drag
  const draggingCardId: NpCardId | null = useMemo(() => {
    if (!dndActive || !dndPayload) return null;
    try {
      const parsed = JSON.parse(dndPayload.data);
      if (parsed?.kind === 'np-card' && NP_CARD_IDS.includes(parsed.id)) return parsed.id as NpCardId;
    } catch { /* not a card payload */ }
    return null;
  }, [dndActive, dndPayload]);

  // Clear the drop indicator when the drag ends (no psy-drop on our target)
  useEffect(() => { if (!draggingCardId) setDragOver(null); }, [draggingCardId]);

  const toggleCardVisible = useCallback((id: NpCardId, next: boolean) => {
    setCardVisible(id, next);
  }, [setCardVisible]);

  const onColumnHover = useCallback((col: NpColumn, idx: number) => {
    setDragOver(prev => (prev && prev.col === col && prev.idx === idx) ? prev : { col, idx });
  }, []);

  // Ref mirror of dragOver so the document-level psy-drop handler always sees
  // the latest hovered column/index regardless of closure timing.
  const dragOverRef = useRef(dragOver);
  dragOverRef.current = dragOver;

  // Global psy-drop listener: catches drops anywhere on the page (even below a
  // column when the cursor left the column bounds), then uses dragOverRef to
  // decide which column/index the user actually meant.
  useEffect(() => {
    if (!draggingCardId) return;
    const onPsyDrop = (evt: Event) => {
      const ce = evt as CustomEvent<{ data: string }>;
      try {
        const parsed = JSON.parse(ce.detail?.data ?? '');
        if (parsed?.kind !== 'np-card' || !NP_CARD_IDS.includes(parsed.id)) return;
        const over = dragOverRef.current;
        if (over) {
          moveCard(parsed.id as NpCardId, over.col, over.idx);
        }
      } catch { /* ignore non-card drops */ }
      setDragOver(null);
    };
    document.addEventListener('psy-drop', onPsyDrop as EventListener);
    return () => document.removeEventListener('psy-drop', onPsyDrop as EventListener);
  }, [draggingCardId, moveCard]);

  // Close layout menu on outside click
  useEffect(() => {
    if (!layoutMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest('.np-dash-toolbar-menu-wrap')) setLayoutMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [layoutMenuOpen]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="np-page">
      <OverlayScrollArea
        className="np-main"
        viewportClassName="np-main__viewport"
        railInset="panel"
        measureDeps={[
          !!currentTrack,
          !!currentRadio,
          layoutCards,
          enableBandsintown,
          tourEvents.length,
          discography.length,
          topSongs.length,
        ]}
      >
        {currentRadio && !currentTrack ? (
          <RadioView radioMeta={radioMeta} currentRadio={currentRadio} resolvedCover={resolvedRadioCover} />
        ) : currentTrack ? (
          <div className="np-dash">
            <Hero
              track={{
                id: currentTrack.id,
                title: currentTrack.title,
                artist: currentTrack.artist,
                album: currentTrack.album,
                year: currentTrack.year,
                duration: currentTrack.duration,
                suffix: currentTrack.suffix,
                bitRate: currentTrack.bitRate,
                samplingRate: songMeta?.samplingRate,
                bitDepth: songMeta?.bitDepth,
                artistId: currentTrack.artistId,
                albumId: currentTrack.albumId,
                userRating: currentTrack.userRating,
              }}
              artistRefs={trackArtistRefs.length > 0 ? trackArtistRefs : undefined}
              genre={songMeta?.genre ?? undefined}
              playCount={(songMeta as (SubsonicSong & { playCount?: number }) | null)?.playCount}
              userRatingOverride={userRatingOverrides[currentTrack.id]}
              lfmTrack={lfmTrack}
              lfmArtist={lfmArtist}
              starred={starred}
              lfmLoved={lfmLoved}
              lfmLoveEnabled={lfmLoveEnabled}
              activeLyricsTab={activeTab === 'lyrics' && isQueueVisible}
              coverRef={playbackCoverRef}
              onNavigate={stableNavigate}
              onToggleStar={toggleStar}
              onToggleLfmLove={toggleLfmLove}
              onOpenLyrics={openLyrics}
            />

            {(() => {
              const renderCard = (id: NpCardId): React.ReactNode => {
                switch (id) {
                  case 'album': return (
                    <AlbumCard
                      album={albumData?.album ?? null}
                      songs={albumData?.songs ?? []}
                      currentTrackId={currentTrack.id}
                      albumName={currentTrack.album}
                      albumId={albumId}
                      albumYear={currentTrack.year}
                      onNavigate={stableNavigate}
                    />
                  );
                  case 'topSongs': return (
                    <TopSongsCard
                      artistName={artistName}
                      artistId={artistId}
                      songs={topSongs}
                      currentTrackId={currentTrack.id}
                      onNavigate={stableNavigate}
                      onPlay={handlePlayTopSong}
                    />
                  );
                  case 'credits': return <CreditsCard rows={contributorRows} />;
                  case 'artist': return (
                    <ArtistCard
                      artistName={artistName}
                      artistId={artistId}
                      artistInfo={effectiveArtistInfo}
                      artistTabs={artistTabs}
                      onNavigate={stableNavigate}
                    />
                  );
                  case 'discography': return (
                    <DiscographyCard
                      artistId={artistId}
                      albums={discography}
                      currentAlbumId={albumId}
                      onNavigate={stableNavigate}
                    />
                  );
                  case 'tour': return (
                    <TourCard
                      artistName={artistName}
                      enabled={enableBandsintown}
                      loading={tourLoading}
                      events={tourEvents}
                      onEnable={handleEnableBandsintown}
                    />
                  );
                }
              };
              const cardLabel = (id: NpCardId): string => {
                const k: Record<NpCardId, string> = {
                  album: 'nowPlaying.fromAlbum',
                  topSongs: 'nowPlaying.topSongs',
                  credits: 'nowPlayingInfo.songInfo',
                  artist: 'nowPlaying.aboutArtist',
                  discography: 'nowPlaying.discography',
                  tour: 'nowPlayingInfo.onTour',
                };
                return t(k[id]);
              };
              const visibleCards = layoutCards.filter(c => c.visible);
              const hiddenCards  = layoutCards.filter(c => !c.visible);
              const renderColumn = (col: NpColumn) => {
                const cards = layoutCards.filter(c =>
                  c.column === col && c.visible && c.id !== draggingCardId,
                );
                const isOver = dragOver?.col === col;
                return (
                  <NpColumnEl
                    col={col}
                    empty={cards.length === 0}
                    emptyLabel={t('nowPlaying.emptyColumn', 'Drop cards here')}
                    isDndActive={!!draggingCardId}
                    draggingCardId={draggingCardId}
                    onHover={onColumnHover}
                    isOverHere={!!isOver}
                  >
                    {cards.map((c, idx) => (
                      <React.Fragment key={c.id}>
                        {isOver && dragOver.idx === idx && <div className="np-dash-drop-indicator" />}
                        <NpCardWrap
                          id={c.id}
                          label={cardLabel(c.id)}
                          isDraggingThis={draggingCardId === c.id}
                        >
                          {renderCard(c.id)}
                        </NpCardWrap>
                      </React.Fragment>
                    ))}
                    {isOver && dragOver.idx === cards.length && <div className="np-dash-drop-indicator" />}
                  </NpColumnEl>
                );
              };
              return (
                <>
                  <div className="np-dash-toolbar">
                    <div className="np-dash-toolbar-menu-wrap">
                      <button
                        className="np-dash-toolbar-btn"
                        onClick={() => setLayoutMenuOpen(v => !v)}
                        data-tooltip={t('nowPlaying.layoutMenu', 'Layout')}
                      >
                        <LayoutGrid size={14} />
                        <span>{t('nowPlaying.layoutMenu', 'Layout')}</span>
                        {hiddenCards.length > 0 && (
                          <span className="np-dash-toolbar-badge">{hiddenCards.length}</span>
                        )}
                      </button>
                      {layoutMenuOpen && (
                        <div className="np-dash-toolbar-menu" role="menu">
                          <div className="np-dash-toolbar-section">
                            {t('nowPlaying.visibleCards', 'Visible cards')}
                          </div>
                          {visibleCards.map(c => (
                            <button
                              key={c.id}
                              className="np-dash-toolbar-item"
                              onClick={() => toggleCardVisible(c.id, false)}
                            >
                              <Eye size={13} /> <span className="np-dash-toolbar-item-label">{cardLabel(c.id)}</span>
                            </button>
                          ))}
                          {hiddenCards.length > 0 && (
                            <>
                              <div className="np-dash-toolbar-section">
                                {t('nowPlaying.hiddenCards', 'Hidden cards')}
                              </div>
                              {hiddenCards.map(c => (
                                <button
                                  key={c.id}
                                  className="np-dash-toolbar-item is-hidden"
                                  onClick={() => toggleCardVisible(c.id, true)}
                                >
                                  <EyeOff size={13} /> <span className="np-dash-toolbar-item-label">{cardLabel(c.id)}</span>
                                </button>
                              ))}
                            </>
                          )}
                          <div className="np-dash-toolbar-divider" />
                          <button
                            className="np-dash-toolbar-item"
                            onClick={() => { resetLayout(); setLayoutMenuOpen(false); }}
                          >
                            <RotateCcw size={13} /> <span className="np-dash-toolbar-item-label">{t('nowPlaying.resetLayout', 'Reset layout')}</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="np-dash-grid">
                    {renderColumn('left')}
                    {renderColumn('right')}
                  </div>
                </>
              );
            })()}
          </div>
        ) : (
          <div className="np-empty-state">
            <Music size={48} style={{ opacity: 0.3 }} />
            <p>{t('nowPlaying.nothingPlaying')}</p>
          </div>
        )}
      </OverlayScrollArea>
    </div>
  );
}
