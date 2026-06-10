import { useEffect, useState } from 'react';
import { version as appVersion } from '../../package.json';
import {
  resolveReleaseNotes,
  type ReleaseNotesSource,
} from '../utils/releaseNotes/releaseNotesResolve';
import type { ReleaseNotesEntry } from '../utils/releaseNotes/releaseNotesMatch';

export interface UseReleaseNotesResult {
  loading: boolean;
  entry: ReleaseNotesEntry | null;
  source: ReleaseNotesSource;
}

export function useReleaseNotes(version: string = appVersion): UseReleaseNotesResult {
  const [loading, setLoading] = useState(true);
  const [entry, setEntry] = useState<ReleaseNotesEntry | null>(null);
  const [source, setSource] = useState<ReleaseNotesSource>('empty');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    resolveReleaseNotes(version)
      .then((resolved) => {
        if (cancelled) return;
        setEntry(resolved.entry);
        setSource(resolved.source);
      })
      .catch(() => {
        if (cancelled) return;
        setEntry(null);
        setSource('empty');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [version]);

  return { loading, entry, source };
}
