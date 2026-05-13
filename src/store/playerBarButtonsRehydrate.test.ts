import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLAYER_BAR_BUTTON_VISIBILITY,
  mergePlayerBarButtonVisibility,
} from './playerBarButtonsRehydrate';

describe('mergePlayerBarButtonVisibility', () => {
  it('returns defaults for nullish or non-object input', () => {
    expect(mergePlayerBarButtonVisibility(undefined)).toEqual(DEFAULT_PLAYER_BAR_BUTTON_VISIBILITY);
    expect(mergePlayerBarButtonVisibility(null)).toEqual(DEFAULT_PLAYER_BAR_BUTTON_VISIBILITY);
    expect(mergePlayerBarButtonVisibility('x')).toEqual(DEFAULT_PLAYER_BAR_BUTTON_VISIBILITY);
  });

  it('returns defaults for empty object', () => {
    expect(mergePlayerBarButtonVisibility({})).toEqual(DEFAULT_PLAYER_BAR_BUTTON_VISIBILITY);
  });

  it('keeps valid booleans and fills missing keys from defaults', () => {
    expect(mergePlayerBarButtonVisibility({ starRating: false })).toEqual({
      ...DEFAULT_PLAYER_BAR_BUTTON_VISIBILITY,
      starRating: false,
    });
  });

  it('ignores non-boolean values (falls back to default for that key)', () => {
    expect(
      mergePlayerBarButtonVisibility({
        starRating: 'no' as unknown as boolean,
        favorite: false,
      }),
    ).toEqual({
      ...DEFAULT_PLAYER_BAR_BUTTON_VISIBILITY,
      favorite: false,
    });
  });

  it('ignores unknown keys without breaking known ones', () => {
    expect(
      mergePlayerBarButtonVisibility({
        legacyFlag: true,
        equalizer: false,
      } as Record<string, unknown>),
    ).toEqual({
      ...DEFAULT_PLAYER_BAR_BUTTON_VISIBILITY,
      equalizer: false,
    });
  });
});
