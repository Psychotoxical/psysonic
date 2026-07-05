// Normalize strings for matching: remove accents, special chars, lowercase, trim
export function normalizeForMatching(s: string): string {
  return s.toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ø]/gi, 'o')
    .replace(/[æ]/gi, 'ae')
    .trim();
}

// Clean common title suffixes (remastered, live, editions, etc.)
export function cleanTrackTitle(title: string): string {
  const suffixes = [
    // Remastered variants
    /\s*-\s*remasterizado$/i,
    /\s*-\s*remaster$/i,
    /\s*-\s*remastered$/i,
    /\s*\(remasterizado\)$/i,
    /\s*\(remaster\)$/i,
    /\s*\(remastered\)$/i,
    /\s*\[remasterizado\]$/i,
    /\s*\[remaster\]$/i,
    /\s*\[remastered\]$/i,
    /\s*-\s*remasterizado\s+\d{4}$/i,
    /\s*-\s*remastered\s+\d{4}$/i,
    /\s*\(\d{4}\s+remaster\)$/i,
    /\s*\(\d{4}\s+remastered\)$/i,
    // Live variants
    /\s*-\s*en vivo$/i,
    /\s*-\s*live$/i,
    /\s*-\s*version en vivo$/i,
    /\s*-\s*studio version$/i,
    /\s*-\s*version de estudio$/i,
    /\s*\(en vivo\)$/i,
    /\s*\(live\)$/i,
    /\s*\(live .*\)$/i,
    /\s*\[en vivo\]$/i,
    /\s*\[live\]$/i,
    /\s*\[live .*\]$/i,
    /\s*-\s*live at.*$/i,
    /\s*\(live at.*\)$/i,
    // Version/Edition variants
    /\s*-\s*version$/i,
    /\s*-\s*versión$/i,
    /\s*\(version\)$/i,
    /\s*\(versión\)$/i,
    /\s*\[version\]$/i,
    /\s*\[versión\]$/i,
    /\s*-\s*album version$/i,
    /\s*\(album version\)$/i,
    /\s*\[album version\]$/i,
    // Radio/Edit variants
    /\s*-\s*radio edit$/i,
    /\s*-\s*radio version$/i,
    /\s*\(radio edit\)$/i,
    /\s*\(radio version\)$/i,
    /\s*\[radio edit\]$/i,
    /\s*\[radio version\]$/i,
    /\s*-\s*edit$/i,
    /\s*\(edit\)$/i,
    /\s*\[edit\]$/i,
    // Acoustic/Instrumental variants
    /\s*-\s*acoustic$/i,
    /\s*-\s*acústico$/i,
    /\s*\(acoustic\)$/i,
    /\s*\(acústico\)$/i,
    /\s*\[acoustic\]$/i,
    /\s*\[acústico\]$/i,
    /\s*-\s*instrumental$/i,
    /\s*\(instrumental\)$/i,
    /\s*\[instrumental\]$/i,
    // Featuring/Feat/Ft/With variants
    /\s*\(feat\.?\s+.*\)$/i,
    /\s*\[feat\.?\s+.*\]$/i,
    /\s*-\s*feat\.?\s+.*$/i,
    /\s*\(featuring\s+.*\)$/i,
    /\s*\[featuring\s+.*\]$/i,
    /\s*\(ft\.?\s+.*\)$/i,
    /\s*\[ft\.?\s+.*\]$/i,
    /\s*-\s*ft\.?\s+.*$/i,
    /\s*\(with\s+.*\)$/i,
    /\s*\[with\s+.*\]$/i,
    /\s*-\s*with\s+.*$/i,
    /\s*ft\.?\s+.*$/i,
    // Explicit/Clean tags
    /\s*\(explicit\)$/i,
    /\s*\[explicit\]$/i,
    /\s*\(clean\)$/i,
    /\s*\[clean\]$/i,
    // Mono/Stereo
    /\s*\(mono\)$/i,
    /\s*\[mono\]$/i,
    /\s*\(stereo\)$/i,
    /\s*\[stereo\]$/i,
    // Deluxe/Special editions
    /\s*-\s*deluxe$/i,
    /\s*\(deluxe\)$/i,
    /\s*\[deluxe\]$/i,
    /\s*-\s*special edition$/i,
    /\s*\(special edition\)$/i,
    /\s*\[special edition\]$/i,
    // Year in parentheses (common in remasters)
    /\s*\(\d{4}\)$/i,
  ];
  let cleaned = title.trim();
  // Apply patterns multiple times for nested cases
  for (let i = 0; i < 3; i++) {
    const previous = cleaned;
    for (const regex of suffixes) {
      cleaned = cleaned.replace(regex, '');
    }
    cleaned = cleaned.trim();
    if (previous === cleaned) break; // No more changes
  }
  return cleaned;
}

// Levenshtein distance for similarity scoring
export function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] = b[i - 1] === a[j - 1]
        ? matrix[i - 1][j - 1]
        : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
    }
  }
  return matrix[b.length][a.length];
}

export function similarityScore(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  // Use normalized strings (without accents) for comparison
  const dist = levenshtein(normalizeForMatching(a), normalizeForMatching(b));
  return 1 - dist / maxLen;
}

// Calculate dynamic threshold based on match quality signals
export function calculateDynamicThreshold(
  bestMatch: { score: number; artistScore: number },
  secondMatch: { score: number } | undefined,
  titleWords: number
): number {
  const baseThreshold = 0.6; // Minimum acceptable score

  // Bonus if there's a large gap between best and second match (clear winner)
  const gap = secondMatch ? bestMatch.score - secondMatch.score : 0.3;
  const gapBonus = gap > 0.15 ? 0.1 : gap > 0.08 ? 0.05 : 0;

  // Short titles (< 3 words) are more ambiguous, need higher threshold
  // Long titles (> 4 words) are more specific, can use lower threshold
  const lengthBonus = titleWords > 4 ? 0.05 : titleWords < 3 ? -0.05 : 0;

  // Strong artist match gives confidence to accept lower overall score
  const artistBonus = bestMatch.artistScore > 0.85 ? 0.08 : bestMatch.artistScore > 0.7 ? 0.04 : 0;

  // Calculate final threshold, clamp between 0.55 and 0.75
  return Math.max(0.55, Math.min(0.75, baseThreshold - gapBonus - lengthBonus - artistBonus));
}

// Process searches in batches to avoid overloading the server
export async function processBatch<T, R>(
  items: T[],
  batchSize: number,
  processor: (item: T) => Promise<R | null>
): Promise<(R | null)[]> {
  const results: (R | null)[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
  }
  return results;
}
