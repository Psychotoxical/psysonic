import { useEffect, useState } from 'react';
import { getArtistInfoForServer } from '@/lib/api/subsonicArtists';
import type { SubsonicAlbum, SubsonicArtistInfo, SubsonicSong } from '@/lib/api/subsonicTypes';
import { resolveNpAlbum, resolveNpDiscography, resolveNpSongMeta, resolveNpTopSongs } from '@/features/nowPlaying/utils/nowPlayingMetadataResolve';
import { fetchBandsintownEvents, type BandsintownEvent } from '@/lib/api/bandsintown';
import type { ArtistStats, TrackStats } from '@/music-network';
import { getMusicNetworkRuntimeOrNull } from '@/music-network';
import { makeCache } from '@/lib/cache/nowPlayingCache';
import { shouldAttemptSubsonicForServer } from '@/lib/network/subsonicNetworkGuard';
import { useConnectionStatus } from '@/lib/hooks/useConnectionStatus';

// Module-level TTL caches (shared across mounts)
const songMetaCache    = makeCache<SubsonicSong | null>();
const artistInfoCache  = makeCache<SubsonicArtistInfo | null>();
const albumCache       = makeCache<{ album: SubsonicAlbum; songs: SubsonicSong[] } | null>();
const topSongsCache    = makeCache<SubsonicSong[]>();
const tourCache        = makeCache<BandsintownEvent[]>();
const discographyCache = makeCache<SubsonicAlbum[]>();
const networkTrackCache    = makeCache<TrackStats | null>();
const networkArtistCache   = makeCache<ArtistStats | null>();

