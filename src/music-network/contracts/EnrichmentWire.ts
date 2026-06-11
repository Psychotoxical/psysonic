// Music Network — EnrichmentWire contract.
//
// Extends ScrobbleWire with the read features that today are Last.fm-only
// (love, similar, stats, top lists, recent tracks, profile links). Only
// Audioscrobbler-class wires implement this; the EnrichmentRouter casts an
// account to EnrichmentWire only after the wire declares supportsEnrichment AND
// the probe confirmed the matching capability.

import type {
  ArtistStats,
  RecentTrack,
  StatsPeriod,
  TopItem,
  TopKind,
  TrackRef,
  TrackStats,
  UserProfile,
} from '../core/types';
import type { ScrobbleWire, WireContext } from './ScrobbleWire';

export interface EnrichmentWire extends ScrobbleWire {
  readonly supportsEnrichment: true;

  getTrackLoved(ctx: WireContext, ref: TrackRef): Promise<boolean>;
  loveTrack(ctx: WireContext, ref: TrackRef, loved: boolean): Promise<void>;
  getAllLovedTracks(ctx: WireContext): Promise<TrackRef[]>;
  getSimilarArtists(ctx: WireContext, name: string): Promise<string[]>;
  getTrackStats(ctx: WireContext, ref: TrackRef): Promise<TrackStats | null>;
  getArtistStats(ctx: WireContext, name: string): Promise<ArtistStats | null>;
  getUserProfile(ctx: WireContext): Promise<UserProfile | null>;
  getTopItems(
    ctx: WireContext,
    period: StatsPeriod,
    kind: TopKind,
    limit: number,
  ): Promise<TopItem[]>;
  getRecentTracks(ctx: WireContext, limit: number): Promise<RecentTrack[]>;

  buildProfileUrl(ctx: WireContext): string;
  buildArtistUrl(ctx: WireContext, name: string): string;
  buildTrackUrl(ctx: WireContext, ref: TrackRef): string;
}

/** Type guard: does this wire implement the enrichment surface? */
export function isEnrichmentWire(wire: ScrobbleWire): wire is EnrichmentWire {
  return wire.supportsEnrichment === true;
}
