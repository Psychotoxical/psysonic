import { describe, expect, it } from 'vitest';
import i18n from '@/lib/i18n';

/**
 * The sidebar song count is the first plural string this project ships for a
 * language whose CLDR rules go past one/other. Supplying only `_one`/`_other`
 * looks complete and is not: i18next resolves `few`/`many` for Russian, Polish
 * and Romanian, finds nothing, and silently falls back to English — so a
 * Russian user with a three-song playlist hears the English string.
 *
 * These assertions pin the resolution against the real i18n instance rather
 * than against the shape of the locale files, because the shape is exactly
 * what looked fine while the output was wrong.
 */

const key = 'sidebar.playlistSongCount';

/** Counts that select a distinct CLDR category in at least one of the locales. */
const COUNTS = [1, 2, 3, 5, 11, 21, 100];

/**
 * A stem only the locale's own wording contains. Testing "not English" would
 * not work: German legitimately says "Song", so the fallback and the real
 * translation are indistinguishable that way.
 */
const OWN_WORDING: Record<string, RegExp> = {
  ru: /трек/,
  uk: /трек/,
  pl: /utw/,
  ro: /melod/,
  fr: /titre/,
  ja: /曲/,
};

describe('sidebar playlist song count plurals', () => {
  it.each(Object.keys(OWN_WORDING))(
    '%s resolves every count to its own wording instead of the English fallback',
    lng => {
      for (const count of COUNTS) {
        const out = i18n.t(key, { count, lng });
        expect(out, `${lng} count=${count}`).toMatch(OWN_WORDING[lng]);
        expect(out, `${lng} count=${count}`).toContain(String(count));
      }
    },
  );

  it('resolves the Russian categories to distinct wordings', () => {
    // 1 → one, 3 → few, 5 → many. If few/many were missing these would be
    // identical to each other or English.
    const one = i18n.t(key, { count: 1, lng: 'ru' });
    const few = i18n.t(key, { count: 3, lng: 'ru' });
    const many = i18n.t(key, { count: 5, lng: 'ru' });
    expect(new Set([one, few, many]).size).toBe(3);
  });

  it('resolves the Ukrainian categories to distinct wordings', () => {
    // 1 → one, 3 → few, 5 → many.
    const one = i18n.t(key, { count: 1, lng: 'uk' });
    const few = i18n.t(key, { count: 3, lng: 'uk' });
    const many = i18n.t(key, { count: 5, lng: 'uk' });
    expect(new Set([one, few, many]).size).toBe(3);
    expect(one).toBe('1 трек');
    expect(few).toBe('3 треки');
    expect(many).toBe('5 треків');
  });

  it('keeps English working for both of its forms', () => {
    expect(i18n.t(key, { count: 1, lng: 'en' })).toBe('1 song');
    expect(i18n.t(key, { count: 4, lng: 'en' })).toBe('4 songs');
  });
});
