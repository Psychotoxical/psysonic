// Audioscrobbler v2 wire — implements the full enrichment surface.
//
// Backs Last.fm, Libre.fm, Rocksky, custom GNU FM, and the Maloja Audioscrobbler
// compat preset. This is the only wire that implements EnrichmentWire; it is the
// behavioural successor to the legacy src/api/lastfm.ts and preserves every
// Last.fm feature (scrobble, now playing, love/unlove, loved sync, similar
// artists, track/artist stats, top lists, recent tracks, user profile, urls).

import {
  type CapabilitySet,
  ENRICHMENT_CAPABILITIES,
  markNoEnrichment,
} from '../../core/capabilities';
import type {
  ArtistStats,
  RecentTrack,
  StatsPeriod,
  TopItem,
  TopKind,
  TrackRef,
  TrackStats,
  UserProfile,
  WireId,
} from '../../core/types';
import type { EnrichmentWire } from '../../contracts/EnrichmentWire';
import type {
  ConnectContext,
  ConnectResult,
  WireContext,
} from '../../contracts/ScrobbleWire';
import { audioscrobblerCall } from './client';
import { tokenPollStrategy } from './auth/tokenPoll';
import { apiKeyOnlyStrategy } from '../shared/apiKeyOnly';
import { MusicNetworkError } from '../../core/errors';

function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function topTags(raw: unknown, max = 5): string[] {
  return toArray(raw).map(tg => String((tg as { name?: unknown }).name)).slice(0, max);
}

class AudioscrobblerWireImpl implements EnrichmentWire {
  readonly wireId: WireId = 'audioscrobbler_v2';
  readonly supportsEnrichment = true as const;

  connect(ctx: ConnectContext): Promise<ConnectResult> {
    // Last.fm / Libre.fm use the browser token-poll flow; Rocksky has no
    // auth.getToken and the user pastes a session key from `rocksky login`.
    if (ctx.authStrategy === 'api_key_only') return apiKeyOnlyStrategy.connect(ctx);
    return tokenPollStrategy.connect(ctx);
  }

  disconnect(): void {
    // Session teardown is store-side; nothing to revoke on the wire.
  }

  async scrobble(ctx: WireContext, event: { title: string; artist: string; album: string; duration: number; timestamp: number }): Promise<void> {
    // Batch/array form (`artist[0]`, `track[0]`, …) is the documented
    // Audioscrobbler track.scrobble shape. Last.fm/Libre.fm also accept the bare
    // single form, but Rocksky requires the indexed array form — so we use the
    // standard everywhere.
    await audioscrobblerCall(ctx, {
      method: 'track.scrobble',
      'track[0]': event.title,
      'artist[0]': event.artist,
      'album[0]': event.album,
      'duration[0]': String(Math.round(event.duration)),
      'timestamp[0]': String(Math.floor(event.timestamp / 1000)),
      sk: ctx.sessionKey,
    }, true, false);
  }

  async updateNowPlaying(ctx: WireContext, event: { title: string; artist: string; album: string; duration: number }): Promise<void> {
    await audioscrobblerCall(ctx, {
      method: 'track.updateNowPlaying',
      track: event.title,
      artist: event.artist,
      album: event.album,
      duration: String(Math.round(event.duration)),
      sk: ctx.sessionKey,
    }, true, false);
  }

