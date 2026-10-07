# darnit

*Your API integrations, invisibly mended.*

Vendors change their APIs. Your code keeps calling them the old way.
darnit finds the exact lines, rewrites them, runs your tests, and opens the pull request.

```
$ npx darnit check
openai 2024-09-12: Rename max_tokens to max_completion_tokens on chat completions
  chat.ts:10:3  max_tokens: 256
  1 call site in 1 file
  https://developers.openai.com/api/docs/api-reference/chat/create

Scanned 1 JavaScript, TypeScript or Python file against 7 change records.
Not checked: request options built elsewhere and passed in as a variable.

$ npx darnit fix
@@ -7,7 +7,7 @@ const anthropic = new Anthropic();
 export const summary = await openai.chat.completions.create({
   model: "gpt-4o",
   messages,
-  max_tokens: 256,
+  max_completion_tokens: 256,
 });
 
 export const reply = await anthropic.messages.create({
✓ Rename max_tokens to max_completion_tokens on chat completions: 1 file
tests: npm test passed
```

The same file also calls `anthropic.messages.create({ max_tokens: 1024 })`.
darnit leaves it alone. That one is correct.

## Install

```
npm install -g darnit
```

Or skip the install: `npx darnit check`. Needs Node 22.12 or newer.

## How it works

```
vendor changes its API   →  a change record: what changed, cited, reviewed by a person
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

| Vendor | Status |
|---|---|
| OpenAI | supported: change records and rewrites |
| Anthropic, Stripe, Twilio | recognized: `init` finds them; no change records yet |

Want one covered? Open an issue.

Reads JavaScript, TypeScript and Python.

## Commands

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
Calls made through another provider's look-alike client are left out, and the
report names each one.

| Flag | |
|---|---|
| `--json` | machine-readable output |

| Exit | |
|---|---|
| 0 | nothing affected, or only unreviewed changes |
| 1 | affected call sites found for a reviewed change |
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
check only runs when JavaScript or TypeScript changed.

Before rewriting, darnit checks the SDK version your repo uses: for JavaScript,
`node_modules` or `package-lock.json`; for Python, exact `==` pins in
requirements files, `poetry.lock` or `uv.lock`. If it is too old for the new code, darnit leaves the files
alone and tells you which version to upgrade to. If it can't tell, it rewrites
and says so.

After rewriting, darnit checks its own work: it scans the files again, and any
call site still there is listed as `needs a human: file:line` (also in the pull
request). If the rules changed nothing, it says so instead of claiming a fix.

`fix` skips changes that are not yet reviewed, and changes that a rule can't
fully make. Both still show up in `check`.

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
| 1 | the build or tests failed after the change (files put back, nothing pushed) |
| 2 | darnit refused or failed, or a mistyped command or flag |

#### `--pr`

Needs a clean working tree and a GitHub token: `GITHUB_TOKEN`, `GH_TOKEN`, or a
`gh auth login` session. Each change gets its own branch (`darnit/<vendor>-<change>`)
and its own pull request against your default branch. darnit never force-pushes
and never pushes to the default branch. Run it again and it finds the open pull
request instead of opening a second one.

The pull request says what changed and why, links the vendor's announcement,
shows the build and test results, lists any call site that still needs a human,
and lists what was not verified.

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
      - run: npx darnit check
```

Once a day it runs `check`. The day a reviewed change hits your code, the run fails and
GitHub tells you, like any failed workflow. Scheduled workflows only run from
the default branch, so commit this file there.

Want pull requests instead of a red run? darnit runs your tests before it
pushes, so the job has to install your dependencies first:

```yaml
permissions:
  contents: write
  pull-requests: write

# ...same as above, then replace the last step with:
      - run: npm ci   # or whatever installs your project
      - run: npx darnit fix --pr
        env:
          GITHUB_TOKEN: ${{ github.token }}
```

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

Records are written by hand from vendor announcements. New candidates also
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
