# darnit

Your API integrations, invisibly mended.

darnit watches the third-party APIs your code actually calls, notices when a
vendor changes something that affects you, and opens a pull request that fixes
it, with the evidence to show the fix is safe.

## Status

Early. Today the command line tool can find the APIs a repository uses and set
up a scheduled check. Reporting affected code and opening fix pull requests are
being built in the open, here.

## What it does

- `npx darnit init` scans your repository, writes `darnit.yml`, and adds a
  scheduled GitHub Actions workflow.
- `npx darnit check` reports vendor changes that touch code you wrote, down to
  the file and line. In progress.
- `npx darnit fix` applies a tested rewrite and opens a pull request with build
  and test results attached. In progress.

## Repository layout

- `packs/`: one folder per vendor per change. Each holds a description of the
  change with a link to the vendor's own announcement, the rewrite rules, and
  before/after examples that must pass in CI. A rule that changes nothing when
  its examples expect a change fails the build.
- `src/`: the command line tool.

## License

Apache-2.0