export interface NowPlayingFetchersDeps {
  songId: string | undefined;
  artistId: string | undefined;
  albumId: string | undefined;
  artistName: string;
  enableBandsintown: boolean;
  audiomuseNavidromeEnabled: boolean;
  enrichmentKey: string;
  currentTrack: { artist: string; title: string } | null;
  /** Subsonic server for API calls — must match the playing queue server. */
  subsonicServerId: string;
  /**
   * Caller intent / prerequisites only (e.g. "we have a playback server id").
   * The network reachability decision — online, server reachable, and no
   * trackId so local-cache playback still loads metadata — is made here via
   * `shouldAttemptSubsonicForServer`; callers must not pre-apply that guard.
   */
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
  networkTrack: TrackStats | null;
  networkArtist: ArtistStats | null;
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
type KeySlot<T> = { key: string; value: T } | null;
function seedSlot<T>(id: string, lookup: (id: string) => T | undefined): IdSlot<T> {
  if (!id) return null;
  const cached = lookup(id);
  return cached === undefined ? null : { id, value: cached };
}

function seedKeySlot<T>(key: string, lookup: (key: string) => T | undefined): KeySlot<T> {
  if (!key) return null;
  const cached = lookup(key);
  return cached === undefined ? null : { key, value: cached };
}

export async function prewarmNowPlayingFetchers(
  deps: NowPlayingFetchersDeps,
): Promise<void> {
  const {
    songId, artistId, albumId, artistName, enableBandsintown, audiomuseNavidromeEnabled,
    enrichmentKey, currentTrack, subsonicServerId, fetchEnabled = true,
  } = deps;

  if (!fetchEnabled || !subsonicServerId) return;
  // Index-first resolvers run whenever there's a server id (offline included) —
  // each guards its own network fallback. artistInfo below is the one
  // network-only job, so it keeps the reachability gate.

  const jobs: Array<Promise<unknown>> = [];

  if (songId) {
    const cacheKey = subsonicCacheKey(subsonicServerId, songId);
    if (songMetaCache.get(cacheKey) === undefined) {
      jobs.push(
        resolveNpSongMeta(subsonicServerId, songId)
          .then(v => songMetaCache.set(cacheKey, v ?? null))
          .catch(() => songMetaCache.set(cacheKey, null)),
      );
    }
  }

  if (artistId) {
    const artistKey = subsonicCacheKey(subsonicServerId, artistId);
    // artistInfo (bio/similar) is network-only — keep the reachability gate.
    if (shouldAttemptSubsonicForServer(subsonicServerId) && artistInfoCache.get(artistKey) === undefined) {
      jobs.push(
        getArtistInfoForServer(subsonicServerId, artistId, {
          similarArtistCount: audiomuseNavidromeEnabled ? 24 : undefined,
        })
          .then(v => artistInfoCache.set(artistKey, v ?? null))
          .catch(() => artistInfoCache.set(artistKey, null)),
      );
    }
    if (discographyCache.get(artistKey) === undefined) {
      jobs.push(
        resolveNpDiscography(subsonicServerId, artistId)
          .then(albums => discographyCache.set(artistKey, albums))
          .catch(() => discographyCache.set(artistKey, [])),
      );
    }
  }

  if (albumId) {
    const cacheKey = subsonicCacheKey(subsonicServerId, albumId);
    if (albumCache.get(cacheKey) === undefined) {
      jobs.push(
        resolveNpAlbum(subsonicServerId, albumId)
          .then(v => albumCache.set(cacheKey, v))
          .catch(() => albumCache.set(cacheKey, null)),
      );
    }
  }

  if (artistName) {
    const cacheKey = subsonicCacheKey(subsonicServerId, artistName);
    if (topSongsCache.get(cacheKey) === undefined) {
      jobs.push(
        resolveNpTopSongs(subsonicServerId, artistId, artistName)
          .then(v => topSongsCache.set(cacheKey, v))
          .catch(() => topSongsCache.set(cacheKey, [])),
      );
    }
    if (enableBandsintown && tourCache.get(artistName) === undefined) {
      jobs.push(
        fetchBandsintownEvents(artistName)
          .then(v => tourCache.set(artistName, v))
          .catch(() => tourCache.set(artistName, [])),
      );
    }
  }

  const prewarmRuntime = getMusicNetworkRuntimeOrNull();
  if (prewarmRuntime?.getEnrichmentPrimaryId() && currentTrack) {
    const trackKey = `${currentTrack.artist} ${currentTrack.title} ${enrichmentKey}`;
    if (networkTrackCache.get(trackKey) === undefined) {
      jobs.push(
        prewarmRuntime.getTrackStats({ title: currentTrack.title, artist: currentTrack.artist })
          .then(v => networkTrackCache.set(trackKey, v))
          .catch(() => networkTrackCache.set(trackKey, null)),
      );
    }
    const artistKey = `${currentTrack.artist} ${enrichmentKey}`;
    if (networkArtistCache.get(artistKey) === undefined) {
      jobs.push(
        prewarmRuntime.getArtistStats(currentTrack.artist)
          .then(v => networkArtistCache.set(artistKey, v))
          .catch(() => networkArtistCache.set(artistKey, null)),
      );
    }
  }

  await Promise.allSettled(jobs);
}

export function useNowPlayingFetchers(deps: NowPlayingFetchersDeps): NowPlayingFetchersResult {
  const {
    songId, artistId, albumId, artistName, enableBandsintown, audiomuseNavidromeEnabled,
    enrichmentKey, currentTrack, subsonicServerId, fetchEnabled = true,
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
  const topSongsKey = artistName && subsonicServerId ? subsonicCacheKey(subsonicServerId, artistName) : '';
  const tourKey = enableBandsintown && artistName ? artistName : '';
  const [topSongsEntry, setTopSongsEntry] = useState<KeySlot<SubsonicSong[]>>(() =>
    seedKeySlot(topSongsKey, k => topSongsCache.get(k)));
  const [tourEventsEntry, setTourEventsEntry] = useState<KeySlot<BandsintownEvent[]>>(() =>
    seedKeySlot(tourKey, k => tourCache.get(k)));
  const [tourLoading, setTourLoading] = useState(false);
  const networkTrackKey = currentTrack ? `${currentTrack.artist} ${currentTrack.title} ${enrichmentKey}` : '';
  const networkArtistKey = artistName ? `${artistName} ${enrichmentKey}` : '';
  const [networkTrackEntry, setNetworkTrackEntry] = useState<KeySlot<TrackStats | null>>(() =>
    seedKeySlot(networkTrackKey, k => networkTrackCache.get(k)));
  const [networkArtistEntry, setNetworkArtistEntry] = useState<KeySlot<ArtistStats | null>>(() =>
    seedKeySlot(networkArtistKey, k => networkArtistCache.get(k)));

  const { status: connStatus } = useConnectionStatus();
  // Gate split (PR #1049): index-first resolvers run whenever there's a server id
  // — they read SQLite even when the server is unreachable (the offline win) and
  // guard their own network fallback. Only artistInfo (bio/similar, no index) is
  // network-only, so it keeps the reachability gate.
  const indexFetchAllowed = fetchEnabled && !!subsonicServerId;
  const networkOnlyAllowed = indexFetchAllowed && shouldAttemptSubsonicForServer(subsonicServerId);

  // Fetch batch per entity change (not per song switch — same-artist songs share artist/top/tour fetches)
  useEffect(() => {
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!indexFetchAllowed || !songId) { setSongMetaEntry(null); return; }
    const cacheKey = subsonicCacheKey(subsonicServerId, songId);
    const cached = songMetaCache.get(cacheKey);
    if (cached !== undefined) { setSongMetaEntry({ id: songId, value: cached }); return; }
    setSongMetaEntry(null);
    let cancelled = false;
    resolveNpSongMeta(subsonicServerId, songId)
      .then(v => { if (!cancelled) { songMetaCache.set(cacheKey, v ?? null); setSongMetaEntry({ id: songId, value: v ?? null }); } })
      .catch(() => { if (!cancelled) { songMetaCache.set(cacheKey, null); setSongMetaEntry({ id: songId, value: null }); } });
    return () => { cancelled = true; };
  }, [indexFetchAllowed, subsonicServerId, songId, connStatus]);

  useEffect(() => {
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!networkOnlyAllowed || !artistId) { setArtistInfoEntry(null); return; }
    const cacheKey = subsonicCacheKey(subsonicServerId, artistId);
    const cached = artistInfoCache.get(cacheKey);
    if (cached !== undefined) { setArtistInfoEntry({ id: artistId, value: cached }); return; }
    setArtistInfoEntry(null);
    let cancelled = false;
    getArtistInfoForServer(subsonicServerId, artistId, { similarArtistCount: audiomuseNavidromeEnabled ? 24 : undefined })
      .then(v => { if (!cancelled) { artistInfoCache.set(cacheKey, v ?? null); setArtistInfoEntry({ id: artistId, value: v ?? null }); } })
      .catch(() => { if (!cancelled) { artistInfoCache.set(cacheKey, null); setArtistInfoEntry({ id: artistId, value: null }); } });
    return () => { cancelled = true; };
  }, [networkOnlyAllowed, subsonicServerId, artistId, audiomuseNavidromeEnabled, connStatus]);

