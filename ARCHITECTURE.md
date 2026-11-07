# Architecture

How darnit's code is laid out, what may depend on what, and the limits every change is held to. Read this before
adding code; CONTRIBUTING.md says what a finished change looks like.

## What runs where
- `darnit check` reads a repository's JavaScript, TypeScript and Python code, and every other file for mentions,
  matches them against the change records in `packs/`, and reports each call site, value and mention a record
  names. It changes nothing.
- `darnit fix` applies a record's rewrite rules, builds and tests the repository, puts back anything the tests
  touched, and opens a pull request per change (`--pr`), or splits that into a read-only job that writes a plan
  (`--prepare`) and a write job that recomputes it and opens the pull requests (`--publish`).
- `darnit init` writes the workflow and the settings file a repository runs darnit with.
- The corpus tools (`npm run corpus`, `accounting`, `replacements`) read vendor specifications and deprecation pages
  and propose or check records. They are not part of the published package.

## Floors
`src/` is arranged in floors. A file may import only from floors below its own, never above and never sideways
across the rules below. Type-only imports follow the same rules. `test/architecture.test.ts` holds the map and checks
every import in `src/` and `scripts/` against it. The imports that broke these rules before the map was checked,
among them the one import cycle, are listed in `scripts/allow/imports.tsv`, and each rule below holds apart from
those lines; any other break, or a new cycle, fails the test.

| Floor | Files today | Job |
|---|---|---|
| 4 | `src/cli.ts`, `src/init.ts`, `src/update.ts` | The command line: arguments, commands, what it prints and exits with. |
| 3 | `src/check.ts`, `src/fix.ts`, `src/plan.ts`, `src/tests.ts`, `src/packs/apply.ts` | The two flows. The fix files may use `src/check.ts`; `src/check.ts` never uses them. `src/packs/apply.ts` stands apart: `src/fix.ts` uses it only through its line in the allowlist. |
| 2 | `src/scan/`, `src/records/`, `src/git.ts`, `src/github.ts`, `src/versions.ts` | What the flows are built from. `src/scan/` may use `src/records/`; nothing else on this floor uses another group on it, apart from the listed lines. |
| 1 | `src/detect.ts` | Vendor facts, files and processes, text out. |
| 0 | `src/refusal.ts` | The error type darnit throws when it declines to act. |
| islands | `src/corpus/`, `src/packs/fixtures.ts` | Tooling. They may use floors 0 to 2 (and `src/packs/apply.ts` for fixtures); only `scripts/` imports them, and the build leaves them out. |

The map also gives each floor folders that do not exist, one per job, so a file keeps its floor when it moves
into one. New code goes into the folder the map gives its job, or next to the code it extends while that code has
not moved; `test/architecture.test.ts` fails on a file under `src/` that the map does not place.

`scripts/` may import islands and floors 0 to 3, never the command line apart from the listed lines. Tests may
import anything. There are no barrel files (an index file that re-exports a folder), and the map test fails on one.

## Where things live
Every path below exists today; `test/docs-paths.test.ts` checks that every path this file names is a file or folder
git tracks. When a file moves to its folder, the same change updates its row.

| Path | Floor | Job |
|---|---|---|
| `src/cli.ts` | 4 | The command line: arguments, commands, what it prints and exits with |
| `src/init.ts` | 4 | `darnit init`: writes the workflow and settings files |
| `src/update.ts` | 4 | The one-line notice when a newer release line exists |
| `src/check.ts` | 3 | `darnit check`: the scan over a repository and its two reports |
| `src/fix.ts` | 3 | `darnit fix`: rewrite, verify, restore, `--prepare`, `--publish`, pull requests, output |
| `src/plan.ts` | 3 | The plan file `--prepare` writes and `--publish` reads |
| `src/tests.ts` | 3 | Finds and runs the repository's own build and tests |
| `src/packs/apply.ts` | 3 | Applies a record's rewrite rules, for `fix` and the fixtures alike |
| `src/scan/` | 2 | Parsing, matching calls, tracing clients, values and mentions |
| `src/records/` | 2 | The change record schema and loading |
| `src/git.ts` | 2 | Every git call, pinned and with a clean environment |
| `src/github.ts` | 2 | The GitHub API and token |
| `src/versions.ts` | 2 | Installed SDK versions from manifests and lock files |
| `src/detect.ts` | 1 | Vendor facts, file reading and listing, environments, escaping |
| `src/refusal.ts` | 0 | `Refusal`, an error the user can act on |
| `src/packs/fixtures.ts` | island | Runs record fixtures (tooling) |
| `src/corpus/` | island | Specification snapshots, candidates, accounting, replacements |

## Classes
Plain modules of functions by default. A class is used only where state must stay consistent across several
operations, is built once and passed around, and has an invariant a test states. The classes today are two error
types: `Refusal` (`src/refusal.ts`: darnit declines to act, and the message says what to change) and
`ChangeRecordError` (`src/records/schema.ts`: a record does not load, and the message names its file). Anything else
thrown is a plain `Error`. The command line prints any error's message without a stack and exits 2. Each
new class is listed here, with its invariant, by the change that adds it.

