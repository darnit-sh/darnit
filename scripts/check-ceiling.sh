#!/bin/sh
# A record ceiling goes up only with a reason. packs/<vendor>/record-ceiling.txt caps the items still needing a record
# that a final release may go out with (npm run accounting -- --final). Whatever the type, a change that raises one
# fails unless the pull request body has a `Ceiling: <reason>` line, shown in the job summary. Each ceiling is read
# from the trees of base and head, never from the diff: packs and each vendor in it must be folders (a plain file in
# packs is no vendor) and each ceiling a regular file, or the change fails whatever its body says, so a link cannot
# show this check one number and --final another. A new file rises from zero; one not holding a whole number counts
# as raised.
#   TITLE=... BODY=... check-ceiling.sh <base sha> <head sha>
set -eu
. "$(dirname "$0")/pr-common.sh"
base=$1 head=$2

found=$(node -e '
  const { execFileSync } = require("node:child_process");
  const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 2 ** 26 });
  // Each entry of a tree as its mode, id and name.
  const tree = (spec) => git("ls-tree", "-z", spec).split("\0").filter(Boolean).map((l) => {
    const [meta, name] = [l.slice(0, l.indexOf("\t")), l.slice(l.indexOf("\t") + 1)];
    const [mode, , id] = meta.split(" ");
    return { mode, id, name };
  });
  const ceilings = (rev, side) => {
    const out = new Map();
    for (const p of tree(rev).filter((e) => /^packs$/i.test(e.name))) {
      if (p.mode !== "040000") { console.log(`refuse ${p.name} in ${side} is not a folder`); continue; }
      for (const v of tree(`${rev}:${p.name}`)) {
        const at = `${p.name}/${v.name}`;
        if (v.mode === "100644" || v.mode === "100755") continue;
        if (v.mode !== "040000") { console.log(`refuse ${at} in ${side} is not a folder`); continue; }
        for (const c of tree(`${rev}:${at}`).filter((e) => /^record-ceiling/i.test(e.name))) {
          if (c.mode === "100644") out.set(`${at}/${c.name}`, git("cat-file", "blob", c.id));
          else console.log(`refuse ${at}/${c.name} in ${side} is not a regular file`);
        }
      }
    }
    return out;
  };
  const count = (t) => (t !== undefined && /^(0|[1-9][0-9]*)\r?\n?$/.test(t) ? BigInt(t.trim()) : undefined);
  const was = ceilings(process.argv[1], "base");
  for (const [f, now] of ceilings(process.argv[2], "head")) {
    const from = count(was.get(f)) ?? 0n;
    const n = count(now);
    if (n === undefined || n > from) console.log(`rise ${f}: ${from} to ${n ?? "something other than a whole number"}`);
  }' "$base" "$head") || found="refuse the ceilings could not be read"
refused=$(printf '%s\n' "$found" | sed -n 's/^refuse //p')
risen=$(printf '%s\n' "$found" | sed -n 's/^rise //p')
if [ -n "$refused" ]; then
  say "**Failed:** packs and each vendor folder in it are folders and each record ceiling a regular file, so the check and \`npm run accounting -- --final\` read the same number. Not so for:"
  list "$refused"
  exit 1
fi
[ -z "$risen" ] && exit 0

body_reason "Ceiling: " Ceiling
if [ -z "$reason" ]; then
  say "**Failed:** a record ceiling goes up only with a \`Ceiling: <reason>\` line in the pull request body, as a final release may then go out with more items that need a record. Raised:"
  list "$risen"
  exit 1
fi
echo "::warning::raises a record ceiling, allowed by a 'Ceiling:' line in the pull request body; the reason is in the job summary"
say "**Ceiling raised** under the Ceiling line in the pull request body. Reason given: \`$reason\`"
list "$risen"
