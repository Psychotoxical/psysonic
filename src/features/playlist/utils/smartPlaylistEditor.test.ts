import { describe, expect, it } from 'vitest';
import { parseSmartRulesDocument } from '@/features/playlist/utils/smartPlaylistRules';
import { YEAR_MAX, YEAR_MIN } from '@/features/playlist/utils/playlistsSmart';
import {
  applySmartEditorJson,
  comparePersistedSmartRules,
  createSmartEditorSession,
  hasEmptySmartCriteria,
  previewRulesFromSession,
  requestSmartEditorMode,
} from '@/features/playlist/utils/smartPlaylistEditor';

describe('smartPlaylistEditor modes', () => {
  it('starts a new playlist with Psysonic year, limit, and random sort defaults', () => {
    const session = createSmartEditorSession({ name: 'Mix' });
    expect(session.mode).toBe('basic');
    expect(session.document.raw).toEqual({
      all: [{ inTheRange: { year: [YEAR_MIN, YEAR_MAX] } }],
      limit: 50,
      sort: '+random',
    });
    expect(session.filters).toMatchObject({
      yearEnabled: true,
      limit: '50',
      sort: '+random',
    });
  });

  it('opens Basic only when the document projects exactly', () => {
    const session = createSmartEditorSession({
      name: 'Mix',
      rules: {
        all: [{ inTheRange: { year: [1950, 2026] } }],
        limit: 50,
        sort: '+random',
      },
    });
    expect(session.mode).toBe('basic');
    expect(session.basicBlockedPaths).toEqual([]);
  });

  it('falls back to Advanced instead of dropping unsupported clauses', () => {
    const session = createSmartEditorSession({
      name: 'Nested',
      rules: {
        any: [
          { contains: { title: 'live' } },
          { all: [{ contains: { artist: 'A' } }, { contains: { album: 'B' } }] },
        ],
        limit: 10,
      },
    });
    expect(session.mode).toBe('advanced');
    expect(session.basicBlockedPaths.length).toBeGreaterThan(0);

    const refused = requestSmartEditorMode(session, 'basic');
    expect(refused.mode).toBe('advanced');
    expect(refused.basicBlockedPaths.length).toBeGreaterThan(0);
    expect(refused.document.raw).toEqual(session.document.raw);
  });

  it('rejects empty criteria', () => {
    expect(hasEmptySmartCriteria(parseSmartRulesDocument({}))).toBe(true);
    expect(hasEmptySmartCriteria(parseSmartRulesDocument({ all: [] }))).toBe(true);
    expect(hasEmptySmartCriteria(parseSmartRulesDocument({ any: [] }))).toBe(true);
    expect(hasEmptySmartCriteria(parseSmartRulesDocument({
      all: [{ contains: { title: 'x' } }],
    }))).toBe(false);
  });

  it('previews the active page including unsaved JSON', () => {
    const session = createSmartEditorSession({ name: 'Mix' });
    const fromBasic = previewRulesFromSession({
      ...session,
      filters: { ...session.filters, artistContains: 'Radiohead' },
    });
    expect(fromBasic.all).toEqual(expect.arrayContaining([
      { contains: { artist: 'Radiohead' } },
      { inTheRange: { year: [YEAR_MIN, YEAR_MAX] } },
    ]));
    expect(fromBasic.limit).toBe(50);
    expect(fromBasic.sort).toBe('+random');

    const fromJson = previewRulesFromSession({
      ...session,
      mode: 'json',
      jsonDraft: JSON.stringify({ any: [{ contains: { title: 'live' } }] }, null, 2),
    });
    expect(fromJson.any).toEqual([{ contains: { title: 'live' } }]);
  });

  it('rebuilds JSON from Basic filters when leaving Basic', () => {
    const session = createSmartEditorSession({ name: 'Mix' });
    const edited = {
      ...session,
      filters: { ...session.filters, artistContains: 'Radiohead', limit: '25' },
    };
    const json = requestSmartEditorMode(edited, 'json');
    expect(json.mode).toBe('json');
    expect(json.jsonDraft).toContain('Radiohead');
    expect(json.jsonDraft).toContain('"limit": 25');
    expect(json.document.raw.all).toEqual(
      expect.arrayContaining([{ contains: { artist: 'Radiohead' } }]),
    );
  });

  it('applies valid JSON to the editor and keeps invalid JSON as a draft error', () => {
    const session = createSmartEditorSession({ name: 'Mix' });
    const applied = applySmartEditorJson(session, JSON.stringify({
      any: [{ contains: { title: 'live' } }],
    }));
    expect(applied.jsonError).toBeNull();
    expect(applied.document.raw.any).toEqual([{ contains: { title: 'live' } }]);
    expect(applied.mode).toBe('advanced');

    const invalid = applySmartEditorJson(session, '{');
    expect(invalid.jsonError).toBeTruthy();
    expect(invalid.document.raw).toEqual(session.document.raw);
  });

  it('warns only when persisted rules drop sent clauses', () => {
    const sent = { all: [{ contains: { title: 'a' } }, { contains: { artist: 'b' } }], limit: 20 };
    expect(comparePersistedSmartRules(sent, {
      all: [{ contains: { title: 'a' } }],
      limit: 20,
      evaluatedAt: 'later',
    })).toContain('/all/1');
    expect(comparePersistedSmartRules(sent, {
      ...sent,
      evaluatedAt: 'later',
    })).toEqual([]);
  });
});
