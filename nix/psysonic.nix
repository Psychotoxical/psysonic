# Installable Psysonic (Tauri): npm build → cargo tauri build --no-bundle.
# Source: `self` (this repo). Package version is read from package.json.
# `npmDepsHash` in nix/upstream-sources.json is refreshed by the release
# workflow (see .github/workflows/release.yml, verify-nix job).

{
  lib,
  stdenv,
  fetchNpmDeps,
  npmHooks,
  rustPlatform,
  cargo,
  rustc,
  pkg-config,
  cmake,
  openssl,
  gtk3,
  webkitgtk_4_1,
  libsoup_3,
  glib-networking,
  alsa-lib,
  libayatana-appindicator,
  atk,
  cairo,
  gdk-pixbuf,
  glib,
  pango,
  librsvg,
  cargo-tauri,
  nodejs,
  makeWrapper,
  wrapGAppsHook4,
  copyDesktopItems,
  makeDesktopItem,
  gst_all_1,
  src,
  upstreamMeta,
  # When true (default), wrapProgram sets GDK_BACKEND=x11 for WebKit stability on many setups.
  # When false, GDK follows the session (e.g. native Wayland) — often better HiDPI sizing.
  forceGdkX11 ? true,
}:

let
  version = (lib.importJSON (src + "/package.json")).version;
  # WebKit media stack needs discoverable GStreamer plugins (e.g. appsink in gst-plugins-base).
  gstPlugins = with gst_all_1; [
    gstreamer
    gst-plugins-base
    gst-plugins-good
    gst-plugins-bad
  ];
  gstPluginPath = lib.makeSearchPath "lib/gstreamer-1.0" gstPlugins;
  srcClean = lib.cleanSourceWith {
    inherit src;
    filter =
      path: _:
      let
        f = toString path;
      in
      !(lib.hasInfix "/node_modules/" f)
      && !(lib.hasInfix "/dist/" f)
      && !(lib.hasInfix "/target/" f)
      && !(lib.hasInfix "/.git/" f)
      && !(lib.hasInfix "/result/" f)
      && !(lib.hasInfix "/.flatpak-builder/" f)
      && !(lib.hasInfix "/.build-local/" f);
  };
  npmDeps = fetchNpmDeps {
    src = srcClean;
    hash = upstreamMeta.npmDepsHash;
  };
  cargoLockFile = src + "/src-tauri/Cargo.lock";
in

stdenv.mkDerivation (finalAttrs: {
  pname = "psysonic";
  inherit version;
  src = srcClean;
  inherit npmDeps;

  strictDeps = true;

  # cmake is only for Rust deps (e.g. libopus); no top-level CMakeLists.txt in repo root
  dontUseCmakeConfigure = true;

  nativeBuildInputs = [
    npmHooks.npmConfigHook
    cargo
    rustc
    rustPlatform.cargoSetupHook
    pkg-config
    cmake
    makeWrapper
    wrapGAppsHook4
    copyDesktopItems
    cargo-tauri
    nodejs
  ];

  buildInputs = [
    gtk3
    webkitgtk_4_1
    libsoup_3
    glib-networking
    openssl
    alsa-lib
    libayatana-appindicator
    atk
    cairo
    gdk-pixbuf
    glib
    pango
    librsvg
  ]
  ++ gstPlugins;

  cargoRoot = "src-tauri";
  cargoDeps = rustPlatform.importCargoLock {
    lockFile = cargoLockFile;
    # Local path overrides for `[patch.crates-io]` entries in src-tauri/Cargo.toml.
    # Keep in sync with that block — importCargoLock needs the source to match
    # the lockfile entries for patched crates (otherwise it tries to fetch from
    # crates.io and the hash mismatches).
    outputHashes = { };
  };

  dontUseCargoParallelJobs = true;

  env = {
    OPENSSL_DIR = "${openssl.dev}";
    OPENSSL_LIB_DIR = "${openssl.out}/lib";
    OPENSSL_INCLUDE_DIR = "${openssl.dev}/include";
    VITE_LASTFM_API_KEY = "";
    VITE_LASTFM_API_SECRET = "";
  };

  # beforeBuildCommand runs npm run build; npmConfigHook supplies offline node_modules
  buildPhase = ''
    runHook preBuild
    export HOME=$(mktemp -d)
    (cd src-tauri && cargo tauri build --no-bundle -v)
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 src-tauri/target/release/psysonic -t $out/bin
    install -Dm644 src-tauri/icons/128x128.png $out/share/icons/hicolor/128x128/apps/psysonic.png
    runHook postInstall
  '';

  desktopItems = [
    (makeDesktopItem {
      name = "psysonic";
      desktopName = "Psysonic";
      comment = "Subsonic-compatible music player";
      icon = "psysonic";
      exec = "psysonic";
      categories = [ "AudioVideo" "Audio" "Player" ];
    })
  ];

  postFixup =
    let
      gdkX11Wrap = lib.optionalString forceGdkX11 ''
        --set GDK_BACKEND x11 \
      '';
    in
    ''
      wrapProgram $out/bin/psysonic \
        --prefix LD_LIBRARY_PATH : "${lib.makeLibraryPath [ libayatana-appindicator ]}" \
        --prefix GST_PLUGIN_PATH : "${gstPluginPath}" \
        --prefix GIO_EXTRA_MODULES : "${glib-networking}/lib/gio/modules" \
        ${gdkX11Wrap}--set WEBKIT_DISABLE_COMPOSITING_MODE 1 \
        --set WEBKIT_DISABLE_DMABUF_RENDERER 1
    '';

  meta = {
    description = "Desktop music player for Subsonic-compatible servers";
    homepage = "https://github.com/Psychotoxical/psysonic";
    license = lib.licenses.gpl3Only;
    mainProgram = "psysonic";
    platforms = lib.platforms.linux;
  };
})
