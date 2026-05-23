import type { TFunction } from 'i18next';
import type { TrackFactDto } from '../../api/library';
import { OXIMEDIA_MOOD_TAG_IDS } from '../../config/moodGroups';

/** Matches `psysonic_library::enrichment::OXIMEDIA_ENRICHMENT_*`. */
export const OXIMEDIA_ENRICHMENT_SOURCE_KIND = 'analysis';
export const OXIMEDIA_ENRICHMENT_SOURCE_ID = 'oximedia-60s-center';

/** Oximedia mood label ids — see `src/config/moodGroups.ts` and Rust `mood_groups`. */
export type { OximediaMoodTagId } from '../../config/moodGroups';

export interface ParsedTrackEnrichment {
  serverBpm: number | null;
  measuredBpm: number | null;
  moodLabels: string[];
}

function isOximediaFact(f: TrackFactDto): boolean {
  return (
    f.sourceKind === OXIMEDIA_ENRICHMENT_SOURCE_KIND
    && (f.sourceId === OXIMEDIA_ENRICHMENT_SOURCE_ID
      || f.sourceId.startsWith(`${OXIMEDIA_ENRICHMENT_SOURCE_ID}:`))
  );
}

export function parseTrackEnrichmentFacts(
  facts: readonly TrackFactDto[],
  serverBpm: number | null | undefined,
): ParsedTrackEnrichment {
  const oximedia = facts.filter(isOximediaFact);
  const measured = oximedia.find(
    f => f.factKind === 'bpm' && f.valueInt != null && f.valueInt > 0,
  );
  const moodsFact = oximedia.find(f => f.factKind === 'moods' && f.valueText);
  const legacyLabelsFact = oximedia.find(f => f.factKind === 'mood_labels' && f.valueText);
  const moodTagFacts = facts.filter(
    f => isOximediaFact(f) && f.factKind === 'mood_tag' && f.valueText,
  );
  const valence = oximedia.find(f => f.factKind === 'valence')?.valueReal ?? null;
  const arousal = oximedia.find(f => f.factKind === 'arousal')?.valueReal ?? null;

  const hotBpm = serverBpm != null && serverBpm > 0 ? serverBpm : null;

  const fromMoodsJson = topMoodLabelIds(parseMoodsScoresJson(moodsFact?.valueText));
  const fromLegacy = parseMoodLabelsArray(legacyLabelsFact?.valueText);
  const fromMoodTags = moodTagFacts
    .map(f => f.valueText!)
    .filter(Boolean)
    .slice(0, 3);
  const fromValenceArousal =
    valence != null && arousal != null ? topMoodLabelIds(deriveMoodScores(valence, arousal)) : [];
  const moodLabels =
    (fromMoodsJson.length > 0 ? fromMoodsJson : null)
    ?? (fromMoodTags.length > 0 ? fromMoodTags : null)
    ?? (fromLegacy && fromLegacy.length > 0 ? fromLegacy : null)
    ?? fromValenceArousal;

  return {
    serverBpm: hotBpm,
    measuredBpm: measured?.valueInt ?? null,
    moodLabels,
  };
}

function parseMoodsScoresJson(raw: string | null | undefined): Record<string, number> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) return null;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

function parseMoodLabelsArray(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const labels = parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
    return labels.length > 0 ? labels.slice(0, 3) : null;
  } catch {
    return null;
  }
}

/** Mirror oximedia `map_to_moods` — display fallback when only valence/arousal exist. */
export function deriveMoodScores(valence: number, arousal: number): Record<string, number> {
  if (valence > 0 && arousal > 0.5) {
    return { happy: (valence + arousal) / 2, excited: arousal };
  }
  if (valence > 0 && arousal <= 0.5) {
    return { calm: valence * (1 - arousal), peaceful: (valence + (1 - arousal)) / 2 };
  }
  if (valence <= 0 && arousal > 0.5) {
    return { angry: arousal * Math.abs(valence), tense: arousal };
  }
  return {
    sad: Math.abs(valence) * (1 - arousal),
    melancholic: (Math.abs(valence) + (1 - arousal)) / 2,
  };
}

export function topMoodLabelIds(
  scores: Record<string, number> | null | undefined,
  limit = 3,
): string[] {
  if (!scores) return [];
  const allowed = new Set<string>(OXIMEDIA_MOOD_TAG_IDS);
  return Object.entries(scores)
    .filter(([id]) => allowed.has(id))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([id]) => id);
}

/** Server BPM wins; measured BPM is the fallback. */
export function resolveQueueBpm(data: ParsedTrackEnrichment): number | null {
  if (data.serverBpm != null) return data.serverBpm;
  if (data.measuredBpm != null) return data.measuredBpm;
  return null;
}

export function formatQueueBpmTech(data: ParsedTrackEnrichment, t: TFunction): string | null {
  const bpm = resolveQueueBpm(data);
  if (bpm == null) return null;
  return t('queue.bpm', { bpm });
}

export function formatQueueMoodLabels(labels: readonly string[], t: TFunction): string | null {
  const names = labels
    .slice(0, 3)
    .map(id => {
      const key = `queue.moods.${id}`;
      const translated = t(key);
      return translated === key ? id : translated;
    });
  return names.length > 0 ? names.join(' · ') : null;
}

function enrichmentHasMoodLabels(data: ParsedTrackEnrichment): boolean {
  return data.moodLabels.length > 0;
}

function enrichmentHasBpm(data: ParsedTrackEnrichment): boolean {
  return (data.measuredBpm != null && data.measuredBpm > 0)
    || (data.serverBpm != null && data.serverBpm > 0);
}

export function enrichmentDisplayComplete(data: ParsedTrackEnrichment): boolean {
  return enrichmentHasMoodLabels(data) || enrichmentHasBpm(data);
}
