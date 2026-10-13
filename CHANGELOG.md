# Changelog

Notable changes to darnit. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/). Before 1.0, a patch release (0.1.x) can add CLI flags, exit codes, report formats and JSON fields but never changes or removes them; that waits for a minor release (0.x.0).

## [Unreleased]

### Added

- `check` notes calls made with OpenAI's SDK pointed at a local or private network address (such as localhost, 192.168.x or `*.local`), and `--json` gets `localAddress`. The exit code is unchanged. `fix` lists these as `needs a human` instead of rewriting them, since a local server may not accept the new parameter. ([#39](https://github.com/darnit-sh/darnit/pull/39))
- The pull request footer links the change record on darnit.sh. ([#40](https://github.com/darnit-sh/darnit/pull/40))
- `check` lists retired or retiring model names set as a value outside the call under "Possibly affected": a constant, a default, a keyword argument (including framework calls such as LangChain's `ChatOpenAI(model=...)`), an object or dict entry, or an environment variable's default, named for a model or engine. Test files are skipped. `check --json` adds `possiblyAffected`, with the same fields as `hits` plus `model`. These never change the exit code, and `fix` leaves them alone. ([#61](https://github.com/darnit-sh/darnit/pull/61))
- `check` counts every other exact mention of a retired or retiring model name in any file, such as docs, config files, `.env` files, tests and comments, per file under "Also mentioned". `--mentions` lists each line, and `check --json` adds `mentions`, with `id`, `file`, `line` and `model`, and `scanned.otherFiles`, the number of other files searched. Mentions never change the exit code, and `fix` leaves them alone. ([#62](https://github.com/darnit-sh/darnit/pull/62))

### Changed

- The workflow `init` writes runs `npx darnit@0.2` instead of `npx darnit`, so a scheduled run takes fixes but waits for you to move to a new minor release, which can change behavior. A workflow written by an earlier version keeps running the latest release; change `npx darnit` to `npx darnit@0.2` in `.github/workflows/darnit.yml` to pin it. ([#58](https://github.com/darnit-sh/darnit/pull/58))
- The npm package includes `CHANGELOG.md`, so the changes are readable offline in `node_modules/darnit`. ([#59](https://github.com/darnit-sh/darnit/pull/59))
- The repository's build and test commands run without `GITHUB_TOKEN` and `GH_TOKEN`, and those values are replaced with `***` in any output darnit keeps. A test suite that needs either variable no longer gets it from darnit. ([#41](https://github.com/darnit-sh/darnit/pull/41))
- darnit's git commands no longer run git hooks, including your own (husky, commitlint, pre-push) and a global `core.hooksPath`, since git cannot tell them from hooks a repository's tests planted. The push now uses git's own credentials, the same as your own `git push`; darnit's token only opens the pull request. A credential helper that reads the token from the environment, such as `gh auth setup-git` with only `GH_TOKEN` set, no longer works for the push. ([#43](https://github.com/darnit-sh/darnit/pull/43))

### Fixed

- `check` counts a model name made only of letters, such as `ada` or `davinci`, under "Also mentioned" only when it sits inside quotes (`"ada"`, `'ada'` or `` `ada` ``), so an agent or person named Ada in a README is no longer counted. Files over 10 MB that are not JavaScript, TypeScript or Python are named under "Not checked" and in `check --json` `scanned.tooLarge`, like code files, instead of being skipped without a note. ([#67](https://github.com/darnit-sh/darnit/pull/67))
- The shorthand `create({ model, messages, max_tokens })` is found and rewritten. ([#35](https://github.com/darnit-sh/darnit/pull/35))
- A retiring model written as the fallback value is found: `?? "name"` and `|| "name"` in JavaScript and TypeScript, `or "name"` in Python. ([#36](https://github.com/darnit-sh/darnit/pull/36))
- `fix` renames `max_tokens` only in a call's first argument, not in the request settings passed second. `check` still reports one written there, and `fix` leaves it to a human. ([#37](https://github.com/darnit-sh/darnit/pull/37))
- `fix` no longer reads settings files (`sgconfig.yml`) from the repository, which could make it load a library the repository named, even with `--dry-run --no-test`. (#42)
- The repository's tests can no longer plant git hooks or settings that darnit's own git commands then run with its token. File names are passed to git literally, so a file named `*.ts` no longer pulls other files into the commit. ([#43](https://github.com/darnit-sh/darnit/pull/43))
- File names, commands, test output and notes from the repository are shown literally in the pull request body and the terminal, so they cannot add live Markdown, mentions or links to the body, or send codes that change the terminal's title, clipboard or screen. Only the end of long test output is kept. ([#44](https://github.com/darnit-sh/darnit/pull/44))
- `fix --pr` uses the `origin` remote only when github.com is its host, and refuses repository names that could reach another part of GitHub's API with your token. ([#49](https://github.com/darnit-sh/darnit/pull/49))
- `init` refuses to write `darnit.yml` or the workflow through a symbolic link that leads outside the repository, such as a `.github` folder linked elsewhere, and exits 2 with the file it refused. Before, it wrote the file wherever the link pointed. ([#57](https://github.com/darnit-sh/darnit/pull/57))
- A file padded with blank lines or spaces to slow down the patterns darnit matches against it, such as an import split over thousands of blank lines, no longer stalls `check`, `init` or `fix`. A named pipe, such as one named `darnit.yml`, is not opened, so it no longer hangs `check`. Files over 10 MB are not read: `check` and `init` name them under "Not checked", and `check --json` lists them in `scanned.tooLarge`. The exit code is unchanged. ([#60](https://github.com/darnit-sh/darnit/pull/60))
- `fix` no longer hangs or fills memory when `package.json`, `pyproject.toml` or `setup.cfg` is a named pipe or a link to one, or a link to a device such as `/dev/zero`. Like every other file, they are read only when they are regular files under 10 MB. A file replaced by a named pipe while darnit opens it no longer hangs `check`, `init` or `fix`. ([#66](https://github.com/darnit-sh/darnit/pull/66))

## [0.1.0] - 2026-10-07

First release.

### Added

- `darnit init` finds the APIs a repository uses and writes `darnit.yml` and a daily GitHub Actions workflow.
- `darnit check` lists the call sites affected by a known change, with the vendor's own source. `--json` for machine-readable output.
- `darnit fix` rewrites the calls a tested rule covers, checks the result against your SDK version, build and tests, and with `--pr` opens one pull request per change.
- OpenAI supported, with 33 change records, including `max_tokens` to `max_completion_tokens` on chat completions (rewritten), `functions` to `tools` (reported), and retiring models from OpenAI's deprecations page (reported). Anthropic, Stripe and Twilio are recognized by `init`.
- Reads JavaScript, TypeScript and Python.

[Unreleased]: https://github.com/darnit-sh/darnit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/darnit-sh/darnit/tree/v0.1.0
