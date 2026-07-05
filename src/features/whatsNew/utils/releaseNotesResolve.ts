import { isWorkspaceReleaseNotesMode } from '@/features/whatsNew/utils/releaseNotesChannel';
import { readReleaseNotesCache, writeReleaseNotesCache } from '@/features/whatsNew/utils/releaseNotesCache';
import { fetchWhatsNewAsset } from '@/features/whatsNew/utils/releaseNotesFetch';
import { findReleaseNotesEntry, type ReleaseNotesEntry } from '@/features/whatsNew/utils/releaseNotesMatch';

export type ReleaseNotesSource =
  | 'workspace'
  | 'workspace-changelog'
  | 'cache'
  | 'remote'
  | 'embedded-whats-new'
  | 'embedded-changelog'
  | 'empty';

export interface ResolvedReleaseNotes {
  source: ReleaseNotesSource;
  entry: ReleaseNotesEntry | null;
}

async function loadWorkspaceWhatsNewRaw(): Promise<string> {
  if (import.meta.env.DEV) {
    return (await import('@/../WHATS_NEW.md?raw')).default;
  }
  const { WHATS_NEW_RAW } = await import('@/generated/releaseNotesBundle');
  return WHATS_NEW_RAW;
}

async function loadWorkspaceChangelogRaw(): Promise<string> {
  if (import.meta.env.DEV) {
    return (await import('@/../CHANGELOG.md?raw')).default;
  }
  const { CHANGELOG_RAW } = await import('@/generated/releaseNotesBundle');
  return CHANGELOG_RAW;
}

async function loadEmbeddedWhatsNewRaw(): Promise<string> {
  const { WHATS_NEW_RAW } = await import('@/generated/releaseNotesBundle');
  return WHATS_NEW_RAW;
}

async function loadEmbeddedChangelogRaw(): Promise<string> {
  const { CHANGELOG_RAW } = await import('@/generated/releaseNotesBundle');
  return CHANGELOG_RAW;
}

function mergeBodyWithMeta(body: string, meta: ReleaseNotesEntry | null, version: string): ReleaseNotesEntry {
  return {
    body,
    date: meta?.date ?? '',
    headerVersion: meta?.headerVersion ?? version,
  };
}

async function resolveWorkspace(version: string): Promise<ResolvedReleaseNotes> {
  const whatsNewRaw = await loadWorkspaceWhatsNewRaw();
  const fromWhatsNew = findReleaseNotesEntry(whatsNewRaw, version);
  if (fromWhatsNew?.body) {
    return { source: 'workspace', entry: fromWhatsNew };
  }

  const changelogRaw = await loadWorkspaceChangelogRaw();
  const fromChangelog = findReleaseNotesEntry(changelogRaw, version);
  if (fromChangelog?.body) {
    return { source: 'workspace-changelog', entry: fromChangelog };
  }

  return { source: 'empty', entry: null };
}

async function resolveShipped(version: string): Promise<ResolvedReleaseNotes> {
  const embeddedMeta = findReleaseNotesEntry(await loadEmbeddedWhatsNewRaw(), version);

  const cached = await readReleaseNotesCache(version);
  if (cached) {
    return {
      source: 'cache',
      entry: mergeBodyWithMeta(cached, embeddedMeta, version),
    };
  }

  const remote = await fetchWhatsNewAsset(version);
  if (remote) {
    await writeReleaseNotesCache(version, remote);
    return {
      source: 'remote',
      entry: mergeBodyWithMeta(remote, embeddedMeta, version),
    };
  }

  const fromEmbeddedWhatsNew = findReleaseNotesEntry(await loadEmbeddedWhatsNewRaw(), version);
  if (fromEmbeddedWhatsNew?.body) {
    return { source: 'embedded-whats-new', entry: fromEmbeddedWhatsNew };
  }

  const fromEmbeddedChangelog = findReleaseNotesEntry(await loadEmbeddedChangelogRaw(), version);
  if (fromEmbeddedChangelog?.body) {
    return { source: 'embedded-changelog', entry: fromEmbeddedChangelog };
  }

  return { source: 'empty', entry: null };
}

export async function resolveReleaseNotes(version: string): Promise<ResolvedReleaseNotes> {
  if (isWorkspaceReleaseNotesMode(version)) {
    return resolveWorkspace(version);
  }
  return resolveShipped(version);
}

/** Technical changelog for the same version (embedded or workspace; never remote). */
export async function resolveChangelogEntry(version: string): Promise<ResolvedReleaseNotes> {
  const changelogRaw = isWorkspaceReleaseNotesMode(version)
    ? await loadWorkspaceChangelogRaw()
    : await loadEmbeddedChangelogRaw();
  const entry = findReleaseNotesEntry(changelogRaw, version);
  if (entry?.body) {
    return {
      source: isWorkspaceReleaseNotesMode(version) ? 'workspace-changelog' : 'embedded-changelog',
      entry,
    };
  }
  return { source: 'empty', entry: null };
}
