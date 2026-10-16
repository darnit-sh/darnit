#!/bin/sh
# One rule per pull request type, so a new title cannot dodge a guard. A refactor or perf change keeps
# every existing test, a test, docs or tooling change leaves the code alone. Results go to the job
# summary on the pull request page.
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
  say "**Rule for \`$type\`:** no change under src/, packs/*/*/rules/ or any change.json."
  touched=$(paths | grep -E "$CODE" || true)
  if [ -n "$touched" ]; then
    say "**Failed:** a $type change leaves the code and the rule packs alone; use fix, feat, refactor or perf. Touched:"
    list "$touched"
    exit 1
  fi
  say "**Passed:** nothing under src/, packs/*/*/rules/ or change.json changed."
  ;;
fix | feat) say "**Rule for \`$type\`:** passes here; the proof check covers $type changes." ;;
revert) say "**Rule for \`revert\`:** exempt." ;;
*)
  say "**Failed:** the title has no type this check knows (see the title check)."
  exit 1
  ;;
esac
