import { useEffect } from 'react';
import { version as appVersion } from '@/../package.json';
import { isWorkspaceReleaseNotesMode } from '@/features/whatsNew/utils/releaseNotesChannel';
import { resolveReleaseNotes } from '@/features/whatsNew/utils/releaseNotesResolve';

/**
 * Warm the release-notes cache after an update (RC/stable only).
 * Runs once per app session; resolveReleaseNotes skips network when cached.
 */
export function usePrefetchReleaseNotes(version: string = appVersion): void {
  useEffect(() => {
    if (isWorkspaceReleaseNotesMode(version)) return;
    void resolveReleaseNotes(version).catch(() => {
      /* offline or missing asset — embedded fallback loads on /whats-new */
    });
  }, [version]);
}
