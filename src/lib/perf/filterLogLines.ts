/**
 * Ordered include/exclude log filter.
 *
 * The filter string is a comma-separated list of tokens applied left to right
 * as layers — sequence matters:
 *   - a plain word `foo`  → INCLUDE: lines containing `foo` are shown.
 *   - a word with a leading `-` (`-foo`) → EXCLUDE: lines containing `foo`
 *     are hidden.
 *
 * Layering model (paint order):
 *   - If the first token is an exclude, the baseline is "all lines visible";
 *     otherwise the baseline is "nothing visible" (include-only narrows down).
 *   - Each include unions in the matching lines; each exclude removes matching
 *     lines from what is currently visible. A later layer overrides an earlier
 *     one, so `error, -error` shows nothing while `-error, error` shows all.
 *
 * Matching is case-insensitive and substring-based.
 */
export type LogFilterToken = {
  kind: 'include' | 'exclude';
  word: string;
};

export function parseLogFilter(filter: string): LogFilterToken[] {
  return filter
    .split(',')
    .map(raw => raw.trim())
    .filter(raw => raw.length > 0)
    .map<LogFilterToken | null>(raw => {
      if (raw.startsWith('-')) {
        const word = raw.slice(1).trim().toLowerCase();
        return word.length > 0 ? { kind: 'exclude', word } : null;
      }
      return { kind: 'include', word: raw.toLowerCase() };
    })
    .filter((t): t is LogFilterToken => t !== null);
}

export function filterLogLines<T extends { text: string }>(
  lines: readonly T[],
  filter: string,
): T[] {
  const tokens = parseLogFilter(filter);
  if (tokens.length === 0) return [...lines];

  const haystacks = lines.map(l => l.text.toLowerCase());
  const visible = new Array<boolean>(lines.length);

  // Baseline: include-first starts hidden; exclude-first starts visible.
  const startVisible = tokens[0].kind === 'exclude';
  visible.fill(startVisible);

  for (const token of tokens) {
    for (let i = 0; i < lines.length; i += 1) {
      const matches = haystacks[i].includes(token.word);
      if (!matches) continue;
      visible[i] = token.kind === 'include';
    }
  }

  return lines.filter((_, i) => visible[i]);
}
