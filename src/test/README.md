# Frontend test framework

Vitest + jsdom + @testing-library/react. Existing util tests in
`src/utils/*.test.ts` keep working; this folder hosts the harness for store,
hook, component and (eventually) integration tests.

## Layout

```
src/test/
  setup.ts                      # global: jest-dom, cleanup, vi.mock for tauri/*,
                                # localStorage polyfill, browser-mock install
  mocks/
    tauri.ts                    # programmable invoke() + listen() helpers,
                                # tauriMockListenerCount(event) for lifecycle tests
    subsonic.ts                 # realistic Subsonic fixture data
    browser.ts                  # ResizeObserver / IntersectionObserver /
                                # matchMedia / clipboard / object URL mocks
  helpers/
    factories.ts                # makeTrack / makeTracks / makeSubsonicSong /
                                # makeServer / makeAuthState / makeQueueState
    storeReset.ts               # resetPlayerStore / resetAuthStore /
                                # resetPreviewStore / resetOrbitStore /
                                # resetAllStores
    renderWithProviders.tsx     # render() wrapped with MemoryRouter + i18n
                                # (en-pinned by default)
  README.md                     # this file
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
`setup.ts`. Configure per-test behaviour via the helpers in
`mocks/tauri.ts`:

```ts
import { onInvoke, emitTauriEvent, invokeMock, tauriMockListenerCount } from '@/test/mocks/tauri';

beforeEach(() => {
  onInvoke('audio_play', () => undefined);
});

it('responds to engine events', () => {
  emitTauriEvent('audio:progress', { id: 't1', currentTime: 42 });
  expect(invokeMock).toHaveBeenCalledWith('audio_play', { id: 't1' });
});

it('does not double-register listeners on re-init', () => {
  // ... call init logic twice, assert listener count is 1
  expect(tauriMockListenerCount('audio:progress')).toBe(1);
});
```

Unhandled `invoke()` calls throw a descriptive error — tests are honest about
which commands they exercise. Handlers + listeners are auto-cleared between
tests.

## Mocking Subsonic / HTTP

Hoist the mock in the test file (vitest limitation — factory functions can't
import helper modules at hoist time), then inject realistic fixture data
from `mocks/subsonic.ts`:

```ts
import { vi, describe, it, beforeEach, expect } from 'vitest';
vi.mock('@/api/subsonic');
import { getAlbum, buildStreamUrl } from '@/api/subsonic';
import { sampleAlbumWithSongs, mockStreamUrl } from '@/test/mocks/subsonic';

beforeEach(() => {
  vi.mocked(getAlbum).mockResolvedValue(sampleAlbumWithSongs);
  vi.mocked(buildStreamUrl).mockImplementation(mockStreamUrl);
});
```

For broader integration tests that touch many endpoints we may introduce
**MSW** later. The framework is intentionally MSW-free right now to keep
the dep surface small until we need it.

## Resetting stores

Zustand stores are module-level singletons and leak state across tests
unless explicitly reset. setup.ts already clears localStorage between
tests, but the in-memory `getState()` snapshot survives.

Use `helpers/storeReset.ts`:

```ts
import { resetPlayerStore, resetAllStores } from '@/test/helpers/storeReset';

describe('myFeature', () => {
  beforeEach(resetPlayerStore);
  // or, for cross-store tests:
  beforeEach(resetAllStores);
});
```

Each reset replaces the live state with the snapshot captured at module
import time. Action references are preserved (they're closed over the
original `set`/`get`, stable across `setState`).

## i18n language is pinned to `en`

`renderWithProviders` calls `i18n.changeLanguage('en')` synchronously before
render, so `getByText('Settings')` finds the English label regardless of
the developer's local language preference. Tests that want to assert
against another translation pass `{ language: 'de' }`:

```ts
renderWithProviders(<MyComponent />, { language: 'de' });
```

Rationale: option 5a from the pre-refactor testing plan (2026-05-11). Without
a fixed test language, every translation edit risks flipping a green test
red on a contributor's machine.

## Patterns

### Pure utilities

Direct import + assert (see `src/utils/dynamicColors.test.ts`). No setup
needed beyond `import { describe, it, expect } from 'vitest'`.

### Zustand stores

- Import the hook, drive it via `useFooStore.getState()`.
- Reset state in a `beforeEach` via `storeReset.ts`.
- Stub Tauri side effects via `onInvoke()`.
- Use `emitTauriEvent()` to drive event-driven state transitions.

See `src/store/previewStore.test.ts` for the reference pattern.

### Components

- `renderWithProviders(<MyComponent />)` from `helpers/renderWithProviders`.
- Prefer `getByRole({ name: ... })` over `getByText` when a semantic role
  exists — the role survives translation tweaks and refactors that move
  labels into different elements.
- Fall back to `data-testid` only when the DOM provides no semantic anchor.
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

## What to NOT snapshot

- Large rendered trees from `renderWithProviders`. Translation edits, CSS
  class renames, or unrelated child-component refactors flip the snapshot
  for reasons unrelated to the unit under test. Assert on specific
  observable behaviour instead — a button is enabled, an aria-label is
  present, a class is set.
- Zustand state snapshots that include action functions. Function identity
  changes break the snapshot without any behavioural reason.

## Coverage gates

- `vitest run --coverage` writes `coverage/coverage-summary.json` which the
  hot-path gate consumes.
- `.github/frontend-hot-path-files.txt` lists the files held to ≥70% line
  coverage by `scripts/check-frontend-hot-path-coverage.sh`.
- CI runs both. The gate is soft today (`continue-on-error: true`) —
  it flips to a hard PR-blocker at the start of M4 in the pre-refactor
  testing plan. Mirrors the backend rust-tests rollout.

## Process isolation

`vitest.config.ts` pins `pool: 'forks'` + `isolate: true`. Each test file
runs in its own forked process with a fresh module graph. ~20% slower
locally than the default thread pool but avoids the fake-timer +
module-mock + Zustand-global flake class that surfaces around suite-size
30+.
