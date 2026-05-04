# Installing Psysonic on NixOS (flake)

This guide is for **NixOS** users who want **Psysonic from the upstream Git flake** (`github:Psychotoxical/psysonic`). Supported systems match the flake: **`x86_64-linux`** and **`aarch64-linux`**.

**Stability:** The project is in **very active development**. For **production or everyday use**, prefer **released builds**: pin the flake input to a stable **`app-v*`** tag, or track the **`release`** branch (`?ref=release`). Following **`main`** or **`next`** is better suited to contributors and early testers.

## Prerequisites

**Flakes** enabled (e.g. in `configuration.nix`):

```nix
nix.settings.experimental-features = [ "nix-command" "flakes" ];
```

## Binary cache (Cachix)

The project publishes store paths to a public Cachix cache so you can **substitute** binaries instead of compiling Psysonic locally on every machine.

- **Cache page:** [psysonic.cachix.org](https://psysonic.cachix.org)
- **Substituter URL:** `https://psysonic.cachix.org`
- **Public key** (trust this only if it matches what you expect from the cache owners):

  ```text
  psysonic.cachix.org-1:M9cQyQ7tgvUWOQ5Pyt8ozlMoPLtOZir6MfRuTH9/VYA=
  ```

### NixOS (`configuration.nix` or a flake module)

Add the substituter **and** its signing key under `nix.settings`. Keep `cache.nixos.org` in the list so ordinary `nixpkgs` binaries still resolve:

```nix
{
  nix.settings = {
    substituters = [
      "https://psysonic.cachix.org"
      "https://cache.nixos.org/"
    ];
    trusted-public-keys = [
      "psysonic.cachix.org-1:M9cQyQ7tgvUWOQ5Pyt8ozlMoPLtOZir6MfRuTH9/VYA="
      "cache.nixos.org-1:6NCHdSuAYQQOxGEKTGXLN9WWRXoSBT8GRiSnR6IdfGW="
    ];
  };
}
```

After `nixos-rebuild switch`, builds that hit the cache will download from Cachix. More background: [Cachix — Getting started](https://docs.cachix.org/getting-started).

## Install on NixOS (flake configuration)

Add the repo as an **input**, then reference **`packages.<system>.psysonic`** (or **`default`**, which is the same package).

### Example: top-level `flake.nix` + `nixosConfigurations`

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    psysonic.url = "github:Psychotoxical/psysonic";
  };

  outputs = { self, nixpkgs, ... }@inputs: let
    system = "x86_64-linux";
  in {
    nixosConfigurations.my-host = nixpkgs.lib.nixosSystem {
      inherit system;
      modules = [
        ./configuration.nix
        {
          environment.systemPackages = [
            inputs.psysonic.packages.${system}.psysonic
          ];
        }
      ];
    };
  };
}
```

Inside a **module** where you already have `pkgs` and flake `inputs` in scope, a common pattern is:

```nix
environment.systemPackages = with pkgs; [
  # …
  inputs.psysonic.packages.${pkgs.stdenv.hostPlatform.system}.psysonic
];
```

### Linux wrapper: default vs gdk-session

The flake exposes **two** installable packages on Linux. They are the same build; only the **wrapped runtime environment** differs:

| Flake attribute | Wrapper behaviour |
|----------------|-------------------|
| **`psysonic`** (and **`default`**) | Sets **`GDK_BACKEND=x11`** together with the usual WebKit / GStreamer / AppIndicator paths. This is the **recommended default**: it matches the dev shell assumptions and avoids many WebKitGTK + Wayland edge cases. |
| **`psysonic-gdk-session`** | **Does not** set `GDK_BACKEND`; GTK follows the session (e.g. native Wayland when available). Can improve **HiDPI sizing** on some desktops, but may cause **black window, broken scrolling, or tray quirks** on other GPU/compositor stacks—the same class of issues described under Linux / WebKit in the in-app Help. **Not default** on purpose. |

Use the alternate package when you understand that trade-off:

```nix
inputs.psysonic.packages.${system}.psysonic-gdk-session
```

Or one-shot (quote the URL in **zsh** — `?` / `#` are special):

```bash
nix run 'github:Psychotoxical/psysonic#psysonic-gdk-session' -- --help
```

### Pinning a revision, branch, or tag

- **`main`** (default in the examples above) follows upstream development.
- **Channel branches** (`next`, `release`) exist for pre-release / release automation. For **operational installs**, prefer **`release`** (or an **`app-v*`** tag) over **`next`** or **`main`**; use **`?ref=next`** only if you want pre-release channel builds.

  ```nix
  psysonic.url = "github:Psychotoxical/psysonic?ref=release";
  ```

