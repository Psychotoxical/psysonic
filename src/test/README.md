# Frontend test framework

Vitest + jsdom + @testing-library/react. Existing util tests in
`src/utils/*.test.ts` keep working; this folder adds the harness for store,
hook, component and (eventually) integration tests.

## Layout

```
src/test/
  setup.ts                      # global setup: jest-dom, @testing-library cleanup,
                                # vi.mock for @tauri-apps/api/*
  mocks/
    tauri.ts                    # programmable invoke() + listen() helpers
  helpers/
    factories.ts                # makeTrack / makeTracks fixtures
    renderWithProviders.tsx     # render() wrapped with MemoryRouter + i18n
  CLAUDE.md                     # this file
```

## Running tests

```bash
npm test                       # one-shot run
npm run test:watch             # watch mode
npm run test:coverage          # with v8 coverage → ./coverage/
```

## Where tests go

- **Co-located with the unit under test**: `Foo.tsx` → `Foo.test.tsx`,
  `barStore.ts` → `barStore.test.ts`. Mirrors the existing util test layout
  and avoids a parallel directory tree.
- Vitest picks them up via `include: src/**/*.test.{ts,tsx}` in
  `vitest.config.ts`.

## Mocking Tauri

`@tauri-apps/api/core` and `@tauri-apps/api/event` are mocked globally in
`setup.ts`. To configure per-test behaviour, import the helpers in
`mocks/tauri.ts`:

```ts
import { onInvoke, emitTauriEvent, invokeMock } from '@/test/mocks/tauri';

beforeEach(() => {
  onInvoke('audio_play', () => undefined);
});

it('responds to engine events', () => {
  emitTauriEvent('audio:progress', { id: 't1', currentTime: 42 });
  expect(invokeMock).toHaveBeenCalledWith('audio_play', { id: 't1' });
});
```

Unhandled `invoke()` calls throw a descriptive error — tests are honest about
which commands they exercise. Handlers are auto-cleared between tests.

## Mocking HTTP

For Subsonic / Navidrome / Last.fm calls, prefer **module-level mocks** for
unit tests:

```ts
vi.mock('@/api/subsonic', () => ({
  getAlbum: vi.fn(async () => ({ id: 'a1', tracks: [] })),
  buildStreamUrl: (id: string) => `https://mock/stream/${id}`,
}));
```

For broader integration tests that touch many endpoints we can introduce
**MSW** later. The framework is intentionally MSW-free right now to keep
the dep surface small until we need it.

## Patterns

### Pure utilities

Direct import + assert (see `src/utils/dynamicColors.test.ts`). No setup
needed beyond `import { describe, it, expect } from 'vitest'`.

### Zustand stores

- Import the hook, drive it via `useFooStore.getState()`.
- Reset state in a `beforeEach` — Zustand stores are module-level singletons
  and leak across tests otherwise.
- Stub Tauri side effects via `onInvoke()`.
- Use `emitTauriEvent()` to drive event-driven state transitions.

See `src/store/previewStore.test.ts` for the reference pattern.

### Components

- `renderWithProviders(<MyComponent />)` from `helpers/renderWithProviders`.
- Query by role / label / text first; fall back to `data-testid` only when
  the DOM provides no semantic anchor.
- Use `userEvent` (not `fireEvent`) for click / type / keyboard, with the
  exception of `keydown` on `window` for global shortcut paths.

See `src/components/CoverLightbox.test.tsx`.

### Hooks

Wrap in `renderHook()` from `@testing-library/react`. Provide custom
wrappers when the hook reads from a provider.

## What to NOT mock

- **Real Zustand stores.** The whole point of characterization tests is to
  exercise the actual state graph. Mock only at the system boundary
  (Tauri / network / browser APIs).
- **The router.** `MemoryRouter` via `renderWithProviders` is fine — don't
  stub `useNavigate` etc. unless a test specifically inspects navigation.
- **react-i18next.** `I18nextProvider` with the real `i18n.ts` instance is
  cheap and avoids tests that lie about labels.

## Coverage gates

- `vitest run --coverage` writes `coverage/coverage-summary.json` which the
  hot-path gate consumes.
- `.github/frontend-hot-path-files.txt` lists the files held to ≥70% line
  coverage by `scripts/check-frontend-hot-path-coverage.sh`.
- CI runs both. The gate is currently soft (`continue-on-error: true`) —
  flip to a hard PR-blocker once a few PRs run cleanly. Mirrors the backend
  rust-tests rollout.
