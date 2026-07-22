import { beforeEach, describe, expect, it } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import { useAuthStore } from '@/store/authStore';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { frontendDebugLog } from '@/lib/api/debugLog';
import {
  describeMultiServerError,
  emitMultiServerDebug,
  summarizeMultiServerProfiles,
  summarizeMusicFoldersByServer,
} from './multiServerDebug';

beforeEach(resetAuthStore);

describe('multiServerDebug', () => {
  it('writes structured multi-server diagnostics only at debug depth 3', () => {
    const captured: Array<{ scope: string; message: string }> = [];
    onInvoke('frontend_debug_log', args => {
      captured.push(args as { scope: string; message: string });
      return undefined;
    });

    emitMultiServerDebug('normal_skip', { value: 1 });
    useAuthStore.setState({ loggingMode: 'debug' });
    emitMultiServerDebug('depth_one_skip', { value: 2 });
    useAuthStore.setState({ debugLoggingDepth: 3 });
    emitMultiServerDebug('scope_snapshot', { activeServerId: 'a' });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.scope).toBe('multi-server');
    expect(JSON.parse(captured[0]?.message ?? '{}')).toMatchObject({
      step: 'scope_snapshot',
      details: { activeServerId: 'a' },
    });
  });

  it('treats frontend diagnostics without an explicit depth as basic level 1', () => {
    const captured: Array<{ scope: string; message: string }> = [];
    onInvoke('frontend_debug_log', args => {
      captured.push(args as { scope: string; message: string });
      return undefined;
    });
    useAuthStore.setState({ loggingMode: 'debug', debugLoggingDepth: 1 });

    frontendDebugLog('existing', 'level-one');
    frontendDebugLog('deeper', 'level-three', 3);

    expect(captured).toEqual([{ scope: 'existing', message: 'level-one' }]);
  });

  it('summarizes profiles and folders without credential fields or full URLs', () => {
    expect(summarizeMultiServerProfiles([{
      id: 'profile-a',
      name: 'Home',
      url: 'https://music.example.test',
      alternateUrl: 'http://192.168.1.2:4533',
    }])).toEqual([{
      position: 0,
      profileId: 'profile-a',
      name: 'Home',
      indexKey: 'music.example.test',
      hasPrimaryUrl: true,
      hasAlternateUrl: true,
    }]);
    expect(summarizeMusicFoldersByServer({
      'profile-a': [{ id: 'music', name: 'Music' }],
    })).toEqual({
      'profile-a': [{ id: 'music', name: 'Music' }],
    });
  });

  it('redacts credentials and query parameters from diagnostic URLs and errors', () => {
    expect(summarizeMultiServerProfiles([{
      id: 'profile-a',
      url: 'https://user:secret@music.example.test/subsonic?token=hidden',
    }])[0]?.indexKey).toBe('music.example.test/subsonic');

    expect(describeMultiServerError(new Error(
      'GET https://user:secret@music.example.test/rest/ping?token=hidden failed authorization=secret',
    ))).toBe(
      'Error: GET https://music.example.test/rest/ping failed authorization=[redacted]',
    );
  });
});
