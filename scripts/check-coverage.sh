#!/bin/sh
# Coverage only goes up. Once base has coverage-thresholds.json, a change fails when it lowers or removes a threshold
# there, changes a vitest or vite config, the coverage plugin's pin or the vitest it runs in, or adds an ignore comment
# under src/, unless it is a ci change with a `Coverage: <reason>` line. Judged from base, by diffing the two commits.
#   TITLE=... BODY=... check-coverage.sh <base sha> <head sha>
#   check-coverage.sh --new-keys <base sha> <json summary>   each folder the thresholds add, against what CI measured
set -eu
. "$(dirname "$0")/pr-common.sh"
file=coverage-thresholds.json

if [ "${1:-}" = --new-keys ]; then
  added=$(node -e '
    const { execFileSync } = require("node:child_process");
    const { readFileSync } = require("node:fs");
    const { relative, sep } = require("node:path");
    const [base, summaryFile, file, dir] = process.argv.slice(1);
    const pm = require(require.resolve("picomatch", { paths: [process.cwd(), dir] }));
    const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
    let was;
    try { was = JSON.parse(execFileSync("git", ["show", `${base}:${file}`], { encoding: "utf8", stdio: "pipe" })); } catch {}
    const [now, summary] = [file, summaryFile].map((f) => JSON.parse(readFileSync(f, "utf8")));
    const files = Object.entries(summary).filter(([f]) => f !== "total").map(([f, s]) => [relative(process.cwd(), f).split(sep).join("/"), s]);
    for (const [glob, t] of Object.entries(now)) {
      if (isObj(was) && Object.hasOwn(was, glob)) continue;
      const hit = files.filter(([f]) => pm(glob)(f));
      if (!hit.length) console.log(`${glob} matches no file`);
      for (const metric of hit.length ? ["lines", "branches"] : []) {
        const [c, n] = hit.reduce(([c, n], [, s]) => [c + s[metric].covered, n + s[metric].total], [0, 0]);
        const pct = n ? Math.floor((100 * c) / n) : 100;
        const v = isObj(t) ? t[metric] : undefined;
        if (!(typeof v === "number" && v >= pct)) console.log(`${glob} ${metric} ${JSON.stringify(v) ?? "(none)"}, measured ${pct}%`);
      }
    }
  ' "$2" "$3" "$file" "$(dirname "$0")") || added="$file or $3 (unreadable)"
  if [ -n "$added" ]; then
    say "**Failed:** a folder this change adds to $file sits below the coverage this run measured, rounded down, or matches no file:"
    list "$added"
    exit 1
  fi
  say "**Coverage passed:** every folder this change adds to $file sits at or above the coverage this run measured."
  exit 0
fi

base=$1 head=$2
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

# Any line of a config vitest reads can reach the coverage settings, so any change to one counts.
configs=$(paths | grep -iE '^"?(vitest\.config|vite\.config|vitest\.workspace)\.[^/]*"?$' | sed 's/$/ (coverage settings)/' || true)

# The plugin, and the vitest it runs inside, as package.json asks for them and the lock installs them.
pins=$(node -e '
  const { execFileSync } = require("node:child_process");
  const [base, head] = process.argv.slice(1);
  const read = (rev, f) => {
    try { return JSON.parse(execFileSync("git", ["show", `${rev}:${f}`], { encoding: "utf8", stdio: "pipe", maxBuffer: 2 ** 28 })); }
    catch { return undefined; }
  };
  const fields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides"];
  const spec = (j, n) => JSON.stringify(fields.map((f) => j?.[f]?.[n]));
  const entry = (j, n) => JSON.stringify(j?.packages?.[`node_modules/${n}`]);
  for (const [f, at, label] of [["package.json", spec, ""], ["package-lock.json", entry, "node_modules/"]]) {
    const [a, b] = [read(base, f), read(head, f)];
    for (const n of ["@vitest/coverage-v8", "vitest"]) if (at(a, n) !== at(b, n)) console.log(`${f} ${label}${n}`);
  }
' "$base" "$head") || pins="package.json or package-lock.json (unreadable)"

# Ignore hints in each file this change adds or edits under src/, counted over its whole text on base and on head.
# The pattern is the plugin's (ast-v8-to-istanbul), whose \s+ spans lines inside a block comment, in any case and
# with start and stop, which it reads one line at a time, so it can only count more than the plugin honours.
ignores=$(node -e '
  const { execFileSync } = require("node:child_process");
  const [base, head] = process.argv.slice(1);
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: "pipe", maxBuffer: 2 ** 28 });
  const show = (rev, f) => { try { return git("show", `${rev}:${f}`); } catch { return ""; } };
  const hint = /(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(?:if|else|next|file|start|stop)(?=\W|$)/gi;
  for (const f of git("diff", "--no-renames", "--name-only", "-z", "--diff-filter=AMT", base, head, "--", "src").split("\0").filter(Boolean)) {
    const [was, now] = [base, head].map((rev) => show(rev, f).match(hint) ?? []);
    if (now.length > was.length) console.log(`${f}: ${now.length} ignore hints, base has ${was.length}: ${now.map((h) => h.replace(/\s+/g, " ")).join(", ")}`);
  }
' "$base" "$head") || ignores="src/ (ignore hints unreadable)"

found=$(printf '%s\n' "$lowered" "$configs" "$pins" "$ignores" | grep . || true)
if [ -z "$found" ]; then
  say "**Coverage passed:** nothing that decides coverage went down: the thresholds in base's $file, vitest and vite config, the coverage plugin's pin and ignore comments under src/."
  exit 0
fi
reason=
[ "$(title_type)" = ci ] && opt_out "Coverage: "
if [ -n "$reason" ]; then
  echo "::warning::coverage settings change, allowed by a 'Coverage:' line in the pull request body; the reason is in the job summary"
  say "**Coverage settings changed** under the \`Coverage:\` line in the pull request body. Reason given: \`$reason\`"
  list "$found"
  exit 0
fi
say "**Failed:** coverage only goes up. Only a ci change with a \`Coverage: <reason>\` line may lower or remove a threshold in base's $file, change a vitest or vite config, the coverage plugin's pin or the vitest it runs in, or add an ignore comment under src/. Found:"
list "$found"
exit 1
