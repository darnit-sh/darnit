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

mb=$(git merge-base "$base" "$head")
# npm and yarn config anywhere, which can send every npm run and npx in CI through a script of its own.
# Names match in any case, as they do on a macOS runner's disk.
config=$(paths | grep -iE '(^|/)\.(npmrc|yarnrc[^/]*)"?$' || true)
case $type in
test | docs | chore | ci | build) ;;
*)
  if [ -n "$config" ]; then
    say "**Failed:** npm or yarn config decides what every npm command in CI runs; only a test or ci change with a \`Proof: none, <reason>\` line may touch it. Touched:"
    list "$config"
    exit 1
  fi
  ;;
esac

deps="dependencies devDependencies optionalDependencies peerDependencies overrides"
# Each dependency spec in package.json and each lock entry this change adds or alters that npm would fetch
# from somewhere other than the registry, so that npm test could run code of the change's own in place of a
# package the suite runs. A file this change leaves unreadable counts, as does a reader that fails.
sources() {
  git diff --quiet "$base...$head" -- package.json package-lock.json npm-shrinkwrap.json && return 0
  node -e '
    const { execFileSync } = require("node:child_process");
    const [mb, head, fields] = process.argv.slice(1);
    // By type, as a key named constructor must not hide the object holding it.
    const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
    const obj = (v) => (isObj(v) ? v : {});
    const read = (rev, f) => {
      if (!execFileSync("git", ["ls-tree", "--name-only", rev, "--", f], { encoding: "utf8" })) return null;
      try { const j = JSON.parse(execFileSync("git", ["show", `${rev}:${f}`], { encoding: "utf8", stdio: "pipe", maxBuffer: 2 ** 28 })); return isObj(j) ? j : undefined; }
      catch { return undefined; }
    };
    // Leaves keyed by their path, so only what this change adds or alters is judged.
    const walk = (v, at, out, next) => { for (const [k, x] of Object.entries(obj(v))) next(x, [...at, k], out); return out; };
    const specs = (j) => { const out = new Map(); const leaf = (v, at) => (isObj(v) ? walk(v, at, out, leaf) : out.set(JSON.stringify(at), [at, v])); for (const f of fields.split(" ")) if (Object.hasOwn(j, f)) leaf(j[f], [f]); return out; };
    const entries = (j) => {
      const out = walk(j.packages, [], new Map(), (v, at, out) => at[0] && out.set(JSON.stringify(["p", ...at]), [at, v, at[0]]));
      const old = (v, at, out) => { out.set(JSON.stringify(at), [at, v]); walk(obj(v).dependencies, at, out, old); };
      return walk(j.dependencies, [], out, old);
    };
    const show = (at, sep) => at.map((k) => JSON.stringify(k).slice(1, -1)).join(sep);
    const changed = (f, list, judge) => {
      const b = read(head, f);
      if (b === undefined) return console.log(`${f} (unreadable)`);
      if (b === null) return;
      const a = list(read(mb, f) ?? {});
      const say = (at, why) => console.log(`${f} ${show(at, f === "package.json" ? "." : " > ")} ${why}`);
      for (const [k, [at, v, loc]] of list(b)) if (JSON.stringify(a.get(k)?.[1]) !== JSON.stringify(v)) judge((why) => say(at, why), at, v, a, a.get(k)?.[1], loc);
    };
    // A version, range or tag, or an npm: alias to one; anything with a path, a protocol or a host is not.
    // An alias may only keep the package base already names under that name.
    const target = (s) => (typeof s === "string" ? /^npm:((?:@[^/@]+\/)?[^/@]+)(?:@|$)/.exec(s.trim())?.[1] : undefined);
    const registry = (s) => typeof s === "string" && !/[:/\\]|^\.|\.(tgz|tar|tar\.gz)$/i.test(s.trim().replace(/^npm:(@[^/@]+\/)?[^/@]+(@|$)/, ""));
    const named = (at) => String(at.at(-1) === "." ? at.at(-2) : at.at(-1)).replace(/(.)@.*$/, "$1");
    changed("package.json", specs, (say, at, v, a) => {
      if (!registry(v)) return say(JSON.stringify(v) ?? "(none)");
      const t = target(v);
      if (t === undefined || t === named(at) || [...a.values()].some(([was, w]) => named(was) === named(at) && target(w) === t)) return;
      say(`${JSON.stringify(v)} (an alias to ${show([t])})`);
    });
    // Each entry is the registry tarball of its own name and version, at a node_modules path npm installs to.
    const name = "(@[^/\\\\]+/)?[^/\\\\]+";
    const place = new RegExp(`^node_modules/${name}(/node_modules/${name})*$`);
    for (const f of ["package-lock.json", "npm-shrinkwrap.json"])
      changed(f, entries, (say, at, e, a, was, loc) => {
        if (loc !== undefined && (!place.test(loc) || loc.split("/").some((s) => s === "." || s === ".."))) return say("location outside node_modules");
        if (Object.hasOwn(obj(e), "link")) return say("link");
        const { resolved, integrity, version, name: alias } = obj(e);
        const here = loc === undefined ? at.at(-1) : loc.slice(loc.lastIndexOf("node_modules/") + 13);
        if (alias !== undefined && alias !== here && alias !== obj(was).name) return say(`name ${JSON.stringify(alias)}`);
        const pkg = typeof alias === "string" ? alias : here;
        if (resolved !== `https://registry.npmjs.org/${pkg}/-/${pkg.split("/").pop()}-${version}.tgz`) return say(`resolved ${JSON.stringify(resolved) ?? "(none)"}`);
        if (typeof integrity !== "string" || !integrity) say("integrity (none)");
      });
  ' "$mb" "$head" "$deps" || echo "dependency sources (unreadable)"
}
fetched=$(sources)
if [ -n "$fetched" ]; then
  say "**Failed:** npm installs every dependency from https://registry.npmjs.org/ with an integrity, so that the suite runs the packages it names; this change adds or alters one it would fetch from elsewhere:"
  list "$fetched"
  exit 1
