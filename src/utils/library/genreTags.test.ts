import { describe, expect, it } from 'vitest';
import { genreTagsFor, parseItemGenres, splitGenreTags } from './genreTags';

describe('splitGenreTags', () => {
  it('splits Navidrome-default separators and dedupes case-insensitively', () => {
    expect(splitGenreTags('Rock/Jazz')).toEqual(['Rock', 'Jazz']);
    expect(splitGenreTags('Rock; Jazz, Electronic')).toEqual(['Rock', 'Jazz', 'Electronic']);
    expect(splitGenreTags('Rock/rock/ROCK')).toEqual(['Rock']);
    expect(splitGenreTags('')).toEqual([]);
  });
});

describe('parseItemGenres', () => {
  it('accepts ItemGenre objects and bare strings', () => {
    expect(parseItemGenres([{ name: 'A' }, { name: 'B' }])).toEqual([{ name: 'A' }, { name: 'B' }]);
    expect(parseItemGenres(['A', 'B'])).toEqual([{ name: 'A' }, { name: 'B' }]);
    expect(parseItemGenres([])).toBeUndefined();
  });
});

describe('genreTagsFor', () => {
  it('prefers genres[] over the compound genre string', () => {
    expect(genreTagsFor({
      genre: 'Noise Metal/Dark Ambient/Experimental Black Metal',
      genres: [{ name: 'Dark Ambient' }, { name: 'Noise Metal' }],
    })).toEqual(['Dark Ambient', 'Noise Metal']);
  });

  it('falls back to splitGenreTags when genres[] is absent', () => {
    expect(genreTagsFor({
      genre: 'Noise Metal/Dark Ambient/Experimental Black Metal',
    })).toEqual([
      'Noise Metal',
      'Dark Ambient',
      'Experimental Black Metal',
    ]);
  });
});
