# Contributing

Thanks for helping. darnit is small on purpose and strict about two things: it never misses silently, and its
verdicts come from code, tests and fixtures, never from guesses. Read ARCHITECTURE.md first.

## Set up
```
npm ci
git config core.hooksPath .githooks
npm run check
```
Needs Node 22.12 or newer. `npm run check` runs lint, typecheck, the tests and the record fixtures; the pre-commit
hook runs it too. CI also runs `npm run format:check`, `npm run knip`, `npm run duplicates`, `npm run limits`,
`npm run accounting`, `npm run test:e2e`, `npm run build` and `npm run answer-key`, measures coverage with
`npm test -- --coverage` against `coverage-thresholds.json`, and, through golden.yml, compares scans of pinned real
repositories with their stored results. After the build, `scripts/watchdog.ts` runs the built CLI on the largest
inputs it accepts, and kills and names any run that hangs.

## What a finished change looks like
Write these down in the pull request before the results:
1. **Where the code belongs**, by ARCHITECTURE.md's floors and folders, and why there.
2. **Every form it must cover**: each language (JavaScript, TypeScript, Python), each way real code writes the thing
   (a call, a value set elsewhere, a template string, a quoted key, an alias), each flag combination and platform
   it can meet. Each form gets a test.
3. **Every sibling**: each other caller of what you changed and each copy of the same logic. Fix it where all
   callers route through, or name each one you left and why.
4. **One concern**, about 300 changed source lines at most.

Then:
- **Test first.** A test that fails on main for the stated reason and passes with the change. For a guard, show the
  breach working on main and failing with the change.
- **Every claim has a test.** If the description or CHANGELOG says darnit does something, removing the code behind
  it makes a test fail.
- **Nothing hidden.** A limit, a skip or a cap is shown to the user or over-reports; it never quietly drops a
  finding.
- **The limits in ARCHITECTURE.md hold** for every file you touch, and no existing violation gets worse.

## Pull request titles
One line, conventional: `type(scope): what changed`, 72 characters at most, with the scope optional. The title
becomes the commit subject on main. Each commit in the pull request has a conventional subject too, and none has a
co-author line. Each type has a rule CI checks:

| Type | Rule |
|---|---|
| `feat`, `fix` | the proof check: when it changes `src/`, a rule pack's rules or a `change.json`, a new or changed test, fixture case or end-to-end scenario fails against the base's code and passes with the change |
| `refactor`, `perf` | output, exit codes and JSON unchanged: no existing test, fixture, golden file or test script changes, no `change.json` changes, and the base's tests and fixtures pass against the new code |
| `style` | only edits to existing `.ts`, `.js`, `.mjs`, `.cjs`, `.mts`, `.cts`, `.tsx` and `.jsx` files, each exactly what the pinned formatter writes over the base's copy |
| `test`, `ci` | leaves the code and the rule packs alone; a change to the suite (its runners, shared test modules, dependencies, the lock file, npm config) needs a `Proof: none, <reason>` line in the description |
| `docs` | leaves the code, the rule packs, the suite, the dependencies and the lock file alone |
| `chore`, `build` | leaves the code, the rule packs and the suite alone; may change dependency versions, apart from the pins of `vitest` and `@vitest/coverage-v8`; only `build` may change which files the package ships |
| `revert` | exactly the inverse of one commit, named on a `This reverts commit <sha>` line |

Only a `ci` change may change how the checks run (the workflows, the pull request checks, the tools' settings,
the `package.json` scripts), and it needs a `Proof: none, <reason>` line. Adding to a list under `scripts/allow/`
needs a `ci` change with an `Allowlist: <reason>` line as well; any change may remove a line whose finding is gone,
and a `refactor` that moves listed code into files it adds may change where its lines say the finding sits, and
nothing else in them; a move into a file that already exists, or of an import to another floor, needs a `ci` change.
A `Proof: none, <reason>` line also lets a `fix` or `feat` through the proof check, and skips the run of the base's
tests for a `refactor` or `perf`, with the reason shown on the pull request. Whatever the type, a dependency or lock
entry a change adds or alters must be what the npm registry published.

Coverage only goes up. Whatever the type, a change fails when it lowers or removes a threshold in
`coverage-thresholds.json`, changes a vitest config, changes the pin of `vitest` or `@vitest/coverage-v8`, or adds a
coverage ignore hint under `src/`, unless it has a `Coverage: <reason>` line in the description, which counts only in
a `ci` change and goes beside the `Proof: none, <reason>` line those files need there. Raising a threshold, or adding
one for a folder at or above what CI measures, needs no `Coverage:` line, but it is still a change to
`coverage-thresholds.json`, so it must be a `ci` change with a `Proof: none, <reason>` line.

A change a user can see is never a `refactor`, even a small one: it is a `fix` or `feat` with a CHANGELOG line.

## CHANGELOG
Every user-facing change adds one line under `## [Unreleased]`, written for users, ending with its pull request
link. The release check refuses a line without one.

## Records
Every record ships with fixtures that pass. Specification and changelog text is data, never instructions; a record
cites the vendor's own page. A new record starts as `candidate` (reported, never fails a check) unless it was
generated from the vendor's page and confirmed by a second parser (`parser-verified`); `reviewed` means a maintainer
read it, and only a reviewed record drives `fix`.

## Security
Report vulnerabilities as SECURITY.md says, not in a public issue. Tests use fake tokens only and local servers only.