fi

# Added files whose name differs from one on base only in case: on a macOS runner's disk one replaces the other.
collisions() {
  { git ls-tree -r --name-only "$mb" | sed 's/^/B /'; paths --diff-filter=A | sed 's/^/A /'; } |
    awk '{ p = substr($0, 3); k = tolower(p) } $1 == "B" { b[k] = 1; next } k in b { print p }'
}
# What the suite and the pull request checks run besides the tests: the runners, the checks and the
# modules tests import.
guarded() {
  grep -iE '^"?(scripts/((fixtures|e2e|e2e-env|golden)\.ts|check-[^/]+|pr-common\.sh)|test/.*\.[cm]?[jt]s)"?$' |
    grep -viE '\.test\.[cm]?[jt]s"?$|^"?test/(e2e|fixtures|samples|golden)/' || true
}
# Those this change edits or removes, or shadows with an added file of the same path minus its extension
# (test/helpers.js beside test/helpers.ts), and any test runner, TypeScript or ESLint config or workflow at all.
# tsx reads tsconfig paths, which can send an import to another file.
suite_files() {
  paths --diff-filter=DMT | guarded
  { git ls-tree -r --name-only "$mb" | guarded | sed 's/^/G /'; paths --diff-filter=A | sed 's/^/A /'; } |
    awk '{ p = substr($0, 3); s = p; sub(/^"/, "", s); sub(/\.[^.\/]*"?$/, "", s); s = tolower(s) } $1 == "G" { g[s] = 1; next } s in g { print p }'
  paths | grep -iE '^"?((vitest\.config|vite\.config|vitest\.workspace)\.[^/]*|\.github/(workflows|actions)/.*)"?$' || true
  paths | grep -iE '(^|/)(tsconfig[^/]*\.json|eslint\.config\.[^/]*)"?$' | grep -viE '^"?test/(e2e|fixtures|samples|golden)/' || true
  collisions
}
# package.json's "files", each script this change adds, alters or removes, or each of the fields named. A
# package.json this change leaves unreadable, or not an object, counts as changed, as does a reader that fails.
package_json() {
  git diff --quiet "$base...$head" -- package.json && return 0
  node -e '
    const git = (rev) => require("node:child_process").execFileSync("git", ["show", `${rev}:package.json`], { encoding: "utf8", stdio: "pipe" });
    const read = (rev) => { try { const j = JSON.parse(git(rev)); return j !== null && typeof j === "object" && !Array.isArray(j) ? j : undefined; } catch { return undefined; } };
    const [a, b] = [read(process.argv[1]), read(process.argv[2])];
    const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
    if (b === undefined) console.log("package.json (removed or unreadable)");
    else if (process.argv[3] === "files") { if (!same(a?.files, b.files)) console.log("package.json \"files\""); }
    else if (process.argv[3] !== "scripts") { for (const f of process.argv[3].split(" ")) if (!same(a?.[f], b[f])) console.log(`package.json "${f}"`); }
    else {
      const [x, y] = [a?.scripts ?? {}, b.scripts ?? {}];
      const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => !same(x[k], y[k]));
      for (const k of keys) console.log(`package.json script "${k}"`);
      if (!keys.length && !same(a?.scripts, b.scripts)) console.log("package.json \"scripts\"");
    }
  ' "$mb" "$head" "$1" || echo "package.json (unreadable)"
}
# What decides which files ship: package.json "files", and ignore files below the root, which drop files
# inside "files" (a root one does not). Test scenarios do not ship.
ships() {
  package_json files
  paths | grep -iE '(^|/)\.npmignore"?$' || true
  paths | grep -iE '/\.gitignore"?$' | grep -viE '^"?test/' || true
}

