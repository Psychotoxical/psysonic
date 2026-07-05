import { useEffect, useState } from 'react';
import { version as appVersion } from '@/../package.json';
import {
  resolveChangelogEntry,
  resolveReleaseNotes,
  type ReleaseNotesSource,
} from '@/features/whatsNew/utils/releaseNotesResolve';
import type { ReleaseNotesEntry } from '@/features/whatsNew/utils/releaseNotesMatch';

export interface UseReleaseNotesResult {
  loading: boolean;
  whatsNewEntry: ReleaseNotesEntry | null;
  changelogEntry: ReleaseNotesEntry | null;
  whatsNewSource: ReleaseNotesSource;
}

export function useReleaseNotes(version: string = appVersion): UseReleaseNotesResult {
  const [loading, setLoading] = useState(true);
  const [whatsNewEntry, setWhatsNewEntry] = useState<ReleaseNotesEntry | null>(null);
  const [changelogEntry, setChangelogEntry] = useState<ReleaseNotesEntry | null>(null);
  const [whatsNewSource, setWhatsNewSource] = useState<ReleaseNotesSource>('empty');

  useEffect(() => {
    let cancelled = false;
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);

    Promise.all([resolveReleaseNotes(version), resolveChangelogEntry(version)])
      .then(([whatsNew, changelog]) => {
        if (cancelled) return;
        setWhatsNewEntry(whatsNew.entry);
        setWhatsNewSource(whatsNew.source);
        setChangelogEntry(changelog.entry);
      })
      .catch(() => {
        if (cancelled) return;
        setWhatsNewEntry(null);
        setChangelogEntry(null);
        setWhatsNewSource('empty');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [version]);

  return { loading, whatsNewEntry, changelogEntry, whatsNewSource };
}
