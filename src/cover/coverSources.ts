/** A cover-art provider source, in user-configurable order. */
export type CoverSource = 'server' | 'apple' | 'lastfm';

/** One entry in the ordered cover-source chain: which source, and whether it
 *  participates. Array order is the resolution priority. */
export interface CoverSourcePref {
  source: CoverSource;
  enabled: boolean;
}

/** A resolved candidate from one chain step. */
export interface CoverSourceCandidate {
  /** Publishable https image URL, or '' for a confirmed miss. */
  src: string;
  /** True while the source is still fetching — hold rather than flash a lower one. */
  pending?: boolean;
}

/**
 * Walk an ordered candidate list and pick the first resolved URL:
 *   - a resolved `src` wins immediately;
 *   - a still-`pending` candidate holds (returns null) rather than flashing a
 *     lower-priority source beneath it;
 *   - a confirmed miss (`src === ''`, not pending) steps to the next candidate.
 * Returns null when nothing resolves.
 */
export function resolveCoverSource(candidates: CoverSourceCandidate[]): string | null {
  for (const c of candidates) {
    if (c.src) return c.src;
    if (c.pending) return null;
  }
  return null;
}

/** True when at least one source is enabled (the chain is not "off"). */
export function isCoverSourceChainEnabled(sources: CoverSourcePref[]): boolean {
  return sources.some(s => s.enabled);
}
