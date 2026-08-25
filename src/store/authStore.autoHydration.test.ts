import { beforeEach, describe, expect, it, vi } from 'vitest';

const server = {
  id: 'server-a',
  name: 'Wall of Sound',
  url: 'https://music.example.com',
  username: 'alice',
  password: 'pw',
};

function writePersistedState(state: Record<string, unknown>): void {
  localStorage.setItem('psysonic-auth', JSON.stringify({ state, version: 0 }));
}

describe('authStore first automatic hydration', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it.each([
    ['a pre-1.51 payload without the browse scope', {}],
    ['an affected 1.51 payload with an empty browse scope', { libraryBrowseServerIds: [] }],
  ])('repairs %s before exposing the store', async (_label, extraState) => {
    writePersistedState({
      servers: [server],
      activeServerId: server.id,
      isLoggedIn: true,
      ...extraState,
    });

    const { useAuthStore } = await import('./authStore');

    expect(useAuthStore.getState().libraryBrowseServerIds).toEqual([server.id]);
    const persisted = JSON.parse(localStorage.getItem('psysonic-auth') ?? '{}') as {
      state?: { libraryBrowseServerIds?: string[] };
      version?: number;
    };
    expect(persisted.version).toBe(1);
    expect(persisted.state?.libraryBrowseServerIds).toEqual([server.id]);
  });
});
