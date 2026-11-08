#!/bin/sh
# Checks that a pushed tag may publish (version, merged pull request, green main CI), and prints
# the npm dist-tag to publish under: next, latest, or latest-X.Y for a patch to an older line.
# Usage: check-release.sh <tag> <full commit sha>. Needs gh signed in, or GH_TOKEN.
set -eu
version=$(node -e 'console.log(require("./package.json").version)')
if [ "$1" != "v$version" ]; then
  echo "::error::tag $1 does not match package.json version $version" >&2
  exit 1
fi
# Every bullet in the section being released ends with its pull request link. A candidate releases
# [Unreleased]; the final version releases its own heading.
case "$version" in
  *-*) section=Unreleased ;;
  *) section=$version ;;
esac
node -e '
const [file, section] = process.argv.slice(1);
let lines = [];
try {
  lines = require("fs").readFileSync(file, "utf8").split(/\r?\n/);
} catch {}
const start = lines.findIndex((l) => l.startsWith("## [" + section + "]"));
if (start < 0) {
  console.error("::error::" + file + " has no ## [" + section + "] section");
  process.exit(1);
}
// A bullet runs on over the lines below it up to a blank line or a heading.
const bullets = [];
let open = false;
for (const line of lines.slice(start + 1)) {
  if (line.startsWith("## ")) break;
  if (/^\s*[-*+]\s/.test(line)) open = bullets.push(line) > 0;
  else if (!line.trim() || line.startsWith("#")) open = false;
  else if (open) bullets[bullets.length - 1] += " " + line.trim();
}
const link = String.raw`\[#(\d+)\]\(https://github\.com/darnit-sh/darnit/pull/(\d+)\)`;
const tail = new RegExp(String.raw`\((${link})(, ${link})*\)$`);
let bad = 0;
for (const b of bullets) {
  const m = tail.exec(b.trimEnd());
  if (m && [...m[0].matchAll(new RegExp(link, "g"))].every((l) => l[1] === l[2])) continue;
  console.error("::error::" + file + " [" + section + "] has a line with no pull request link: " + b.trim().slice(0, 100));
  bad = 1;
}
process.exit(bad);
' CHANGELOG.md "$section" || exit 1
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
ci=$(gh api -X GET "repos/$repo/actions/runs" -f head_sha="$2" -f event=push --jq '[.workflow_runs[] | select(.path == ".github/workflows/ci.yml")][0] | if . == null then "missing" else .conclusion // .status end')
if [ "$ci" != success ]; then
  echo "::error::ci on $2 is $ci; wait for it to pass on main, then rerun this workflow" >&2
  exit 1
fi
case "$version" in
  *-*) echo next; exit 0 ;;
esac
# A release becomes latest only when it is newer than npm's latest; a patch to an older line gets
# latest-X.Y. Registry text is untrusted: anything but a plain x.y.z stops the release.
if ! current=$(npm view darnit dist-tags.latest); then
  echo "::error::could not read darnit's latest version from npm" >&2
  exit 1
fi
node -e '
const re = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const [v, cur] = process.argv.slice(1).map((s) => re.exec(s)?.slice(1).map(BigInt));
if (!v || !cur) {
  console.error("::error::expected x.y.z versions, got " + JSON.stringify(process.argv.slice(1)));
  process.exit(1);
}
const i = v.findIndex((n, k) => n !== cur[k]);
console.log(i >= 0 && v[i] > cur[i] ? "latest" : "latest-" + v[0] + "." + v[1]);
' "$version" "$current"
