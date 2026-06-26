import { useEffect, useRef, useState } from 'react';
import type { ArtistBackdrop, BackdropSource, BackdropSourcePref } from './artistBackdrop';
import type { ArtistImage } from './useArtistFanart';
import { getHeroBackdropUpgrade, recordHeroBackdropUpgrade } from './heroBackdropMemory';

export interface HeroBackdropLive {
  banner: ArtistImage;
  fanart: ArtistImage;
  /** Navidrome artist cover url — local/fast, the instant default. */
  navidrome: string;
}

const PORTRAIT = 'center 30%';

interface ReadySrcs {
  banner: string;
  fanart: string;
  navidrome: string;
}

/** The chosen source plus the per-album disk-memory url for it, snapshotted at
 *  freeze time so the render path never reads the memory map. */
interface FrozenChoice {
  source: BackdropSource;
  memUrl: string;
}

/**
 * First enabled source (in configured order) that has a ready url — live, or
 * from the per-album disk memory (re-entry, while the live ensure re-resolves).
 * Returns the source *choice*, not a url, so the caller can keep deriving the
 * live url for it (self-correcting) rather than freezing a possibly-stale value.
 */
function pickReadyChoice(
  sources: BackdropSourcePref[],
  srcs: ReadySrcs,
  mem: ReturnType<typeof getHeroBackdropUpgrade>,
): FrozenChoice | null {
  for (const { source, enabled } of sources) {
    if (!enabled) continue;
    if (source === 'banner' && (srcs.banner || mem?.banner)) return { source, memUrl: mem?.banner ?? '' };
    if (source === 'fanart' && (srcs.fanart || mem?.fanart)) return { source, memUrl: mem?.fanart ?? '' };
    if (source === 'navidrome' && srcs.navidrome) return { source, memUrl: '' };
  }
  return null;
}

/**
 * Hero mainstage backdrop with the "show-ready-now, upgrade-on-re-entry" policy
 * (cucadmuh, 2026-06): on entering a slide, pick the best source ready **at that
 * moment** (Navidrome on a cold first visit; the prefetched/cached external one
 * on re-entry) and **freeze that choice** for the visit — a higher-priority
 * source resolving mid-dwell is recorded for next time but never swaps in. The
 * url is derived live from the frozen source (so a Navidrome cover that resolves
 * a beat late still self-corrects, instead of freezing a stale neighbour).
 */
export function useHeroBackdrop(
  sources: BackdropSourcePref[],
  live: HeroBackdropLive,
  albumId: string | undefined,
): ArtistBackdrop {
  const bannerSrc = live.banner.src;
  const fanartSrc = live.fanart.src;
  const navidromeSrc = live.navidrome;

  // Remember every external source that resolves for this album, so a later
  // re-entry can paint it immediately from disk. Safe now that the source hooks
  // reset synchronously on artist change (no stale neighbour leaks in here).
  useEffect(() => {
    if (bannerSrc) recordHeroBackdropUpgrade(albumId, 'banner', bannerSrc);
    if (fanartSrc) recordHeroBackdropUpgrade(albumId, 'fanart', fanartSrc);
  }, [albumId, bannerSrc, fanartSrc]);

  const [frozen, setFrozen] = useState<FrozenChoice | null>(null);
  const frozenFor = useRef<string | undefined>(undefined);

  // Freeze the source choice at entry; re-run as the live sources resolve until
  // the first ready choice, then bail (frozen) so nothing swaps mid-dwell.
  useEffect(() => {
    if (!albumId) {
      // React Compiler set-state-in-effect rule: resets the frozen choice on teardown.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFrozen(null);
      frozenFor.current = undefined;
      return;
    }
    if (frozenFor.current === albumId) return;
    const choice = pickReadyChoice(
      sources,
      { banner: bannerSrc, fanart: fanartSrc, navidrome: navidromeSrc },
      getHeroBackdropUpgrade(albumId),
    );
    if (choice) {
      setFrozen(choice);
      frozenFor.current = albumId;
    }
  }, [albumId, sources, bannerSrc, fanartSrc, navidromeSrc]);

  // Live url for the frozen source (mem snapshot fills the gap while an external
  // source re-resolves on re-entry).
  let url = '';
  if (frozen) {
    if (frozen.source === 'banner') url = bannerSrc || frozen.memUrl;
    else if (frozen.source === 'fanart') url = fanartSrc || frozen.memUrl;
    else url = navidromeSrc;
  }
  return { url, position: frozen?.source === 'banner' ? undefined : PORTRAIT };
}
