import { describe, expect, it } from 'vitest';
import {
  createCustomSmartRuleField,
  findSmartRuleField,
  getAvailableSmartRuleFields,
  getSmartRuleOperatorsForField,
  RELEASED_SMART_RULE_FIELDS,
  resolveCustomSmartRuleFields,
  resolveSmartPlaylistCapabilities,
  searchSmartRuleFields,
  titleCaseSmartFieldName,
} from './smartPlaylistFields';

describe('resolveSmartPlaylistCapabilities', () => {
  it.each([
    ['0.47.9', 'base', false],
    ['0.48.0', 'base', true],
    ['0.51.9', 'playlistReferences', false],
    ['0.52.0', 'playlistReferences', true],
    ['0.54.9', 'dynamicFields', false],
    ['0.55.0', 'dynamicFields', true],
    ['0.56.9', 'multiSort', false],
    ['0.57.0', 'multiSort', true],
    ['0.60.9', 'percentageLimit', false],
    ['0.61.0', 'percentageLimit', true],
    ['0.61.9', 'presenceOperators', false],
    ['0.62.0', 'presenceOperators', true],
    ['0.62.9', 'expandedFields', false],
    ['0.63.0', 'expandedFields', true],
  ] as const)('gates %s capability %s', (version, capability, expected) => {
    expect(resolveSmartPlaylistCapabilities(version)[capability]).toBe(expected);
  });

  it('stays conservative for unknown and non-Navidrome servers', () => {
    expect(resolveSmartPlaylistCapabilities({ type: 'navidrome' }).base).toBe(false);
    expect(resolveSmartPlaylistCapabilities({
      type: 'gonic',
      serverVersion: '1.0.0',
    }).base).toBe(false);
  });
});

describe('released smart-rule registry', () => {
  it('contains released 0.63 fields but excludes master-only album fields', () => {
    const names = RELEASED_SMART_RULE_FIELDS.map(field => field.name);
    expect(names).toContain('library_id');
    expect(names).toContain('rgtrackgain');
    expect(names).not.toContain('albumdateadded');
    expect(names).not.toContain('albumduration');
    expect(findSmartRuleField('library_id')?.type).toBe('number');
    expect(findSmartRuleField('random')).toMatchObject({
      filterable: false,
      sortable: true,
    });
    expect(findSmartRuleField('playlist')).toMatchObject({
      name: 'playlist',
      label: 'Playlist',
      type: 'playlist',
      filterable: true,
      sortable: false,
    });
    expect(findSmartRuleField('rating')).toMatchObject({ min: 0, max: 5 });
    expect(findSmartRuleField('albumrating')).toMatchObject({ min: 0, max: 5 });
    expect(findSmartRuleField('artistrating')).toMatchObject({ min: 0, max: 5 });
    expect(findSmartRuleField('averagerating')).toMatchObject({ min: 0, max: 5 });
    expect(findSmartRuleField('playcount')?.min).toBe(0);
    expect(findSmartRuleField('playcount')?.max).toBeUndefined();
    expect(findSmartRuleField('year')?.min).toBeUndefined();
    expect(findSmartRuleField('rgalbumgain')?.min).toBeUndefined();
  });

  it('exposes playlist membership from 0.52 and keeps it out of sort fields', () => {
    const v51 = resolveSmartPlaylistCapabilities('0.51.9');
    const v52 = resolveSmartPlaylistCapabilities('0.52.0');
    expect(getAvailableSmartRuleFields(v51).map(field => field.name)).not.toContain('playlist');
    expect(getAvailableSmartRuleFields(v52).map(field => field.name)).toContain('playlist');
    const playlist = findSmartRuleField('playlist')!;
    expect(getSmartRuleOperatorsForField(playlist, v52).map(item => item.name))
      .toEqual(['inPlaylist', 'notInPlaylist']);
    expect(searchSmartRuleFields('playlist', v52).find(field => field.name === 'playlist')?.sortable)
      .toBe(false);
  });

  it('includes default mappings.yaml tags and roles such as mood', () => {
    expect(findSmartRuleField('mood')).toMatchObject({
      name: 'mood',
      type: 'string',
      source: 'tag',
      nullable: true,
    });
    expect(findSmartRuleField('grouping')?.source).toBe('tag');
    expect(findSmartRuleField('composer')).toMatchObject({
      source: 'role',
      type: 'string',
    });
    const v54 = resolveSmartPlaylistCapabilities('0.54.9');
    const v55 = resolveSmartPlaylistCapabilities('0.55.0');
    expect(getAvailableSmartRuleFields(v54).map(field => field.name)).not.toContain('mood');
    expect(getAvailableSmartRuleFields(v55).map(field => field.name)).toEqual(
      expect.arrayContaining(['mood', 'grouping', 'composer', 'conductor']),
    );
  });

  it('title-cases concatenated Navidrome field names', () => {
    expect(titleCaseSmartFieldName('playcount')).toBe('Play Count');
    expect(titleCaseSmartFieldName('rating')).toBe('Rating');
    expect(titleCaseSmartFieldName('dateloved')).toBe('Date Loved');
    expect(titleCaseSmartFieldName('albumplaycount')).toBe('Album Play Count');
    expect(titleCaseSmartFieldName('albumlastplayed')).toBe('Album Last Played');
    expect(titleCaseSmartFieldName('album')).toBe('Album');
    expect(titleCaseSmartFieldName('discnumber')).toBe('Disc Number');
    expect(titleCaseSmartFieldName('tracknumber')).toBe('Track Number');
    expect(titleCaseSmartFieldName('mbz_album_id')).toBe('MusicBrainz Album ID');
    expect(findSmartRuleField('albumplaycount')?.label).toBe('Album Play Count');
  });

  it('searches available fields by machine name or label', () => {
    const capabilities = resolveSmartPlaylistCapabilities('0.63.2');
    expect(searchSmartRuleFields('musicbrainz album', capabilities).map(field => field.name))
      .toContain('mbz_album_id');
    expect(searchSmartRuleFields('library_', capabilities).map(field => field.name))
      .toEqual(['library_id']);
  });

  it('restricts operators by field capability and server release', () => {
    const v61 = resolveSmartPlaylistCapabilities('0.61.0');
    const v62 = resolveSmartPlaylistCapabilities('0.62.0');
    const title = findSmartRuleField('title')!;
    const album = findSmartRuleField('album')!;
    const genre = findSmartRuleField('genre')!;
    const year = findSmartRuleField('year')!;

    expect(getSmartRuleOperatorsForField(year, v62).map(item => item.name))
      .toEqual(['is', 'isNot', 'gt', 'lt', 'inTheRange']);
    expect(getSmartRuleOperatorsForField(title, v62).map(item => item.name))
      .not.toContain('isPresent');
    expect(getSmartRuleOperatorsForField(album, v61).map(item => item.name))
      .not.toContain('isMissing');
    expect(getSmartRuleOperatorsForField(album, v62).map(item => item.name))
      .toContain('isMissing');
    expect(getSmartRuleOperatorsForField(genre, v62).map(item => item.name))
      .toContain('isPresent');

    const lastplayed = findSmartRuleField('lastplayed')!;
    expect(getSmartRuleOperatorsForField(lastplayed, v62).map(item => item.name))
      .toEqual(['is', 'isNot', 'before', 'after', 'inTheRange', 'inTheLast', 'notInTheLast']);
  });
});

