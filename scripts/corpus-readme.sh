#!/bin/sh
# The corpus pull request's README.md comes from a job that runs dependency code, so the job holding the
# token takes only its counts. Each line must match the checked-out README, except that a count of change
# records ("against N change records") or of retiring models ("OpenAI: N retiring models") may change, in
# the same sentence, to 1 to 4 digits. Then those numbers are written into the checked-out README; otherwise
# each other line is named, nothing is written and it exits 1. The artifact's text is never printed, so it
# cannot reach the workflow log.
#   corpus-readme.sh <README from the artifact> <README to update>
set -eu
from=$1 to=$2
out=$(mktemp)
trap 'rm -f "$out"' EXIT
awk '
  # Splits a count line into the text before its number, the number and the text after; 0 when not one.
  function parts(l, p) {
    if (!match(l, /(against [1-9][0-9]?[0-9]?[0-9]? change records|OpenAI: [1-9][0-9]?[0-9]?[0-9]? retiring models)/)) return 0
    p["head"] = substr(l, 1, RSTART - 1)
    p["body"] = substr(l, RSTART, RLENGTH)
    p["tail"] = substr(l, RSTART + RLENGTH)
    p["num"] = p["body"]
    gsub(/[^0-9]/, "", p["num"])
    p["head"] = p["head"] substr(p["body"], 1, index(p["body"], p["num"]) - 1)
    p["tail"] = substr(p["body"], index(p["body"], p["num"]) + length(p["num"])) p["tail"]
    return 1
  }
  function refuse(n, why) { printf "README.md:%d: %s\n", n, why > "/dev/stderr"; bad = 1 }
  FILENAME == ARGV[1] { old[FNR] = $0; lines = FNR; next }
  {
    seen = FNR
    if (FNR > lines) { if (!extra++) refuse(FNR, "and later lines are ones the checked-out README does not have"); next }
    # Compared as text: as numbers, 10 and 1e1 would be the same line.
    if ($0 "" == old[FNR] "") { line[FNR] = old[FNR]; next }
    if (!parts(old[FNR], o) || !parts($0, n) || o["head"] != n["head"] || o["tail"] != n["tail"]) {
      refuse(FNR, "changed, and only the count of change records or retiring models may change, to 1 to 4 digits")
      next
    }
    line[FNR] = o["head"] n["num"] o["tail"]
  }
  END {
    if (seen < lines) refuse(seen + 1, "missing from the artifact README")
    if (bad) exit 1
    for (i = 1; i <= lines; i++) print line[i]
  }
' "$to" "$from" >"$out"
cat "$out" >"$to"
