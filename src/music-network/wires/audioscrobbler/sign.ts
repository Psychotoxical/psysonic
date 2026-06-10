// Audioscrobbler v2 — signature base-string construction.
//
// The actual api_sig (MD5 of base-string + secret) is computed in Rust. This is
// a TS mirror of the *ordering rule* — sorted params, `format`/`callback`
// excluded, key+value concatenated — so the fragile part stays unit-testable
// without pulling an MD5 dependency into the frontend.

/**
 * Builds the Audioscrobbler signature base string from request params plus the
 * api_key, exactly as the Rust transport does before appending the secret.
 */
export function buildSignatureBaseString(
  params: Record<string, string>,
  apiKey: string,
): string {
  const all: Record<string, string> = { ...params, api_key: apiKey };
  return Object.keys(all)
    .filter(k => k !== 'format' && k !== 'callback')
    .sort()
    .map(k => `${k}${all[k]}`)
    .join('');
}
