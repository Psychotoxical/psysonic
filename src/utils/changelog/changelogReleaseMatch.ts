/**
 * Match CHANGELOG ## [version] sections to the app version from package.json.
 * Exact match first; otherwise same semver major.minor.patch (ignores -rc, -dev, etc.).
 */

const SEMVER_CORE = /^v?(\d+\.\d+\.\d+)/i;

export function changelogVersionCore(version: string): string | null {
  const m = version.trim().match(SEMVER_CORE);
  return m ? m[1] : null;
}

function isPlainSemverTriple(header: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(header.trim());
}

export function splitChangelogBlocks(changelogRaw: string): string[] {
  return changelogRaw.split(/\n(?=## \[)/).filter((b: string) => b.startsWith('## ['));
}

export interface ChangelogReleaseEntry {
  headerVersion: string;
  date: string;
  body: string;
}

function parseBlock(block: string): ChangelogReleaseEntry | null {
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

export function findChangelogReleaseEntry(
  changelogRaw: string,
  appVersion: string,
): ChangelogReleaseEntry | null {
  const blocks = splitChangelogBlocks(changelogRaw);

  const exact = blocks.find((b: string) => b.startsWith(`## [${appVersion}]`));
  if (exact) return parseBlock(exact);

  const appCore = changelogVersionCore(appVersion);
  if (!appCore) return null;

  const candidates = blocks.filter((b: string) => {
    const hv = headerVersionFromBlock(b);
    if (!hv) return false;
    return changelogVersionCore(hv) === appCore;
  });
  if (candidates.length === 0) return null;

  const plain = candidates.find((b: string) => {
    const hv = headerVersionFromBlock(b);
    return hv !== null && isPlainSemverTriple(hv);
  });
  const chosen = plain ?? candidates[0];
  return parseBlock(chosen);
}
