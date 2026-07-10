import { describe, expect, it } from 'vitest';
import { parseEnhancedLrc, parseLrc } from '@/features/lyrics/utils/lrc';

describe('parseLrc', () => {
  it('parses plain LRC with and without fractional seconds', () => {
    expect(parseLrc('[00:15]first\n[01:02.50]second')).toEqual([
      { time: 15, text: 'first' },
      { time: 62.5, text: 'second' },
    ]);
  });

  it('sorts by time and skips unstamped lines', () => {
    expect(parseLrc('[ti:Title]\n[00:20]later\n\n[00:10]earlier')).toEqual([
      { time: 10, text: 'earlier' },
      { time: 20, text: 'later' },
    ]);
  });

  it('strips inline Enhanced LRC word markers from the text', () => {
    // Regression: the markers used to survive into the rendered line.
    expect(parseLrc('[00:12.00]<00:12.00>Hello <00:12.90>world')).toEqual([
      { time: 12, text: 'Hello world' },
    ]);
  });
});

describe('parseEnhancedLrc', () => {
  it('returns null word lines for plain LRC', () => {
    const { lines, wordLines } = parseEnhancedLrc('[00:10]just a line');
    expect(lines).toEqual([{ time: 10, text: 'just a line' }]);
    expect(wordLines).toBeNull();
  });

  it('derives word timing from inline markers, ending at the next line', () => {
    const { lines, wordLines } = parseEnhancedLrc(
      '[00:12.00]<00:12.00>Hello <00:12.90>world\n[00:14.00]<00:14.00>bye',
    );
    expect(lines).toEqual([
      { time: 12, text: 'Hello world' },
      { time: 14, text: 'bye' },
    ]);
    expect(wordLines).toHaveLength(2);

    // Durations are seconds derived by subtraction, so compare with tolerance.
    const [first, second] = wordLines!;
    expect(first.text).toBe('Hello world');
    expect(first.time).toBe(12);
    expect(first.duration).toBeCloseTo(2, 5);
    expect(first.words.map(w => w.text)).toEqual(['Hello ', 'world']);
    expect(first.words[0].time).toBe(12);
    expect(first.words[0].duration).toBeCloseTo(0.9, 5);
    expect(first.words[1].time).toBeCloseTo(12.9, 5);
    expect(first.words[1].duration).toBeCloseTo(1.1, 5);

    expect(second).toEqual({
      time: 14,
      duration: 0,
      text: 'bye',
      words: [{ text: 'bye', time: 14, duration: 0 }],
    });
  });

  it('folds text before the first marker into the first word', () => {
    const { wordLines } = parseEnhancedLrc('[00:01.00]Oh <00:01.50>yeah\n[00:03.00]end');
    expect(wordLines?.[0].text).toBe('Oh yeah');
    expect(wordLines?.[0].words).toEqual([{ text: 'Oh yeah', time: 1.5, duration: 1.5 }]);
  });

  it('keeps a marker-free line as one full-line word so no line is dropped', () => {
    const { wordLines } = parseEnhancedLrc('[00:00.00]<00:00.00>sung\n[00:02.00]instrumental\n[00:05.00]<00:05.00>again');
    expect(wordLines).toHaveLength(3);
    expect(wordLines?.[1]).toEqual({
      time: 2,
      duration: 3,
      text: 'instrumental',
      words: [{ text: 'instrumental', time: 2, duration: 3 }],
    });
  });
});