case $type in
refactor | perf)
  say "**Rule for \`$type\`:** (a) no existing test, fixture, golden file or test script changes, and no record (change.json) at all; (b) base's tests and fixtures pass against this code."
  # CI runs this change's copy of the test scripts, and records are data the tests do not check.
  edited=$(
    paths --diff-filter=DMT | grep -iE '^"?(test/|packs/[^/]+/[^/]+/fixtures/|scripts/(e2e|e2e-env|golden)\.ts"?$)' || true
    paths | grep -iE '(^|/)change\.json"?$' || true
    collisions
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
  suite="the test runner config, fixture, end-to-end and golden runners, shared test modules, package.json scripts, TypeScript and ESLint config, pull request checks, workflows"
  case $type in
  chore | build) suite="$suite or npm and yarn config" ;;
  *) suite="$suite, npm and yarn config, package.json dependencies or the lock file" ;;
  esac
  case $type in
  test | ci) allowed="$suite only with a \`Proof: none, <reason>\` line" ;;
  *) allowed="nothing in $suite" ;;
  esac
  [ "$type" = build ] && ships="may change" || ships="stay"
  say "**Rule for \`$type\`:** no change under src/, packs/*/*/rules/ or any change.json; $allowed; package.json \"files\", any .npmignore and any .gitignore below the root outside test/ $ships."
  touched=$(paths | grep -iE "$CODE" || true)
  [ "$type" = build ] || touched=$(printf '%s\n' "$touched" "$(ships)" | grep . || true)
  changed=$(printf '%s\n' "$(suite_files)" "$(package_json scripts)" "$config" | grep . || true)
  # Dependabot bumps registry versions under chore and build, which the source check above still judges.
  case $type in
  test | docs | ci)
    locks=$(paths | grep -ixE '"?(package-lock|npm-shrinkwrap)\.json"?' || true)
    changed=$(printf '%s\n' "$changed" "$(package_json "$deps workspaces")" "$locks" | grep . || true)
    ;;
  esac
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
    say "**Failed:** a $type change leaves alone the code, the rule packs and what the rule above keeps. Code goes under fix, feat, refactor or perf, the suite under test or ci with a reason, and what ships under build. Touched:"
    list "$touched"
    exit 1
  fi
  say "**Passed:** nothing the rule keeps changed."
  ;;
fix | feat) say "**Rule for \`$type\`:** passes here; the proof check covers $type changes." ;;
revert)
  say "**Rule for \`revert\`:** the change is exactly the inverse of the commit on a \`This reverts commit <sha>\` line in the title or body, a single-parent commit already in this change's history."
  shas=$({ printf '%s\n' "${TITLE:-}"; visible; } | grep -oE 'This reverts commit [0-9a-f]+' | sed 's/.* //' | awk '!seen[$0]++')
  if [ "$(printf '%s' "$shas" | grep -c .)" != 1 ]; then
    say "**Failed:** name exactly one commit on a \`This reverts commit <sha>\` line; revert one commit per pull request."
    exit 1
  fi
  sha=$(printf '%s\n' "$shas" | head -1)
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
