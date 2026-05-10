#!/usr/bin/env bash
#
# Hot-path file coverage gate — soft mode.
#
# For each source file listed in `.github/hot-path-files.txt`, verifies
# that line coverage is at least $THRESHOLD %. Emits GitHub Actions
# warning annotations for files below the floor; never sets a non-zero
# exit code (soft gate).
#
# Why files instead of per-function: cargo-llvm-cov's per-function
# region data is unreliable for async state-machines (most regions live
# in synthetic closures) and generic functions (every instantiation is
# a separate symbol). File-level line coverage is robustly measured and
# tracks the underlying intent: "is the hot-path file thoroughly tested?".
#
# Usage:
#   scripts/check-hot-path-coverage.sh [<coverage.json>] [<hot-path-list.txt>]
#
# Defaults:
#   coverage.json    — src-tauri/target/llvm-cov/cov.json
#   hot-path-list.txt — .github/hot-path-files.txt
#
# Requires: jq (preinstalled on Ubuntu runners; on Windows install via
#               `winget install jqlang.jq` or `choco install jq`).

set -euo pipefail
export LC_ALL=C

JSON="${1:-src-tauri/target/llvm-cov/cov.json}"
HOT_PATH_LIST="${2:-.github/hot-path-files.txt}"
THRESHOLD=70

if [[ ! -f "$JSON" ]]; then
    echo "::error::Coverage JSON not found at $JSON. Did you run cargo llvm-cov --workspace --json --output-path \"$JSON\" first?"
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

# Pre-extract every file's line coverage % into a TSV keyed by basename.
# We match by suffix (file path ends with the listed relative path) because
# the JSON stores absolute paths that vary between Windows runners and Linux.
ALL_FILES=$(mktemp)
trap 'rm -f "$ALL_FILES"' EXIT
jq -r '.data[0].files[] | [.filename, .summary.lines.percent] | @tsv' "$JSON" > "$ALL_FILES"

TOTAL=0
BELOW=0
NOT_FOUND=0

echo "── Hot-path file coverage check (threshold: ≥${THRESHOLD}%) ──────────"

while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
    line="${raw_line%%#*}"           # strip trailing comment
    line="${line#"${line%%[![:space:]]*}"}"   # ltrim
    line="${line%"${line##*[![:space:]]}"}"   # rtrim
    [[ -z "$line" ]] && continue
    TOTAL=$((TOTAL + 1))

    # Match suffix — the JSON stores absolute paths; the hot-path list uses
    # workspace-relative paths. Convert both to forward slashes first so the
    # endsWith works on Windows-encoded paths too.
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
        echo "::warning::Hot-path file '$line' not found in coverage report (deleted? renamed?)"
        NOT_FOUND=$((NOT_FOUND + 1))
        continue
    fi

    # bash arithmetic doesn't do float. Truncate to int for comparison.
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

# Two-layer gate:
#   - This script exits 1 when any hot-path file regresses below the
#     threshold. That gives an unambiguous CI signal in the workflow log.
#   - The `coverage` job in `.github/workflows/rust-tests.yml` carries
#     `continue-on-error: true`, so the failing exit is visible in the
#     PR's checks panel but does NOT block merges yet.
#   - Flip to a hard PR-blocker by removing `continue-on-error` from the
#     workflow once we've watched a few PRs run cleanly.
if [[ "$BELOW" -gt 0 ]]; then
    exit 1
fi
exit 0
