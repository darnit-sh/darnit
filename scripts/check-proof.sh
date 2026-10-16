#!/bin/sh
# The proof check: a fix or feat that changes code or a rule pack comes with a new or changed test
# that fails without the change and passes with it. Results go to the job summary.
#   TITLE=... BODY=... check-proof.sh <base sha> <head sha>   decides, and asks for --run when needed
#   TITLE=... check-proof.sh --run <base sha> <head sha>      runs the changed tests on the checked out
#     code, then on base's src/ and packs/ with this change's tests and fixtures
# The second form overwrites src/ and packs/ in the working tree and puts them back at the end.
set -eu
. "$(dirname "$0")/pr-common.sh"
mode=check
if [ "${1:-}" = --run ]; then mode=run && shift; fi
base=$1 head=$2
type=$(title_type)
NL='
'
in_head() { while read -r p; do if git cat-file -e "$head:$p" 2>/dev/null; then echo "$p"; fi; done; }
# Changed tests: test files, pack fixture cases and end-to-end scenarios that this change still has.
tests=$(paths --diff-filter=AM | grep -E '^test/.*\.test\.ts$' || true)
cases=$(paths | sed -nE 's#^(packs/[^/]+/[^/]+/fixtures/[^/]+)/.*#\1#p' | sort -u | in_head)
# A scenario also counts as changed when its entry in scripts/e2e.ts's EXPECT table changed.
hunks=$(git diff -U0 --no-color "$base...$head" -- scripts/e2e.ts | sed -nE 's/^@@ [^+]*\+([0-9]+)(,([0-9]+))? @@.*/\1 \3/p')
expected=$(git show "$head:scripts/e2e.ts" 2>/dev/null | HUNKS=$hunks awk '
  BEGIN { n = split(ENVIRON["HUNKS"], h, "\n"); for (i = 1; i <= n; i++) { split(h[i], p, " "); from[i] = p[1]; to[i] = p[1] + (p[2] == "" || p[2] == 0 ? 0 : p[2] - 1) } }
  /^const EXPECT/ { inside = 1 }
  inside && /^};/ { inside = 0 }
  inside && match($0, /^  "[^"]+": \{/) { key = substr($0, 4, RLENGTH - 7) }
  inside && key != "" { for (i = 1; i <= n; i++) if (NR >= from[i] && NR <= to[i]) print "test/e2e/" key }' || true)
scenarios=$({ paths | sed -nE 's#^(test/e2e/[^/]+)/.*#\1#p'; printf '%s\n' "$expected"; } | grep . | sort -u | in_head)

if [ "$mode" = check ]; then
  case $type in
  fix | feat) ;;
  *)
    say "**Not checked:** the proof check covers fix and feat; this title's type is \`${type:-none}\`."
    exit 0
    ;;
  esac
  if [ -z "$(paths | grep -E "$CODE" || true)" ]; then
    say "**Not checked:** this $type changes nothing under src/, packs/*/*/rules/ or change.json."
    exit 0
  fi
  say "**Rule for \`$type\`:** a new or changed test fails against base's src/ and packs/, and passes against this change's."
  opt_out
  if [ -n "$reason" ]; then
    echo "::warning::passed without a proof by a 'Proof: none' line in the pull request body; the reason is in the job summary"
    say "**Passed without a proof** by the opt-out line in the pull request body. Reason given: \`$reason\`"
    exit 0
  fi
  if [ -z "$tests$cases$scenarios" ]; then
    say "**Failed:** no new or changed test. Add a test, a pack fixture case or an end-to-end scenario that fails without this change, or give a reason on a line \`Proof: none, <reason>\`."
    exit 1
  fi
  say "Changed tests:"
  list "$(printf '%s\n' "$tests" "$cases" "$scenarios" | grep . || true)"
  echo "run=true" >>"${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
# One path per line, spaces kept, no globbing.
IFS=$NL
set -f
# Runs the changed tests on the code in the working tree, writing each runner's output to $out/$1.*.
run() {
  if [ -n "$tests" ]; then
    npx vitest run $tests --reporter=default --reporter=json --outputFile.json="$out/$1.json" || true
  fi
  if [ -n "$cases" ]; then npx tsx scripts/fixtures.ts $cases | tee "$out/$1.cases" || true; fi
  if [ -n "$scenarios" ]; then npm run test:e2e 2>&1 | tee "$out/$1.e2e" || true; fi
}
OUT=$out npx tsx "$(dirname "$0")/check-proof.ts" exports
run head
rm -rf src packs
git checkout "$base" -- src packs
find packs -mindepth 3 -maxdepth 3 -name fixtures -type d -exec rm -rf {} +
git checkout HEAD -- ':(glob)packs/*/*/fixtures/**'
OUT=$out npx tsx "$(dirname "$0")/check-proof.ts" mark
run base
rm -rf src packs
git checkout HEAD -- src packs
status=0
TYPE=$type TESTS=$tests CASES=$cases SCENARIOS=$scenarios OUT=$out npx tsx "$(dirname "$0")/check-proof.ts" >"$out/table.md" || status=$?
tee -a "$summary" <"$out/table.md"
exit "$status"
