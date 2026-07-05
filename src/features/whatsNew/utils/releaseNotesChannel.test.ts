import { describe, expect, it } from 'vitest';
import { isDevChannelVersion, isWorkspaceReleaseNotesMode } from '@/features/whatsNew/utils/releaseNotesChannel';

describe('releaseNotesChannel', () => {
  it('detects -dev channel versions', () => {
    expect(isDevChannelVersion('1.48.0-dev')).toBe(true);
    expect(isDevChannelVersion('1.48.0')).toBe(false);
    expect(isDevChannelVersion('1.48.0-rc.1')).toBe(false);
  });

  it('enables workspace mode in vitest DEV builds', () => {
    expect(isWorkspaceReleaseNotesMode('1.48.0')).toBe(import.meta.env.DEV);
    expect(isWorkspaceReleaseNotesMode('1.48.0-dev')).toBe(true);
  });
});
