#!/bin/sh
# Checks a published version the way users get it: waits for npm to serve it, then runs it from an
# empty folder and on a sample with one known hit. Usage: verify-release.sh <version> [tries]
set -eu
version=$1
tries=${2:-30}
until [ "$(npm view "darnit@$version" version 2>/dev/null)" = "$version" ]; do
  tries=$((tries - 1))
  if [ "$tries" -le 0 ]; then
    echo "::error::npm does not serve darnit@$version" >&2
    exit 1
  fi
  sleep 10
done
dir=$(mktemp -d)
cp -R test/samples/small "$dir/sample"
mkdir "$dir/empty"
# npx reads a separately cached listing that can lag behind npm view, so give its install a retry.
got=$(cd "$dir/empty" && npx -y "darnit@$version" --version) ||
  { sleep 30; got=$(cd "$dir/empty" && npx -y "darnit@$version" --version); }
if [ "$got" != "$version" ]; then
  echo "::error::darnit@$version --version printed $got" >&2
  exit 1
fi
status=0
(cd "$dir/sample" && npx -y "darnit@$version" check --json) > "$dir/out.json" || status=$?
if [ "$status" != 1 ]; then
  echo "::error::darnit@$version check exited $status on test/samples/small, expected 1 for a hit" >&2
  exit 1
fi
if ! hits=$(node -e 'const { hits } = require(process.argv[1]); if (!Array.isArray(hits) || !hits.length) process.exit(1); console.log(hits.length)' "$dir/out.json"); then
  echo "::error::darnit@$version check --json has no hits on test/samples/small" >&2
  exit 1
fi
echo "darnit@$version: --version prints $got, check finds $hits hit(s)"
