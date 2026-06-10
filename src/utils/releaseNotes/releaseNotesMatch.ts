/**
 * Match ## [version] sections in release-notes markdown to the app version.
 * Exact match first; otherwise same semver major.minor.patch (ignores -rc, -dev, etc.).
 */

const SEMVER_CORE = /^v?(\d+\.\d+\.\d+)/i;

export function releaseNotesVersionCore(version: string): string | null {
  const m = version.trim().match(SEMVER_CORE);
  return m ? m[1] : null;
}

function isPlainSemverTriple(header: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(header.trim());
}

export function splitReleaseNotesBlocks(markdownRaw: string): string[] {
  return markdownRaw.split(/\n(?=## \[)/).filter((b: string) => b.startsWith('## ['));
}

export interface ReleaseNotesEntry {
  headerVersion: string;
  date: string;
  body: string;
}

function parseBlock(block: string): ReleaseNotesEntry | null {
  const lines = block.split('\n');
  const m = lines[0].match(/## \[([^\]]+)\](?:\s*-\s*(.+))?/);
  if (!m) return null;
  return {
    headerVersion: m[1],
    date: (m[2] ?? '').trim(),
    body: lines.slice(1).join('\n').trim(),
  };
}

function headerVersionFromBlock(block: string): string | null {
  const m = block.match(/^## \[([^\]]+)\]/);
  return m ? m[1] : null;
}

export function findReleaseNotesEntry(
  markdownRaw: string,
  appVersion: string,
): ReleaseNotesEntry | null {
  const blocks = splitReleaseNotesBlocks(markdownRaw);

  const exact = blocks.find((b: string) => b.startsWith(`## [${appVersion}]`));
  if (exact) return parseBlock(exact);

  const appCore = releaseNotesVersionCore(appVersion);
  if (!appCore) return null;

  const candidates = blocks.filter((b: string) => {
    const hv = headerVersionFromBlock(b);
    if (!hv) return false;
    return releaseNotesVersionCore(hv) === appCore;
  });
  if (candidates.length === 0) return null;

  const plain = candidates.find((b: string) => {
    const hv = headerVersionFromBlock(b);
    return hv !== null && isPlainSemverTriple(hv);
  });
  const chosen = plain ?? candidates[0];
  return parseBlock(chosen);
}

/** @deprecated Use findReleaseNotesEntry */
export const findChangelogReleaseEntry = findReleaseNotesEntry;

/** @deprecated Use ReleaseNotesEntry */
export type ChangelogReleaseEntry = ReleaseNotesEntry;

/** @deprecated Use releaseNotesVersionCore */
export const changelogVersionCore = releaseNotesVersionCore;

/** @deprecated Use splitReleaseNotesBlocks */
export const splitChangelogBlocks = splitReleaseNotesBlocks;
