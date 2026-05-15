import { useEffect, useState } from 'react';
import { getArtist, getArtistInfo, getTopSongs } from '../api/subsonicArtists';
import { getAlbum, getSong } from '../api/subsonicLibrary';
import type { SubsonicAlbum, SubsonicArtistInfo, SubsonicSong } from '../api/subsonicTypes';
import { fetchBandsintownEvents, type BandsintownEvent } from '../api/bandsintown';
import {
  lastfmGetArtistStats, lastfmGetTrackInfo, lastfmIsConfigured,
  type LastfmArtistStats, type LastfmTrackInfo,
} from '../api/lastfm';
import { makeCache } from '../utils/cache/nowPlayingCache';

// Module-level TTL caches (shared across mounts)
const songMetaCache    = makeCache<SubsonicSong | null>();
const artistInfoCache  = makeCache<SubsonicArtistInfo | null>();
const albumCache       = makeCache<{ album: SubsonicAlbum; songs: SubsonicSong[] } | null>();
const topSongsCache    = makeCache<SubsonicSong[]>();
const tourCache        = makeCache<BandsintownEvent[]>();
const discographyCache = makeCache<SubsonicAlbum[]>();
const lfmTrackCache    = makeCache<LastfmTrackInfo | null>();
const lfmArtistCache   = makeCache<LastfmArtistStats | null>();

export interface NowPlayingFetchersDeps {
  songId: string | undefined;
  artistId: string | undefined;
  albumId: string | undefined;
  artistName: string;
  enableBandsintown: boolean;
  audiomuseNavidromeEnabled: boolean;
  lastfmUsername: string;
  currentTrack: { artist: string; title: string } | null;
  /** Subsonic server for API calls — must match the playing queue server. */
  subsonicServerId: string;
  /** False while switching active server to the queue server. */
  fetchEnabled?: boolean;
}

export interface NowPlayingFetchersResult {
  songMeta: SubsonicSong | null;
  artistInfo: SubsonicArtistInfo | null;
  albumData: { album: SubsonicAlbum; songs: SubsonicSong[] } | null;
  topSongs: SubsonicSong[];
  tourEvents: BandsintownEvent[];
  tourLoading: boolean;
  discography: SubsonicAlbum[];
  lfmTrack: LastfmTrackInfo | null;
  lfmArtist: LastfmArtistStats | null;
}

function subsonicCacheKey(serverId: string, id: string): string {
  return serverId ? `${serverId}:${id}` : id;
}

