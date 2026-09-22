# darnit

> Your API integrations, invisibly mended.

darnit watches the third-party APIs a codebase actually uses, detects breaking and
notable changes at the vendor — including ones with no version bump anywhere in
your lockfile — and opens verified migration pull requests, each with an evidence
report a reviewer can audit.

**Status: pre-release.** `npx darnit init` and `npx darnit check` land in October
2026; verified auto-PRs follow.

## What's in this repo today

- `packs/` — the ChangeRecord corpus and its rule packs: one directory per vendor
  per change, each with a cited `change.json`, ast-grep rewrite rules, and
  before/after fixtures that CI runs on every push. A pack whose rules apply
  zero changes when its fixtures expect some fails CI.
- `src/` — the CLI (`init`, `check`, `fix`) and the ChangeRecord schema.

## License

Apache-2.0
