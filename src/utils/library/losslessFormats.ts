/** Containers that are *only* lossless — keep in sync with Rust `lossless_formats.rs`. */
export const LOSSLESS_SUFFIXES = new Set([
  'flac', 'wav', 'wave', 'aiff', 'aif', 'dsf', 'dff', 'ape', 'wv', 'shn', 'tta',
]);

export function isLosslessSuffix(suffix?: string | null): boolean {
  if (!suffix) return false;
  return LOSSLESS_SUFFIXES.has(suffix.toLowerCase());
}
