import { describe, expect, it } from 'vitest';
import { encodeSharePayload } from '@/lib/share/shareLink';
import { parseShareSearchText } from '@/lib/share/shareSearch';
import { shareServerOriginLabel } from '@/lib/share/shareServerOriginLabel';

const home = {
  id: 'home',
  name: 'Home NAS',
  url: 'https://music.home.example',
  username: 'u1',
  password: 'p1',
};
const office = {
  id: 'office',
  name: 'Office',
  url: 'https://music.office.example',
  username: 'u2',
  password: 'p2',
};

describe('shareServerOriginLabel', () => {
  it('returns null when share targets the active server', () => {
    const match = parseShareSearchText(
      encodeSharePayload({ srv: home.url, k: 'track', id: 't-1' }),
    );
    expect(shareServerOriginLabel(match, [home, office], 'home')).toBeNull();
  });

  it('returns the saved server display name when share is from another saved server', () => {
    const match = parseShareSearchText(
      encodeSharePayload({ srv: office.url, k: 'track', id: 't-1' }),
    );
    expect(shareServerOriginLabel(match, [home, office], 'home')).toBe('Office');
  });

  it('returns null when the share server is not in saved profiles', () => {
    const match = parseShareSearchText(
      encodeSharePayload({ srv: 'https://unknown.example', k: 'track', id: 't-1' }),
    );
    expect(shareServerOriginLabel(match, [home], 'home')).toBeNull();
  });

  it('returns null for unsupported share payloads', () => {
    expect(shareServerOriginLabel({ type: 'unsupported' }, [home], 'home')).toBeNull();
  });
});
