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

// id-keyed slots are held as `{ id, value }` tuples and gated on id-match in
// the return statement. Without the gate, a track switch renders one frame
// with the previous track's value paired with the new id — consumers that
// build a cacheKey from the new id (e.g. CachedImage) would persist a
// mismatched blob in IndexedDB and never recover. See PR #732 for the same
// fix inside `NowPlayingInfo.tsx`.
type IdSlot<T> = { id: string; value: T } | null;
function seedSlot<T>(id: string, lookup: (id: string) => T | undefined): IdSlot<T> {
  if (!id) return null;
  const cached = lookup(id);
  return cached === undefined ? null : { id, value: cached };
}

export function useNowPlayingFetchers(deps: NowPlayingFetchersDeps): NowPlayingFetchersResult {
  const {
    songId, artistId, albumId, artistName, enableBandsintown, audiomuseNavidromeEnabled,
    lastfmUsername, currentTrack, subsonicServerId, fetchEnabled = true,
  } = deps;

  // id-keyed entity state — seeded from TTL cache so same-artist song switches
  // are instant. Held as `{ id, value }` tuples and gated below.
  const [songMetaEntry,   setSongMetaEntry]   = useState<IdSlot<SubsonicSong | null>>(() =>
    seedSlot(songId && subsonicServerId ? songId : '', k => songMetaCache.get(subsonicCacheKey(subsonicServerId, k))));
  const [artistInfoEntry, setArtistInfoEntry] = useState<IdSlot<SubsonicArtistInfo | null>>(() =>
    seedSlot(artistId && subsonicServerId ? artistId : '', k => artistInfoCache.get(subsonicCacheKey(subsonicServerId, k))));
  const [albumDataEntry,  setAlbumDataEntry]  = useState<IdSlot<{ album: SubsonicAlbum; songs: SubsonicSong[] } | null>>(() =>
    seedSlot(albumId && subsonicServerId ? albumId : '', k => albumCache.get(subsonicCacheKey(subsonicServerId, k))));
  const [discographyEntry, setDiscographyEntry] = useState<IdSlot<SubsonicAlbum[]>>(() =>
    seedSlot(artistId && subsonicServerId ? artistId : '', k => discographyCache.get(subsonicCacheKey(subsonicServerId, k))));

  // Name-keyed / global state — no cacheKey/persistence hazard, kept as plain state.
  const [topSongs,   setTopSongs]   = useState<SubsonicSong[]>(() =>
    artistName && subsonicServerId ? topSongsCache.get(subsonicCacheKey(subsonicServerId, artistName)) ?? [] : []);
  const [tourEvents, setTourEvents] = useState<BandsintownEvent[]>(() => artistName ? tourCache.get(artistName) ?? [] : []);
  const [tourLoading, setTourLoading] = useState(false);
  const [lfmTrack,   setLfmTrack]   = useState<LastfmTrackInfo | null>(null);
  const [lfmArtist,  setLfmArtist]  = useState<LastfmArtistStats | null>(null);

  // Fetch batch per entity change (not per song switch — same-artist songs share artist/top/tour fetches)
  useEffect(() => {
    if (!fetchEnabled || !subsonicServerId || !songId) { setSongMetaEntry(null); return; }
    const cacheKey = subsonicCacheKey(subsonicServerId, songId);
    const cached = songMetaCache.get(cacheKey);
    if (cached !== undefined) { setSongMetaEntry({ id: songId, value: cached }); return; }
    setSongMetaEntry(null);
    let cancelled = false;
    getSong(songId)
      .then(v => { if (!cancelled) { songMetaCache.set(cacheKey, v ?? null); setSongMetaEntry({ id: songId, value: v ?? null }); } })
      .catch(() => { if (!cancelled) { songMetaCache.set(cacheKey, null); setSongMetaEntry({ id: songId, value: null }); } });
    return () => { cancelled = true; };
  }, [fetchEnabled, subsonicServerId, songId]);

  useEffect(() => {
    if (!fetchEnabled || !subsonicServerId || !artistId) { setArtistInfoEntry(null); return; }
    const cacheKey = subsonicCacheKey(subsonicServerId, artistId);
    const cached = artistInfoCache.get(cacheKey);
    if (cached !== undefined) { setArtistInfoEntry({ id: artistId, value: cached }); return; }
    setArtistInfoEntry(null);
    let cancelled = false;
    getArtistInfo(artistId, { similarArtistCount: audiomuseNavidromeEnabled ? 24 : undefined })
      .then(v => { if (!cancelled) { artistInfoCache.set(cacheKey, v ?? null); setArtistInfoEntry({ id: artistId, value: v ?? null }); } })
      .catch(() => { if (!cancelled) { artistInfoCache.set(cacheKey, null); setArtistInfoEntry({ id: artistId, value: null }); } });
    return () => { cancelled = true; };
  }, [fetchEnabled, subsonicServerId, artistId, audiomuseNavidromeEnabled]);

  useEffect(() => {
    if (!fetchEnabled || !subsonicServerId || !albumId) { setAlbumDataEntry(null); return; }
    const cacheKey = subsonicCacheKey(subsonicServerId, albumId);
    const cached = albumCache.get(cacheKey);
    if (cached !== undefined) { setAlbumDataEntry({ id: albumId, value: cached }); return; }
    setAlbumDataEntry(null);
    let cancelled = false;
    getAlbum(albumId)
      .then(v => { if (!cancelled) { albumCache.set(cacheKey, v); setAlbumDataEntry({ id: albumId, value: v }); } })
      .catch(() => { if (!cancelled) { albumCache.set(cacheKey, null); setAlbumDataEntry({ id: albumId, value: null }); } });
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
    if (!fetchEnabled || !subsonicServerId || !artistId) { setDiscographyEntry(null); return; }
    const cacheKey = subsonicCacheKey(subsonicServerId, artistId);
    const cached = discographyCache.get(cacheKey);
    if (cached !== undefined) { setDiscographyEntry({ id: artistId, value: cached }); return; }
    setDiscographyEntry(null);
    let cancelled = false;
    getArtist(artistId)
      .then(v => { if (!cancelled) { discographyCache.set(cacheKey, v.albums); setDiscographyEntry({ id: artistId, value: v.albums }); } })
      .catch(() => { if (!cancelled) { discographyCache.set(cacheKey, []); setDiscographyEntry({ id: artistId, value: [] }); } });
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

  // Gate id-keyed slots on id-match so consumers never see a value paired
  // with the wrong id, even on the single render between an id change and
  // the next effect run.
  const songMeta    = songMetaEntry    && songMetaEntry.id    === songId   ? songMetaEntry.value    : null;
  const artistInfo  = artistInfoEntry  && artistInfoEntry.id  === artistId ? artistInfoEntry.value  : null;
  const albumData   = albumDataEntry   && albumDataEntry.id   === albumId  ? albumDataEntry.value   : null;
  const discography = discographyEntry && discographyEntry.id === artistId ? discographyEntry.value : [];

  return { songMeta, artistInfo, albumData, topSongs, tourEvents, tourLoading, discography, lfmTrack, lfmArtist };
}
