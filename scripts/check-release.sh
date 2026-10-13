#!/bin/sh
# Checks that a pushed tag may publish, and prints the npm dist-tag to publish under.
# Usage: check-release.sh <tag> <commit>
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
case "$version" in
  *-*) echo next ;;
  *) echo latest ;;
esac
