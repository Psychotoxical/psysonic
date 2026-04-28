# Release Process (Strict SOP)

This document defines the **only allowed** release workflow for this repository.
All maintainers should follow it exactly.

## 1) Branch roles

- `main`:
  - primary development branch
  - all regular feature/fix work lands here via PR
  - should usually carry a development version (for example `X.Y.Z-dev`)
- `next`:
  - release-candidate (RC) stabilization branch
  - receives promoted changes from `main`
  - receives RC-only fixes during freeze
- `release`:
  - stable release branch
  - only receives promoted commits from `next`

Direct push to these branches is not part of normal human workflow. Use PRs and promotion workflows.

## 2) Versioning rules (mandatory)

Version is authoritative in `package.json` and `package-lock.json`.

- `main` version format: `X.Y.Z-dev`
- `next` version format: `X.Y.Z-rc.N`
- `release` version format: `X.Y.Z`

Rules:

1. Never edit versions manually in random commits.
2. Version transitions must happen through the defined promotion workflows.
3. Tags must match package version:
   - RC: `app-vX.Y.Z-rc.N`
   - Stable: `app-vX.Y.Z`

## 3) Standard release flow

### Step A: Prepare in `main`

1. Merge ready PRs into `main`.
2. Confirm CI is green on `main`.

### Step B: Promote to RC (`next`)

1. Run workflow: **Promote main to next**.
2. Workflow behavior:
   - validates required `main` checks before promotion (default: `ci-ok`, or UI-style `ci-main / ci-ok`; either satisfies the gate)
   - resets `next` to `main` snapshot
   - auto-bump package version in `next` to next `-rc.N`
   - commit and push version bump
3. Push on `next` triggers **Next Channel** workflow:
   - build/publish RC artifacts for all platforms
   - run Nix verification path

### Step C: Stabilize RC

1. Test RC artifacts.
2. If fixes are needed, follow Section 5 (RC fix policy).
3. Repeat Step B as needed until release candidate is accepted.

### Step D: Promote to stable (`release`)

1. Run workflow: **Promote next to release**.
2. Workflow behavior:
   - resets `release` to `next` snapshot
   - finalize version from `-rc.N` to `X.Y.Z`
   - commit and push finalized version
3. Push on `release` triggers **Release Channel** workflow:
   - stable artifact publish
   - Nix verification
   - opens PR to bump `main` to next minor `-dev`

### Step E: Move `main` forward

1. Merge the auto-generated PR that bumps `main` to next minor dev version.
2. Confirm `main` now uses `X.(Y+1).0-dev`.
3. Update AUR package metadata for the same stable version:
   - bump `pkgver` in `packages/aur/PKGBUILD`
   - regenerate `packages/aur/.SRCINFO`
   - publish/update in AUR remote

## 4) Freeze policy (RC stabilization window)

When RC freeze starts:

- Do **not** run `Promote main to next` automatically or casually.
- Only approved release manager(s) may run promotion workflows.
- `next` accepts only stabilization changes (fixes/docs/chore required for release quality).
- New features remain in `main` and wait for next cycle.

Freeze ends after `next -> release` promotion is complete.

## 5) RC fix policy (strict backport/forward-port rules)

If a bug is discovered during RC stabilization:

1. Create dedicated fix branch from `next`:
   - example: `fix/rc-crash-login`
2. Open PR: `fix/rc-crash-login -> next`
3. After merge to `next`, create dedicated backport branch from `main`:
   - example: `fix/backport-rc-crash-login-main`
4. Cherry-pick (or re-apply) same fix.
5. Open PR: `fix/backport-rc-crash-login-main -> main`
6. Merge this `main` backport PR before the next `Promote main to next` run.

This is mandatory. RC-only fixes may not stay only in `next`.

Alternative allowed order:

- implement first in `main`, then promote `main -> next`.

But if `main` is ahead with non-release features and promotion is frozen, use the `next-first + mandatory main backport` flow above.

## 6) Post-release critical hotfix policy (default path)

After a stable release `X.Y.Z`, critical fixes must be shipped as a patch release:

