#!/usr/bin/env bash
#
# Hot-path function coverage gate — soft mode.
#
# Reads cargo-llvm-cov JSON output and checks each function listed in
# .github/hot-path-functions.txt against an 80% region-coverage threshold.
# Emits GitHub Actions warning annotations for misses; never sets a non-zero
# exit code (the gate is a warning-only signal until cucadmuh decides to
# flip it to a hard fail in a follow-up).
#
# Usage:
#   scripts/check-hot-path-coverage.sh [<coverage.json>] [<hot-path-list.txt>]
#
# Defaults:
#   coverage.json    — src-tauri/target/llvm-cov/cov.json
#   hot-path-list.txt — .github/hot-path-functions.txt
#
# Requires: jq (preinstalled on Ubuntu runners; on Windows install via
#               `winget install jqlang.jq` or `choco install jq`).

set -euo pipefail

JSON="${1:-src-tauri/target/llvm-cov/cov.json}"
HOT_PATH_LIST="${2:-.github/hot-path-functions.txt}"
THRESHOLD=80

if [[ ! -f "$JSON" ]]; then
    echo "::error::Coverage JSON not found at $JSON. Did you run cargo llvm-cov --workspace --json --output-path \"$JSON\" first?"
    exit 2
fi

if [[ ! -f "$HOT_PATH_LIST" ]]; then
    echo "::error::Hot-path function list not found at $HOT_PATH_LIST"
    exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
    echo "::error::jq not found in PATH. Install via apt-get install jq / brew install jq / winget install jqlang.jq"
    exit 2
fi

TOTAL=0
BELOW=0
NOT_FOUND=0

# Pre-extract every function with its region totals into a flat TSV so we
# don't re-scan the JSON for each line in the hot-path list.
ALL_FNS=$(mktemp)
trap 'rm -f "$ALL_FNS"' EXIT
jq -r '
    .data[0].functions[]
    | [
        .name,
        (.regions | length),
        ([.regions[] | select(.[4] > 0)] | length)
    ]
    | @tsv
' "$JSON" > "$ALL_FNS"

echo "── Hot-path coverage check (threshold: ≥${THRESHOLD}%) ──────────────────"

while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
    line="${raw_line%%#*}"           # strip trailing comment
    line="${line#"${line%%[![:space:]]*}"}"   # ltrim
    line="${line%"${line##*[![:space:]]}"}"   # rtrim
    [[ -z "$line" ]] && continue
    TOTAL=$((TOTAL + 1))

    matches=$(awk -F'\t' -v fn="$line" 'index($1, fn) > 0' "$ALL_FNS")
    if [[ -z "$matches" ]]; then
        echo "::warning::Hot-path function '$line' not found in coverage report (deleted? renamed?)"
        NOT_FOUND=$((NOT_FOUND + 1))
        continue
    fi

    # Aggregate across all matched instantiations (handles generics + closures).
    sums=$(echo "$matches" | awk -F'\t' '
        { regions += $2; covered += $3 }
        END { printf "%d\t%d\n", regions, covered }
    ')
    regions=$(echo "$sums" | cut -f1)
    covered=$(echo "$sums" | cut -f2)

    if [[ "$regions" -eq 0 ]]; then
        echo "::warning::Hot-path '$line' has 0 regions (likely inlined or never reached)"
        NOT_FOUND=$((NOT_FOUND + 1))
        continue
    fi

    pct=$(( covered * 100 / regions ))
    if [[ "$pct" -lt "$THRESHOLD" ]]; then
        echo "::warning::Hot-path '$line': ${pct}% (${covered}/${regions} regions) — below ${THRESHOLD}%"
        BELOW=$((BELOW + 1))
    else
        echo "  ok  $line  ${pct}% (${covered}/${regions})"
    fi
done < "$HOT_PATH_LIST"

echo
echo "── Summary ─────────────────────────────────────────────────────────────"
echo "Checked: $TOTAL function(s)"
echo "Below threshold: $BELOW"
echo "Not found / 0 regions: $NOT_FOUND"

# SOFT GATE — never fail. Warnings are visible in the PR's checks panel but
# don't block merge. cucadmuh can flip this to `exit 1` once the warning has
# been clean across a few PRs.
exit 0