export function useNowPlayingFetchers(deps: NowPlayingFetchersDeps): NowPlayingFetchersResult {
  const {
    songId, artistId, albumId, artistName, enableBandsintown, audiomuseNavidromeEnabled,
    lastfmUsername, currentTrack, subsonicServerId, fetchEnabled = true,
  } = deps;

  // Entity state, seeded from TTL cache so same-artist song switches are instant
  const [songMeta,   setSongMeta]   = useState<SubsonicSong | null>(() =>
    songId && subsonicServerId ? songMetaCache.get(subsonicCacheKey(subsonicServerId, songId)) ?? null : null);
  const [artistInfo, setArtistInfo] = useState<SubsonicArtistInfo | null>(() =>
    artistId && subsonicServerId ? artistInfoCache.get(subsonicCacheKey(subsonicServerId, artistId)) ?? null : null);
  const [albumData,  setAlbumData]  = useState<{ album: SubsonicAlbum; songs: SubsonicSong[] } | null>(() =>
    albumId && subsonicServerId ? albumCache.get(subsonicCacheKey(subsonicServerId, albumId)) ?? null : null);
  const [topSongs,   setTopSongs]   = useState<SubsonicSong[]>(() =>
    artistName && subsonicServerId ? topSongsCache.get(subsonicCacheKey(subsonicServerId, artistName)) ?? [] : []);
  const [tourEvents, setTourEvents] = useState<BandsintownEvent[]>(() => artistName ? tourCache.get(artistName) ?? [] : []);
  const [tourLoading, setTourLoading] = useState(false);
  const [discography, setDiscography] = useState<SubsonicAlbum[]>(() =>
    artistId && subsonicServerId ? discographyCache.get(subsonicCacheKey(subsonicServerId, artistId)) ?? [] : []);
  const [lfmTrack,   setLfmTrack]   = useState<LastfmTrackInfo | null>(null);
  const [lfmArtist,  setLfmArtist]  = useState<LastfmArtistStats | null>(null);

  // Fetch batch per entity change (not per song switch — same-artist songs share artist/top/tour fetches)
  useEffect(() => {
    if (!fetchEnabled || !subsonicServerId || !songId) { setSongMeta(null); return; }
    const cacheKey = subsonicCacheKey(subsonicServerId, songId);
    const cached = songMetaCache.get(cacheKey);
    if (cached !== undefined) { setSongMeta(cached); return; }
    let cancelled = false;
    getSong(songId)
      .then(v => { if (!cancelled) { songMetaCache.set(cacheKey, v ?? null); setSongMeta(v ?? null); } })
      .catch(() => { if (!cancelled) { songMetaCache.set(cacheKey, null); setSongMeta(null); } });
    return () => { cancelled = true; };
  }, [fetchEnabled, subsonicServerId, songId]);

  useEffect(() => {
    if (!fetchEnabled || !subsonicServerId || !artistId) { setArtistInfo(null); return; }
    const cacheKey = subsonicCacheKey(subsonicServerId, artistId);
    const cached = artistInfoCache.get(cacheKey);
    if (cached !== undefined) { setArtistInfo(cached); return; }
    let cancelled = false;
    getArtistInfo(artistId, { similarArtistCount: audiomuseNavidromeEnabled ? 24 : undefined })
      .then(v => { if (!cancelled) { artistInfoCache.set(cacheKey, v ?? null); setArtistInfo(v ?? null); } })
      .catch(() => { if (!cancelled) { artistInfoCache.set(cacheKey, null); setArtistInfo(null); } });
    return () => { cancelled = true; };
  }, [fetchEnabled, subsonicServerId, artistId, audiomuseNavidromeEnabled]);

  useEffect(() => {
    if (!fetchEnabled || !subsonicServerId || !albumId) { setAlbumData(null); return; }
    const cacheKey = subsonicCacheKey(subsonicServerId, albumId);
    const cached = albumCache.get(cacheKey);
    if (cached !== undefined) { setAlbumData(cached); return; }
    let cancelled = false;
    getAlbum(albumId)
      .then(v => { if (!cancelled) { albumCache.set(cacheKey, v); setAlbumData(v); } })
      .catch(() => { if (!cancelled) { albumCache.set(cacheKey, null); setAlbumData(null); } });
    return () => { cancelled = true; };
  }, [fetchEnabled, subsonicServerId, albumId]);

  useEffect(() => {
    if (!fetchEnabled || !subsonicServerId || !artistName) { setTopSongs([]); return; }
    const cacheKey = subsonicCacheKey(subsonicServerId, artistName);
    const cached = topSongsCache.get(cacheKey);
    if (cached !== undefined) { setTopSongs(cached); return; }
    let cancelled = false;
    getTopSongs(artistName)
      .then(v => { if (!cancelled) { topSongsCache.set(cacheKey, v); setTopSongs(v); } })
      .catch(() => { if (!cancelled) { topSongsCache.set(cacheKey, []); setTopSongs([]); } });
    return () => { cancelled = true; };
  }, [fetchEnabled, subsonicServerId, artistName]);

  useEffect(() => {
    if (!enableBandsintown || !artistName) { setTourEvents([]); return; }
    const cached = tourCache.get(artistName);
    if (cached !== undefined) { setTourEvents(cached); setTourLoading(false); return; }
    let cancelled = false;
    setTourLoading(true);
    fetchBandsintownEvents(artistName)
      .then(v => { if (!cancelled) { tourCache.set(artistName, v); setTourEvents(v); } })
      .finally(() => { if (!cancelled) setTourLoading(false); });
    return () => { cancelled = true; };
  }, [enableBandsintown, artistName]);

  // Discography via getArtist
  useEffect(() => {
    if (!fetchEnabled || !subsonicServerId || !artistId) { setDiscography([]); return; }
    const cacheKey = subsonicCacheKey(subsonicServerId, artistId);
    const cached = discographyCache.get(cacheKey);
    if (cached !== undefined) { setDiscography(cached); return; }
    let cancelled = false;
    getArtist(artistId)
      .then(v => { if (!cancelled) { discographyCache.set(cacheKey, v.albums); setDiscography(v.albums); } })
      .catch(() => { if (!cancelled) { discographyCache.set(cacheKey, []); setDiscography([]); } });
    return () => { cancelled = true; };
  }, [fetchEnabled, subsonicServerId, artistId]);

  // Last.fm track info (per-track)
  const lfmTrackKey = currentTrack ? `${currentTrack.artist} ${currentTrack.title} ${lastfmUsername}` : '';
  useEffect(() => {
    if (!lastfmIsConfigured() || !currentTrack) { setLfmTrack(null); return; }
    const cached = lfmTrackCache.get(lfmTrackKey);
    if (cached !== undefined) { setLfmTrack(cached); return; }
    let cancelled = false;
    lastfmGetTrackInfo(currentTrack.artist, currentTrack.title, lastfmUsername || undefined)
      .then(v => { if (!cancelled) { lfmTrackCache.set(lfmTrackKey, v); setLfmTrack(v); } })
      .catch(() => { if (!cancelled) { lfmTrackCache.set(lfmTrackKey, null); setLfmTrack(null); } });
    return () => { cancelled = true; };
  }, [lfmTrackKey, currentTrack, lastfmUsername]);

  // Last.fm artist stats (per-artist — shared across same-artist tracks)
  const lfmArtistKey = artistName ? `${artistName} ${lastfmUsername}` : '';
  useEffect(() => {
    if (!lastfmIsConfigured() || !artistName) { setLfmArtist(null); return; }
    const cached = lfmArtistCache.get(lfmArtistKey);
    if (cached !== undefined) { setLfmArtist(cached); return; }
    let cancelled = false;
    lastfmGetArtistStats(artistName, lastfmUsername || undefined)
      .then(v => { if (!cancelled) { lfmArtistCache.set(lfmArtistKey, v); setLfmArtist(v); } })
      .catch(() => { if (!cancelled) { lfmArtistCache.set(lfmArtistKey, null); setLfmArtist(null); } });
    return () => { cancelled = true; };
  }, [lfmArtistKey, artistName, lastfmUsername]);

  return { songMeta, artistInfo, albumData, topSongs, tourEvents, tourLoading, discography, lfmTrack, lfmArtist };
}
