import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios, { AxiosError } from 'axios';
import {
  isHttp414,
  serializeSubsonicParams,
} from '@/lib/api/subsonicClient';

vi.mock('axios');

describe('serializeSubsonicParams', () => {
  it('encodes scalars and repeats array keys like axios indexes:null', () => {
    expect(
      serializeSubsonicParams({
        u: 'user',
        id: ['a', 'b'],
        current: 'a',
        position: 1200,
      }),
    ).toBe('u=user&id=a&id=b&current=a&position=1200');
  });

  it('skips null and undefined values', () => {
    expect(serializeSubsonicParams({ a: 1, b: null, c: undefined, d: ['x'] })).toBe('a=1&d=x');
  });
});

describe('isHttp414', () => {
  it('detects axios 414 responses', () => {
    const err = new AxiosError('Request failed');
    err.response = { status: 414, data: '', statusText: 'URI Too Long', headers: {}, config: {} as never };
    expect(isHttp414(err)).toBe(true);
  });

  it('detects message-based URI-too-long errors', () => {
    expect(isHttp414(new Error('Request-URI Too Large'))).toBe(true);
    expect(isHttp414(new Error('offline'))).toBe(false);
  });
});

describe('apiPostFormWithCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POSTs form-urlencoded body with path-only URL', async () => {
    const { apiPostFormWithCredentials } = await import('@/lib/api/subsonicClient');
    vi.mocked(axios.post).mockResolvedValue({
      data: { 'subsonic-response': { status: 'ok' } },
    });

    await apiPostFormWithCredentials('https://music.example:4533', 'user', 'pass', 'savePlayQueue.view', {
      id: ['a', 'b'],
      current: 'a',
      position: 10,
    });

    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = vi.mocked(axios.post).mock.calls[0]!;
    expect(url).toBe('https://music.example:4533/rest/savePlayQueue.view');
    expect(String(body)).toContain('id=a&id=b');
    expect(String(body)).toContain('current=a');
    expect(String(body)).toContain('u=user');
    expect((config as { headers?: Record<string, string> }).headers?.['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
  });
});
