import type { ServerProfile } from '../store/authStore';

/** Host (+ port) from a server base URL, e.g. `https://music.one.com/foo` → `music.one.com`. */
export function shortHostFromServerUrl(urlRaw: string): string {
  const t = urlRaw.trim();
  if (!t) return '';
  try {
    const u = new URL(t.includes('://') ? t : `https://${t}`);
    return u.host;
  } catch {
    return t
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      ?.split('?')[0]
      ?.trim() ?? t;
  }
}

/**
 * Label for server lists and chrome: if several servers share the same effective name,
 * show `username@host` so entries stay distinguishable.
 */
export function serverListDisplayLabel(server: ServerProfile, all: ServerProfile[]): string {
  const nameTrim = (server.name || '').trim();
  const shortHost = shortHostFromServerUrl(server.url);
  const key = nameTrim || shortHost;
  const collisions = all.filter(s => {
    const nt = (s.name || '').trim();
    const sh = shortHostFromServerUrl(s.url);
    return (nt || sh) === key;
  });
  if (collisions.length < 2) {
    return nameTrim || shortHost || server.url.trim();
  }
  return `${server.username}@${shortHost}`;
}
