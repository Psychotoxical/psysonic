#!/usr/bin/env bash
# Dump Psysonic-related toolchain, Nix closure hints, app config, and env for cross-machine diff.
# Re-enters `nix develop` automatically when flake.nix is present (no manual dev shell needed).
# Usage: ./scripts/dump-environment.sh [-o FILE]
# Compare: ./scripts/compare-environment.sh a.txt b.txt

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/dump-environment.sh"

# Bootstrap: run the rest inside the flake dev shell so node/jq match the project.
if [[ -z "${PSYSONIC_ENV_DUMP_IN_NIX:-}" ]] && [[ -f "$REPO_ROOT/flake.nix" ]]; then
  if ! command -v nix >/dev/null 2>&1; then
    echo "$0: flake.nix found but nix is not on PATH — install Nix or run from a NixOS profile with flakes." >&2
    exit 1
  fi
  export PSYSONIC_ENV_DUMP_IN_NIX=1
  exec env REPO_ROOT="$REPO_ROOT" nix develop --command bash "$SCRIPT" "$@"
fi

cd "$REPO_ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "$0: node not found after nix develop — check flake.nix devShell." >&2
  exit 1
fi

OUTPUT_FILE=""
while getopts 'o:h' opt; do
  case "$opt" in
    o) OUTPUT_FILE="$OPTARG" ;;
    h)
      echo "Usage: $0 [-o FILE]" >&2
      exit 0
      ;;
    *)
      echo "Usage: $0 [-o FILE]" >&2
      exit 1
      ;;
  esac
done

emit() {
  if [[ -n "$OUTPUT_FILE" ]]; then
    printf '%s\n' "$*" >>"$OUTPUT_FILE"
  else
    printf '%s\n' "$*"
  fi
}

kv() {
  local key="$1"
  local value="${2-}"
  value="${value//$'\n'/\\n}"
  emit "${key}=${value}"
}

section() {
  emit ""
  emit "[$1]"
}

run_optional() {
  "$@" 2>/dev/null || true
}

if [[ -n "$OUTPUT_FILE" ]]; then
  : >"$OUTPUT_FILE"
fi

section meta
kv generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
kv in_nix_dev_shell "${PSYSONIC_ENV_DUMP_IN_NIX:-no}"
kv hostname "$(hostname 2>/dev/null || echo unknown)"
kv repo_root "$REPO_ROOT"
if command -v git >/dev/null 2>&1 && git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  kv git_rev "$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  kv git_branch "$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  kv git_dirty "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
else
  kv git_rev "n/a"
  kv git_branch "n/a"
  kv git_dirty "n/a"
fi
if [[ -f "$REPO_ROOT/package.json" ]]; then
  kv package_json_version "$(node -p "require('./package.json').version" 2>/dev/null || sed -n 's/.*\"version\": \"\\([^\"]*\\)\".*/\\1/p' "$REPO_ROOT/package.json" | head -1)"
fi
if [[ -f "$REPO_ROOT/flake.lock" ]]; then
  kv flake_lock_sha256 "$(sha256sum "$REPO_ROOT/flake.lock" | awk '{print $1}')"
  if command -v jq >/dev/null 2>&1; then
    kv nixpkgs_locked_rev "$(jq -r '.nodes.nixpkgs.locked.rev // "unknown"' "$REPO_ROOT/flake.lock" 2>/dev/null)"
    kv nixpkgs_locked_narHash "$(jq -r '.nodes.nixpkgs.locked.narHash // "unknown"' "$REPO_ROOT/flake.lock" 2>/dev/null)"
  fi
fi
if [[ -f "$REPO_ROOT/package-lock.json" ]]; then
  kv npm_lockfile_version "$(jq -r '.lockfileVersion // "unknown"' "$REPO_ROOT/package-lock.json" 2>/dev/null || echo unknown)"
  kv npm_lock_sha256 "$(sha256sum "$REPO_ROOT/package-lock.json" | awk '{print $1}')"
fi

