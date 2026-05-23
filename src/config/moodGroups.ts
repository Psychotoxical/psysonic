/** Oximedia mood label ids — keep in sync with `psysonic_library::mood_groups`. */
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