  /**
   * Validates the session with a single user.getInfo call and derives the whole
   * enrichment set from it. One call instead of probing each capability keeps
   * connect cheap (performance-first); individual methods degrade gracefully at
   * call time if a self-hosted GNU FM lacks a specific endpoint.
   */
  async probe(ctx: WireContext): Promise<CapabilitySet> {
    const caps: CapabilitySet = {
      scrobble: { status: 'yes' },
      nowPlaying: { status: 'yes' },
    };

    // Paste-auth presets (Rocksky, Maloja Audioscrobbler) only had the credential
    // checked for non-emptiness at connect, and they don't do enrichment — so
    // validate the pasted session key here with a SIGNED call. We flip scrobble to
    // 'error' ONLY on a genuine auth failure: a scrobble-only service that rejects
    // user.getInfo ("Unsupported method" → NETWORK) or a transient blip is NOT
    // proof of a bad key, so it leaves scrobble optimistic (no false reconnect).
    if (ctx.authStrategy === 'api_key_only') {
      try {
        await audioscrobblerCall(ctx, { method: 'user.getInfo', user: ctx.username, sk: ctx.sessionKey }, true, false);
      } catch (e) {
        if (e instanceof MusicNetworkError && e.code === 'AUTH_SESSION_INVALID') {
          caps.scrobble = { status: 'error', message: e.message };
          caps.nowPlaying = { status: 'error', message: e.message };
        }
      }
      return markNoEnrichment(caps);
    }

    // Token-poll presets: the session was already validated by the browser flow.
    // One unsigned user.getInfo derives the whole enrichment set; a self-hosted
    // GNU FM lacking it degrades gracefully (enrichment-only error).
    try {
      const data = await audioscrobblerCall(ctx, { method: 'user.getInfo', user: ctx.username, sk: ctx.sessionKey }, false, true);
      const ok = Boolean(data?.user);
      for (const id of ENRICHMENT_CAPABILITIES) {
        caps[id] = { status: ok ? 'yes' : 'error' };
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      for (const id of ENRICHMENT_CAPABILITIES) {
        caps[id] = { status: 'error', message };
      }
    }
    return caps;
  }

  async getTrackLoved(ctx: WireContext, ref: TrackRef): Promise<boolean> {
    try {
      const data = await audioscrobblerCall(ctx, { method: 'track.getInfo', track: ref.title, artist: ref.artist, sk: ctx.sessionKey }, false, true);
      return data?.track?.userloved === '1' || data?.track?.userloved === 1;
    } catch {
      return false;
    }
  }

  async loveTrack(ctx: WireContext, ref: TrackRef, loved: boolean): Promise<void> {
    await audioscrobblerCall(ctx, {
      method: loved ? 'track.love' : 'track.unlove',
      track: ref.title,
      artist: ref.artist,
      sk: ctx.sessionKey,
    }, true, false);
  }

  async getAllLovedTracks(ctx: WireContext): Promise<TrackRef[]> {
    const results: TrackRef[] = [];
    let page = 1;
    const limit = 200;
    while (true) {
      try {
        const data = await audioscrobblerCall(ctx, {
          method: 'user.getLovedTracks',
          user: ctx.username,
          sk: ctx.sessionKey,
          limit: String(limit),
          page: String(page),
        }, false, true);
        const tracks = toArray(data?.lovedtracks?.track);
        if (tracks.length === 0) break;
        for (const t of tracks) {
          results.push({ title: t.name, artist: t.artist?.name ?? '' });
        }
        const totalPages = Number(data?.lovedtracks?.['@attr']?.totalPages ?? 1);
        if (page >= totalPages || page >= 10) break; // max 10 pages = 2000 tracks
        page++;
      } catch {
        break;
      }
    }
    return results;
  }

  async getSimilarArtists(ctx: WireContext, name: string): Promise<string[]> {
    try {
      const data = await audioscrobblerCall(ctx, { method: 'artist.getSimilar', artist: name, limit: '50' }, false, true);
      return toArray(data?.similarartists?.artist).map(a => a.name as string);
    } catch {
      return [];
    }
  }

  async getTrackStats(ctx: WireContext, ref: TrackRef): Promise<TrackStats | null> {
    try {
      const params: Record<string, string> = { method: 'track.getInfo', artist: ref.artist, track: ref.title };
      if (ctx.username) params.username = ctx.username;
      const data = await audioscrobblerCall(ctx, params, false, true);
      const t = data?.track;
      if (!t) return null;
      const userPc = t.userplaycount != null ? Number(t.userplaycount) : null;
      return {
        listeners: Number(t.listeners) || 0,
        playcount: Number(t.playcount) || 0,
        userPlaycount: Number.isFinite(userPc as number) ? userPc : null,
        userLoved: t.userloved === '1' || t.userloved === 1,
        tags: topTags(t.toptags?.tag),
        url: t.url ?? null,
      };
    } catch {
      return null;
    }
  }

  async getArtistStats(ctx: WireContext, name: string): Promise<ArtistStats | null> {
    try {
      const params: Record<string, string> = { method: 'artist.getInfo', artist: name };
      if (ctx.username) params.username = ctx.username;
      const data = await audioscrobblerCall(ctx, params, false, true);
      const a = data?.artist;
      if (!a) return null;
      const userPc = a.stats?.userplaycount != null ? Number(a.stats.userplaycount) : null;
      const bioRaw = (a.bio?.content || a.bio?.summary || '').trim();
      return {
        listeners: Number(a.stats?.listeners) || 0,
        playcount: Number(a.stats?.playcount) || 0,
        userPlaycount: Number.isFinite(userPc as number) ? userPc : null,
        tags: topTags(a.tags?.tag),
        url: a.url ?? null,
        bio: bioRaw || null,
      };
    } catch {
      return null;
    }
  }

  async getUserProfile(ctx: WireContext): Promise<UserProfile | null> {
    try {
      const data = await audioscrobblerCall(ctx, { method: 'user.getInfo', user: ctx.username, sk: ctx.sessionKey }, false, true);
      const u = data?.user;
      if (!u) return null;
      return {
        username: ctx.username,
        playcount: Number(u.playcount) || 0,
        registeredAt: Number(u.registered?.unixtime ?? 0),
      };
    } catch {
      return null;
    }
  }

  async getTopItems(ctx: WireContext, period: StatsPeriod, kind: TopKind, limit: number): Promise<TopItem[]> {
    const method = kind === 'artists' ? 'user.getTopArtists' : kind === 'albums' ? 'user.getTopAlbums' : 'user.getTopTracks';
    const collection = kind === 'artists' ? 'topartists' : kind === 'albums' ? 'topalbums' : 'toptracks';
    const node = kind === 'artists' ? 'artist' : kind === 'albums' ? 'album' : 'track';
    try {
      const data = await audioscrobblerCall(ctx, {
        method,
        user: ctx.username,
        sk: ctx.sessionKey,
        period,
        limit: String(limit),
      }, false, true);
      return toArray(data?.[collection]?.[node]).map(it => ({
        name: it.name,
        playcount: it.playcount,
        ...(kind === 'artists' ? {} : { artist: it.artist?.name ?? '' }),
      }));
    } catch {
      return [];
    }
  }

  async getRecentTracks(ctx: WireContext, limit: number): Promise<RecentTrack[]> {
    try {
      const data = await audioscrobblerCall(ctx, {
        method: 'user.getRecentTracks',
        user: ctx.username,
        sk: ctx.sessionKey,
        limit: String(limit),
      }, false, true);
      return toArray(data?.recenttracks?.track).map(t => ({
        name: t.name,
        artist: t.artist?.['#text'] ?? t.artist?.name ?? '',
        album: t.album?.['#text'] ?? '',
        timestamp: t.date?.uts ? Number(t.date.uts) : null,
        nowPlaying: t['@attr']?.nowplaying === 'true',
      }));
    } catch {
      return [];
    }
  }

  buildProfileUrl(ctx: WireContext): string {
    if (!ctx.profileBase || !ctx.username) return '';
    return `${ctx.profileBase}/user/${encodeURIComponent(ctx.username)}`;
  }

  buildArtistUrl(ctx: WireContext, name: string): string {
    if (!ctx.profileBase) return '';
    return `${ctx.profileBase}/music/${encodeURIComponent(name)}`;
  }

  buildTrackUrl(ctx: WireContext, ref: TrackRef): string {
    if (!ctx.profileBase) return '';
    return `${ctx.profileBase}/music/${encodeURIComponent(ref.artist)}/_/${encodeURIComponent(ref.title)}`;
  }
}

/** Singleton wire instance (wires are stateless; context carries all state). */
export const audioscrobblerWire: EnrichmentWire = new AudioscrobblerWireImpl();
