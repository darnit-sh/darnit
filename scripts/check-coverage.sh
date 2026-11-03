#!/bin/sh
# Coverage thresholds only go up: every folder in base's coverage-thresholds.json stays in head's at the same
# or a higher percent, and vitest.config.ts still reads the file. A file head leaves unreadable counts as removed.
#   check-coverage.sh <base sha> <head sha>
set -eu
. "$(dirname "$0")/pr-common.sh"

base=$1 head=$2
file=coverage-thresholds.json
git cat-file -e "$base:$file" 2>/dev/null || exit 0

lowered=$(node -e '
  const { execFileSync } = require("node:child_process");
  const [base, head, file] = process.argv.slice(1);
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const read = (rev) => {
    try { const j = JSON.parse(execFileSync("git", ["show", `${rev}:${file}`], { encoding: "utf8", stdio: "pipe" })); return isObj(j) ? j : undefined; }
    catch { return undefined; }
  };
  const [was, now] = [read(base) ?? {}, read(head)];
  if (!now) console.log(`${file} (removed or unreadable)`);
  else for (const [glob, t] of Object.entries(was)) {
    const n = Object.hasOwn(now, glob) && isObj(now[glob]) ? now[glob] : undefined;
    if (!n) { console.log(`${glob} (removed)`); continue; }
    for (const [metric, v] of Object.entries(isObj(t) ? t : {}))
      if (typeof v === "number" && !(typeof n[metric] === "number" && n[metric] >= v)) console.log(`${glob} ${metric} ${v} to ${JSON.stringify(n[metric]) ?? "(none)"}`);
  }
' "$base" "$head" "$file") || lowered="$file (unreadable)"
git show "$head:vitest.config.ts" 2>/dev/null | grep -qF "$file" || lowered=$(printf '%s\n' "$lowered" "vitest.config.ts no longer reads $file" | grep . || true)

if [ -n "$lowered" ]; then
  say "**Failed:** coverage thresholds only go up; this change lowers or removes some from base's $file:"
  list "$lowered"
  exit 1
fi
say "**Coverage passed:** every threshold in base's $file stays or goes up."
