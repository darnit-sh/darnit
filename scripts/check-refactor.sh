#!/bin/sh
# One rule per pull request type, so a new title cannot dodge a guard. A refactor or perf change keeps
# every existing test, a test, docs or tooling change leaves the code and what the suite proves alone,
# only a ci change alters how the checks run, a style change is exactly the formatter's output, and a
# revert is exactly the inverse of one commit. Results
# go to the job summary on the pull request page.
#   TITLE=... BODY=... check-refactor.sh <base sha> <head sha>
#   check-refactor.sh --base-tests <base sha>   runs base's tests and fixtures against the checked out code
#   check-refactor.sh --style <base sha> <head sha>   formats base's copy of each changed file with the
#     prettier in node_modules, which must be the version base pins, and base's config
# The second form overwrites test/ and the fixtures in the working tree.
set -eu
. "$(dirname "$0")/pr-common.sh"
if queued; then exit 0; fi

# Fails a style change that touches anything but edits to existing .ts, .js, .mjs, .cjs, .mts, .cts, .tsx and
# .jsx files that keep their mode. An added or removed file shows mode 000000 on one side. Workflow actions and
# formatter config written in code are among what only a ci change may touch (gates below).
style_scope() {
  outside=$(git diff --raw --no-renames "$base...$head" | awk -F '\t' '{ split($1, m, " ") }
    m[1] != ":" m[2] || m[2] !~ /^100(644|755)$/ || $2 !~ /\.(ts|js|mjs|cjs|mts|cts|tsx|jsx)$/ { print $2 }')
  [ -z "$outside" ] && return
  say "**(a) failed:** a style change only edits existing code files the formatter covers. Touched:"
  list "$outside"
  exit 1
}

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

if [ "${1:-}" = --style ]; then
  base=$2 head=$3
  style_scope
  tree=$(mktemp -d)
  trap 'rm -rf "$tree"' EXIT
  git archive "$base" | tar -x -C "$tree"
  # Options come only from base's root .prettierrc.json, read as JSON: no config file runs, and no plugin,
  # override or parser can change what the code does. Templates are left as they are whatever it says.
  differ=$(paths | node -e '(async () => {
    const { execFileSync } = require("node:child_process");
    const { existsSync, readFileSync } = require("node:fs");
    const { join, posix } = require("node:path");
    const [tree, base, mb, head] = process.argv.slice(1);
    const blob = (rev, f) => execFileSync("git", ["cat-file", "blob", `${rev}:${f}`], { maxBuffer: 2 ** 28 });
    const prettier = require(join(process.cwd(), "node_modules/prettier"));
    let pinned;
    try { pinned = JSON.parse(blob(base, "package.json")).devDependencies?.prettier; } catch {}
    if (pinned !== prettier.version) return console.log(`prettier ${pinned ?? "(none)"} pinned in base\x27s package.json, ${prettier.version} installed`);
    const files = readFileSync(0, "utf8").split("\n").filter(Boolean);
    // Each config prettier or .editorconfig would read for a changed file: any in its folder or above it.
    const listed = execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", base], { encoding: "utf8", maxBuffer: 2 ** 28 }).split("\0");
    const named = (p) => /^(\.prettierrc.*|prettier\.config\..*|\.editorconfig|package\.yaml)$/i.test(posix.basename(p)) ||
      (/^package\.json$/i.test(posix.basename(p)) && (() => { try { return Object.hasOwn(JSON.parse(readFileSync(join(tree, p), "utf8")), "prettier"); } catch { return true; } })());
    const dirs = new Set(files.flatMap((f) => f.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/")).concat("")));
    const others = listed.filter((p) => p && p !== ".prettierrc.json" && dirs.has(posix.dirname(p) === "." ? "" : posix.dirname(p)) && named(p));
    if (others.length) return others.forEach((p) => console.log(`${p} in base: only base\x27s root .prettierrc.json may set options`));
    const rc = join(tree, ".prettierrc.json");
    if (!existsSync(rc)) return console.log(".prettierrc.json in base is missing");
    let config;
    try { config = JSON.parse(readFileSync(rc, "utf8")); } catch {}
    if (config === null || typeof config !== "object" || Array.isArray(config)) return console.log(".prettierrc.json in base is not a JSON object");
    const layout = ["printWidth", "tabWidth", "useTabs", "semi", "singleQuote", "quoteProps", "trailingComma", "bracketSpacing", "arrowParens", "endOfLine", "embeddedLanguageFormatting"];
    for (const [k, v] of Object.entries(config)) {
      const at = `.prettierrc.json in base sets ${JSON.stringify(k)}`;
      if (!layout.includes(k)) return console.log(`${at}, not a plain layout option`);
      if (!["string", "number", "boolean"].includes(typeof v)) return console.log(`${at} to ${JSON.stringify(v)}, not a plain value`);
      if (k === "embeddedLanguageFormatting" && v !== "off") return console.log(`${at} to ${JSON.stringify(v)}, where only "off" keeps templates as they are`);
    }
    // Only the root .prettierignore, as the format scripts read it: .gitignore decides nothing here.
    const ignorePath = join(tree, ".prettierignore");
    for (const f of files) {
      const file = join(tree, f);
      const info = await prettier.getFileInfo(file, { ignorePath, resolveConfig: false });
      if (info.ignored || !info.inferredParser) { console.log(`${f} (left out by base\x27s .prettierignore)`); continue; }
      try {
        const out = await prettier.format(blob(mb, f).toString("utf8"), { ...config, embeddedLanguageFormatting: "off", filepath: file });
        if (!Buffer.from(out, "utf8").equals(blob(head, f))) console.log(`${f} (differs from the formatter\x27s output)`);
      } catch (e) { console.log(`${f} (could not be formatted: ${String(e?.message).split("\n")[0]})`); }
    }
  })().catch((e) => console.log(`the formatter (could not run: ${String(e?.message).split("\n")[0]})`))' "$tree" "$base" "$(git merge-base "$base" "$head")" "$head") ||
    differ="the formatter (could not run; log above)"
  if [ -n "$differ" ]; then
    say "**(b) failed:** a style change is exactly what base's pinned prettier writes over base's copy of each file with the layout options in base's root .prettierrc.json. Not so for:"
    list "$differ"
    exit 1
  fi
  say "**(b) passed:** every changed file is what prettier $(node -p 'require(process.cwd() + "/node_modules/prettier").version') writes over base's copy with base's layout options."
  exit 0
fi

base=$1 head=$2
type=$(title_type)

mb=$(git merge-base "$base" "$head")
# Every type: nothing that decides coverage goes down (scripts/check-coverage.sh). Its failure ends the run after
# the list of what decides how the checks run and the allowlist check, so each says what it found.
coverage=0
sh "$(dirname "$0")/check-coverage.sh" "$mb" "$head" || coverage=1
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
# Each dependency spec in package.json that npm would fetch from somewhere other than the registry, and each
# lock entry that is not what the registry published, among those this change adds or alters, so that npm test
# could run code of the change's own in place of a package the suite runs. A file this change leaves
# unreadable counts, as does a reader that fails or a registry this check cannot ask.
sources() {
  git diff --quiet "$base...$head" -- package.json package-lock.json npm-shrinkwrap.json && return 0
  node -e '(async () => {
    const { execFileSync } = require("node:child_process");
    const { posix } = require("node:path");
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
    // npm reads an override key as name@spec, split at its first @ after the start, and the spec counts too.
    const specs = (j) => {
      const out = new Map();
      const leaf = (v, at) => {
        const key = at.length > 1 && at[0] === "overrides" ? at.at(-1) : "";
        if (key.indexOf("@", 1) > 0) out.set(`${JSON.stringify(at)}@`, [at, key.slice(key.indexOf("@", 1) + 1)]);
        if (isObj(v)) walk(v, at, out, leaf);
        else out.set(JSON.stringify(at), [at, v]);
      };
      for (const f of fields.split(" ")) if (Object.hasOwn(j, f)) leaf(j[f], [f]);
      return out;
    };
    // npm reads a lock old style, from "dependencies", only when it has no "packages".
    const entries = (j) =>
      isObj(j.packages) || !Object.hasOwn(j, "dependencies")
        ? walk(j.packages, [], new Map(), (v, at, out) => at[0] && out.set(at[0], [at, v]))
        : new Map([["", [["dependencies"], j.dependencies]]]);
    const show = (at, sep) => at.map((k) => JSON.stringify(k).slice(1, -1)).join(sep);
    const changed = (f, list, judge) => {
      const b = read(head, f);
      if (b === undefined) return console.log(`${f} (unreadable)`);
      if (b === null) return;
      const a = list(read(mb, f) ?? {});
      const say = (at, why) => console.log(`${f} ${show(at, f === "package.json" ? "." : " > ")} ${why}`);
      for (const [k, [at, v]] of list(b)) if (JSON.stringify(a.get(k)?.[1]) !== JSON.stringify(v)) judge((why) => say(at, why), at, v, a, a.get(k)?.[1], b);
    };
    // A version, range or tag, or an npm: alias to one: only the characters those use, no leading dot, and no
    // tarball ending as npm 10 reads one, with any character for its inner dot. An alias may only keep the
    // package base already names under that name. A $name override is judged as the root spec it names,
    // looked up as npm does.
    const target = (s) => (typeof s === "string" ? /^npm:((?:@[^/@]+\/)?[^/@]+)(?:@|$)/.exec(s.trim())?.[1] : undefined);
    const registry = (s) => {
      if (typeof s !== "string") return false;
      const spec = s.trim().replace(/^npm:(@[^/@]+\/)?[^/@]+(@|$)/, "");
      return /^[\w.*^~<>=|+ -]*$/.test(spec) && !spec.startsWith(".") && !/[.](?:tgz|tar.gz|tar)$/i.test(spec);
    };
    const root = (j, ref) => ["devDependencies", "optionalDependencies", "dependencies", "peerDependencies"].map((f) => Object.hasOwn(obj(j[f]), ref) && j[f][ref]).find(Boolean);
    const named = (at) => String(at.at(-1) === "." ? at.at(-2) : at.at(-1)).replace(/(.)@.*$/, "$1");
    changed("package.json", specs, (say, at, v, a, was, b) => {
      const spec = at[0] === "overrides" && typeof v === "string" && v.startsWith("$") ? root(b, v.slice(1)) : v;
      if (!registry(spec)) return say(JSON.stringify(v) ?? "(none)");
      const t = target(spec);
      if (t === undefined || t === named(at) || [...a.values()].some(([was, w]) => named(was) === named(at) && target(w) === t)) return;
      say(`${JSON.stringify(v)} (an alias to ${show([t])})`);
    });
    // Each entry sits at a node_modules path npm installs to and holds a plain version, then matches what the
    // registry published for that name and version: every field npm writes from the manifest, and no other.
    const name = "(@[^/\\\\]+/)?[^/\\\\]+";
    const place = new RegExp(`^node_modules/${name}(/node_modules/${name})*$`);
    const semver = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
    const asked = [];
    for (const f of ["package-lock.json", "npm-shrinkwrap.json"])
      changed(f, entries, (say, [loc], e, a, was) => {
        if (loc === "dependencies") return say("in the old format, without \"packages\"");
        if (!place.test(loc)) return say("location outside node_modules");
        const { version, name: alias } = obj(e);
        const here = loc.slice(loc.lastIndexOf("node_modules/") + 13);
        if (alias !== undefined && alias !== here && alias !== obj(was).name) return say(`name ${JSON.stringify(alias)}`);
        if (typeof version !== "string" || !semver.test(version)) return say(`version ${JSON.stringify(version) ?? "(none)"}`);
        asked.push([say, obj(e), typeof alias === "string" ? alias : here, version]);
      });
    // Only the tests point this at a registry of their own, and only on this machine.
    const test = process.env.DARNIT_TEST_REGISTRY;
    const origin = !test ? "https://registry.npmjs.org" : /^http:\/\/127\.0\.0\.1:\d+$/.test(test) ? test : undefined;
    const manifest = async (pkg, version) => {
      if (!origin) throw new Error("DARNIT_TEST_REGISTRY is not http://127.0.0.1:<port>");
      const at = `${origin}/${pkg[0] === "@" ? "@" + encodeURIComponent(pkg.slice(1)) : encodeURIComponent(pkg)}/${version}`;
      const r = await fetch(at, { redirect: "error", signal: AbortSignal.timeout(30_000) }).catch((e) => {
        throw new Error(`the registry could not be reached (${e.cause?.code ?? e.cause?.message ?? e.name})`);
      });
      if (r.status !== 200 || !/^application\/json\b/.test(r.headers.get("content-type") ?? "")) throw new Error(`the registry answered ${r.status} ${r.headers.get("content-type") ?? ""}`.trim());
      const parts = [];
      let size = 0;
      for await (const part of r.body) if ((size += part.length) > 2 ** 23) throw new Error("the registry answer is over 8 MiB");
      else parts.push(part);
      const m = JSON.parse(Buffer.concat(parts).toString("utf8"));
      if (!isObj(m) || m.name !== pkg || m.version !== version) throw new Error(`the registry answered for another package than ${show([`${pkg}@${version}`])}`);
      return m;
    };
    // The entry npm writes from a manifest: pacote normalizes it, then arborist keeps each field that is set.
    const secure = (r) => { const s = posix.join(".", posix.join("/", r.replace(/\\|:/g, "/"))).replace(/\\|:/g, "/"); return s.startsWith("./") ? "" : s; };
    const expected = (m) => {
      m = structuredClone(m);
      const bd = m.bundleDependencies ?? m.bundledDependencies;
      m.bundleDependencies = bd === true ? Object.keys(obj(m.dependencies)) : isObj(bd) ? Object.keys(bd) : Array.isArray(bd) ? bd : undefined;
      if (m.dependencies && isObj(m.optionalDependencies)) for (const n of Object.keys(m.optionalDependencies)) delete m.dependencies[n];
      let bin = typeof m.bin === "string" ? { [m.name]: m.bin } : Array.isArray(m.bin) ? Object.fromEntries(m.bin.map((k) => [posix.basename(k), k])) : m.bin;
      if (isObj(bin)) bin = Object.fromEntries(Object.entries(bin).map(([k, v]) => [posix.basename(secure(k)), typeof v === "string" && secure(v)]).filter(([k, v]) => k && v));
      const s = obj(m.scripts), dist = obj(m.dist);
      const meta = {
        resolved: dist.tarball, version: m.version, dependencies: m.dependencies, peerDependencies: m.peerDependencies, peerDependenciesMeta: m.peerDependenciesMeta,
        optionalDependencies: m.optionalDependencies, bundleDependencies: m.bundleDependencies, acceptDependencies: m.acceptDependencies,
        funding: typeof m.funding === "string" ? { url: m.funding } : m.funding, engines: m.engines, os: m.os, cpu: m.cpu, libc: m.libc,
        integrity: dist.integrity || (dist.shasum && `sha1-${Buffer.from(dist.shasum, "hex").toString("base64")}`),
        license: isObj(m.license) && m.license.type ? m.license.type : m.license, hasShrinkwrap: m._hasShrinkwrap,
        hasInstallScript: !!(m.hasInstallScript || ["install", "preinstall", "postinstall"].some((k) => typeof s[k] === "string" && s[k])), bin, deprecated: m.deprecated, workspaces: m.workspaces,
      };
      return Object.fromEntries(Object.entries(meta).filter(([, v]) => v && (typeof v !== "object" || Object.keys(v).length)));
    };
    const sorted = (v) => (isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : Array.isArray(v) ? v.map(sorted) : v);
    const flags = new Set(["dev", "optional", "devOptional", "peer"]);
    if (asked.length > 500) console.log(`${asked.length} lock entries to compare with the registry, over the 500 this check asks for; a person reviews this change`);
    else
      for (let i = 0; i < asked.length; i += 16)
        await Promise.all(asked.slice(i, i + 16).map(async ([say, e, pkg, version]) => {
          const m = await manifest(pkg, version).catch((err) => say(`not compared: ${err.message}`));
          if (!m) return;
          const want = expected(m);
          for (const k of new Set([...Object.keys(want), ...Object.keys(e)]))
            if (k !== "name" && (flags.has(k) ? e[k] !== true : JSON.stringify(sorted(e[k])) !== JSON.stringify(sorted(want[k]))))
              say(`${show([k])} ${JSON.stringify(e[k]) ?? "(none)"}, published ${JSON.stringify(want[k]) ?? "(none)"}`);
        }));
  })()' "$mb" "$head" "$deps" || echo "dependency sources (unreadable)"
}
fetched=$(sources)
if [ -n "$fetched" ]; then
  say "**Failed:** npm installs every dependency as https://registry.npmjs.org/ published it, so that the suite runs the packages it names; this change adds or alters one it would install otherwise, or that this check could not compare:"
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
  grep -iE '^"?(scripts/(fixtures|e2e|e2e-env|golden|installed)\.ts|test/.*\.[cm]?[jt]s)"?$' |
    grep -viE '\.test\.[cm]?[jt]s"?$|^"?test/(e2e|fixtures|samples|golden)/' || true
}
# Those this change edits or removes, or shadows with an added file of the same path minus its extension
# (test/helpers.js beside test/helpers.ts).
suite_files() {
  paths --diff-filter=DMT | guarded
  { git ls-tree -r --name-only "$mb" | guarded | sed 's/^/G /'; paths --diff-filter=A | sed 's/^/A /'; } |
    awk '{ p = substr($0, 3); s = p; sub(/^"/, "", s); sub(/\.[^.\/]*"?$/, "", s); s = tolower(s) } $1 == "G" { g[s] = 1; next } s in g { print p }'
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
# How the checks run, each with why it counts: a change to any of these can switch a check off without
# touching the code, so only a ci change with a reason may make one. Test data keeps its own config.
# tsx reads tsconfig paths, which can send an import to another file. A runner may gain a new script beside it.
# The setup files are those vitest.config.ts names in setupFiles and globalSetup; a test keeps the two in step.
gates() {
  all=$(paths | grep -viE '^"?test/(e2e|fixtures|samples|golden)/' || true)
  edited=$(paths --diff-filter=DMT)
  gate() { printf '%s\n' "${3-$all}" | grep -iE "$1" | awk -v why="$2" '{ print $0 " (" why ")" }'; }
  gate '^"?\.github/' "the workflows and settings that run and review every pull request"
  gate '^"?\.(npmrc|yarnrc[^/]*)"?$' "npm and yarn config, which decides what every npm command runs"
  gate '^"?test/no-credentials\.ts"?$' "what vitest runs in every worker before the tests"
  gate '^"?scripts/(accounting|accounting-final|golden|installed|e2e-env|fixtures|allowlist|unseen|show)\.ts"?$' "a runner behind a required check" "$edited"
  gate '^"?scripts/(check-[^/]+|pr-common\.[^/]*)"?$' "the pull request checks"
  # A list there that only loses lines is left out, so the change that removes dead code can drop its line too.
  shrunk=$(git diff --no-renames --text --numstat --diff-filter=M "$base...$head" -- ':(icase,glob)scripts/allow/*.tsv' | awk '$1 == 0 { print $3 }')
  gate '^"?scripts/allow/' "the lists the pull request checks accept" "$(printf '%s\n' "$all" | grep -vixF -- "${shrunk:-//}" || true)"
  gate '^"?('"$VITEST_CONFIG"'|coverage-thresholds\.json)"?$' "which tests run and how much they must cover"
  gate '(^|/)(tsconfig[^/]*\.json|eslint\.config\.[^/]*)"?$' "what the typecheck and lint steps check"
  gate '^"?(\.?knip(\.config)?\.[^/]*|\.jscpd\.json)"?$' "what the unused code and duplicate checks report"
  gate '(^|/)(\.prettierrc[^/]*|prettier\.config\.[^/]*|\.prettierignore|\.editorconfig|package\.yaml)"?$' "what the format check accepts"
  package_json scripts | awk '{ print $0 " (what npm run runs)" }'
  package_json "prettier knip jscpd" | awk '{ print $0 " (the config a check reads from package.json)" }'
  # prettier also reads a "prettier" key from a package.json below the root, for the files beside and below it.
  printf '%s\n' "$all" | grep -iE '/package\.json"?$' | { node -e '
    const git = (rev, f) => require("node:child_process").execFileSync("git", ["show", `${rev}:${f}`], { encoding: "utf8", stdio: "pipe" });
    const key = (rev, f) => { try { return JSON.stringify(JSON.parse(git(rev, f))?.prettier); } catch { return undefined; } };
    for (const f of require("node:fs").readFileSync(0, "utf8").split("\n").filter(Boolean)) if (key(process.argv[1], f) !== key(process.argv[2], f)) console.log(`${f} "prettier"`);
  ' "$mb" "$head" || echo 'package.json "prettier" (unreadable)'; } | awk '{ print $0 " (what the format check accepts)" }'
}

# What decides which files ship: package.json "files", and ignore files below the root, which drop files
# inside "files" (a root one does not). Test scenarios do not ship.
ships() {
  package_json files
  paths | grep -iE '(^|/)\.npmignore"?$' || true
  paths | grep -iE '/\.gitignore"?$' | grep -viE '^"?test/' || true
}

gated=$(gates)
if [ "$type" != ci ] && [ -n "$gated" ]; then
  say "**Failed:** how the checks run changes only in a ci change with a \`Proof: none, <reason>\` line, so that no other change can switch a check off. Touched:"
  list "$gated"
  exit 1
fi

# What lets a finding of the unused or duplicate code checks pass besides the paths gates() lists: a line added to a
# list under scripts/allow/ (one edited in place counts as added), or an added line anywhere with a tag knip skips an
# export for (@public, @beta, @alias) or a jscpd:ignore marker. These are lines, not paths, so they are not entries in
# gates(): a marker lands in code, and growing a list takes its own reason beside the ci one. Names match in any case.
grown=$(
  git diff --no-renames --no-color --text --no-textconv --no-ext-diff -U0 "$base...$head" |
    awk '/^\+\+\+ / { f = substr($0, 5); sub(/^"?b\//, "", f); next }
      /^\+/ && (tolower(f) ~ /^scripts\/allow\/.*\.tsv"?$/ || /@(public|beta|alias)([^A-Za-z0-9_]|$)/ || tolower($0) ~ /jscpd:ignore-(start|end)/) { print f ": " substr($0, 2) }'
)
if [ -n "$grown" ]; then
  reason=
  if [ "$type" = ci ]; then body_reason "Allowlist: " Allowlist; fi
  if [ -z "$reason" ]; then
    say "**Failed:** only a \`ci\` change with an \`Allowlist: <reason>\` line in the pull request body may add to an allowlist under scripts/allow/ or add a knip tag or jscpd:ignore marker. Added or changed:"
    list "$grown"
    exit 1
  fi
  echo "::warning::adds to an allowlist or a way past the unused and duplicate code checks, allowed by an 'Allowlist:' line in the pull request body; the reason is in the job summary"
  say "**Allowlist grown** under the Allowlist line in the pull request body. Reason given: \`$reason\`"
  list "$grown"
fi
# Every type: a record ceiling goes up only with a reason (scripts/check-ceiling.sh).
sh "$(dirname "$0")/check-ceiling.sh" "$mb" "$head"
[ "$coverage" = 0 ] || exit 1

case $type in
refactor | perf)
  say "**Rule for \`$type\`:** (a) no existing test, fixture, golden file or test script changes, and no record (change.json) at all; (b) base's tests and fixtures pass against this code."
  # CI runs this change's copy of the test scripts, and records are data the tests do not check.
  edited=$(
    paths --diff-filter=DMT | grep -iE '^"?(test/|packs/[^/]+/[^/]+/fixtures/|scripts/(e2e|e2e-env|golden|installed)\.ts"?$)' || true
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
  suite="the fixture, end-to-end and golden runners, shared test modules"
  [ "$type" = ci ] && suite="$suite, the workflows, check config, pull request checks, package.json scripts"
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
  changed=$(printf '%s\n' "$(suite_files)" "$gated" "$config" | grep . || true)
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
style)
  say "**Rule for \`style\`:** (a) only edits to existing .ts, .js, .mjs, .cjs, .mts, .cts, .tsx and .jsx files that base's .prettierignore keeps: no added, removed or renamed file, and no package.json, lock, formatter config, workflow or other file; (b) each is exactly what base's pinned prettier writes over base's copy with the layout options in base's root .prettierrc.json, tagged templates left as they are."
  style_scope
  say "**(a) passed:** every changed path is an existing code file; base's .prettierignore and (b) are checked next."
  echo "style=true" >>"${GITHUB_OUTPUT:-/dev/null}"
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
