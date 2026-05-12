# Contributing to Psysonic

Thanks for your interest in helping the project.

Psysonic is **GPLv3** — see [LICENSE](LICENSE). Forks and modifications are welcome under the license; for attribution expectations when publishing derivative work, see **Forks and Attribution** in the [README](README.md).

## Contents

- [Quick start](#quick-start)
- [Before you write code](#before-you-write-code)
- [Repository layout](#repository-layout)
- [Environment and running the app](#environment-and-running-the-app)
- [Where processes and conventions are documented](#where-processes-and-conventions-are-documented)
- [House rules](#house-rules)
- [The Rust ↔ frontend (Tauri) contract](#the-rust--frontend-tauri-contract)
- [CI on pull requests to `main`](#ci-on-pull-requests-to-main)
- [Local checks](#local-checks)
- [Pull request expectations](#pull-request-expectations)
- [Why we are wary of irreversible UI churn](#why-we-are-wary-of-irreversible-ui-churn)

---

## Quick start

```bash
git clone https://github.com/Psychotoxical/psysonic.git
cd psysonic
npm install
npm run tauri:dev     # run the desktop app in dev mode
npm test              # frontend tests (Vitest)
( cd src-tauri && cargo test --workspace --all-targets )   # backend tests
```

Open pull requests against `main`. `next` and `release` are maintainer-driven promotion branches — don't target them directly. The rest of this document covers what reviewers look for, especially around the [Tauri contract](#the-rust--frontend-tauri-contract) and UI changes.

---

## Before you write code

- **Usage questions** ("is this a bug or my setup?") — please use [Discord](https://discord.gg/AMnDRErm4u) or [Telegram](https://t.me/+GLBx1_xeH28xYTJi) first. The issue tracker is intended for confirmed bugs and feature requests (see [issue templates](.github/ISSUE_TEMPLATE/)).
- **AUR packaging problems** — follow the AUR links in [README](README.md); those packages are maintained separately from this repository.
- **Large features or UX overhauls** — consider discussing in chat or opening an issue early so effort aligns with product direction.
- **Changes to the Tauri boundary** — read [The Rust ↔ frontend (Tauri) contract](#the-rust--frontend-tauri-contract) before opening a PR; reviewers will ask for a clear justification.
- **Security issues** — please do **not** open a public issue. Reach a maintainer privately via Discord or Telegram first; we'll coordinate disclosure from there.

---

## Repository layout

```text
src/         React / TypeScript frontend
src-tauri/   Rust backend (Tauri host process)
public/      Static assets served by Vite
scripts/     CI helpers (coverage gates, install, version sync)
.github/     Workflows, issue templates, hot-path lists
flake.nix    Nix development shell + packaging
```

---

## Environment and running the app

See [README](README.md) (**Development**) for the basic flow: from the repository root, `npm install` then `npm run tauri:dev` for development or `npm run tauri:build` for a release build. Use `npm install` while iterating; `npm ci` is what CI runs and is the right command when you want a reproducible install.

For non-Linux contributors, install the native dependencies Tauri requires on your OS — see the upstream [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (Windows: WebView2 + MSVC build tools; macOS: Xcode Command Line Tools). The Linux package list used in CI is in [`rust-tests.yml`](.github/workflows/rust-tests.yml).

If you use **Nix**, `nix develop` (see [`flake.nix`](flake.nix)) provides the pinned toolchain and native dependencies. Adding `psysonic.cachix.org` as a substituter (badge in the [README](README.md)) lets you pull prebuilt dev-shell dependencies instead of rebuilding them locally.

---

## Where processes and conventions are documented

| Topic | Location |
|--------|----------|
| Frontend test stack (Vitest, Tauri/Subsonic mocks, store resets, i18n in tests) | [`src/test/README.md`](src/test/README.md) |
| What CI runs for frontend / backend | [`frontend-tests.yml`](.github/workflows/frontend-tests.yml), [`rust-tests.yml`](.github/workflows/rust-tests.yml) |
| Frontend "hot path" files held to a coverage threshold | [`frontend-hot-path-files.txt`](.github/frontend-hot-path-files.txt), [`check-frontend-hot-path-coverage.sh`](scripts/check-frontend-hot-path-coverage.sh) |
| Rust hot-path gate | [`hot-path-files.txt`](.github/hot-path-files.txt), [`check-hot-path-coverage.sh`](scripts/check-hot-path-coverage.sh) |
| Nix packaging / release automation | [`flake.nix`](flake.nix), workflows under [`.github/workflows/`](.github/workflows/) |

---

## House rules

1. **One pull request, one coherent goal.** Easier review, easier revert, fewer merge conflicts.
2. **Match existing style** in touched files (naming, module layout, comment density). Avoid drive-by refactors unrelated to the task.
3. **Linting and formatting:** there is no enforced JS/TS formatter or ESLint config in the repo today — `tsc --noEmit` is the only frontend gate beyond tests. For Rust, `cargo clippy --workspace --all-targets -- -D warnings` is the lint gate; `cargo fmt` is not currently required but won't hurt.
4. **Commit messages:** a short **human-readable** summary of what changed and why; Conventional Commits-style prefixes (`feat:`, `fix:`, ...) are fine if you prefer them. Do not include meta references (IDEs, assistants, or how the message was produced) — only what matters for project history.
5. **License:** new code must remain compatible with the project's GPLv3.
6. **Tests:** when you change behaviour users rely on, add or update tests next to the code (see [`src/test/README.md`](src/test/README.md)). Purely visual tweaks may not need tests, but behavioural regressions should be covered where the suite can catch them.
7. **i18n:** user-visible strings live in `src/locales/*.ts` (one TypeScript module per language) and are wired up in `src/i18n.ts`. English (`en.ts`) is the baseline — always add the key there. Other locales may be left for follow-up translation PRs if you don't speak the language, but keep the object shape consistent so missing keys are obvious.

---

## The Rust ↔ frontend (Tauri) contract

Treat `invoke` handlers, event names, and JSON/payload shapes as a **public API between two codebases**. Prefer **additive** changes (new optional fields, new commands/events) over silent renames or breaking shape changes.

When a breaking change is unavoidable, it should be:

- **narrow** and **documented in the PR**,
- paired with updates on **both sides** of the boundary, and
- paired with updates to any Vitest Tauri mocks that encode the contract.

Drive-by churn here is expensive: it hurts forks, complicates bisects, and forces every contributor to relearn the boundary. If the same outcome can be achieved inside Rust or inside React alone, default to that.

Align early: open an issue or chat thread before sending a PR that renames `invoke` commands, changes event payloads, or reshapes data across the boundary. Reviewers will ask for a clear benefit because every such change ripples through `src-tauri`, `src`, tests, and future contributors' mental model.

---

## CI on pull requests to `main`

PRs must target `main`. `next` and `release` are maintainer-driven promotion branches — don't target them directly.

Workflows are path-filtered (see the YAML for exact `paths` / `paths-ignore`):

- **Frontend** (`src/**`, lockfile, Vitest/Vite/tsconfig, etc.): `npm test` (Vitest), `npx tsc --noEmit`, then a coverage run.
- **Rust** (`src-tauri/**`): `cargo test --workspace --all-targets`, `cargo clippy --workspace --all-targets -- -D warnings`, then coverage.

Hot-path coverage gates are currently **soft** (warnings only — the workflow carries `continue-on-error: true`). They will be flipped to required when the floors stabilise; see the headers in [`frontend-hot-path-files.txt`](.github/frontend-hot-path-files.txt) and [`hot-path-files.txt`](.github/hot-path-files.txt) for the current state of each list.

---

## Local checks

Assume the repository root is `psysonic/` (for example after `git clone https://github.com/Psychotoxical/psysonic.git` and `cd psysonic`).

**Frontend** — from the repository root:

```bash
npm ci
npm test
npx tsc --noEmit
npm run test:coverage
bash scripts/check-frontend-hot-path-coverage.sh
```

The last command mirrors the optional hot-path gate used in CI; `jq` must be on `PATH`.

**Rust** — install the Linux packages your distro needs to build Tauri/WebKitGTK (the list used in Ubuntu CI is in [`rust-tests.yml`](.github/workflows/rust-tests.yml) under `apt-get install`), or use `nix develop`. Then:

```bash
cd src-tauri
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
```

To reproduce the **coverage + hot-path** job locally you also need:

- `cargo-llvm-cov`
- the `llvm-tools-preview` rustup component
- `jq` on `PATH`

The exact `cargo llvm-cov` invocations and the gate call are taken from the `coverage` job in [`rust-tests.yml`](.github/workflows/rust-tests.yml). After generating `src-tauri/target/llvm-cov/cov.json` as that job does, run the gate from the **repository root**:

```bash
bash scripts/check-hot-path-coverage.sh
```

If you change both frontend and backend, run the relevant blocks above before opening a PR.

---

## Pull request expectations

- **Description:** what changed, who should notice (end users vs developers only), how to verify manually. Link the issue if the PR closes it.
- **Scope:** stay on task; no unrelated reformatting or cleanup in the same PR.
- **UI/UX:** describe the user flow; before/after screenshots help reviewers a lot.
- **i18n:** see [House rules](#house-rules) — add the key to `en.ts` first, keep the shape of other locales consistent.
- **Server compatibility:** the client targets the Subsonic API and is **Navidrome-first**; if a feature depends on server support, say so explicitly.
- **Tauri boundary:** if you touched it, list added/removed/renamed commands and events, describe payload changes, and note how you verified both `src-tauri` and `src` (plus any updated tests/mocks). If you did **not** touch the boundary, saying so helps reviewers scope the review.
- **Persisted settings / on-disk layout:** if you change how configuration or local data is stored, migrated, or located, spell out the impact on **existing installs** (one-time migration, backwards compatibility, or explicit break with rationale).

---

## Why we are wary of irreversible UI churn

Psysonic is a desktop app people use for hours: muscle memory, layout, themes, keyboard workflows, and accessibility settings all matter. Abrupt changes to navigation, information hierarchy, or visual language without a migration path:

- break **habits and power-user flows**;
- complicate **themes and accessibility** (contrast, sizing, custom fonts);
- increase support load and frustration — some users stay on old builds or fork.

We prefer **evolutionary** UI work: discuss large shifts early, ship in steps where possible, use settings or toggles when a breaking visual change is justified, and preserve predictability where users did not ask for an experiment. That is not a ban on fresh design — it is a preference to **not strand users** without a strong reason and a clear adaptation path.
