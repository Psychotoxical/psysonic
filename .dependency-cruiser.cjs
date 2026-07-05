// Architecture / layering guard for the feature-folder structure (PR #1225, group A1).
//
// Encodes the layering contract the restructure established:
//
//   lib                     (feature-free infra: api clients, format, i18n, util, media, server, navigation)
//     ▲
//   store / ui              (cross-cutting global stores; domain-agnostic primitives) — may import lib
//     ▲
//   cover / music-network   (top-level domains — peers; may import lib, store, ui)
//     ▲
//   features/<x>            (may import lib, store, ui, cover, music-network, other features via barrel only)
//     ▲
//   app                     (shell + bridges — may import anything)
//
// A lower layer may NOT import a higher one. Cross-feature access goes through the
// `@/features/<x>` barrel only, never a deep path. No import cycles anywhere.
//
// Ratchet: current known violations (residual legacy dirs + documented inversions) are
// captured in `.dependency-cruiser-known-violations.json` and ignored via `--ignore-known`
// (see `npm run dep:check`). Any NEW violation fails CI. As the drain (group E) removes an
// exception, regenerate the baseline so the count ratchets toward zero.

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'No import cycles anywhere under src/ — they make the module graph impossible to reason about.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'lib-is-the-floor',
      severity: 'error',
      comment:
        'lib/** is feature-free infra and must not import a higher layer ' +
        '(features, store, ui, app, cover, music-network).',
      from: { path: '^src/lib/' },
      to: { path: '^src/(features|store|ui|app|cover|music-network)/' },
    },
    {
      name: 'no-core-to-feature',
      severity: 'error',
      comment:
        'store/** and ui/** are cross-cutting core and must not import features or the app shell ' +
        '(the inversions the seams removed — keep them out).',
      from: { path: '^src/(store|ui)/' },
      to: { path: '^src/(features|app)/' },
    },
    {
      name: 'no-deep-cross-feature',
      severity: 'error',
      comment:
        'A feature must reach another feature only through its `@/features/<x>` barrel (index), ' +
        'never a deep path. Same-feature deep imports are fine.',
      from: { path: '^src/features/([^/]+)/' },
      to: {
        path: '^src/features/([^/]+)/[^/]+',
        pathNot: [
          '^src/features/$1/', // same feature — allowed
          '^src/features/[^/]+/index\\.(ts|tsx)$', // the barrel — allowed
        ],
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Type-only edges are tolerated by the iron rule (erased at runtime), but the ratchet
    // records whatever exists today regardless of kind; new edges of any kind fail.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
    // The layering contract is about the production module graph. Tests, test helpers,
    // ambient declarations and non-src trees are not part of it.
    exclude: {
      path: [
        '\\.test\\.(ts|tsx)$',
        '^src/test/',
        '\\.d\\.ts$',
        '^src/vite-env',
      ],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
