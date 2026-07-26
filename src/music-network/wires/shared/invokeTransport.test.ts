import { describe, expect, it, vi, beforeEach } from 'vitest';
import { invokeTransport } from './invokeTransport';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

describe('invokeTransport', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('returns the command payload on success', async () => {
    invokeMock.mockResolvedValue({ token: 'abc' });
    await expect(invokeTransport('audioscrobbler_request', { a: 1 })).resolves.toEqual({ token: 'abc' });
    expect(invokeMock).toHaveBeenCalledWith('audioscrobbler_request', { a: 1 });
  });

  it('classifies a non-JSON body as RESPONSE_NOT_JSON, not NETWORK', async () => {
    // A block page served to a VPN exit node: the provider answers, the Rust side
    // fails to decode it, and the user needs to know it is their route being
    // blocked rather than the app or the service being down.
    invokeMock.mockRejectedValue(
      'error decoding response body for url (https://example.test/2.0/?format=json)',
    );
    await expect(invokeTransport('audioscrobbler_request', {})).rejects.toMatchObject({
      code: 'RESPONSE_NOT_JSON',
    });
  });

  it('classifies a bare serde decode failure as RESPONSE_NOT_JSON', async () => {
    invokeMock.mockRejectedValue(new Error('expected value at line 1 column 1'));
    await expect(invokeTransport('listenbrainz_request', {})).rejects.toMatchObject({
      code: 'RESPONSE_NOT_JSON',
    });
  });

  it('leaves genuine transport failures on NETWORK', async () => {
    invokeMock.mockRejectedValue('error sending request for url (https://example.test/): dns error');
    await expect(invokeTransport('audioscrobbler_request', {})).rejects.toMatchObject({
      code: 'NETWORK',
    });
  });

  it('lets the wire auth rule win over the non-JSON classifier', async () => {
    invokeMock.mockRejectedValue('Audioscrobbler 9 Invalid session key');
    await expect(
      invokeTransport('audioscrobbler_request', {}, {
        match: msg => /invalid session/i.test(msg),
        code: 'AUTH_SESSION_INVALID',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_SESSION_INVALID' });
  });

  it('keeps the transport message so a report stays actionable', async () => {
    invokeMock.mockRejectedValue('error decoding response body for url (https://example.test/)');
    await expect(invokeTransport('audioscrobbler_request', {})).rejects.toMatchObject({
      message: 'error decoding response body for url (https://example.test/)',
    });
  });
});