section host
kv uname "$(uname -a 2>/dev/null || echo unknown)"
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
  kv os_id "${ID:-unknown}"
  kv os_version "${VERSION_ID:-unknown}"
  kv os_pretty "${PRETTY_NAME:-unknown}"
fi
if command -v nixos-version >/dev/null 2>&1; then
  kv nixos_version "$(nixos-version 2>/dev/null || echo unknown)"
fi

section nix
if command -v nix >/dev/null 2>&1; then
  kv nix_version "$(nix --version 2>/dev/null | head -1)"
  kv nix_flake_present "$([[ -f "$REPO_ROOT/flake.nix" ]] && echo yes || echo no)"
else
  kv nix_version "not_installed"
  kv nix_flake_present "$([[ -f "$REPO_ROOT/flake.nix" ]] && echo yes || echo no)"
fi

dump_toolchain_block() {
  local label="$1"
  shift
  section "$label"
  for tool in node npm rustc cargo clippy jq cmake pkg-config; do
    if command -v "$tool" >/dev/null 2>&1; then
      case "$tool" in
        node) kv node_version "$("$tool" -v 2>/dev/null)" ;;
        npm) kv npm_version "$("$tool" -v 2>/dev/null)" ;;
        rustc) kv rustc_version "$("$tool" -V 2>/dev/null | head -1)" ;;
        cargo) kv cargo_version "$("$tool" -V 2>/dev/null | head -1)" ;;
        clippy) kv clippy_version "$("$tool" -V 2>/dev/null | head -1)" ;;
        jq) kv jq_version "$("$tool" --version 2>/dev/null | head -1)" ;;
        cmake) kv cmake_version "$("$tool" --version 2>/dev/null | head -1)" ;;
        pkg-config) kv pkg_config_version "$("$tool" --version 2>/dev/null | head -1)" ;;
      esac
      kv "${tool}_path" "$(command -v "$tool")"
      if [[ -L "$(command -v "$tool")" ]] || [[ -e "$(command -v "$tool")" ]]; then
        kv "${tool}_realpath" "$(readlink -f "$(command -v "$tool")" 2>/dev/null || echo unknown)"
      fi
    else
      kv "${tool}_version" "missing"
    fi
  done
  kv CARGO_TARGET_DIR "${CARGO_TARGET_DIR:-unset}"
  kv LD_LIBRARY_PATH "${LD_LIBRARY_PATH:-unset}"
  kv GST_PLUGIN_PATH "${GST_PLUGIN_PATH:-unset}"
  kv GIO_EXTRA_MODULES "${GIO_EXTRA_MODULES:-unset}"
}

if [[ -n "${PSYSONIC_ENV_DUMP_IN_NIX:-}" ]]; then
  dump_toolchain_block toolchain_nix_develop
elif command -v nix >/dev/null 2>&1 && [[ -f "$REPO_ROOT/flake.nix" ]]; then
  # No bootstrap (should not happen when flake exists) — capture devShell separately.
  NIX_DEV_DUMP="$(nix develop --command bash -lc '
    set +e
    cd "$REPO_ROOT" || exit 0
    for tool in node npm rustc cargo clippy jq; do
      if command -v "$tool" >/dev/null 2>&1; then
        case "$tool" in
          node) printf "node_version=%s\n" "$("$tool" -v)" ;;
          npm) printf "npm_version=%s\n" "$("$tool" -v)" ;;
          rustc) printf "rustc_version=%s\n" "$("$tool" -V | head -1)" ;;
          cargo) printf "cargo_version=%s\n" "$("$tool" -V | head -1)" ;;
          clippy) printf "clippy_version=%s\n" "$("$tool" -V | head -1)" ;;
          jq) printf "jq_version=%s\n" "$("$tool" --version | head -1)" ;;
        esac
        printf "%s_path=%s\n" "$tool" "$(command -v "$tool")"
        printf "%s_realpath=%s\n" "$tool" "$(readlink -f "$(command -v "$tool")" 2>/dev/null || echo unknown)"
      else
        printf "%s_version=missing\n" "$tool"
      fi
    done
    printf "CARGO_TARGET_DIR=%s\n" "${CARGO_TARGET_DIR:-unset}"
    printf "LD_LIBRARY_PATH=%s\n" "${LD_LIBRARY_PATH:-unset}"
    printf "GST_PLUGIN_PATH=%s\n" "${GST_PLUGIN_PATH:-unset}"
    printf "GIO_EXTRA_MODULES=%s\n" "${GIO_EXTRA_MODULES:-unset}"
  ' REPO_ROOT="$REPO_ROOT" 2>/dev/null | tr -d '\r' || true)"
  if [[ -n "$NIX_DEV_DUMP" ]]; then
    section toolchain_nix_develop
    while IFS= read -r line; do
      [[ -n "$line" && "$line" == *=* ]] && emit "$line"
    done <<<"$NIX_DEV_DUMP"
  else
    section toolchain_nix_develop
    kv status "nix develop failed or unavailable"
  fi
