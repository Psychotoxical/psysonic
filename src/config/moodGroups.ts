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

export type MoodGroupId = 'joy' | 'sadness' | 'dance' | 'work' | 'romance';

/** Product mood groups for Advanced Search (not stored on tracks). */
export const MOOD_GROUPS: ReadonlyArray<{
  readonly id: MoodGroupId;
  readonly tags: readonly OximediaMoodTagId[];
}> = [
  { id: 'joy', tags: ['happy', 'excited'] },
  { id: 'sadness', tags: ['sad', 'melancholic'] },
  { id: 'dance', tags: ['excited', 'tense', 'happy', 'angry'] },
  { id: 'work', tags: ['calm', 'peaceful'] },
  { id: 'romance', tags: ['peaceful', 'calm', 'melancholic'] },
] as const;

export function moodGroupById(id: string): (typeof MOOD_GROUPS)[number] | undefined {
  return MOOD_GROUPS.find(g => g.id === id);
}

export function expandMoodGroups(groupIds: readonly string[]): string[] {
  const out: string[] = [];
  for (const gid of groupIds) {
    const group = moodGroupById(gid);
    if (!group) continue;
    for (const tag of group.tags) {
      if (!out.includes(tag)) out.push(tag);
    }
  }
  return out;
}
