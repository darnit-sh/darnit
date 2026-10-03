# darnit

Your API integrations, invisibly mended.

darnit watches the third-party APIs your code actually calls, notices when a
vendor changes something that affects you, and opens a pull request that fixes
it, with the evidence to show the fix is safe.

## Install

```
npm install -g darnit
```

Or run any command without installing: `npx darnit check`.

## Use

```
darnit init     # find the APIs this repository uses, write darnit.yml, add a daily check
darnit check    # list the vendor changes that touch your code, file and line, with the vendor's announcement
darnit fix      # rewrite the affected code, run your tests, show the diff
```

`darnit check` exits with status 1 when something is affected, so the scheduled
workflow fails the day a change lands and GitHub lets you know.

### fix

`darnit fix` only runs inside a git repository, so everything it does can be
undone with git. It rewrites only the files `check` reported, runs your test
command if it can find one (`npm test`, `pnpm test`, `yarn test`, or `pytest`),
and prints the diff. If the tests fail it puts the files back and runs them once
more, so it can tell you whether the change broke them or they were already failing.

```
darnit fix --dry-run          # show the diff, write nothing (works outside git too)
darnit fix --pr               # one branch and one pull request per change, tests run on each
darnit fix --only <record>    # just one change, by its id from check --json
darnit fix --test "<cmd>"     # use this test command
darnit fix --no-test          # skip tests
darnit fix --allow-dirty      # let --pr run with uncommitted changes present
darnit fix --repo owner/name  # when origin is not a GitHub URL
darnit fix --json             # machine-readable result
```

With `--pr`, darnit needs a clean tree and a GitHub token (`GITHUB_TOKEN`,
`GH_TOKEN`, or a `gh auth login` session). It never force-pushes and never
pushes to your default branch. Running it again finds the open pull request
instead of opening a second one. The pull request body says what changed, links
the vendor's announcement, shows the test result, and lists what was not verified.

To have the scheduled workflow open pull requests instead of only reporting,
change its `npx darnit check` step to `npx darnit fix --pr` and give the job
`contents: write` and `pull-requests: write` permissions.

Exit codes: 0 nothing to do or done; 1 tests failed after the change (files put
back, nothing pushed); 2 darnit refused or failed.

## What darnit knows

Every change darnit can report lives in `packs/`, one folder per vendor per
change. Each holds a description of the change with a link to the vendor's own
announcement, the rewrite rules, and before/after examples that must pass in CI.
A rule that changes nothing when its examples expect a change fails the build.

### Where records come from

Vendors listed in `vendors.yml` publish an OpenAPI specification. Once a week a
workflow fetches each spec, compares it with the last snapshot in `corpus/`
using [oasdiff](https://github.com/oasdiff/oasdiff), and turns every deprecated
or removed request field and every removed endpoint into a candidate record,
complete with detection patterns, example files, and, when the spec names the
replacement, the rename rules. The candidates arrive as a pull request. A
maintainer reads each one, adds anything the spec could not say, and marks it
reviewed. `check` reports candidates as unreviewed; `fix` only acts on reviewed
records. To watch a new vendor, add its spec URL and the SDK calls for its
endpoints to `vendors.yml`.

darnit reads JavaScript, TypeScript and Python. What it does not see: an options
object built in one place and passed to the API call by name. Those call sites
are listed as unchecked rather than guessed at.

## License

Apache-2.0
