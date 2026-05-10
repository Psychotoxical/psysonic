{
  description = ''
    Psysonic for NixOS / nixpkgs: installable app + dev shell.

    Packages:
      nix build .#psysonic          # or .#default — desktop app (.desktop + icon); GDK_BACKEND=x11 (default, fewer WebKit surprises)
      nix build .#psysonic-gdk-session   # same app, no forced GDK x11 — optional; can misbehave on some stacks (see nixos-install.md)
      nix profile install .#psysonic

    Run (after build, or from any clone with flake):
      nix run .#psysonic
      nix run .#psysonic-gdk-session
      nix run github:Psychotoxical/psysonic

    Development:
      nix develop                   # mkShell (Rust/Node/WebKit deps + hooks)
      nix shell .#devShells.default # same environment without entering subshell semantics
      Local cargo output: .build-local/ (gitignored; not copied into flake source tarball)

    Release pipeline updates `flake.lock` (nixpkgs pin refresh) and
    `nix/upstream-sources.json` (npmDepsHash) on every `v*` tag push —
    see `.github/workflows/release.yml` (verify-nix job). Package version
    is read from `package.json`; nothing in this file needs manual bumping
    per release.
  '';

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forSystem = f: lib.genAttrs systems f;

      mkShellFor =
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          gstPlugins = with pkgs.gst_all_1; [
            gstreamer
            gst-plugins-base
            gst-plugins-good
            gst-plugins-bad
          ];
          gstPluginPath = pkgs.lib.makeSearchPath "lib/gstreamer-1.0" gstPlugins;
        in
        pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22
            rustc
            cargo
            clippy
            cargo-llvm-cov
            llvmPackages.llvm
            jq
            cmake
            pkg-config
            openssl
            gtk3
            webkitgtk_4_1
            libsoup_3
            glib-networking
            atk
            cairo
            gdk-pixbuf
            glib
            pango
            librsvg
            alsa-lib
            libayatana-appindicator
          ]
          ++ gstPlugins;

          shellHook = ''
            _repo="$(git rev-parse --show-toplevel 2>/dev/null || true)"
            if [ -n "$_repo" ] && [ -f "$_repo/flake.nix" ]; then
              export CARGO_TARGET_DIR="''${CARGO_TARGET_DIR:-$_repo/.build-local/cargo-target}"
            fi
            export LD_LIBRARY_PATH="${pkgs.libayatana-appindicator}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
            export GST_PLUGIN_PATH="${gstPluginPath}''${GST_PLUGIN_PATH:+:$GST_PLUGIN_PATH}"
            export GIO_EXTRA_MODULES="${pkgs.glib-networking}/lib/gio/modules''${GIO_EXTRA_MODULES:+:$GIO_EXTRA_MODULES}"
            export LLVM_COV="${pkgs.llvmPackages.llvm}/bin/llvm-cov"
            export LLVM_PROFDATA="${pkgs.llvmPackages.llvm}/bin/llvm-profdata"
            export GDK_BACKEND=x11
            export WEBKIT_DISABLE_COMPOSITING_MODE=1
            export WEBKIT_DISABLE_DMABUF_RENDERER=1
            unset CI
          '';

          OPENSSL_LIB_DIR = "${pkgs.openssl.out}/lib";
          OPENSSL_INCLUDE_DIR = "${pkgs.openssl.dev}/include";
        };

      upstreamMeta = lib.importJSON ./nix/upstream-sources.json;

      psysonicFor =
        system:
        nixpkgs.legacyPackages.${system}.callPackage ./nix/psysonic.nix {
          src = self;
          inherit upstreamMeta;
        };

      psysonicGdkSessionFor =
        system:
        nixpkgs.legacyPackages.${system}.callPackage ./nix/psysonic.nix {
          src = self;
          inherit upstreamMeta;
          forceGdkX11 = false;
        };
    in
    {
      devShells = forSystem (system: { default = mkShellFor system; });

      packages = forSystem (system: {
        psysonic = psysonicFor system;
        psysonic-gdk-session = psysonicGdkSessionFor system;
        default = psysonicFor system;
      });

      apps = forSystem (
        system:
        let
          p = psysonicFor system;
          pGdk = psysonicGdkSessionFor system;
        in
        {
          default = {
            type = "app";
            program = lib.getExe p;
            meta = {
              inherit (p.meta) description homepage license;
              mainProgram = "psysonic";
            };
          };
          psysonic-gdk-session = {
            type = "app";
            program = lib.getExe pGdk;
            meta = {
              inherit (pGdk.meta) description homepage license;
              mainProgram = "psysonic";
            };
          };
        }
      );
    };
}
