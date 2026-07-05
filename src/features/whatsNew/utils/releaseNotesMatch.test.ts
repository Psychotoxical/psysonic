import { describe, expect, it } from 'vitest';
import { findReleaseNotesEntry } from '@/features/whatsNew/utils/releaseNotesMatch';

const FIXTURE = `
# Notes

## [1.48.0] - 2026-06-10

## Highlights

### Theme Store
- Install themes

## [1.47.0]

Old line
`;

describe('findReleaseNotesEntry', () => {
  it('matches exact version header', () => {
    const e = findReleaseNotesEntry(FIXTURE, '1.48.0');
    expect(e?.headerVersion).toBe('1.48.0');
    expect(e?.date).toBe('2026-06-10');
    expect(e?.body).toContain('Theme Store');
  });

  it('resolves -rc to base release line', () => {
    const e = findReleaseNotesEntry(FIXTURE, '1.48.0-rc.2');
    expect(e?.headerVersion).toBe('1.48.0');
  });

  it('resolves -dev to base release line', () => {
    const e = findReleaseNotesEntry(FIXTURE, '1.48.0-dev');
    expect(e?.headerVersion).toBe('1.48.0');
  });

  it('prefers plain X.Y.Z header when multiple share core and no exact header', () => {
    const raw = `
## [1.48.0-rc.1]
RC only

## [1.48.0]
Stable line
`;
    const e = findReleaseNotesEntry(raw, '1.48.0-rc.2');
    expect(e?.headerVersion).toBe('1.48.0');
    expect(e?.body).toContain('Stable line');
  });

  it('returns null when no section matches', () => {
    expect(findReleaseNotesEntry(FIXTURE, '9.9.9')).toBeNull();
  });
});
