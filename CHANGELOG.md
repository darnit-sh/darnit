# Changelog

Notable changes to darnit. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/). Before 1.0, a patch release (0.1.x) only adds to CLI flags, exit codes, report formats and JSON fields; anything else waits for a minor release (0.x.0).

## [Unreleased]

### Added

- `check` notes calls made with OpenAI's SDK pointed at a local address (localhost, 127.x, private 10.x, 172.16 to 172.31 and 192.168.x, `*.local`, `host.docker.internal`), and `--json` gets `localAddress`. The exit code is unchanged. `fix` lists these as `needs a human` instead of rewriting them, since a local server may not accept the new parameter. ([#39](https://github.com/darnit-sh/darnit/pull/39))
- The pull request footer links the change record on darnit.sh. ([#40](https://github.com/darnit-sh/darnit/pull/40))

### Changed

- The repository's build and test commands run without `GITHUB_TOKEN` and `GH_TOKEN`, and those values are replaced with `***` in any output darnit keeps. A test suite that needs either variable no longer gets it from darnit. ([#41](https://github.com/darnit-sh/darnit/pull/41))
- darnit's git commands no longer run git hooks, including your own (husky, commitlint, pre-push) and a global `core.hooksPath`, since git cannot tell them from hooks a repository's tests planted. The push now uses git's own credentials, the same as your own `git push`; darnit's token only opens the pull request. A credential helper that reads the token from the environment, such as `gh auth setup-git` with only `GH_TOKEN` set, no longer works for the push. ([#43](https://github.com/darnit-sh/darnit/pull/43))

### Fixed

- The shorthand `create({ model, messages, max_tokens })` is found and rewritten. ([#35](https://github.com/darnit-sh/darnit/pull/35))
- A retiring model written as the fallback value is found: `?? "name"` and `|| "name"` in JavaScript and TypeScript, `or "name"` in Python. ([#36](https://github.com/darnit-sh/darnit/pull/36))
- `fix` renames `max_tokens` only in a call's first argument, not in the request settings passed second. `check` still reports one written there, and `fix` leaves it to a human. ([#37](https://github.com/darnit-sh/darnit/pull/37))
- npm no longer warns about the `darnit` command's path on install. ([#38](https://github.com/darnit-sh/darnit/pull/38))
- `fix` no longer reads ast-grep settings from the repository, which could make it load a library the repository named, even with `--dry-run --no-test`. (#42)
- File names, commands, test output and notes from the repository are shown literally in the pull request body and the terminal, so they cannot add live Markdown, mentions or links to the body, or send control sequences to the terminal. Only the last 16 KiB of test output is kept. ([#44](https://github.com/darnit-sh/darnit/pull/44))

## [0.1.0] - 2026-10-07

First release.

- `darnit init` finds the APIs a repository uses and writes `darnit.yml` and a daily GitHub Actions workflow.
- `darnit check` lists every call site affected by a known change, with the vendor's own source. `--json` for machine-readable output.
- `darnit fix` rewrites the calls a tested rule covers, checks the result against your SDK version, build and tests, and with `--pr` opens one pull request per change.
- OpenAI supported, with 33 change records, including `max_tokens` to `max_completion_tokens` on chat completions (rewritten), `functions` to `tools` (reported), and retiring models from OpenAI's deprecations page (reported). Anthropic, Stripe and Twilio are recognized by `init`.
- Reads JavaScript, TypeScript and Python.

[Unreleased]: https://github.com/darnit-sh/darnit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/darnit-sh/darnit/tree/v0.1.0
