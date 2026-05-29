# Security policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report them privately so we can investigate and coordinate a fix before details are public:

- [Discord](https://discord.gg/AMnDRErm4u) — reach a maintainer directly
- [Telegram](https://t.me/+GLBx1_xeH28xYTJi) — same

Include what you can: affected version, platform (Windows / macOS / Linux), steps to reproduce, and impact if known.

## What to expect

- We will acknowledge your report as soon as we can.
- We will work with you on verification and timing of any public disclosure.
- We do not offer a paid bug-bounty program; credit in the changelog or release notes is given when reporters want it and when it fits the fix.

## Scope notes

- **This repository** — Psysonic desktop application source.
- **AUR packages** ([`psysonic`](https://aur.archlinux.org/packages/psysonic), [`psysonic-bin`](https://aur.archlinux.org/packages/psysonic-bin)) are maintained separately; packaging issues there should go through the AUR unless they reflect a vulnerability in the upstream app itself.
- **Your music server** (Navidrome, Gonic, etc.) is outside this project's scope; report server-side issues to those projects.

## Secure development

Pull requests are reviewed on `main`. **Dependency security updates** are tracked via Dependabot (PRs only for reported vulnerabilities and their fix paths—not routine version bumps). For general contribution expectations, see [CONTRIBUTING.md](CONTRIBUTING.md).
