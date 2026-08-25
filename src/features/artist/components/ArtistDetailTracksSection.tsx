import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SubsonicAlbum, SubsonicSong } from '@/lib/api/subsonicTypes';
import type { LibraryScopePair } from '@/lib/api/library/scopeReads';
import { useTracklistColumns } from '@/lib/hooks/useTracklistColumns';
import { TracklistColumnPicker } from '@/ui/TracklistColumnPicker';
import ArtistDetailTopTracks from '@/features/artist/components/ArtistDetailTopTracks';
import ArtistAllTracksList from '@/features/artist/components/ArtistAllTracksList';
import { useArtistAllTracks } from '@/features/artist/hooks/useArtistAllTracks';
import {
  ARTIST_ALL_TRACKS_COLUMNS,
  ARTIST_ALL_TRACKS_STORAGE_KEY,
} from '@/features/artist/utils/artistAllTracksColumns';

type TracksTab = 'top' | 'all';

interface Props {
  topSongs: SubsonicSong[];
  topSongsLoading: boolean;
  albums: SubsonicAlbum[];
  marginTop: string;
  playTopSongWithContinuation: (startIndex: number) => Promise<void>;
  losslessOnly?: boolean;
  /** Scope the full list is read under — falls back to the active server. */
  scopes: LibraryScopePair[];
  serverId: string;
  artistId: string;
  onPlayAllTracks: (songs: SubsonicSong[], index: number) => void;
}

/**
 * The artist's two track views behind one pair of tabs: the server's popularity
 * ranking, and everything the artist performs on.
 *
 * Only the table below the tabs changes. The full list is fetched the first time
 * its tab is opened — see `useArtistAllTracks` for why it is not loaded upfront.
 */
export default function ArtistDetailTracksSection({
  topSongs, topSongsLoading, albums, marginTop, playTopSongWithContinuation,
  losslessOnly = false, scopes, serverId, artistId, onPlayAllTracks,
}: Props) {
  const { t } = useTranslation();
  // Starts on the ranking for every artist: the caller keys this component by
  // artist id, so landing on another one mounts a fresh tab state rather than
  // carrying the previous artist's choice over.
  const [tab, setTab] = useState<TracksTab>('top');

  const allTracks = useArtistAllTracks({
    scopes,
    serverId,
    artistId,
    enabled: tab === 'all',
    losslessOnly,
  });

  // Owned here so the picker can live in the tab row; the table only reads it.
  const columns = useTracklistColumns(ARTIST_ALL_TRACKS_COLUMNS, ARTIST_ALL_TRACKS_STORAGE_KEY);
  const { setPickerOpen } = columns;

  // The picker menu renders into a portal on `body`, so hiding its button would
  // leave an open menu floating with nothing to belong to.
  const selectTab = (id: TracksTab) => {
    if (id !== 'all') setPickerOpen(() => false);
    setTab(id);
  };

  const tabs: ReadonlyArray<{ id: TracksTab; label: string }> = [
    { id: 'top', label: t(losslessOnly ? 'artistDetail.tracksTabLossless' : 'artistDetail.tracksTabTop') },
    { id: 'all', label: t('artistDetail.tracksTabAll') },
  ];

  // Arrow keys move between tabs, as WAI-ARIA expects of a tab list — the pills
  // are reachable with one Tab stop and stepped through from there.
  const onTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const index = tabs.findIndex(item => item.id === tab);
    const next = tabs[(index + step + tabs.length) % tabs.length];
    selectTab(next.id);
    e.currentTarget.querySelector<HTMLButtonElement>(`#artist-tracks-tab-${next.id}`)?.focus();
  };

  return (
    <div style={{ marginTop }}>
      <div className="artist-tracks-header">
        <h2 className="section-title" style={{ marginBottom: 0 }}>
          {t('artistDetail.tracksSectionTitle')}
        </h2>
        <div className="artist-tracks-controls">
          <div
            className="artist-tracks-tabs"
            role="tablist"
            aria-label={t('artistDetail.tracksTabsLabel')}
            onKeyDown={onTabKeyDown}
          >
            {tabs.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`artist-tracks-tab-${id}`}
                aria-selected={tab === id}
                aria-controls="artist-tracks-panel"
                tabIndex={tab === id ? 0 : -1}
                className={`btn ${tab === id ? 'btn-primary' : 'btn-ghost'} artist-tracks-tab`}
                onClick={() => selectTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          {/*
            Only the full list has columns to pick, but the picker keeps its space
            on the ranking tab: removing it would let the group re-centre and make
            the tabs jump sideways on every switch. `visibility: hidden` also takes
            it out of the tab order and off the accessibility tree.
          */}
          <div
            className={`artist-tracks-picker${tab === 'all' ? '' : ' is-hidden'}`}
            aria-hidden={tab !== 'all'}
          >
            <TracklistColumnPicker
              allColumns={ARTIST_ALL_TRACKS_COLUMNS}
              pickerRef={columns.pickerRef}
              pickerOpen={columns.pickerOpen}
              setPickerOpen={columns.setPickerOpen}
              colVisible={columns.colVisible}
              toggleColumn={columns.toggleColumn}
              resetColumns={columns.resetColumns}
              t={t}
            />
          </div>
        </div>
      </div>

      <div
        id="artist-tracks-panel"
        role="tabpanel"
        aria-labelledby={`artist-tracks-tab-${tab}`}
        style={{ marginBottom: '2rem' }}
      >
        {tab === 'top' ? (
          <ArtistDetailTopTracks
            topSongs={topSongs}
            loading={topSongsLoading}
            albums={albums}
            playTopSongWithContinuation={playTopSongWithContinuation}
          />
        ) : (
          <ArtistAllTracksList
            songs={allTracks.tracks}
            loading={allTracks.loading}
            failed={allTracks.failed}
            onPlay={onPlayAllTracks}
            columns={columns}
          />
        )}
      </div>
    </div>
  );
}
