import type { SubsonicOpenArtistRef } from '@/lib/api/subsonicTypes';
import { useResolvedArtistRefs } from '@/lib/hooks/useResolvedArtistRefs';
import { OpenArtistRefInline } from '@/ui/OpenArtistRefInline';

interface Props {
  refs: SubsonicOpenArtistRef[];
  /**
   * Owning server for the id lookup. Callers apply the usual
   * `entity.serverId ?? activeServerId` fallback.
   */
  serverId: string | null | undefined;
  /** Used when `refs` is empty (callers should normally avoid that). */
  fallbackName: string;
  onGoArtist: (artistId: string) => void;
  as?: 'span' | 'none';
  linkTag?: 'button' | 'span';
  outerClassName?: string;
  linkClassName?: string;
  plainClassName?: string;
  separatorClassName?: string;
}

/**
 * [`OpenArtistRefInline`] with the id lookup for credits that came from splitting a
 * joined display string.
 *
 * Splitting "A feat. B" yields a name without an id for every guest, so on its own it
 * renders guests as plain text. Every interactive surface that shows credits goes
 * through this component, so "each named artist is clickable" holds on cards, rails,
 * track rows and the player alike instead of only where a caller remembered to run the
 * resolver — and each of them inherits the accessible link behaviour.
 */
export function ResolvedArtistRefInline({ refs, serverId, ...rest }: Props) {
  const resolved = useResolvedArtistRefs(refs, serverId);
  return <OpenArtistRefInline refs={resolved} {...rest} />;
}
