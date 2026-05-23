/** Oximedia mood label ids — keep in sync with `psysonic_library::mood_groups` (see `moodGroups.test.ts`). */
export const OXIMEDIA_MOOD_TAG_IDS = [
  'happy',
  'excited',
  'calm',
  'peaceful',
  'angry',
  'tense',
  'sad',
  'melancholic',
] as const;

export type OximediaMoodTagId = (typeof OXIMEDIA_MOOD_TAG_IDS)[number];

export type MoodGroupId = 'joy' | 'sadness' | 'dance' | 'work' | 'romance' | 'anger';

/** Virtual mood groups for Advanced Search — overlaps are intentional. */
export const MOOD_GROUPS: ReadonlyArray<{
  readonly id: MoodGroupId;
  readonly tags: readonly string[];
}> = [
  { id: 'joy', tags: ['happy', 'excited'] },
  { id: 'sadness', tags: ['sad', 'melancholic'] },
  { id: 'dance', tags: ['excited', 'happy', 'tense', 'angry'] },
  { id: 'work', tags: ['calm', 'peaceful'] },
  { id: 'romance', tags: ['peaceful', 'calm', 'melancholic'] },
  { id: 'anger', tags: ['angry', 'tense'] },
] as const;

export const MOOD_GROUP_IDS: readonly MoodGroupId[] = MOOD_GROUPS.map(g => g.id);

/** Valence/arousal anchor — keep in sync with Rust `mood_groups::MOOD_VA_ANCHORS`. */
const MOOD_VA_ANCHORS: ReadonlyArray<{ readonly id: OximediaMoodTagId; readonly v: number; readonly a: number }> = [
  { id: 'happy', v: 0.75, a: 0.72 },
  { id: 'excited', v: 0.55, a: 0.88 },
  { id: 'calm', v: 0.65, a: 0.22 },
  { id: 'peaceful', v: 0.78, a: 0.12 },
  { id: 'angry', v: -0.72, a: 0.82 },
  { id: 'tense', v: -0.35, a: 0.68 },
  { id: 'sad', v: -0.75, a: 0.28 },
  { id: 'melancholic', v: -0.55, a: 0.18 },
] as const;

const MOOD_VA_MAX_DIST = 1.35;
const MOOD_VA_VALENCE_BIAS = 0.12;
const MOOD_VA_VALENCE_SCALE = 1.4;
const MOOD_VA_AROUSAL_OFFSET = 0.48;
const MOOD_VA_AROUSAL_SCALE = 0.40;
const MOOD_DISPLAY_MIN_RELATIVE = 0.55;
const MOOD_DISPLAY_MIN_ABSOLUTE = 0.28;

/** One label per cluster in UI — mirrors Rust `MOOD_DISPLAY_CLUSTERS`. */
const MOOD_DISPLAY_CLUSTERS: readonly (readonly OximediaMoodTagId[])[] = [
  ['happy', 'excited'],
  ['calm', 'peaceful'],
  ['angry', 'tense'],
  ['sad', 'melancholic'],
] as const;

function moodDisplayCluster(tag: string): number | null {
  const idx = MOOD_DISPLAY_CLUSTERS.findIndex(cluster => cluster.includes(tag as OximediaMoodTagId));
  return idx >= 0 ? idx : null;
}

/**
 * Soft scores for all oximedia mood tags from raw valence/arousal.
 * Oximedia's built-in mapper returns only two labels (often happy/excited);
 * we recalibrate V/A and score every catalog tag by distance to anchors.
 */
export function moodScoresFromValenceArousal(valence: number, arousal: number): Record<string, number> {
  const v = Math.max(-1, Math.min(1, (valence - MOOD_VA_VALENCE_BIAS) * MOOD_VA_VALENCE_SCALE));
  const a = Math.max(0, Math.min(1, (arousal - MOOD_VA_AROUSAL_OFFSET) / MOOD_VA_AROUSAL_SCALE));
  const scores: Record<string, number> = {};
  for (const anchor of MOOD_VA_ANCHORS) {
    const dv = v - anchor.v;
    const da = a - anchor.a;
    const dist = Math.sqrt(dv * dv + da * da);
    scores[anchor.id] = Math.max(0, 1 - dist / MOOD_VA_MAX_DIST);
  }
  return scores;
}

/** Shared test vector with Rust `mood_groups::top_oximedia_mood_tag_ids_from_moods_json`. */
export const TOP_OXIMEDIA_MOOD_TAG_TEST_SCORES = {
  noise: 0.99,
  calm: 0.2,
  happy: 0.9,
  excited: 0.5,
} as const;

/** Top oximedia mood tag ids by score — mirrors Rust `top_oximedia_mood_tag_ids_from_scores`. */
export function topOximediaMoodTagIds(
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

/** One tag per display cluster (never happy+excited together). Mirrors Rust distinct picker. */
export function topDistinctOximediaMoodTagIds(
  scores: Record<string, number> | null | undefined,
  limit = 2,
): string[] {
  if (!scores) return [];
  const ranked = topOximediaMoodTagIds(scores, OXIMEDIA_MOOD_TAG_IDS.length);
  if (ranked.length === 0) return [];
  const topScore = scores[ranked[0]] ?? 0;
  const usedClusters = new Set<number>();
  const out: string[] = [];
  for (const id of ranked) {
    const score = scores[id] ?? 0;
    if (score < MOOD_DISPLAY_MIN_ABSOLUTE || score < topScore * MOOD_DISPLAY_MIN_RELATIVE) continue;
    const cluster = moodDisplayCluster(id);
    if (cluster != null) {
      if (usedClusters.has(cluster)) continue;
      usedClusters.add(cluster);
    }
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

export function topDistinctOximediaMoodTagIdsFromValenceArousal(
  valence: number,
  arousal: number,
  limit = 2,
): string[] {
  return topDistinctOximediaMoodTagIds(moodScoresFromValenceArousal(valence, arousal), limit);
}

/** Dedupe a stored tag list to one label per cluster (preserves rank order). */
export function distinctOximediaMoodTagIds(tags: readonly string[], limit = 2): string[] {
  const scores = Object.fromEntries(tags.map((id, index) => [id, tags.length - index]));
  return topDistinctOximediaMoodTagIds(scores, limit);
}
