import { describe, expect, it } from 'vitest';
import type { SubsonicStructuredLyrics } from '@/lib/api/subsonicTypes';
import { parseStructuredLyrics, parseStructuredWordLines } from '@/features/lyrics/utils/structuredLyrics';

/** `byteStart`/`byteEnd` are required by the type but unused by the mapper (we read `value`). */
function cue(start: number, value: string, end?: number) {
  return { start, end, value, byteStart: 0, byteEnd: value.length - 1 };
}

describe('parseStructuredLyrics', () => {
  it('converts synced ms timestamps to seconds and sorts', () => {
    const lyrics: SubsonicStructuredLyrics = {
      synced: true,
      line: [{ start: 2000, value: ' second ' }, { start: 500, value: 'first' }],
    };
    expect(parseStructuredLyrics(lyrics)).toEqual({
      syncedLines: [{ time: 0.5, text: 'first' }, { time: 2, text: 'second' }],
      plainLyrics: null,
    });
  });

  it('falls back to plain text when unsynced', () => {
    const lyrics: SubsonicStructuredLyrics = { line: [{ value: 'a' }, { value: 'b' }] };
    expect(parseStructuredLyrics(lyrics)).toEqual({ syncedLines: null, plainLyrics: 'a\nb' });
  });
});

describe('parseStructuredWordLines', () => {
  it('returns null without cue lines (songLyrics v1 response)', () => {
    expect(parseStructuredWordLines({ synced: true, line: [{ start: 0, value: 'a' }] })).toBeNull();
  });

  it('returns null for unsynced lyrics even when cues are present', () => {
    const lyrics: SubsonicStructuredLyrics = {
      line: [{ value: 'a' }],
      cueLine: [{ index: 0, value: 'a', cue: [cue(0, 'a')] }],
    };
    expect(parseStructuredWordLines(lyrics)).toBeNull();
  });

  it('returns null when a line lacks a start time', () => {
    const lyrics: SubsonicStructuredLyrics = {
      synced: true,
      line: [{ start: 0, value: 'a' }, { value: 'b' }],
      cueLine: [{ index: 0, value: 'a', cue: [cue(0, 'a')] }],
    };
    expect(parseStructuredWordLines(lyrics)).toBeNull();
  });

  it('returns null when line starts are out of order', () => {
    const lyrics: SubsonicStructuredLyrics = {
      synced: true,
      line: [{ start: 2000, value: 'a' }, { start: 1000, value: 'b' }],
      cueLine: [{ index: 0, value: 'a', cue: [cue(2000, 'a')] }],
    };
    expect(parseStructuredWordLines(lyrics)).toBeNull();
  });

  it('derives a missing cue end from the next cue, then from the line end', () => {
    // Navidrome emits `end` all-or-nothing per cue line; here it emits none.
    const lyrics: SubsonicStructuredLyrics = {
      synced: true,
      line: [{ start: 1000, value: 'hello world' }],
      cueLine: [{
        index: 0,
        start: 1000,
        end: 2500,
        value: 'hello world',
        cue: [cue(1000, 'hello '), cue(1800, 'world')],
      }],
    };
    expect(parseStructuredWordLines(lyrics)).toEqual([{
      time: 1,
      duration: 1.5,
      text: 'hello world',
      words: [
        { text: 'hello ', time: 1, duration: 0.8 },
        { text: 'world', time: 1.8, duration: 0.7 },
      ],
    }]);
  });

  it('uses an explicit cue end when the server provides one', () => {
    const lyrics: SubsonicStructuredLyrics = {
      synced: true,
      line: [{ start: 0, value: 'hi' }],
      cueLine: [{ index: 0, end: 1000, value: 'hi', cue: [cue(0, 'hi', 400)] }],
    };
    const [line] = parseStructuredWordLines(lyrics)!;
    expect(line.words).toEqual([{ text: 'hi', time: 0, duration: 0.4 }]);
    expect(line.duration).toBe(1);
  });

  it('keeps a cue-less line as one full-line word so no line is dropped', () => {
    const lyrics: SubsonicStructuredLyrics = {
      synced: true,
      line: [{ start: 1000, value: 'sung' }, { start: 3000, value: 'instrumental' }],
      cueLine: [{ index: 0, end: 2000, value: 'sung', cue: [cue(1000, 'sung', 2000)] }],
    };
    const lines = parseStructuredWordLines(lyrics)!;
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({
      time: 3,
      duration: 0,
      text: 'instrumental',
      words: [{ text: 'instrumental', time: 3, duration: 0 }],
    });
  });

  it('renders only the first cue line per index (main agent wins over backing vocals)', () => {
    const lyrics: SubsonicStructuredLyrics = {
      synced: true,
      line: [{ start: 0, value: 'lead' }],
      agents: [{ id: 'v1', role: 'main' }, { id: 'v2', role: 'bg' }],
      cueLine: [
        { index: 0, end: 1000, value: 'lead', agentId: 'v1', cue: [cue(0, 'lead', 1000)] },
        { index: 0, end: 1000, value: 'ooh', agentId: 'v2', cue: [cue(0, 'ooh', 1000)] },
      ],
    };
    const lines = parseStructuredWordLines(lyrics)!;
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('lead');
    expect(lines[0].words).toEqual([{ text: 'lead', time: 0, duration: 1 }]);
  });

  it('falls back to the next line start when the cue line has no end', () => {
    const lyrics: SubsonicStructuredLyrics = {
      synced: true,
      line: [{ start: 0, value: 'a' }, { start: 2000, value: 'b' }],
      cueLine: [
        { index: 0, value: 'a', cue: [cue(0, 'a')] },
        { index: 1, value: 'b', cue: [cue(2000, 'b')] },
      ],
    };
    const lines = parseStructuredWordLines(lyrics)!;
    expect(lines[0].duration).toBe(2);
    expect(lines[0].words[0].duration).toBe(2);
  });
});