- next stable target is always `X.Y.(Z+1)`
- RC tags for hotfix cycle: `app-vX.Y.(Z+1)-rc.N`
- final stable tag: `app-vX.Y.(Z+1)`

Never re-use or overwrite `X.Y.Z` tags/releases.

### Case A: `next` is not yet used for the next minor

This case is uncommon in this repository but allowed.

1. Create hotfix branch from `release`.
2. Implement fix and open PR to `release`.
3. Move patch line through `next` RC flow (`X.Y.(Z+1)-rc.N`).
4. Promote `next -> release` for final `X.Y.(Z+1)`.
5. Backport fix to `main` via dedicated PR (mandatory).

### Case B (default): `next` already tracks next minor

This is the expected real-world case.

Assume:

- `release` is `1.9.0`
- `main`/`next` already moved to `1.10.0-*`
- critical bug requires `1.9.1`

Required steps:

1. Announce **hotfix override window** and freeze normal next-minor RC flow.
2. Create hotfix branch from `release` (`1.9.0` baseline).
3. Implement fix and merge into `release` branch via PR.
4. Temporarily align `next` to the hotfix patch line for RC publication.
5. Publish hotfix RC(s): `1.9.1-rc.N`.
6. Promote `next -> release` to finalize `1.9.1`.
7. Backport/cherry-pick same fix into `main` via dedicated PR (mandatory).
8. Restore `next` back to the normal next-minor line from `main`.
9. Announce end of hotfix override and resume normal RC cycle.

Hard rule: no feature work may be merged into `next` during hotfix override.

## 7) Idempotency and rerun behavior

Manual workflow reruns should be safe:

- rerunning **Promote main to next**:
  - no change if no new commits
  - version bump occurs only when needed for next RC number
- rerunning **Promote next to release**:
  - no change if release already matches next
  - no extra version increment beyond `X.Y.Z`
- rerunning release publish:
  - main dev bump step should no-op when `main` already has target dev version

Rerun is allowed for recovery, but must be announced in release channel/chat.

## 8) Hard rules and prohibitions

Do:

- use PRs for all code changes
- keep channel promotions deterministic and force-push only through approved promotion workflows
- require green CI before promotions
- document exceptions in PR description

Do not:

- manually retag or overwrite release tags
- manually edit `package.json` version outside defined release flow
- merge feature PRs into `next` during freeze
- skip the `next/release -> main` backport for RC fixes or hotfixes
- force-push `next` or `release` manually outside promotion workflows

## 9) Incident handling

If an incorrect promotion happened:

1. Stop further promotions immediately.
2. Announce incident and current branch SHAs.
3. Create corrective PRs (do not use destructive git history rewrites on protected branches).
4. Re-run affected workflows only after corrective PRs are merged.

## 10) Operator checklist (quick)

Before `main -> next`:

- [ ] `main` CI green
- [ ] freeze status known
- [ ] release manager approval
- [ ] branch rules allow workflow `--force-with-lease` on `next`

Before `next -> release`:

- [ ] RC validation complete
- [ ] all RC fixes merged to `next`
- [ ] corresponding backports to `main` completed or queued with owners
- [ ] branch rules allow workflow `--force-with-lease` on `release`

After stable release:

- [ ] verify stable artifacts exist
- [ ] merge auto PR for next `-dev` bump in `main`
- [ ] publish AUR update (`PKGBUILD` + `.SRCINFO`)
- [ ] announce cycle close

For post-release hotfix:

- [ ] patch target decided: `X.Y.(Z+1)`
- [ ] hotfix override for `next` announced
- [ ] fix merged to release patch line
- [ ] hotfix backport PR to `main` merged
- [ ] `next` restored to normal next-minor line

Nix note:

- `nix-npm-deps-hash-sync.yml` runs on pushes to `main`, `next`, and `release`.
- `verify-nix` in channel publish still performs full lock/hash refresh verification for release artifacts.
- Channel-local nix refresh PRs are advisory and can be overwritten by later reset-based promotions.
- If a nix refresh must survive release cycles, ensure the same change is merged into `main`.