- **Tags** (`app-v*`) match published GitHub releases and are the usual choice for a **reproducible** install aligned with a shipped version:

  ```nix
  psysonic.url = "github:Psychotoxical/psysonic?ref=app-v1.44.0";  # example; pick a tag that exists on GitHub
  ```

Use a `ref` (branch, tag, or commit SHA) that exists on GitHub.

### How `flake.lock` and `nix/upstream-sources.json` stay in sync

CI runs a **verify-nix** job (Nix build, `npmDepsHash` refresh, `flake.lock` refresh, Cachix push) from **`.github/workflows/reusable-channel-publish.yml`**, invoked by:

- **`.github/workflows/next.yml`** (Next channel, branch `next`)
- **`.github/workflows/release.yml`** (Release channel, branch `release`)

So the lock and **`nix/upstream-sources.json`** (`npmDepsHash`) are updated as part of channel publishing, not only from a single legacy “tag-only” path. On **`main`**, **`nix-npm-deps-hash-sync.yml`** can also open PRs when `package-lock.json` changes so the Nix npm hash does not drift.

End users who pin **`main`** should run `nix flake update psysonic` (or equivalent) periodically if they want the latest lock inputs from upstream.

### One-shot run (no system install)

From any machine with flakes:

```bash
nix run 'github:Psychotoxical/psysonic'
```

Same as `nix build` / `packages.<system>.default` (the **x11-wrapped** binary); uses the flake `apps` output. For the session-GDK variant, use `'github:Psychotoxical/psysonic#psysonic-gdk-session'` (see [Linux wrapper](#linux-wrapper-default-vs-gdk-session) above). With a branch pin, keep the **whole** `github:…?ref=…#…` string in **single quotes** under **zsh**.

### Apply configuration

- **NixOS flake host**

  ```bash
  sudo nixos-rebuild switch --flake .#my-host
  ```

- **Home Manager** (if used separately)

  ```bash
  home-manager switch --flake .#my-user@my-host
  ```

## Home Manager

If you manage packages with [Home Manager](https://github.com/nix-community/home-manager), add the same package to `home.packages`:

```nix
home.packages = [
  inputs.psysonic.packages.${pkgs.stdenv.hostPlatform.system}.psysonic
];
```

(Adjust how `inputs` / `pkgs` are passed into your Home Manager module.)

## Development shell (contributors)

From a **flake-enabled** clone of the repo:

- **`nix develop`** — enters the upstream `devShell` (Rust, Node 22, WebKitGTK, GStreamer plugins for the webview, env hooks aligned with `package.json` / Tauri dev).
- **`nix shell .#devShells.default`** — same packages and hooks without `nix develop`’s subshell semantics.

The flake **`devShell`** uses the same **`nixpkgs`** input as **`packages.psysonic`** (see **`flake.nix`**).

Optional **local-only** helpers (`dev.sh`, `shell.nix`, `prod.sh`) are **gitignored** — not part of the upstream tree; keep your own copies if you use them (e.g. a small `dev.sh` that runs `nix develop` and `npm run tauri:dev`).

## Desktop entry

The flake package installs a **`.desktop`** file and icon via `copyDesktopItems`; after `nixos-rebuild switch` (or a Home Manager activation that includes the package), Psysonic should appear in your application launcher like any other desktop app.

## Troubleshooting (Linux / WebKit)

Some GPU / compositor setups show a black window or broken scrolling under Wayland/EGL. The upstream Help / FAQ documents workarounds (e.g. running under **X11** and compositor-related env vars). Those apply to the Nix-built binary as well as other Linux builds.

## More detail in-repo

- **`flake.nix`** — `packages`, `apps`, `devShells`, supported systems; inline comments for `nix build` / `nix develop` / `nix run`.
- **`nix/psysonic.nix`** — how the app is built from this source tree (`npmDepsHash` from **`nix/upstream-sources.json`**).
- **`.github/workflows/reusable-channel-publish.yml`** — **`verify-nix`** job (prefetch npm deps hash, `nix flake update`, `nix build .#psysonic`, Cachix push, optional lock refresh PR).
- **`.github/workflows/next.yml`** / **`.github/workflows/release.yml`** — channel workflows that call the reusable publish workflow with **`verify_nix: true`**.
- **`.github/workflows/nix-npm-deps-hash-sync.yml`** — keeps **`nix/upstream-sources.json`** aligned with **`package-lock.json`** on **`main`** via PRs.

For the full promotion and release picture (branches, tags, automation), see **`RELEASE_PROCESS.md`**.
