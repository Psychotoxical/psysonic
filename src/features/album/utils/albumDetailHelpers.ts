/**
 * Make an arbitrary album / playlist name safe to use as a file name on
 * Windows, macOS, and Linux. Replaces every reserved character class with
 * a dash, collapses runs of dots (which Windows treats specially) into one,
 * trims leading/trailing whitespace and dots, and caps the length at 200
 * characters so we don't hit MAX_PATH edges on Windows. Falls back to
 * `download` when the sanitisation strips the name down to nothing.
 */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .substring(0, 200) || 'download';
}
