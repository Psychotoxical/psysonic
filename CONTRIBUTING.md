# Contributing to Psysonic

Thanks for your interest in helping the project. This document covers where to ask questions, how CI is set up, what we expect in pull requests, why we are cautious about disruptive UI changes, and why **changes to the Rust ↔ frontend contract** (Tauri IPC) need an unusually strong justification.

Psysonic is **GPLv3** — see [LICENSE](LICENSE). Forks and modifications are welcome under the license. For attribution expectations when publishing derivative work, see the **Forks and Attribution** section in [README](README.md).

---

## Before you write code

- **Usage questions** (“is this a bug or my setup?”) — please use [Discord](https://discord.gg/AMnDRErm4u) or [Telegram](https://t.me/+GLBx1_xeH28xYTJi) first. The issue tracker is intended for confirmed bugs and feature requests (see [issue templates](.github/ISSUE_TEMPLATE/) and [config](.github/ISSUE_TEMPLATE/config.yml)).
- **AUR packaging problems** — follow the AUR links in [README](README.md); those packages are maintained separately from this repository.
- **Large features or UX overhauls** — consider discussing in chat or opening an issue early so effort aligns with product direction.
- **Renaming `invoke` commands, changing event payloads, or reshaping the data passed across the Tauri boundary** — same as above: align early; reviewers will ask for a clear benefit because every such change ripples through `src-tauri`, `src`, tests, and future contributors’ mental model.

---

## Environment and running the app

See [README](README.md) (**Development**): from the repository root after `npm install`, use `npm run tauri:dev` for development and `npm run tauri:build` for a release build.

If you use **Nix**, `nix develop` (see [`flake.nix`](flake.nix)) provides the toolchain and native dependencies the flake maintainers pin for Linux.

---

## Where processes and conventions are documented

| Topic | Location |
|--------|----------|
| Frontend test stack (Vitest, Tauri/Subsonic mocks, store resets, i18n in tests) | [`src/test/README.md`](src/test/README.md) |
| What CI runs for frontend / backend | [`frontend-tests.yml`](.github/workflows/frontend-tests.yml), [`rust-tests.yml`](.github/workflows/rust-tests.yml) |
| Frontend “hot path” files held to a coverage threshold | [`frontend-hot-path-files.txt`](.github/frontend-hot-path-files.txt) and [`check-frontend-hot-path-coverage.sh`](scripts/check-frontend-hot-path-coverage.sh) |
| Rust hot-path gate | [`hot-path-files.txt`](.github/hot-path-files.txt), [`check-hot-path-coverage.sh`](scripts/check-hot-path-coverage.sh) |
| Nix packaging / release automation | [`flake.nix`](flake.nix), workflows under [`.github/workflows/`](.github/workflows/) |

---

## Guidelines

1. **One pull request, one coherent goal.** Easier review, easier revert, fewer merge conflicts.
2. **Match existing style** in touched files (naming, module layout, comment density). Avoid drive-by refactors unrelated to the task.
3. **Commit messages:** a short **human-readable** summary of what changed and why; Conventional Commits-style prefixes (`feat:`, `fix:`, …) are fine if you prefer them. Do not include meta references (IDEs, assistants, or how the message was produced) — only what matters for project history.
4. **License:** new code must remain compatible with the project’s GPLv3.
5. **Tests:** when you change behaviour users rely on, add or update tests next to the code (see [`src/test/README.md`](src/test/README.md)). Purely visual tweaks may not need tests, but behavioural regressions should be covered where the suite can catch them.
6. **Rust ↔ frontend contract (Tauri):** treat `invoke` handlers, event names, and JSON/payload shapes as a **public API between two codebases**. Prefer **additive** changes (new fields optional, new commands/events) over silent renames or breaking shape changes. When a breaking change is unavoidable, it should be **narrow, documented in the PR**, and paired with updates on **both** sides of the boundary plus any Vitest Tauri mocks that encode the contract. Drive-by churn here is expensive: it hurts forks, complicates bisects, and forces every contributor to relearn the boundary. If the same outcome can be achieved inside Rust or inside React alone, default to that.

---

## CI on pull requests to `main`

Workflows are path-filtered (see the YAML for exact `paths` / `paths-ignore`):

- **Frontend** (`src/**`, lockfile, Vitest/Vite/tsconfig, etc.): `npm test` (Vitest), `npx tsc --noEmit`, then a coverage run plus a **soft** hot-path file gate (see comments in the workflow — the gate job may be non-blocking while it is tuned).
- **Rust** (`src-tauri/**`): `cargo test --workspace --all-targets`, `cargo clippy --workspace --all-targets -- -D warnings`, then coverage plus a **soft** Rust hot-path gate.

### Local checks (vanilla clone, same layout as `origin`)

Assume repository root = `psysonic/` (for example after `git clone https://github.com/Psychotoxical/psysonic.git` and `cd psysonic`).

**Frontend** — from repository root:

```bash
npm ci
npm test
npx tsc --noEmit
npm run test:coverage
bash scripts/check-frontend-hot-path-coverage.sh
```

The last command mirrors the optional hot-path gate used in CI; `jq` must be on `PATH` (the CI images install it where the gate needs it).

**Rust** — install the Linux packages your distro needs to build Tauri/WebKitGTK (the list used in Ubuntu CI is in [`rust-tests.yml`](.github/workflows/rust-tests.yml) under `apt-get install`). Then:

```bash
cd src-tauri
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
```

To reproduce the **coverage + hot-path** job locally you also need `cargo-llvm-cov`, the `llvm-tools-preview` Rust component, and `jq`; the exact `cargo llvm-cov` invocations and the follow-up gate are copied verbatim from the `coverage` job in [`rust-tests.yml`](.github/workflows/rust-tests.yml) (run the gate as `bash scripts/check-hot-path-coverage.sh` from the **repository root** after generating `src-tauri/target/llvm-cov/cov.json` as in that job).

If you change both frontend and backend, run the relevant blocks above before opening a PR.

---

## Pull request expectations

- **Description:** what changed, who should notice (end users vs developers only), how to verify manually. Link the issue if the PR closes it.
- **Scope:** stay on task; no unrelated reformatting or cleanup in the same PR.
- **UI/UX:** describe the user flow; screenshots before/after help reviewers a lot.
- **i18n:** follow existing key patterns; English is the baseline language of the app.
- **Server compatibility:** the client targets the Subsonic API and is **Navidrome-first**; if a feature depends on server support, say so explicitly.
- **Rust ↔ frontend boundary:** list added/removed/renamed commands and events; describe payload changes; note how you verified both `src-tauri` and `src` paths (and updated tests/mocks). If you did *not* touch the boundary, saying so helps reviewers scope the review.
- **Persisted settings / on-disk layout:** if you change how configuration or local data is stored, migrated, or located, spell out the impact on **existing installs** (one-time migration, backwards compatibility, or explicit break with rationale).

---

## Why we are wary of irreversible UI churn

Psysonic is a desktop app people use for hours: muscle memory, layout, themes, keyboard workflows, and accessibility settings all matter. Abrupt changes to navigation, information hierarchy, or visual language without a migration path:

- break **habits and power-user flows**;
- complicate **themes and accessibility** (contrast, sizing, custom fonts);
- increase support load and frustration — some users stay on old builds or fork.

We prefer **evolutionary** UI work: discuss large shifts early, ship in steps where possible, use settings or toggles when a breaking visual change is justified, and preserve predictability where users did not ask for an experiment. That is not a ban on fresh design — it is a preference to **not strand users** without a strong reason and a clear adaptation path.

---

## Summary

We value **focused, testable, well-explained** changes, respect for reviewers’ time, respect for people who live in the UI daily, and **stability of the Tauri contract** unless a change pays for its own migration cost. If anything here is unclear, ask in Discord or Telegram before investing in a large diff.