describe('custom smart-rule fields', () => {
  it('requires an explicit valid type and becomes available at 0.55', () => {
    const customTag = createCustomSmartRuleField({
      name: 'ndmood_energy',
      type: 'string',
      kind: 'tag',
    });
    expect(customTag).toMatchObject({
      name: 'ndmood_energy',
      type: 'string',
      source: 'custom-tag',
    });
    expect(getAvailableSmartRuleFields(
      resolveSmartPlaylistCapabilities('0.54.9'),
      [customTag],
    )).not.toContain(customTag);
    expect(getAvailableSmartRuleFields(
      resolveSmartPlaylistCapabilities('0.55.0'),
      [customTag],
    )).toContain(customTag);
  });

  it('does not expose ranges for multi-valued custom tags', () => {
    const score = createCustomSmartRuleField({
      name: 'custom_score',
      type: 'number',
      kind: 'tag',
    });
    const operators = getSmartRuleOperatorsForField(
      score,
      resolveSmartPlaylistCapabilities('0.63.2'),
    ).map(item => item.name);
    expect(operators).toContain('gt');
    expect(operators).toContain('isMissing');
    expect(operators).not.toContain('inTheRange');
  });

  it('skips invalid persisted custom fields', () => {
    expect(resolveCustomSmartRuleFields([
      { name: 'sort', type: 'string', kind: 'tag' },
      { name: 'ndmood_energy', type: 'string', kind: 'tag' },
      { name: 'NDMOOD_ENERGY', type: 'number', kind: 'role' },
    ]).map(field => field.name)).toEqual(['ndmood_energy']);
  });

  it('rejects reserved or untyped-looking names', () => {
    expect(() => createCustomSmartRuleField({
      name: 'sort',
      type: 'string',
      kind: 'tag',
    })).toThrow(/Invalid custom/);
    expect(() => createCustomSmartRuleField({
      name: 'bad field',
      type: 'string',
      kind: 'role',
    })).toThrow(/Invalid custom/);
  });
});
