import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findReleaseSection } from './extract-release-section.mjs';

const FIXTURE = `
## [1.48.0] - 2026-06-10

## Highlights
- One

## [1.47.0]
- Old
`;

describe('findReleaseSection', () => {
  it('matches base line for -rc versions', () => {
    const entry = findReleaseSection(FIXTURE, '1.48.0-rc.3');
    assert.equal(entry.headerVersion, '1.48.0');
    assert.match(entry.body, /Highlights/);
  });

  it('matches base line for -dev versions', () => {
    const entry = findReleaseSection(FIXTURE, '1.48.0-dev');
    assert.equal(entry.headerVersion, '1.48.0');
  });
});
