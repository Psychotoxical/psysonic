import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown, ChevronRight, Disc3, ListMusic,
  Loader2, Shuffle, Users, Zap,
} from 'lucide-react';
import type {
  SubsonicAlbum, SubsonicArtist, SubsonicPlaylist,
} from '../../api/subsonicTypes';
import type { DeviceSyncSource } from '../../store/deviceSyncStore';
import type { SourceTab } from '../../utils/deviceSyncHelpers';
import BrowserRow from './BrowserRow';

interface Props {
  activeTab: SourceTab;
  setActiveTab: (t: SourceTab) => void;
  search: string;
  setSearch: (v: string) => void;
  playlists: SubsonicPlaylist[];
  randomAlbums: SubsonicAlbum[];
  albumSearchResults: SubsonicAlbum[];
  albumSearchLoading: boolean;
  artists: SubsonicArtist[];
  loadingBrowser: boolean;
  expandedArtistIds: Set<string>;
  artistAlbumsMap: Map<string, SubsonicAlbum[]>;
  loadingArtistIds: Set<string>;
  toggleArtistExpand: (artistId: string) => Promise<void>;
  sources: DeviceSyncSource[];
  pendingDeletion: string[];
  handleToggleSource: (source: DeviceSyncSource) => void;
}

export default function DeviceSyncBrowserPanel({
  activeTab, setActiveTab, search, setSearch,
  playlists, randomAlbums, albumSearchResults, albumSearchLoading,
  artists, loadingBrowser,
  expandedArtistIds, artistAlbumsMap, loadingArtistIds, toggleArtistExpand,
  sources, pendingDeletion, handleToggleSource,
}: Props) {
  const { t } = useTranslation();

  const tabs: { key: SourceTab; icon: React.ReactNode; label: string }[] = [
    { key: 'playlists', icon: <ListMusic size={14} />, label: t('deviceSync.tabPlaylists') },
    { key: 'albums',    icon: <Disc3 size={14} />,     label: t('deviceSync.tabAlbums') },
    { key: 'artists',   icon: <Users size={14} />,     label: t('deviceSync.tabArtists') },
  ];

  const q = search.toLowerCase();
  const filteredPlaylists = useMemo(() => playlists.filter(p => p.name.toLowerCase().includes(q)), [playlists, q]);
  const filteredArtists   = useMemo(() => artists.filter(a => a.name.toLowerCase().includes(q)), [artists, q]);

  return (
    <div className="device-sync-browser">
      <div className="device-sync-tabs">
        {tabs.map(tab => (
          <button
            key={tab.key}
            className={`device-sync-tab${activeTab === tab.key ? ' active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.icon}{tab.label}
          </button>
        ))}
      </div>
      <div className="device-sync-search-wrap">
        <input
          className="input"
          placeholder={t('deviceSync.searchPlaceholder')}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {activeTab === 'albums' && (
          <span className="device-sync-live-badge">
            <Zap size={10} />{t('deviceSync.liveSearch')}
          </span>
        )}
      </div>
      <div className="device-sync-list">
        {(loadingBrowser || albumSearchLoading) && (
          <div className="device-sync-loading"><Loader2 size={16} className="spin" /></div>
        )}
        {activeTab === 'albums' && !search.trim() && !loadingBrowser && randomAlbums.length > 0 && (
          <div className="device-sync-section-label">
            <Shuffle size={11} />{t('deviceSync.randomAlbumsLabel')}
          </div>
        )}
        {activeTab === 'playlists' && filteredPlaylists.map(pl => (
          <BrowserRow key={pl.id} name={pl.name} meta={`${pl.songCount} tracks`}
            selected={sources.some(s => s.id === pl.id) && !pendingDeletion.includes(pl.id)}
            onToggle={() => handleToggleSource({ type: 'playlist', id: pl.id, name: pl.name })} />
        ))}
        {activeTab === 'albums' && (search.trim() ? albumSearchResults : randomAlbums).map(al => (
          <BrowserRow key={al.id} name={al.name} meta={al.artist}
            selected={sources.some(s => s.id === al.id) && !pendingDeletion.includes(al.id)}
            onToggle={() => handleToggleSource({ type: 'album', id: al.id, name: al.name, artist: al.artist })} />
        ))}
        {activeTab === 'artists' && filteredArtists.map(ar => (
          <React.Fragment key={ar.id}>
            <div className="device-sync-artist-row">
              <button
                className="device-sync-expand-btn"
                onClick={() => toggleArtistExpand(ar.id)}
              >
                {loadingArtistIds.has(ar.id)
                  ? <Loader2 size={13} className="spin" />
                  : expandedArtistIds.has(ar.id)
                    ? <ChevronDown size={13} />
                    : <ChevronRight size={13} />}
              </button>
              <span className="device-sync-row-name">{ar.name}</span>
              {ar.albumCount != null &&
                <span className="device-sync-row-meta">{ar.albumCount} Albums</span>}
            </div>
            {expandedArtistIds.has(ar.id) && artistAlbumsMap.has(ar.id) &&
              artistAlbumsMap.get(ar.id)!.map(al => (
                <BrowserRow key={al.id} name={al.name} meta={al.year?.toString()}
                  selected={sources.some(s => s.id === al.id) && !pendingDeletion.includes(al.id)}
                  indent
                  onToggle={() => handleToggleSource({ type: 'album', id: al.id, name: al.name, artist: al.artist || ar.name })} />
              ))
            }
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
