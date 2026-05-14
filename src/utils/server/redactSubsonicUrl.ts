/**
 * Masks Subsonic wire-auth query params so debug logs are safe to copy.
 * (`t` salt, `s` token hash, `p` password when present.)
 */
export function redactSubsonicUrlForLog(url: string): string {
  if (!url || !url.includes('stream.view')) return url;
  try {
    const u = new URL(url);
    // Placeholder must stay URL-safe (no `<>` — URLSearchParams percent-encodes them).
    for (const k of ['t', 's', 'p'] as const) {
      if (u.searchParams.has(k)) u.searchParams.set(k, 'REDACTED');
    }
    return u.toString();
  } catch {
    return url.replace(/([?&])(t|s|p)=([^&]*)/gi, (_m, sep: string, key: string) => `${sep}${key}=REDACTED`);
  }
}
