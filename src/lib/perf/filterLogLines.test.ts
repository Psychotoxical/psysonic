import { describe, expect, it } from 'vitest';
import { filterLogLines, parseLogFilter } from '@/lib/perf/filterLogLines';

const L = (text: string) => ({ text });
const lines = [
  L('[10:00] cover error: timeout'),
  L('[10:01] cover ok album=Discovery'),
  L('[10:02] analysis warn: slow'),
  L('[10:03] cover error spam noise'),
];

const texts = (rows: { text: string }[]) => rows.map(r => r.text);

describe('parseLogFilter', () => {
  it('classifies include and exclude tokens, trims, drops empties', () => {
    expect(parseLogFilter(' cover , -spam ,, - , error')).toEqual([
      { kind: 'include', word: 'cover' },
      { kind: 'exclude', word: 'spam' },
      { kind: 'include', word: 'error' },
    ]);
  });
});

describe('filterLogLines', () => {
  it('returns all lines when filter is empty', () => {
    expect(filterLogLines(lines, '   ')).toHaveLength(4);
  });

  it('include-only narrows to matching lines (union of includes)', () => {
    expect(texts(filterLogLines(lines, 'error, warn'))).toEqual([
      '[10:00] cover error: timeout',
      '[10:02] analysis warn: slow',
      '[10:03] cover error spam noise',
    ]);
  });

  it('exclude-first starts from all and removes matches', () => {
    expect(texts(filterLogLines(lines, '-cover'))).toEqual([
      '[10:02] analysis warn: slow',
    ]);
  });

  it('respects sequence: include then exclude', () => {
    expect(texts(filterLogLines(lines, 'cover, -spam'))).toEqual([
      '[10:00] cover error: timeout',
      '[10:01] cover ok album=Discovery',
    ]);
  });

  it('layering order matters: later layer overrides earlier', () => {
    expect(filterLogLines(lines, 'error, -error')).toHaveLength(0);
    expect(filterLogLines(lines, '-error, error')).toHaveLength(4);
  });

  it('is case-insensitive', () => {
    expect(texts(filterLogLines(lines, 'DISCOVERY'))).toEqual([
      '[10:01] cover ok album=Discovery',
    ]);
  });
});
