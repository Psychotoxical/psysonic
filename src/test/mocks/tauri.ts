/**
 * Tauri test harness — programmable `invoke()` + `listen()` mocks.
 *
 * Usage in a test:
 *
 *   import { onInvoke, emitTauriEvent } from '@/test/mocks/tauri';
 *
 *   beforeEach(() => {
 *     onInvoke('audio_play', () => undefined);
 *     onInvoke('audio_get_state', () => ({ playing: true }));
 *   });
 *
 *   it('emits progress', () => {
 *     emitTauriEvent('audio:progress', { id: 't1', currentTime: 42 });
 *   });
 *
 * Handlers are auto-cleared between tests (`beforeEach` hook below).
 * Unhandled invokes throw — keeps tests honest about which commands they touch.
 */
import { beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type InvokeHandler = (args: unknown) => unknown | Promise<unknown>;
export type EventCallback = (payload: unknown) => void;

const invokeHandlers = new Map<string, InvokeHandler>();
const eventListeners = new Map<string, EventCallback[]>();

// Tauri's typed signatures are strict (InvokeArgs / Event<T>). Tests don't
// need that level of precision — cast the mocks to `any` so the helpers
// accept simple `{ payload }` envelopes and plain object args.
const invokeMock = vi.mocked(invoke) as unknown as ReturnType<typeof vi.fn>;
const listenMock = vi.mocked(listen) as unknown as ReturnType<typeof vi.fn>;

invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
  const handler = invokeHandlers.get(cmd);
  if (!handler) {
    throw new Error(
      `Unhandled invoke('${cmd}'). Register via onInvoke('${cmd}', …) in the test.`,
    );
  }
  return await handler(args);
});

listenMock.mockImplementation(
  async (event: string, cb: (e: { payload: unknown }) => void) => {
    const wrapped: EventCallback = (payload) =>
      cb({ payload } as { payload: unknown });
    const arr = eventListeners.get(event) ?? [];
    arr.push(wrapped);
    eventListeners.set(event, arr);
    return () => {
      const list = eventListeners.get(event);
      if (!list) return;
      const i = list.indexOf(wrapped);
      if (i >= 0) list.splice(i, 1);
    };
  },
);

/** Register a handler for `invoke('<cmd>', …)`. Last-write-wins per command. */
export function onInvoke(cmd: string, handler: InvokeHandler): void {
  invokeHandlers.set(cmd, handler);
}

/** Synchronously deliver an `<event>` payload to every active listener. */
export function emitTauriEvent(event: string, payload: unknown): void {
  for (const cb of eventListeners.get(event) ?? []) cb(payload);
}

/** Clear all handlers + listeners + call counts. Wired to `beforeEach` below. */
export function resetTauriMocks(): void {
  invokeHandlers.clear();
  eventListeners.clear();
  invokeMock.mockClear();
  listenMock.mockClear();
}

export { invokeMock, listenMock };

beforeEach(resetTauriMocks);