  useEffect(() => {
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!indexFetchAllowed || !albumId) { setAlbumDataEntry(null); return; }
    const cacheKey = subsonicCacheKey(subsonicServerId, albumId);
    const cached = albumCache.get(cacheKey);
    if (cached !== undefined) { setAlbumDataEntry({ id: albumId, value: cached }); return; }
    setAlbumDataEntry(null);
    let cancelled = false;
    resolveNpAlbum(subsonicServerId, albumId)
      .then(v => { if (!cancelled) { albumCache.set(cacheKey, v); setAlbumDataEntry({ id: albumId, value: v }); } })
      .catch(() => { if (!cancelled) { albumCache.set(cacheKey, null); setAlbumDataEntry({ id: albumId, value: null }); } });
    return () => { cancelled = true; };
  }, [indexFetchAllowed, subsonicServerId, albumId, connStatus]);

  useEffect(() => {
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!indexFetchAllowed || !topSongsKey) { setTopSongsEntry(null); return; }
    const cached = topSongsCache.get(topSongsKey);
    if (cached !== undefined) { setTopSongsEntry({ key: topSongsKey, value: cached }); return; }
    setTopSongsEntry(null);
    let cancelled = false;
    resolveNpTopSongs(subsonicServerId, artistId, artistName)
      .then(v => { if (!cancelled) { topSongsCache.set(topSongsKey, v); setTopSongsEntry({ key: topSongsKey, value: v }); } })
      .catch(() => { if (!cancelled) { topSongsCache.set(topSongsKey, []); setTopSongsEntry({ key: topSongsKey, value: [] }); } });
    return () => { cancelled = true; };
  }, [indexFetchAllowed, topSongsKey, subsonicServerId, artistId, artistName, connStatus]);

  useEffect(() => {
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!tourKey) { setTourEventsEntry(null); setTourLoading(false); return; }
    const cached = tourCache.get(tourKey);
    if (cached !== undefined) { setTourEventsEntry({ key: tourKey, value: cached }); setTourLoading(false); return; }
    let cancelled = false;
    setTourLoading(true);
    setTourEventsEntry(null);
    fetchBandsintownEvents(artistName)
      .then(v => { if (!cancelled) { tourCache.set(tourKey, v); setTourEventsEntry({ key: tourKey, value: v }); } })
      .finally(() => { if (!cancelled) setTourLoading(false); });
    return () => { cancelled = true; };
  }, [tourKey, artistName]);

  // Discography via getArtist
  useEffect(() => {
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!indexFetchAllowed || !artistId) { setDiscographyEntry(null); return; }
    const cacheKey = subsonicCacheKey(subsonicServerId, artistId);
    const cached = discographyCache.get(cacheKey);
    if (cached !== undefined) { setDiscographyEntry({ id: artistId, value: cached }); return; }
    setDiscographyEntry(null);
    let cancelled = false;
    resolveNpDiscography(subsonicServerId, artistId)
      .then(albums => { if (!cancelled) { discographyCache.set(cacheKey, albums); setDiscographyEntry({ id: artistId, value: albums }); } })
      .catch(() => { if (!cancelled) { discographyCache.set(cacheKey, []); setDiscographyEntry({ id: artistId, value: [] }); } });
    return () => { cancelled = true; };
  }, [indexFetchAllowed, subsonicServerId, artistId, connStatus]);

  // Enrichment track stats (per-track, from the enrichment primary)
  useEffect(() => {
    const runtime = getMusicNetworkRuntimeOrNull();
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!runtime?.getEnrichmentPrimaryId() || !currentTrack || !networkTrackKey) { setNetworkTrackEntry(null); return; }
    const cached = networkTrackCache.get(networkTrackKey);
    if (cached !== undefined) { setNetworkTrackEntry({ key: networkTrackKey, value: cached }); return; }
    setNetworkTrackEntry(null);
    let cancelled = false;
    runtime.getTrackStats({ title: currentTrack.title, artist: currentTrack.artist })
      .then(v => { if (!cancelled) { networkTrackCache.set(networkTrackKey, v); setNetworkTrackEntry({ key: networkTrackKey, value: v }); } })
      .catch(() => { if (!cancelled) { networkTrackCache.set(networkTrackKey, null); setNetworkTrackEntry({ key: networkTrackKey, value: null }); } });
    return () => { cancelled = true; };
  }, [networkTrackKey, currentTrack, enrichmentKey]);

  // Enrichment artist stats (per-artist — shared across same-artist tracks)
  useEffect(() => {
    const runtime = getMusicNetworkRuntimeOrNull();
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!runtime?.getEnrichmentPrimaryId() || !artistName || !networkArtistKey) { setNetworkArtistEntry(null); return; }
    const cached = networkArtistCache.get(networkArtistKey);
    if (cached !== undefined) { setNetworkArtistEntry({ key: networkArtistKey, value: cached }); return; }
    setNetworkArtistEntry(null);
    let cancelled = false;
    runtime.getArtistStats(artistName)
      .then(v => { if (!cancelled) { networkArtistCache.set(networkArtistKey, v); setNetworkArtistEntry({ key: networkArtistKey, value: v }); } })
      .catch(() => { if (!cancelled) { networkArtistCache.set(networkArtistKey, null); setNetworkArtistEntry({ key: networkArtistKey, value: null }); } });
    return () => { cancelled = true; };
  }, [networkArtistKey, artistName, enrichmentKey]);

  // Gate id-keyed slots on id-match so consumers never see a value paired
  // with the wrong id, even on the single render between an id change and
  // the next effect run.
  const songMeta    = songMetaEntry    && songMetaEntry.id    === songId   ? songMetaEntry.value    : null;
  const artistInfo  = artistInfoEntry  && artistInfoEntry.id  === artistId ? artistInfoEntry.value  : null;
  const albumData   = albumDataEntry   && albumDataEntry.id   === albumId  ? albumDataEntry.value   : null;
  const discography = discographyEntry && discographyEntry.id === artistId ? discographyEntry.value : [];
  const topSongs = topSongsEntry && topSongsEntry.key === topSongsKey ? topSongsEntry.value : [];
  const tourEvents = tourEventsEntry && tourEventsEntry.key === tourKey ? tourEventsEntry.value : [];
  const networkTrack = networkTrackEntry && networkTrackEntry.key === networkTrackKey ? networkTrackEntry.value : null;
  const networkArtist = networkArtistEntry && networkArtistEntry.key === networkArtistKey ? networkArtistEntry.value : null;

  return { songMeta, artistInfo, albumData, topSongs, tourEvents, tourLoading, discography, networkTrack, networkArtist };
}
