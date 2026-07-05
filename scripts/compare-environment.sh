#!/usr/bin/env bash
# Compare two environment dumps from dump-environment.sh
# Usage: ./scripts/compare-environment.sh FILE_A FILE_B

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 FILE_A FILE_B" >&2
  exit 1
fi

FILE_A="$1"
FILE_B="$2"

for f in "$FILE_A" "$FILE_B"; do
  if [[ ! -f "$f" ]]; then
    echo "Missing file: $f" >&2
    exit 1
  fi
done

parse_dump() {
  local file="$1"
  awk -F= '
    /^\[/ {
      section = substr($0, 2, length($0) - 2)
      next
    }
    /^[[:space:]]*$/ { next }
    /^#/ { next }
    {
      key = $1
      $1 = ""
      sub(/^=/, "", $0)
      full = (section == "" ? key : section "." key)
      print full "\t" $0
    }
  ' "$file" | sort -u
}

TMP_A="$(mktemp)"
TMP_B="$(mktemp)"
TMP_JOIN="$(mktemp)"
trap 'rm -f "$TMP_A" "$TMP_B" "$TMP_JOIN"' EXIT

parse_dump "$FILE_A" >"$TMP_A"
parse_dump "$FILE_B" >"$TMP_B"

join -t $'\t' -a 1 -a 2 -e '—' -o '0,1.2,2.2' "$TMP_A" "$TMP_B" >"$TMP_JOIN"

ONLY_A=0
ONLY_B=0
DIFF=0
SAME=0

echo "Comparing:"
echo "  A: $FILE_A"
echo "  B: $FILE_B"
echo

while IFS=$'\t' read -r key val_a val_b; do
  [[ -z "$key" ]] && continue
  if [[ "$val_a" == "—" ]]; then
    ONLY_B=$((ONLY_B + 1))
    printf '  +  %-40s  B=%s\n' "$key" "$val_b"
  elif [[ "$val_b" == "—" ]]; then
    ONLY_A=$((ONLY_A + 1))
    printf '  -  %-40s  A=%s\n' "$key" "$val_a"
  elif [[ "$val_a" != "$val_b" ]]; then
    DIFF=$((DIFF + 1))
    printf '  ≠  %-40s\n     A=%s\n     B=%s\n' "$key" "$val_a" "$val_b"
  else
    SAME=$((SAME + 1))
  fi
done <"$TMP_JOIN"

echo
echo "Summary: same=$SAME  different=$DIFF  only_in_A=$ONLY_A  only_in_B=$ONLY_B"

# High-signal keys for the common "works on one NixOS box" case.
echo
echo "High-signal differences (if any):"
HIGH_SIGNAL=0
while IFS=$'\t' read -r key val_a val_b; do
  [[ "$val_a" == "$val_b" ]] && continue
  case "$key" in
    meta.flake_lock_sha256|meta.nixpkgs_locked_rev|meta.npm_lock_sha256|meta.git_rev|\
    installed_app.psysonic_realpath|installed_app.psysonic_closure_paths|installed_app.psysonic_drv|\
    runtime_env.HTTP_PROXY|runtime_env.HTTPS_PROXY|runtime_env.http_proxy|runtime_env.https_proxy|\
    runtime_env.NO_PROXY|runtime_env.no_proxy|runtime_env.SSL_CERT_FILE|runtime_env.NIX_SSL_CERT_FILE|\
    toolchain_nix_develop.node_realpath|toolchain_nix_develop.rustc_realpath|\
    host.nixos_version|host.uname|\
    app_config_paths.data_dir|app_config_paths.localstorage_db_path|\
    app_preferences.language|app_servers.active_server_id|app_servers.server_count|\
    app_servers.server.*.url|app_servers.server.*.alternateUrl|\
    app_servers.server.*.customHeaders_count|app_servers.server.*.customHeadersApplyTo|\
    app_servers.server.*.password_sha256|app_servers.server.*.customHeaders.*.name|\
    app_servers.server.*.customHeaders.*.value_sha256|\
    app_network_probe.probe.*)
      HIGH_SIGNAL=$((HIGH_SIGNAL + 1))
      printf '  ! %s\n    A=%s\n    B=%s\n' "$key" "$val_a" "$val_b"
      ;;
  esac
done <"$TMP_JOIN"

if [[ "$HIGH_SIGNAL" -eq 0 && "$DIFF" -eq 0 && "$ONLY_A" -eq 0 && "$ONLY_B" -eq 0 ]]; then
  echo "  (none — environments match on recorded keys)"
elif [[ "$HIGH_SIGNAL" -eq 0 ]]; then
  echo "  (no high-signal keys differ; see full list above — may be npm patch-level deps only)"
fi

echo
echo "Server / network config differences:"
SERVER_DIFF=0
while IFS=$'\t' read -r key val_a val_b; do
  [[ "$val_a" == "$val_b" ]] && continue
  case "$key" in
    app_servers.*|app_network_probe.*|app_config_paths.*|app_preferences.*)
      SERVER_DIFF=$((SERVER_DIFF + 1))
      printf '  • %s\n    A=%s\n    B=%s\n' "$key" "$val_a" "$val_b"
      ;;
  esac
done <"$TMP_JOIN"
if [[ "$SERVER_DIFF" -eq 0 ]]; then
  echo "  (none — server URLs, headers, and curl probes match)"
fi

echo
echo "Reminder: server offline is usually URL/network/headers, not Node patch versions."
echo "Next: curl the Navidrome URL from both hosts; compare Settings → Servers side by side."

if [[ "$DIFF" -gt 0 || "$ONLY_A" -gt 0 || "$ONLY_B" -gt 0 ]]; then
  exit 1
fi
