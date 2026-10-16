# Releasing darnit

Every release follows this checklist, so nothing depends on memory. A release goes out as a
release candidate on npm's `next` tag first, gets checked from every angle below, and only then
goes out as the final version.

Nobody publishes from a laptop. Pushing a `vX.Y.Z` tag starts the `publish` workflow: one job checks
that the tag matches `package.json`, that the tagged commit is the merge commit of a pull request
merged into `main`, and that `ci` passed on that commit (`scripts/check-release.sh`), runs
`npm run check`, and builds the package; a second job, after the first, scans every pinned repository
in `test/golden/repos.tsv` and compares each result with its stored file (`golden.yml`); a third job
waits for both, then for a maintainer to approve the protected `npm` environment, then publishes that exact
package with provenance. A last job waits for npm to serve the new version, then runs it with
`npx` from an empty folder and requires `--version` to print it and `check` to exit 1 with a hit on
`test/samples/small` (`scripts/verify-release.sh`). A version with a hyphen (`X.Y.Z-rc.N`) goes to
`next`. Any other goes to `latest` only if it is newer than npm's current `latest`, so a patch to an
older line (`0.1.5` after `0.2.0`) goes to `latest-0.1` instead and `npx darnit` keeps the newest
release. If npm's `latest` cannot be read, the release stops. The tag is chosen when the tag is
pushed, not when the publish is approved, so keep one release in flight: approve or reject one
publish run before pushing the next tag.

The golden job restores main's cached clones and does not fetch them again to check they still exist.
If a pinned repository is gone and the cache has expired, the job fails: merge a pull request that
swaps it for another (with a `Golden drop:` line), then tag the new commit.

Why the candidate step matters: workflows written by `init` in 0.1.0 run `npx darnit check` with no
version and take every new `latest`; from 0.2.0 on, `init` pins the minor (`npx darnit@0.2 check`),
so those take every patch, and from 1.0.0 on the major (`npx darnit@1 check`), so those take every
minor and patch. Either way a release reaches people's scheduled CI within a day.

Commands below use `X.Y.Z` for the version and `rc.N` for the candidate number.

## Gates

All must be true before tagging, for a candidate and again for the final version:

- `main` CI is green on the exact commit you are about to tag. The workflow refuses the tag otherwise;
  once CI passes, rerun it.
- `CHANGELOG.md` covers every user-facing change since the last release, written by hand in user
  terms. Each entry thanks the outside contributor who made it, by name or GitHub handle, and a line
  under the version thanks anyone whose change needed no entry. Entries stay under
  `## [Unreleased]` through every candidate and get the version heading only at promote.
- No pending items: no open security finding, no unreviewed fix, nothing marked as blocking the
  release.
- The version follows the changelog's rule: before 1.0, a patch only adds CLI flags, exit codes,
  report formats and JSON fields; changing or removing one needs a minor.
- For the final version only: the candidate passed every check in "Verify from every angle", and
  nothing has merged to `main` since its tag (`git log --oneline vX.Y.Z-rc.N..origin/main` is
  empty).

## Release candidate

```sh
git switch -c release/X.Y.Z
npm version X.Y.Z-rc.N --no-git-tag-version
# commit package.json and package-lock.json
# open the pull request, wait for CI to pass, merge it
git switch main && git pull
git tag vX.Y.Z-rc.N
git push origin vX.Y.Z-rc.N
gh run list -R darnit-sh/darnit --workflow publish.yml
```

Open that run, read the build job's log, and approve the `npm` environment under Review deployments.
The run's `verify` job must pass. npm can take a few minutes to serve a new version everywhere, so
if it fails, rerun it once; if it fails again, the candidate is on npm but broken: deprecate it as
in "Roll back" below and cut `rc.N+1`. Then, from an empty folder:

```sh
cd "$(mktemp -d)" && npx -y darnit@next --version   # prints X.Y.Z-rc.N
npm view darnit dist-tags                           # latest unchanged, next is X.Y.Z-rc.N
```

Any failure, here or below: fix it on `main` and cut `rc.N+1`. Never move or reuse a tag.

## Verify from every angle

One line per angle, all on the candidate:

- **Correctness:** full suite, fixtures and e2e on the release commit; CI green.
- **Real code:** re-scan the real repositories darnit is field-tested on, with the previous release
  and the candidate; every changed result is explained in the changelog.
- **Upgrade:** a repository set up by the previous release (`init` output, `darnit.yml`, workflow)
  still works unchanged with the candidate.
- **Install:** `npx -y darnit@next` and `npm install -g darnit@next` from a clean folder, on macOS
  and Linux, Node 22 and 24.
- **Live CI:** the workflow in darnit-sh/darnit-example, pointed at the candidate's exact version,
  passes a real Actions run.
- **Contract:** `--help`, exit codes and a `--json` sample diffed against the previous release; only
  additions.
- **Package:** the `npm pack --dry-run` file list diffed against the previous version; no stray or
  missing files.
- **Security:** a security pass of the release's changes, `npm audit --omit=dev`, and a secret scan
  of the release diff.
- **Docs:** README and darnit.sh claims re-checked against the candidate's real output, and every
  example re-read cold, as a newcomer would, and run as written.
- **Independent:** a reviewer who did not build the release tries to break the candidate from a
  clean folder.
- **Human:** a maintainer's hands-on check, then their explicit go.

## Promote

The final version is the verified candidate with only the version, the changelog and, for a new
minor, the README changed:

```sh
git switch -c release/X.Y.Z-final
npm version X.Y.Z --no-git-tag-version
# in CHANGELOG.md, add `## [X.Y.Z] - <release date>` under an empty `## [Unreleased]`, point
#   the `[Unreleased]` link at `vX.Y.Z...HEAD` and add an `[X.Y.Z]` link from the previous release
# for a new minor (X.Y.0) before 1.0, README.md's workflow examples become `npx darnit@X.Y check`
#   and `npx darnit@X.Y fix --pr`, with a one-line note on the pin; npm has no X.Y before this.
#   From 1.0 on, `init` pins the major, so for a new major (X.0.0) they become `npx darnit@X check`
#   and `npx darnit@X fix --pr`
# open the pull request, wait for CI to pass, merge it
git switch main && git pull
git log --oneline vX.Y.Z-rc.N..main                 # only the version pull request
git tag vX.Y.Z
git push origin vX.Y.Z
```

Approve the `npm` environment on the publish run as above and wait for its `verify` job to pass; if
it fails, rerun it once, and if it fails again, roll back (below). Then:

```sh
gh release create vX.Y.Z -R darnit-sh/darnit --verify-tag --title vX.Y.Z --notes-file notes.md
cd "$(mktemp -d)" && npx -y darnit@X.Y.Z --version
npm view darnit dist-tags                           # latest (or latest-X.Y for an older line) is X.Y.Z
```

`notes.md` holds the version's changelog entry. A candidate's `init` pins its exact version
(`darnit@X.Y.Z-rc.N`), so anyone who set up a repository with a candidate re-runs `init` or edits
the pin to `darnit@X.Y` (`darnit@X` from 1.0 on). Afterwards, watch the next scheduled run of the
darnit-sh/darnit-example workflow (`gh run list -R darnit-sh/darnit-example`) and check it passes.

## Roll back

Never unpublish: users and lockfiles may already depend on the version. From a maintainer's npm
account:

```sh
npm dist-tag add darnit@<good version> latest   # or latest-X.Y for a patch to an older line
npm deprecate darnit@<bad version> "<one-line reason>, use <good version>"
```

Then fix forward in the next patch release, through this same checklist, and note the bad version
and the fix in the changelog.
