#!/bin/sh
# One rule per pull request type, so a new title cannot dodge a guard. A refactor or perf change keeps
# every existing test, a test, docs or tooling change leaves the code and what the suite proves alone,
# and a revert is exactly the inverse of one commit. Results go to the job summary on the pull request page.
#   TITLE=... BODY=... check-refactor.sh <base sha> <head sha>
#   check-refactor.sh --base-tests <base sha>   runs base's tests and fixtures against the checked out code
# The second form overwrites test/ and the fixtures in the working tree.
set -eu
. "$(dirname "$0")/pr-common.sh"

if [ "${1:-}" = --base-tests ]; then
  base=$2
  rm -rf test
  git checkout "$base" -- test vitest.config.ts scripts/fixtures.ts
  # Only packs that exist on base; a pack added here keeps its own fixtures.
  for dir in $(git ls-tree -r --name-only "$base" -- packs | sed -n 's#^\(packs/[^/]*/[^/]*/fixtures\)/.*#\1#p' | sort -u); do
    rm -rf "$dir"
    git checkout "$base" -- "$dir"
  done
  fail=0
  npx vitest run || { say "**(b) failed:** a test from base fails against this change's code (log above)."; fail=1; }
  npx tsx scripts/fixtures.ts || { say "**(b) failed:** a pack fixture from base fails against this change's code (log above)."; fail=1; }
  [ "$fail" = 0 ] && say "**(b) passed:** every test and fixture from base passes against this change's code."
  exit "$fail"
fi

base=$1 head=$2
type=$(title_type)

# What the suite runs and proves with besides the tests: the runners and the modules tests import,
# edited or removed, and any test runner config at all.
suite_files() {
  paths --diff-filter=DMT | grep -E '^"?(scripts/(fixtures|e2e|golden)\.ts|test/.*\.[cm]?[jt]s)"?$' |
    grep -vE '\.test\.[cm]?[jt]s"?$|^"?test/(e2e|fixtures|samples|golden)/' || true
  paths | grep -E '^"?(vitest|vite)\.(config|workspace)\.[cm]?[jt]s"?$' || true
}
# package.json's "files", or each of base's scripts, when this change alters it. A package.json this
# change leaves unreadable counts as changed.
package_json() {
  git diff --quiet "$base...$head" -- package.json && return 0
  node -e '
    const git = (rev) => require("node:child_process").execFileSync("git", ["show", `${rev}:package.json`], { encoding: "utf8", stdio: "pipe" });
    const read = (rev) => { try { return JSON.parse(git(rev)); } catch { return undefined; } };
    const [a, b] = [read(process.argv[1]), read(process.argv[2])];
    const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
    if (b === undefined) console.log("package.json (removed or unreadable)");
    else if (process.argv[3] === "files") { if (!same(a?.files, b.files)) console.log("package.json \"files\""); }
    else for (const k of Object.keys(a?.scripts ?? {})) if (!same(a.scripts[k], b.scripts?.[k])) console.log(`package.json script "${k}"`);
  ' "$(git merge-base "$base" "$head")" "$head" "$1"
}

case $type in
refactor | perf)
  say "**Rule for \`$type\`:** (a) no existing test, fixture, golden file or test script changes, and no record (change.json) at all; (b) base's tests and fixtures pass against this code."
  # CI runs this change's copy of the test scripts, and records are data the tests do not check.
  edited=$(
    paths --diff-filter=DMT | grep -E '^"?(test/|packs/[^/]+/[^/]+/fixtures/|scripts/(e2e|golden)\.ts"?$)' || true
    paths | grep -E '(^|/)change\.json"?$' || true
  )
  if [ -n "$edited" ]; then
    say "**(a) failed:** a $type keeps every existing test, test script and record as it is (new test files are fine). Touched:"
    list "$edited"
    exit 1
  fi
  say "**(a) passed:** no existing test, fixture, golden file, test script or record changed."
  opt_out
  if [ -n "$reason" ]; then
    echo "::warning::(b) skipped by a 'Proof: none' line in the pull request body; the reason is in the job summary"
    say "**(b) skipped** by the opt-out line in the pull request body. Reason given: \`$reason\`"
  else
    say "(b) runs next."
    echo "base-tests=true" >>"${GITHUB_OUTPUT:-/dev/null}"
  fi
  ;;
