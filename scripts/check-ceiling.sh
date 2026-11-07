#!/bin/sh
# A record ceiling goes up only with a reason. packs/<vendor>/record-ceiling.txt caps the items still needing a record
# that a final release may go out with (npm run accounting -- --final). Whatever the type, a change that raises one
# fails unless the pull request body has a `Ceiling: <reason>` line, shown in the job summary. Base's number is judged
# against head's: a new file rises from zero, and one that does not hold a whole number counts as raised.
#   TITLE=... BODY=... check-ceiling.sh <base sha> <head sha>
set -eu
. "$(dirname "$0")/pr-common.sh"
base=$1 head=$2

risen=$(paths -z | node -e '
  const { execFileSync } = require("node:child_process");
  const [base, head] = process.argv.slice(1);
  const read = (rev, f) => { try { return execFileSync("git", ["show", `${rev}:${f}`], { encoding: "utf8", stdio: "pipe" }); } catch { return undefined; } };
  const count = (t) => (t !== undefined && /^(0|[1-9][0-9]*)\r?\n?$/.test(t) ? BigInt(t.trim()) : undefined);
  for (const f of require("node:fs").readFileSync(0, "utf8").split("\0").filter((f) => /^packs\/[^/]+\/record-ceiling[^/]*$/i.test(f))) {
    const now = read(head, f);
    if (now === undefined) continue;
    const was = count(read(base, f)) ?? 0n;
    const n = count(now);
    if (n === undefined || n > was) console.log(`${f}: ${was} to ${n ?? "something other than a whole number"}`);
  }' "$base" "$head") || risen="record ceilings (unreadable)"
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
