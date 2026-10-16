# Shared by check-refactor.sh and check-proof.sh, which source it from their own folder.
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
say() { printf '%s\n' "$1"; printf '%s\n\n' "$1" >>"$summary"; }
list() { printf '%s\n' "$1" | sed 's/^/- /' | tee -a "$summary"; echo >>"$summary"; }
title_type() { printf '%s\n' "${TITLE:-}" | sed -nE '1s/^([a-z]+)(\([a-z0-9-]+\))?!?: .*/\1/p'; }
# Code and rule packs: what a fix or feat needs a proof for and what a test, docs or tooling change leaves alone.
CODE='^"?(src/|packs/[^/]+/[^/]+/rules/)|(^|/)change\.json"?$'
# No rename detection: a renamed file shows as its old path deleted and its new path added.
paths() { git diff --no-renames --name-only "$@" "$base...$head"; }
# The body as a reader sees it: HTML comments and fenced code blocks taken out.
visible() {
  printf '%s\n' "${BODY:-}" | tr -d '\r' | awk '
    !c && fence == "" && match($0, /^ ? ? ?(```+|~~~+)/) { fence = substr($0, RSTART, RLENGTH); sub(/^ +/, "", fence); next }
    fence != "" { t = $0; sub(/^ +/, "", t); if (index(t, fence) == 1 && t ~ /^(`+|~+)[ \t]*$/) fence = ""; next }
    {
      s = $0; out = ""
      while (s != "") {
        if (c) { i = index(s, "-->"); if (i) { s = substr(s, i + 3); c = 0 } else s = "" }
        else { i = index(s, "<!--"); if (i) { out = out substr(s, 1, i - 1); s = substr(s, i + 4); c = 1 } else { out = out s; s = "" } }
      }
      print out
    }'
}
# Sets $reason to the reason on a "Proof: none, <reason>" line a reader sees, backticks made quotes so
# it shows as code, or to nothing when there is no such line or the reason is under 10 characters.
opt_out() {
  reason=$(visible | sed -n 's/^Proof: none, //p' | head -1 | sed 's/[[:space:]]*$//')
  # Characters, not bytes, whatever the locale: UTF-8 continuation bytes are not counted.
  if [ $(($(printf '%s' "$reason" | LC_ALL=C tr -d '\200-\277' | wc -c))) -lt 10 ]; then
    [ -n "$reason" ] && say "The opt-out line was ignored: its reason needs at least 10 characters."
    reason=
  fi
  reason=$(printf '%s' "$reason" | tr '`' "'")
}
