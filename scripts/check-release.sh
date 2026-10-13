#!/bin/sh
# Checks that a pushed tag may publish, and prints the npm dist-tag to publish under.
# Usage: check-release.sh <tag> <full commit sha>. Needs gh signed in, or GH_TOKEN.
set -eu
version=$(node -p 'require("./package.json").version')
if [ "$1" != "v$version" ]; then
  echo "::error::tag $1 does not match package.json version $version" >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$2" origin/main; then
  echo "::error::$2 is not on main" >&2
  exit 1
fi
repo=${GITHUB_REPOSITORY:-darnit-sh/darnit}
merged=$(gh api "repos/$repo/commits/$2/pulls" --jq '.[] | select(.base.ref == "main" and .merged_at != null) | .merge_commit_sha + " " + .base.repo.full_name')
if ! printf '%s\n' "$merged" | grep -qxF "$2 $repo"; then
  echo "::error::$2 is not the merge commit of a pull request merged into main" >&2
  exit 1
fi
case "$version" in
  *-*) echo next ;;
  *) echo latest ;;
esac
