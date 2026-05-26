export const LOSSLESS_MODE_QUERY = 'lossless=1';

export function isLosslessMode(searchParams: URLSearchParams): boolean {
  return searchParams.get('lossless') === '1';
}
