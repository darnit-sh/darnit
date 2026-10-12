#!/bin/sh
# Checks what a pull request leaves behind: its title becomes the commit subject on main, and its
# commits stay on the pull request page. Usage: TITLE=... AUTHOR=... check-pr.sh <base sha> <head sha>
set -eu
fail=0
bad() { echo "::error::$1"; fail=1; }
CONVENTIONAL='^(feat|fix|chore|docs|test|ci|refactor|perf|build|revert)(\([a-z0-9-]+\))?!?: [^ ]'

printf '%s\n' "$TITLE" | grep -Eq "$CONVENTIONAL" || bad "title is not type(scope): summary: $TITLE"
[ "${#TITLE}" -le 72 ] || [ "$AUTHOR" = "dependabot[bot]" ] || bad "title is over 72 characters"

# Dependabot writes its own commits, quoting upstream release notes and crediting itself.
if [ "$AUTHOR" != "dependabot[bot]" ]; then
  shas=$(git rev-list --no-merges "$1..$2")
  for sha in $shas; do
    msg=$(git log -1 --format=%B "$sha")
    printf '%s\n' "$msg" | head -1 | grep -Eq "$CONVENTIONAL" || bad "commit $sha subject is not type(scope): summary"
    printf '%s\n' "$msg" | grep -iq '^co-authored-by:' && bad "commit $sha has a co-author line; the squash merge credits the pull request author"
  done
fi
exit "$fail"