## Adding things
- **A record:** a folder `packs/<vendor>/<record>/` holding
  - `packs/<vendor>/<record>/change.json`, checked by `src/records/schema.ts`;
  - one or more fixture cases, each with the code as a user writes it in
    `packs/<vendor>/<record>/fixtures/<case>/before/`, the rules' result in
    `packs/<vendor>/<record>/fixtures/<case>/after/` and the match counts in
    `packs/<vendor>/<record>/fixtures/<case>/expected.json`;
  - `packs/<vendor>/<record>/rules/js/` and `packs/<vendor>/<record>/rules/py/` when it rewrites code.

  Every record ships with passing fixtures (`npm run test:fixtures`): a record with no fixture case, a language with
  patterns or rules but no fixture file, and a rule that applies no change where a fixture has code in its language
  all fail CI.
- **A rewrite rule:** an ast-grep rule file (YAML, applied in name order) under
  `packs/<vendor>/<record>/rules/<language>/`, with a fixture case for every form it handles.
- **A vendor:** its runtime facts (packages, hosts, tier) in `VENDORS` in `src/detect.ts`, with the tier
  `supported` once a rule pack for it exists in `packs/` and `recognized` while it is only named, and its look-alikes
  in `LOOKALIKES` beside it. For the corpus, its specification address and endpoint-to-SDK map in `vendors.yml`.
  `npm run accounting` reads `corpus/<vendor>/openapi.yaml` for every vendor there and stops on one without it, so
  the same change runs `npm run corpus`, which stores the first snapshot as `corpus/<vendor>/openapi.yaml` and
  `corpus/<vendor>/snapshot.json`, and commits both. It fetches every vendor's spec, so it can also change another
  vendor's corpus files, and accounting then fails on that vendor's new removals: keep only the new vendor's files
  and restore the rest (`git checkout -- corpus/<other-vendor>/`). Every item the new vendor's spec marks deprecated
  then needs a record or an entry with its reason in `packs/<vendor>/not-covered.yaml`, or `npm run accounting`
  fails, and `packs/<vendor>/record-ceiling.txt` holds how many of them that file marks needs-record, or
  `npm test` fails. Nothing checks that `VENDORS` and `vendors.yml` name the same vendors.

## Limits
The checks below run in CI. Anything that broke one before it existed is listed in its file under `scripts/allow/`
(`scripts/allow/imports.tsv`, `scripts/allow/unused.tsv`, `scripts/allow/duplicates.tsv`), one finding per line,
tab-separated with the reason last. One shared reader (`scripts/allowlist.ts`) checks every list the same way: a
finding not listed fails, and a listed line whose finding is gone fails, so each list can only shrink. Only a `ci`
change with an `Allowlist: <reason>` line in its description may add a line to a list, or add anywhere a tag that
makes knip skip an export or a `jscpd:ignore` marker, and only a `ci` change with a `Proof: none, <reason>` line may
change a tool's settings (`scripts/check-refactor.sh`).

Coverage has a floor rather than a list: each threshold in `coverage-thresholds.json`, which `vitest.config.ts`
reads, only goes up. Whatever its type, a change fails when it lowers or removes a threshold, changes a vitest
config, changes the pin of `vitest` or `@vitest/coverage-v8`, or adds a coverage ignore hint under `src/`
(`scripts/check-coverage.sh`). Only a `ci` change passes with a `Coverage: <reason>` line in its description, on top
of the `Proof: none, <reason>` line those files need; a `ci` change cannot touch `src/`, so no change adds an ignore
hint there. A folder a change adds to the thresholds must start at or above what CI measures for it, rounded down.

| Check | Value |
|---|---|
| Import floors and cycles | the map above, checked by `npm test` |
| Unused files, exports and dependencies | none, checked by `npm run knip` |
| Duplicated blocks in `src/` and `scripts/` | none of 50 tokens or more, checked by `npm run duplicates` |
| Coverage per folder of `src/` | at or above each line and branch percent in `coverage-thresholds.json`, measured by `npm test -- --coverage` on one CI runner |

These limits hold for any code a change writes or touches. No lint rule enforces them, so the change holds to
them itself, and does not make an existing breach worse.

| Limit | Value |
|---|---|
| Lines per file in `src/` | 300 |
| Lines per function | 50 |
| Complexity per function | 10 |
| Nesting depth | 3 |
| Parameters | 4 (an options object beyond) |
| Nested ternaries, shadowed names | none |
| Formatting | what the pinned prettier writes (`npx prettier --write <files>`); CI's lint job checks it (`npm run format:check`) on every `.ts`, `.js`, `.mjs`, `.cjs`, `.mts`, `.cts`, `.tsx` and `.jsx` file except those `.prettierignore` leaves out: build output, rule pack fixtures, test fixtures, samples, end-to-end scenarios, golden files and the corpus |