test | docs | chore | ci | build)
  suite="the test runner config, fixture, end-to-end and golden runners, shared test modules or package.json scripts"
  case $type in
  test | ci) allowed="$suite only with a \`Proof: none, <reason>\` line" ;;
  *) allowed="nothing in $suite" ;;
  esac
  [ "$type" = build ] && ships="may change" || ships="stays"
  say "**Rule for \`$type\`:** no change under src/, packs/*/*/rules/ or any change.json; $allowed; package.json \"files\" $ships."
  touched=$(paths | grep -E "$CODE" || true)
  [ "$type" = build ] || touched=$(printf '%s\n' "$touched" "$(package_json files)" | grep . || true)
  changed=$(printf '%s\n' "$(suite_files)" "$(package_json scripts)" | grep . || true)
  if [ -n "$changed" ]; then
    reason=
    case $type in test | ci) opt_out ;; esac
    if [ -n "$reason" ]; then
      echo "::warning::$type changes the suite, allowed by a 'Proof: none' line in the pull request body; the reason is in the job summary"
      say "**Suite changed** under the opt-out line in the pull request body. Reason given: \`$reason\`"
      list "$changed"
    else
      touched=$(printf '%s\n' "$touched" "$changed" | grep . || true)
    fi
  fi
  if [ -n "$touched" ]; then
    say "**Failed:** a $type change leaves alone the code, the rule packs and what the rule above keeps. Code goes under fix, feat, refactor or perf, the suite under test or ci with a reason, and package.json \"files\" under build. Touched:"
    list "$touched"
    exit 1
  fi
  say "**Passed:** nothing the rule keeps changed."
  ;;
fix | feat) say "**Rule for \`$type\`:** passes here; the proof check covers $type changes." ;;
revert)
  say "**Rule for \`revert\`:** the change is exactly the inverse of the commit on a \`This reverts commit <sha>\` line in the title or body, a single-parent commit already in this change's history."
  shas=$({ printf '%s\n' "${TITLE:-}"; visible; } | grep -oE 'This reverts commit [0-9a-f]+' | sed 's/.* //' | sort -u)
  if [ "$(printf '%s' "$shas" | grep -c .)" != 1 ]; then
    say "**Failed:** name exactly one commit on a \`This reverts commit <sha>\` line; revert one commit per pull request."
    exit 1
  fi
  sha=$shas
  mb=$(git merge-base "$base" "$head")
  commit=$(git rev-parse --verify --quiet "$sha^{commit}" || true)
  if [ -z "$commit" ] || ! git merge-base --is-ancestor "$commit" "$mb" || git rev-parse --verify --quiet "$commit^2" >/dev/null; then
    say "**Failed:** $sha is not a single-parent commit in this change's history."
    exit 1
  fi
  if ! tree=$(git merge-tree --write-tree --merge-base="$commit" "$mb" "$commit^" 2>/dev/null); then
    say "**Failed:** $sha does not revert cleanly onto this change's base."
    exit 1
  fi
  differ=$(git diff --no-renames --name-only "$(printf '%s\n' "$tree" | head -1)" "$head")
  if [ -n "$differ" ]; then
    say "**Failed:** this change differs from the inverse of $sha in:"
    list "$differ"
    exit 1
  fi
  say "**Passed:** this change is exactly the inverse of $(git log -1 --format=%h "$commit")."
  ;;
*)
  say "**Failed:** the title has no type this check knows (see the title check)."
  exit 1
  ;;
esac
