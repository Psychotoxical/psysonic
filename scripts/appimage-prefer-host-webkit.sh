#!/usr/bin/env bash
# Post-process a Tauri-built AppImage so its AppRun prefers the host WebKitGTK
# stack when one is available.
#
# Rationale: the AppImage bundles the Ubuntu build of WebKitGTK. On hosts with
# a newer graphics stack (Mesa/libglvnd on Fedora 42+, atomic distros like
# Bluefin/Silverblue) that build fails to create an EGL display
# (EGL_BAD_PARAMETER) and WebKitWebProcess aborts, leaving a blank window.
# The host WebKitGTK, when installed, is always a better fit; the bundled copy
# remains as a fallback for hosts without webkit2gtk-4.1.
#
# Usage: appimage-prefer-host-webkit.sh <AppImage-or-directory>...
# Directories are scanned for *.AppImage; producing none is not an error, so a
# build that skipped the AppImage bundle still passes.
#
# appimagetool comes from $APPIMAGETOOL, else $PATH, else a pinned release
# downloaded and checksummed here.
set -euo pipefail

APPIMAGETOOL_VERSION=1.9.1

arch="$(uname -m)"
case "$arch" in
    # ldconfig_arch is how `ldconfig -p` spells the architecture, which differs
    # from uname; the filter keeps a multiarch host from matching its i386 copy.
    x86_64)  appimagetool_sha256=ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0; ldconfig_arch='x86-64' ;;
    aarch64) appimagetool_sha256=f0837e7448a0c1e4e650a93bb3e85802546e60654ef287576f46c71c126a9158; ldconfig_arch='AArch64' ;;
    *) echo "error: unsupported architecture: $arch" >&2; exit 1 ;;
esac

tmproot="$(mktemp -d)"
trap 'rm -rf "$tmproot"' EXIT

resolve_appimagetool() {
    if [ -n "${APPIMAGETOOL:-}" ]; then
        echo "$APPIMAGETOOL"
        return
    fi
    if command -v appimagetool >/dev/null; then
        command -v appimagetool
        return
    fi
    local tool="$tmproot/appimagetool"
    curl -fsSL -o "$tool" \
        "https://github.com/AppImage/appimagetool/releases/download/$APPIMAGETOOL_VERSION/appimagetool-$arch.AppImage" >&2
    echo "$appimagetool_sha256  $tool" | sha256sum -c - >&2
    chmod +x "$tool"
    echo "$tool"
}

# The block is inserted after linuxdeploy's own apprun-hooks (which pin
# GDK_BACKEND=x11 among other things) and before the final exec, so everything
# the hooks set is kept. It has to exec the binary directly rather than fall
# through to AppRun.wrapped, because AppRun.wrapped rebuilds LD_LIBRARY_PATH as
# "$APPDIR/usr/lib/:...:$LD_LIBRARY_PATH" and would put the bundled libraries
# back in front. AppRun.wrapped sets nothing else this app needs that the hooks
# do not already set (GST_PLUGIN_SYSTEM_PATH_1_0 comes from the gstreamer hook).
read -r -d '' block <<'EOF' || true

# Prefer the host WebKitGTK stack when available. The bundled (Ubuntu) build of
# WebKitGTK is incompatible with newer host graphics stacks (Mesa/libglvnd on
# e.g. Fedora 42+): EGL display creation fails with EGL_BAD_PARAMETER and
# WebKitWebProcess aborts, leaving a blank window. LD_LIBRARY_PATH outranks the
# binary's RUNPATH ($ORIGIN/../lib), so putting the host libdir first makes the
# whole stack resolve from the host instead of the bundled copies. The binary is
# exec'd directly because AppRun.wrapped would prepend the bundled libdirs again.
# Set PSYSONIC_FORCE_BUNDLED_WEBKIT=1 to skip this and use the bundled stack.
if [ -z "${PSYSONIC_FORCE_BUNDLED_WEBKIT:-}" ]; then
    # ldconfig lives in sbin, which is not on a non-root PATH on Debian.
    psysonic_host_webkit="$(PATH=/usr/sbin:/sbin:$PATH ldconfig -p 2>/dev/null | awk '/libwebkit2gtk-4\.1\.so\.0 .*@LDARCH@/{print $NF; exit}')"
    if [ -n "$psysonic_host_webkit" ] && [ -e "$psysonic_host_webkit" ]; then
        export LD_LIBRARY_PATH="$(dirname "$psysonic_host_webkit")${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
        export PATH="$this_dir/usr/bin:$PATH"
        exec "$this_dir"/usr/bin/@BINARY@ "$@"
    fi
fi
EOF
block="${block//@LDARCH@/$ldconfig_arch}"

patch_appimage() {
    local appimage
    appimage="$(readlink -f "$1")"
    local workdir="$tmproot/work"
    rm -rf "$workdir"
    mkdir -p "$workdir"

    (
        cd "$workdir"
        "$appimage" --appimage-extract >/dev/null

        local apprun=squashfs-root/AppRun
        # Only patch the linuxdeploy-generated AppRun we know the shape of.
        grep -q 'apprun-hooks' "$apprun" || {
            echo "error: unexpected AppRun format in $appimage, refusing to patch" >&2
            exit 1
        }
        grep -q '^exec ' "$apprun" || {
            echo "error: no exec line in AppRun of $appimage, refusing to patch" >&2
            exit 1
        }
        if grep -q 'PSYSONIC_FORCE_BUNDLED_WEBKIT' "$apprun"; then
            echo "already patched, skipping: $appimage"
            exit 0
        fi

        local binary
        binary="$(ls squashfs-root/usr/bin)"
        [ "$(echo "$binary" | wc -l)" -eq 1 ] || {
            echo "error: expected exactly one binary in usr/bin of $appimage" >&2
            exit 1
        }

        # ENVIRON (unlike awk -v) does not mangle backslash escapes in the block
        # text. Insert before the first exec so the hooks above it still run.
        BLOCK="${block//@BINARY@/$binary}" \
            awk '/^exec / && !done {print ENVIRON["BLOCK"]; done=1} {print}' \
            "$apprun" > "$apprun.new"
        mv "$apprun.new" "$apprun"
        chmod +x "$apprun"

        # APPIMAGE_EXTRACT_AND_RUN is for appimagetool alone (it is an AppImage
        # and the runners have no FUSE); exported globally it would also make
        # the runtime of the AppImage above run the app instead of extracting.
        # Absolute AppDir path: APPIMAGE_EXTRACT_AND_RUN makes appimagetool's own
        # runtime chdir into its extraction dir, so a relative one does not resolve.
        ARCH="$arch" APPIMAGE_EXTRACT_AND_RUN=1 "$appimagetool" "$PWD/squashfs-root" "$appimage.patched" >/dev/null
        mv "$appimage.patched" "$appimage"
        echo "patched: $appimage"
    )
}

shopt -s nullglob
targets=()
for arg in "$@"; do
    if [ -d "$arg" ]; then
        targets+=("$arg"/*.AppImage)
    elif [ -f "$arg" ]; then
        targets+=("$arg")
    else
        # A build that skipped the appimage bundle leaves no directory at all.
        echo "skipping (not found): $arg" >&2
    fi
done

if [ "${#targets[@]}" -eq 0 ]; then
    echo "no AppImage found in: $*"
    exit 0
fi

appimagetool="$(resolve_appimagetool)"
for target in "${targets[@]}"; do
    patch_appimage "$target"
done
