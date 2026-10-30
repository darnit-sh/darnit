# darnit

*Your API integrations, invisibly mended.*

Your dependencies didn't change. The API did.

[darnit.sh](https://darnit.sh)

Vendors change their APIs. Your code keeps calling them the old way.
darnit finds the exact lines, rewrites them, runs your tests, and opens the pull request.

```
$ npx darnit check
openai 2024-09-12: Rename max_tokens to max_completion_tokens on chat completions
  chat.ts:11:5  max_tokens: 256
  1 call site in 1 file
  https://developers.openai.com/api/docs/api-reference/chat/create

Scanned 1 JavaScript, TypeScript or Python file against 33 change records.
Not checked: request options built elsewhere and passed in as a variable.

$ npx darnit fix
@@ -8,7 +8,7 @@ export async function summarize(messages) {
   return openai.chat.completions.create({
     model: "gpt-4o",
     messages,
-    max_tokens: 256,
+    max_completion_tokens: 256,
   });
 }
 
✓ Rename max_tokens to max_completion_tokens on chat completions: 1 file
tests: npm test passed
```

The same file also calls `anthropic.messages.create({ max_tokens: 1024 })`.
darnit leaves it alone. That one is correct.

## Install

```
npm install -g darnit
darnit check
```

Or skip the install: `npx darnit check`. Run inside a repository, npx trusts it: a
darnit in its `node_modules` or a setting in its `.npmrc` can run the repository's
own code before darnit starts. Needs Node 22.12 or newer.

### Code you don't trust

Run `check` only, from outside the repository, with its path:
`darnit check path/to/repo`, or `npx darnit check path/to/repo` from another
folder. `check` reads the files and runs nothing from them. `fix` runs the
repository's own build and tests, so run it only on code you would run yourself.

The official package is `darnit` on npm. Its source is
[github.com/darnit-sh/darnit](https://github.com/darnit-sh/darnit) and its site
is [darnit.sh](https://darnit.sh).

## How it works

```
vendor changes its API   →  a change record: what changed, cited, checked by a person or against the vendor's own page
change record            →  the exact call sites in your repo, made through that vendor's own client
call sites               →  rewrite rules, proven against before/after examples in CI
rewrite                  →  checked: your SDK version first, then your build and your tests
nothing broke            →  one pull request per change, with the evidence and anything unchecked in the body
```

No guessing anywhere in that chain. Every rewrite is a rule that was tested
before it shipped, and the same rule gives the same result in every repo.

## What it covers

Small on purpose. A change gets a rewrite only when the rewrite is proven.

| Change | `check` | `fix` |
|---|---|---|
| OpenAI: `max_tokens` → `max_completion_tokens` on chat completions | reports | rewrites |
| OpenAI: chat completions `functions` → `tools` | reports | reports only: code that reads the response needs changes a rule can't make safely |
| OpenAI: `style` and `response_format` on image generation and edits, found by the weekly spec check | reports, marked unreviewed | no: waiting for review |
| OpenAI: 143 retiring models listed on the deprecations page | reports, marked parser-verified | reports only: a newer model can answer differently |

| Vendor | Status |
|---|---|
| OpenAI | supported: change records and rewrites |
| Anthropic, Stripe, Twilio | recognized: `init` finds them; no change records yet |

Want one covered? Open an issue.

Reads JavaScript, TypeScript and Python.

## Commands

Each command works on the current folder, or on the folder named after it, as in
`darnit check path/to/repo`.

### `darnit init`

Finds the APIs the repo uses and sets up the daily check. It reads your
dependency files, your imports, and any API hostnames in your code.

```
$ npx darnit init
✓ Scanned repo: found openai (package.json: openai), stripe (package.json: stripe; recognized only)
✓ Wrote darnit.yml
✓ Wrote .github/workflows/darnit.yml
```

| Flag | |
|---|---|
| `--force` | overwrite `darnit.yml` and the workflow if they already exist |

Without `--force`, existing files are left untouched.

### `darnit check`

Lists every call site affected by a known change: file, line, and the vendor's
own announcement or API spec. Changes still waiting for review are marked
`(unreviewed change, detection only)` and never fail the check on their own.
Changes read from a vendor's page by a script and confirmed by a second, separate
parser are marked `(parser-verified, not read by a person)` and do fail the check.
Calls made through another provider's look-alike client are left out, and the
report names each one.

A retired or retiring model name set as a value outside the call, such as
`DEFAULT_MODEL = "gpt-4"`, `os.getenv("MODEL", "gpt-4")` or a `model="gpt-4"`
default, is listed after the call sites under "Possibly affected", grouped by
change, and so is one written inside the call in a form `check` does not
confirm. darnit cannot see where these values are sent, so check each one. They
never change the exit code, and test files are skipped. `--json` lists them in
`possiblyAffected`, with the same fields as `hits` plus `model`.

Other exact mentions of a retired or retiring model name, in any file (docs,
config, `.env`, tests, comments), are counted per file under "Also mentioned".
Only the whole name counts: `gpt-4` never matches inside `gpt-4o`, `gpt-4.1` or
`gpt-4-turbo`. A name made only of letters, such as `ada` or `davinci`, is also
an everyday word or name, so it counts only inside quotes (`"ada"`, `'ada'`,
`` `ada` `` or `\"ada\"` in a JSON string) or as the whole value of a setting
named for a model or engine (`OPENAI_MODEL=ada`, `model: ada`). A name that
code can also use as a variable, such as `o1`, counts in code files (Python,
Java, Kotlin, Scala, Groovy, Swift, Dart, Go, Rust, C, C++, C#, and JavaScript
and TypeScript other than `.jsx` and `.tsx`) only inside a string or a comment
or as a setting value, so `compare(String o1, String o2)` is not counted; in
other files every mention counts. On a line over 5,000 characters, as in a
minified bundle, it counts only directly inside quotes or as a setting value.
Mentions never change the exit code. `--mentions` lists each line, and
`--json` always lists them all in `mentions`, with `id`, `file`, `line` and
`model`, and counts the other files searched in `scanned.otherFiles`. Binary
files are skipped, and other files over 10 MB are listed under "Not checked".
Dependency and build folders (`node_modules`, `vendor`, `dist`, `build`, Python
virtual environments and the like), copies of an SDK bundled into the project,
symbolic links to outside the repository, and folders and files darnit could not
read are not searched; "Not checked" names them, and `--json` lists each in
`scanned.skipped` with its `path` and `reason`, leaving the field out when there
are none, as with `scanned.tooLarge`. When anything was not checked, a clean
result reads "No call sites of known vendor changes found." rather than claiming
nothing affects the repository.

| Flag | |
|---|---|
| `--json` | machine-readable output |
| `--mentions` | list every line that mentions a retired or retiring model name |

| Exit | |
|---|---|
| 0 | nothing affected, or only unreviewed changes |
| 1 | affected call sites found for a reviewed or parser-verified change |
| 2 | darnit itself failed, or a mistyped command or flag |

### `darnit fix`

Rewrites the affected code, runs your build and tests, and shows the diff. It only runs
inside a git repository, so everything it does can be undone with git. Commit
first if those files have changes of your own. It touches only the files `check`
reported.

It finds your checks on its own: a `typecheck` or `build` script (or the
repo's own TypeScript compiler), then your tests (`npm test`, `pnpm test`,
`yarn test` or pytest). If either fails, darnit puts your files back and runs
it once more, so it can tell you whether the change broke it or it was already
failing. A build that was already failing can't judge the change, so darnit
keeps the change and says the build could not check it. Tests that were already
failing still put the files back: fix them first, or use `--no-test`. The build
check only runs when JavaScript or TypeScript changed. A build or test run that
takes over 10 minutes is stopped: darnit puts your files back and says it timed
out, without running it again or saying whether the change was the cause. The
same goes when the run without the change times out.

Before rewriting, darnit checks the SDK version your repo uses: for JavaScript,
`node_modules` or `package-lock.json`; for Python, exact `==` pins in
requirements files, `poetry.lock` or `uv.lock`. If it is too old for the new code, darnit leaves the files
alone and tells you which version to upgrade to. If it can't tell, it rewrites
and says so.

After rewriting, darnit checks its own work: it scans the files again, and any
call site still there is listed as `needs a human: file:line` (also in the pull
request). If the rules changed nothing, it says so instead of claiming a fix.

`fix` skips changes that are not yet reviewed, and changes that a rule can't
fully make. Both still show up in `check`. It works from the same scan as
`check`, so it ends with the same lines about folders and files it did not
read, and when something was not read, "Nothing to fix." reads "Nothing to fix
in the files darnit checked." When `check` lists model names outside the call
sites, which `fix` leaves alone, it says "No call sites to fix." and points to
`darnit check`.

`--json` gives each check it ran under `build` and `tests` (or under each
record's `pr`) with `kind` (`build` or `tests`), `command`, `passed`, `output`,
`attributed` (`change` when the change broke it, `baseline` when it already
failed without the change), `notChecked` (true when an already failing build
could not check the change) and `timedOut`. A check that timed out has
`timedOut: true`, and with `--pr` its record's `pr.state` is `build-failed` or
`tests-failed`. `scanned` is the same as in `check --json`, including
`scanned.skipped` and `scanned.tooLarge`.

| Flag | |
|---|---|
| `--dry-run` | show the diff, write nothing (works outside git too) |
| `--pr` | one branch, one build and test run, and one pull request per change |
| `--only <id>` | just this change, by its id from `check --json` (repeatable) |
| `--test <command>` | run this instead of the detected test command |
| `--no-test` | skip tests and the build check |
| `--allow-dirty` | let `--pr` run with uncommitted changes elsewhere in the tree |
| `--repo <owner/name>` | the GitHub repository, when `origin` is not a GitHub URL |
| `--json` | machine-readable output |

| Exit | |
|---|---|
| 0 | done, or nothing to do (including changes left alone because the SDK is too old, and call sites listed as `needs a human`) |
| 1 | the build or tests failed or timed out after the change (files put back, nothing pushed) |
| 2 | darnit refused or failed, or a mistyped command or flag |

#### `--pr`

Needs a clean working tree and a GitHub token: `GITHUB_TOKEN`, `GH_TOKEN`, or a
`gh auth login` session. The token opens the pull request; the push uses git's
own credentials, the same as your own `git push`, and your repository's git hooks
don't run on darnit's commits. Each change gets its own branch (`darnit/<vendor>-<change>`)
and its own pull request against your default branch. darnit never force-pushes
and never pushes to the default branch. Run it again and it finds the open pull
request instead of opening a second one.

Every pull request carries its receipts: the vendor's source link, the change
record it applies, the files it changed, the result of each check it ran, any
call site that still needs a human, and what was not verified.

## The scheduled check

`init` writes `.github/workflows/darnit.yml`:

```yaml
name: darnit

on:
  schedule:
    - cron: "17 6 * * *"
  workflow_dispatch: {}

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          package-manager-cache: false
      - run: cd "${RUNNER_TEMP:?}" && npx darnit check "${GITHUB_WORKSPACE:?}"
```

Once a day it runs `check`. npx starts outside your checkout, so nothing in the
repository can change which darnit runs. The day a reviewed or parser-verified change hits your code, the run fails and
GitHub tells you, like any failed workflow. Scheduled workflows only run from
the default branch, so commit this file there.

When a newer release line is out, `check` and `fix` end with one line naming
the version to change in this file, shown in a workflow run as a notice on the
run summary. darnit asks npm once per run, waits at most 1.5 seconds, never
changes the exit code, and never asks with `--json`. Set
`DARNIT_NO_UPDATE_CHECK=1` (or `NO_UPDATE_NOTIFIER=1`) to turn it off.

Want pull requests instead of a red run? darnit runs your tests before it
pushes, so the job has to install your dependencies first:

```yaml
permissions:
  contents: write
  pull-requests: write

# ...same as above, with the checkout keeping no token on disk:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
# ...and the last step replaced with:
      - run: npm ci   # or whatever installs your project
      - run: cd "${RUNNER_TEMP:?}" && npx darnit fix --pr "${GITHUB_WORKSPACE:?}"
        env:
          GITHUB_TOKEN: ${{ github.token }}
```

With `persist-credentials: false` the checkout leaves no token in git config or
under `$RUNNER_TEMP` for your install scripts and tests to read. darnit hands the
token to its own git calls to github.com through each command's environment.
That does not hold against the repository's own code: your install scripts and
tests run first, in the same job, and git config they write to the repository,
such as `http.curloptResolve` with `http.sslVerify false`, can send darnit's
push, and the token with it, to another server. Only running the tests in a
separate job that has no token removes this.

Also turn on *Settings → Actions → General → Allow GitHub Actions to create
and approve pull requests*. Pull requests opened this way don't trigger your
own CI (a GitHub rule for workflow tokens), which is why darnit runs the tests
itself and puts the result in the pull request.

## darnit.yml

```yaml
version: 1
apis:
  openai:
    tier: supported
    evidence:
      - "package.json: openai"
```

`check` only reports vendors listed under `apis`. Remove one to stop hearing
about it. With no file, or an empty list, `check` reports every vendor it knows.

## Where change records come from

Every change darnit knows lives in `packs/`, one folder per vendor per change:
the record (what changed, with a link to its source), the rewrite
rules, and before/after examples. CI applies the rules to the examples and fails
on any difference. A rule that quietly changes nothing fails the build too.

Records are written by hand from vendor announcements, except model shutdowns:
those are read from OpenAI's deprecations page by a script, confirmed by a second,
separate parser, and stay parser-verified until a person reviews them. New candidates also
come from the vendors' own API specs: once a week a workflow
compares each spec in `vendors.yml` with the last saved copy (using
[oasdiff](https://github.com/oasdiff/oasdiff)) and turns deprecated or removed
fields and endpoints into candidate records. Candidates arrive as a pull request, and a
person reviews each one before `fix` will touch it.

To add a vendor, open a pull request adding its spec URL and SDK calls to
`vendors.yml`.

## Limits

- Request options built somewhere else and passed in as a variable are not
  followed. `check` reminds you at the end of every report, clean or not.
- A model name fails `check` only when written in the call's own `model` option
  as a plain string or a fallback such as `name || "gpt-4"`. Written any other
  way in the call (a quoted `"model"` key, a template string, a Python f-string,
  `**kwargs`) or set as a value named for a model or engine elsewhere (a
  constant, a default, a keyword argument, an object or dict entry, an
  environment variable's default), it is only listed under "Possibly affected",
  and some of those go to other providers. This includes framework calls such as
  LangChain's `ChatOpenAI(model="gpt-3.5-turbo")`: darnit reports the name
  there, but does not follow LangChain or Vercel's AI SDK calls. Any other
  mention, such as a name in a config file, a `.env` file, a list of models or a
  test file, is only counted under "Also mentioned", and short names such as `o1`
  can match unrelated text, while `ada` in plain text is not counted. A name
  built at run time or set outside the repository is missed. A clean `check` does not mean no retired model is in use.
- Only changes with a record are found. No record, no report.
- Clients that copy OpenAI's methods are left out when the same file shows a
  known look-alike: the Groq, Together, Cerebras or Fireworks SDKs, or OpenAI's
  SDK pointed at OpenRouter, DeepSeek, Groq, Together, Fireworks, Cerebras, xAI,
  Mistral, Perplexity or Gemini. Every other client counts as OpenAI, including
  wrappers, proxies, a client passed in from elsewhere, and an address read from
  configuration.
- `fix` runs in your working tree, not a sandbox. Your test command runs as you.
- Tested on macOS and Linux with Node 22 and 24. Windows is not supported yet.

## License

Apache-2.0
