import type { SubsonicSong } from '../api/subsonicTypes';

export function formatTime(s: number): string {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

export function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

export function formatTotalDuration(s: number): string {
  if (!s || isNaN(s)) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function sanitizeHtml(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, form, input, button, select, base, meta, link').forEach(el => el.remove());
  doc.querySelectorAll('*').forEach(el => {
    Array.from(el.attributes).forEach(attr => {
      const name = attr.name.toLowerCase();
      const val = attr.value.toLowerCase().trim();
      if (name.startsWith('on') || (name === 'href' && (val.startsWith('javascript:') || val.startsWith('data:'))) || (name === 'src' && (val.startsWith('javascript:') || val.startsWith('data:')))) {
        el.removeAttribute(attr.name);
      }
    });
  });
  // Strip trailing "Read more on Last.fm" style links for cleaner clamped bios.
  return doc.body.innerHTML.replace(/<a [^>]*>.*?<\/a>\.?\s*$/i, '').trim();
}

export function isoToParts(iso: string): { month: string; day: string; weekday: string; time: string } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return {
    month: d.toLocaleString(undefined, { month: 'short' }),
    day: String(d.getDate()),
    weekday: d.toLocaleString(undefined, { weekday: 'short' }),
    time: d.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' }),
  };
}

export interface ContributorRow { role: string; names: string[]; }

export function buildContributorRows(song: SubsonicSong | null | undefined, mainArtistName: string): ContributorRow[] {
  if (!song?.contributors || song.contributors.length === 0) return [];
  const mainLower = mainArtistName.trim().toLowerCase();
  const rows = new Map<string, Set<string>>();
  for (const c of song.contributors) {
    const role = c.role?.trim();
    const name = c.artist?.name?.trim();
    if (!role || !name) continue;
    const label = c.subRole ? `${role} • ${c.subRole}` : role;
    let bucket = rows.get(label);
    if (!bucket) { bucket = new Set(); rows.set(label, bucket); }
    bucket.add(name);
  }
  const out: ContributorRow[] = [];
  for (const [role, names] of rows.entries()) {
    const list = Array.from(names);
    if (role.toLowerCase().startsWith('artist') && list.length === 1 && list[0].toLowerCase() === mainLower) continue;
    out.push({ role, names: list });
  }
  return out;
}

/**
 * Filter out the well-known Last.fm "no image" placeholder that Subsonic
 * backends aggregate into `largeImageUrl`/`mediumImageUrl` when no real
 * artist image exists. The placeholder MD5 is fixed and documented.
 */
export function isRealArtistImage(url?: string): boolean {
  if (!url) return false;
  if (url.includes('2a96cbd8b46e442fc41c2b86b821562f')) return false;
  return true;
}
