#!/usr/bin/env bash
#
# Hot-path file coverage gate — frontend, soft mode.
#
# Mirrors `scripts/check-hot-path-coverage.sh` for the Rust workspace. For
# each source file listed in `.github/frontend-hot-path-files.txt`, verifies
# that line coverage is at least $THRESHOLD %. Emits GitHub Actions warning
# annotations for files below the floor; exits 1 when any file is below, but
# the wrapping CI job carries `continue-on-error: true` so it doesn't block
# merges yet (drop that flag once we've watched a few PRs run cleanly).
#
# Why files instead of per-function: v8 coverage's per-function data is
# fragile under React Compiler / Vite minification — file-level line
# coverage tracks the underlying intent ("is the hot-path file thoroughly
# tested?") more robustly.
#
# Usage:
#   scripts/check-frontend-hot-path-coverage.sh [<summary.json>] [<hot-path-list.txt>]
#
# Defaults:
#   summary.json       — coverage/coverage-summary.json
#   hot-path-list.txt  — .github/frontend-hot-path-files.txt
#
# Requires: jq.

set -euo pipefail
export LC_ALL=C

JSON="${1:-coverage/coverage-summary.json}"
HOT_PATH_LIST="${2:-.github/frontend-hot-path-files.txt}"
THRESHOLD=70

if [[ ! -f "$JSON" ]]; then
    echo "::error::Coverage summary not found at $JSON. Did you run 'npm run test:coverage' first?"
    exit 2
fi

if [[ ! -f "$HOT_PATH_LIST" ]]; then
    echo "::error::Hot-path file list not found at $HOT_PATH_LIST"
    exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
    echo "::error::jq not found in PATH. Install via apt-get install jq / brew install jq / winget install jqlang.jq"
    exit 2
fi

# The v8 / Istanbul coverage-summary.json has the form:
#   { "total": {...}, "<absolute-path>": { "lines": { "pct": 87.5 }, ... }, ... }
# We want each file path + its line pct as a TSV keyed by basename suffix.
ALL_FILES=$(mktemp)
trap 'rm -f "$ALL_FILES"' EXIT
jq -r 'to_entries[] | select(.key != "total") | [.key, .value.lines.pct] | @tsv' "$JSON" > "$ALL_FILES"

TOTAL=0
BELOW=0
NOT_FOUND=0

echo "── Hot-path file coverage check, frontend (threshold: ≥${THRESHOLD}%) ──"

while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
    line="${raw_line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" ]] && continue
    TOTAL=$((TOTAL + 1))

    # Match suffix — JSON paths are absolute, hot-path list is workspace-relative.
    pct=$(awk -F'\t' -v target="$line" '
        {
            path = $1
            gsub(/\\\\/, "/", path)
            gsub(/\\/, "/", path)
            n = length(path)
            tlen = length(target)
            if (n >= tlen && substr(path, n - tlen + 1) == target) {
                printf "%s\n", $2
                exit
            }
        }
    ' "$ALL_FILES")

    if [[ -z "$pct" ]]; then
        echo "::warning::Hot-path file '$line' not found in coverage report (deleted? renamed? or no test imports it yet)"
        NOT_FOUND=$((NOT_FOUND + 1))
        continue
    fi

    pct_int=${pct%.*}
    if [[ "$pct_int" -lt "$THRESHOLD" ]]; then
        printf "::warning::Hot-path file '%s': %.1f%% — below %d%%\n" "$line" "$pct" "$THRESHOLD"
        BELOW=$((BELOW + 1))
    else
        printf "  ok  %s  %.1f%%\n" "$line" "$pct"
    fi
done < "$HOT_PATH_LIST"

echo
echo "── Summary ─────────────────────────────────────────────────────────"
echo "Checked: $TOTAL hot-path file(s)"
echo "Below threshold: $BELOW"
echo "Not found: $NOT_FOUND"

if [[ "$BELOW" -gt 0 ]]; then
    exit 1
fi
exit 0
