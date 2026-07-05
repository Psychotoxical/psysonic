import type { ServerProfile } from '@/store/authStoreTypes';
/** Host (+ port) from a server base URL, e.g. `https://music.one.com/foo` → `music.one.com`. */
export function shortHostFromServerUrl(urlRaw?: string | null): string {
  const t = typeof urlRaw === 'string' ? urlRaw.trim() : '';
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

/** Settings server card primary line: `username@host`. */
export function serverIdentityLabel(server: ServerProfile): string {
  const shortHost = shortHostFromServerUrl(server.url);
  const host = shortHost || (typeof server.url === 'string' ? server.url.trim() : '');
  return `${server.username}@${host}`;
}

/** Settings server card title: custom entry name, or short host when unset. */
export function serverSettingsEntryTitle(server: ServerProfile): string {
  const nameTrim = (server.name || '').trim();
  if (nameTrim) return nameTrim;
  return shortHostFromServerUrl(server.url) || (typeof server.url === 'string' ? server.url.trim() : '');
}

/**
 * Label for server lists and chrome: if several servers share the same effective name,
 * show `username@host` so entries stay distinguishable.
 */
export function serverListDisplayLabel(server: ServerProfile, all: ServerProfile[]): string {
  const nameTrim = (server.name || '').trim();
  const safeUrl = typeof server.url === 'string' ? server.url : '';
  const shortHost = shortHostFromServerUrl(safeUrl);
  const key = nameTrim || shortHost;
  const collisions = all.filter(s => {
    const nt = (s.name || '').trim();
    const sh = shortHostFromServerUrl(s.url);
    return (nt || sh) === key;
  });
  if (collisions.length < 2) {
    return nameTrim || shortHost || safeUrl.trim();
  }
  return `${server.username}@${shortHost}`;
}
