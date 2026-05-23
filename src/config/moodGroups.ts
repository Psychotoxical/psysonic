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

/** Shared test vector with Rust `mood_groups::top_oximedia_mood_tag_ids_from_moods_json`. */
export const TOP_OXIMEDIA_MOOD_TAG_TEST_SCORES = {
  noise: 0.99,
  calm: 0.2,
  happy: 0.9,
  excited: 0.5,
} as const;

/** Top oximedia mood tag ids by score — mirrors Rust `mood_groups::top_oximedia_mood_tag_ids_from_scores`. */
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