else
  dump_toolchain_block toolchain_ambient
fi

section runtime_env
for var in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy GDK_BACKEND PSYSONIC_SKIP_WAYLAND_FONT_TUNING PSYSONIC_ALLOW_NATIVE_GDK SSL_CERT_FILE SSL_CERT_DIR NIX_SSL_CERT_FILE; do
  kv "$var" "${!var-unset}"
done
kv navigator_online "n/a (browser-only)"

section installed_app
if command -v psysonic >/dev/null 2>&1; then
  PSY_PATH="$(command -v psysonic)"
  kv psysonic_path "$PSY_PATH"
  kv psysonic_realpath "$(readlink -f "$PSY_PATH" 2>/dev/null || echo unknown)"
  run_optional kv psysonic_version "$(psysonic --version 2>/dev/null | head -1)"
  if command -v nix-store >/dev/null 2>&1; then
    kv psysonic_closure_paths "$(nix-store -qR "$PSY_PATH" 2>/dev/null | wc -l | tr -d ' ')"
    kv psysonic_drv "$(nix-store -q --deriver "$PSY_PATH" 2>/dev/null | sed 's/\.drv$//' | xargs -r basename 2>/dev/null || echo unknown)"
  fi
else
  kv psysonic_path "not_in_path"
fi

section npm_dependencies
if [[ -f "$REPO_ROOT/package-lock.json" ]] && command -v node >/dev/null 2>&1; then
  REPO_ROOT="$REPO_ROOT" node <<'NODE' 2>/dev/null | while IFS= read -r line; do emit "$line"; done || true
const fs = require('fs');
const path = require('path');
const lockPath = path.join(process.env.REPO_ROOT || '.', 'package-lock.json');
let lock;
try { lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { process.exit(0); }
const root = lock.packages?.['']?.dependencies || {};
const deps = Object.keys(root).sort();
for (const name of deps) {
  const entry = lock.packages?.[`node_modules/${name}`] || lock.packages?.[name];
  const version = entry?.version || 'unknown';
  console.log(`dep.${name}=${version}`);
}
NODE
else
  kv status "node or package-lock.json unavailable"
fi

run_app_config_dump() {
  local extractor="$REPO_ROOT/scripts/lib/extract-app-config.mjs"
  [[ -f "$extractor" ]] || return 0
  if node "$extractor" --repo-root "$REPO_ROOT" >>"${OUTPUT_FILE:-/dev/stdout}" 2>/dev/null; then
    :
  else
    section app_config
    kv status "extract-app-config failed (is Psysonic installed / has it been run once?)"
  fi
}

run_app_config_dump

section network_probe_hint
kv note_1 "App server profiles and curl probes are in app_servers / app_network_probe sections above."
kv note_2 "Passwords and custom header values are redacted; compare password_sha256 and value_sha256 only."
kv note_3 "Compare two dumps with: scripts/compare-environment.sh a.txt b.txt"

if [[ -n "$OUTPUT_FILE" ]]; then
  echo "Wrote $OUTPUT_FILE" >&2
fi
