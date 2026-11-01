# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Use
[Report a vulnerability](https://github.com/darnit-sh/darnit/security/advisories/new)
on the Security tab, or email darnit.project@gmail.com.

Tell us the darnit version (`darnit --version`), the command you ran, and, if you can, a
repository or file that shows the problem.

We reply within 3 days. Once we confirm the problem we share our plan, keep you posted, and credit
you in the advisory and the changelog unless you would rather we did not.

## Supported versions

Security fixes go into the newest 0.2 release. 0.1.x and older get none.

| Version | Security fixes |
|---|---|
| Newest 0.2.x | Yes |
| Older 0.2.x | No |
| 0.1.x and older | No |

Workflows written by `darnit init` from a final 0.2 release run `npx darnit@0.2`, so they pick up a
new 0.2 release on their next run.

## What counts

- darnit's own `check` or `init` code running code from the repository they read.
- Anything in a repository (a file, a file name, a link, `darnit.yml`) that makes darnit write
  outside the repository, skip part of the repository without naming it in its report, or put
  live content in a terminal, a workflow log or a pull request: escape codes, workflow commands,
  links, mentions or HTML.
- darnit's GitHub token reaching the repository's own commands, or being sent anywhere other than
  api.github.com.
- A weakness in how darnit is built and published: this repository's workflows and the npm
  package.

## What does not

- `fix` runs your repository's build and test commands; that is its job. Run `fix` only on
  repositories whose code you would run yourself.
- Run inside a repository, `npx darnit` trusts that repository: a darnit in its `node_modules` or a
  setting in its `.npmrc` can run its code before darnit starts. On code you do not trust, run
  `check` only, from outside the repository, with its path: `darnit check path/to/repo` after
  `npm install -g darnit`, or `npx darnit check path/to/repo` from another folder. The workflow
  `darnit init` writes starts npx from `$RUNNER_TEMP` for this reason.
- Problems in a vendor's API or SDK.
- Problems in a dependency that darnit does not reach. Report those upstream, and tell us if
  darnit is affected.
- Attacks that need someone who can already change your workflow files or your machine.

In the README's `fix --pr` workflow, your install scripts and tests run in the job that holds the
GitHub token. The token is not in their environment, on disk or in the pull request, but a process
there can still read darnit's own environment, and the token with it. Git config they write to the
repository can also send darnit's git calls to GitHub, and the token with them, to another server,
for example `http.curloptResolve` pointing github.com at another address with
`http.sslVerify false`. The README workflow cannot prevent either. On code you do not trust, run
`check` only.

`fix --pr` pushes darnit's rewrite only. Before the build and tests run, it notes the commit and top
level the tree is at, and stages each file it rewrote as `git add` would, with the line-ending and
encoding settings in force then and no filter driver run, in an index and work tree of its own read from
that commit. It first stages the file as it was, which must change nothing, so the settings are the ones
the committed file was stored with. After the checks it commits that index on that commit, with replace
refs off and no hook or signing program run, checks that the commit changes exactly the staged files,
and pushes that commit id alone, with no tags following it. What the tests do to the work tree, the
index, HEAD, refs, git's line-ending settings, `core.worktree` or a nested repository therefore cannot
change what is pushed. When an earlier change's build or tests changed a later change's files or how git
stores them, or when a rewritten file on disk differs afterwards, darnit opens no pull request for that
change and says why. Git config the tests write, or a process they leave running writes, still applies
to that commit and push: the author and committer name and email, and where the push goes with what
credentials, as above. Such a process could also rewrite the object files darnit reads the starting
commit from, since git does not check an object against its id when reading it. Commits, staged changes
and config the tests make stay in the repository.

darnit needs git 2.31 or newer, the first version that reads the config below from its environment;
on an older git it refuses to run rather than silently skip the pins.

A repository's own config (`.git/config` and the files it includes) can name programs git would
otherwise run inside darnit's own git calls, even under `--no-test`. In its own calls darnit turns
these off: no hooks (`core.hooksPath`), no `core.fsmonitor`, no gpg signing of a commit or on push
(`commit.gpgSign`, `push.gpgSign`, so `gpg.program` and `gpg.ssh.program` never run), no external
diff or textconv (`diff.external`, a `diff.<driver>.command` or `.textconv`), and no clean/smudge/
process filter (`filter.<driver>.*`). Filters are keyed by driver name, so darnit reads the names git
would use and turns each off in the child's environment, where a name holding `=` (which a
command-line `-c filter.<name>.clean=` would split) stays intact; a repository that configures more
filter drivers than darnit will handle, whose filter config cannot be read whole, or that names a
driver with bytes that are not valid UTF-8 (which darnit cannot carry back through the environment),
is refused rather than run. A status or diff does not descend into a submodule
(`--ignore-submodules=all`), and darnit never pushes a submodule from its own push
(`push.recurseSubmodules=no`, which also overrides a repository's `submodule.recurse=true`), so a
submodule's own filters and remote helper never run and the token never reaches them; darnit passes no
`--recurse-submodules` and checks out no submodule path. A pager (`core.pager`, `pager.*`) never starts because darnit captures git's
output rather than writing to a terminal. darnit's own commit therefore does not run the repository's
commit hooks; they are repository code, and `fix --pr` runs the repository's tests separately. This
does not cover config that only matters on a call that reaches origin, which darnit makes only to push
or query its own remote: `core.sshCommand`, a credential helper or `core.askPass`, `core.gitProxy`,
`remote.<name>.uploadpack`/`receivepack`/`vcs`, `protocol.ext.allow`, and an http header or URL that
carries a credential. Those are the token-handling surface above; on code you do not trust, run
`check` only.

`fix --prepare` runs the repository's code, and its plan is uploaded for another job to read, so its
job must hold no secrets at all: no token or other secret in its environment or git config, and no
`id-token: write`. darnit refuses to start when it finds one in these places only: `GITHUB_TOKEN` or
`GH_TOKEN`; `GIT_SSH_COMMAND`, `GIT_SSH`, `SSH_AUTH_SOCK` or the legacy `GIT_CONFIG`; and, in git
config as git reads it in the repository (every scope, config passed in darnit's environment and
every file they include), an http extra header, `core.sshCommand`, or an http or https URL with a
user name or password. Other places are not checked, such as an inline `credential.helper`,
`credential.helper=store` and its credentials file, `core.askPass`, `credential.<url>.username`, a
URL with another scheme, any other environment variable, and config files hidden from git by
`GIT_CONFIG_NOSYSTEM` or `GIT_CONFIG_GLOBAL=/dev/null` that the repository's code can still read. A
secret in any of them can reach the plan through test output.

`fix --publish` holds the token and runs none of the repository's code: no install, build, tests or
git hooks. It reads none of the folder it is run from, so a reused self-hosted workspace cannot steer
it. Instead it makes its own clone: in a new temporary folder it fetches only the plan's commit from
`https://github.com/<owner>/<repo>.git`, recomputes each rewrite there, and pushes to that same URL.
The job runs three programs: git, `gh`, and the bundled ast-grep that applies darnit's rewrite
rules. git and `gh` are each resolved once to an absolute real path (`realpath`) from an absolute
`PATH` entry, never by bare name, and refused when that path lies under a folder this job controls
(the current folder, `GITHUB_WORKSPACE`, or the temp root), compared by real path so a symlink, a
`..` or a case difference cannot slip past; so a `git` or `gh` the commit ships or the checkout holds
cannot be run. ast-grep is darnit's own pinned dependency, run from its absolute path in
`node_modules`. git runs with the process started outside the work tree and the work tree named by
`-C`. Every one of the three runs with an environment built from an allowlist, not from
`process.env`: only `PATH`, locale and temp-folder variables carry over, so no credential, no `GIT_*`
variable (a trace, config or replace setting), no `SSH_ASKPASS` and nothing else inherited reaches
them. git additionally gets darnit's own hardening: `GIT_CONFIG_NOSYSTEM`, an empty global config,
`HOME` and `XDG_CONFIG_HOME` in an empty folder, `GIT_NO_REPLACE_OBJECTS`, and pins that turn off
hooks, fsmonitor, gpg signing and submodule push (a filter needs no pin because the fresh clone names
none); the git version check at the start runs under the same allowlist. `gh auth token`, run only
when no token is set, gets the allowlist plus `HOME`, `XDG_CONFIG_HOME` and `GH_CONFIG_DIR`, the
folders gh reads its own login from, and nothing else. The token reaches git only as an http header
scoped to github.com. It trusts darnit's own install (its code, records and rewrite rules) and,
through that header, that github.com serves the real commit and accepts the push. It does not trust
the workspace, the machine's user or system git config, or the plan: it applies nothing from the
plan, makes each change again and compares it with the plan's patch byte for byte, and treats the
build and test results and notes as text to report. A plan can still say tests passed when they did
not; the pull request then holds darnit's own change only on top of the published commit, and says
the verify job reported the results. That commit must be the one the job is meant to publish, not any
commit the remote serves by id (github.com serves every commit in a fork network): in GitHub Actions
it must equal `GITHUB_SHA`; outside Actions it must be the tip of the repository's default branch on
the remote, read only from the ref named exactly `HEAD` in `git ls-remote <url> HEAD` before anything
is fetched. `--publish` does not run when `GITHUB_SERVER_URL` names a GitHub host other than
github.com, where the token's header would not apply.

## How we handle a report

1. We confirm the problem with a test that shows it.
2. We keep the report private while we prepare the fix, then land it and release it at once
   through the steps in [RELEASING.md](RELEASING.md).
3. For a problem in a released version, we publish a GitHub security advisory, request a CVE,
   and mark affected versions as deprecated on npm.

We aim to disclose within 90 days of the report, and sooner once a fix is out. If a problem is being
exploited, we publish a fix or a workaround as soon as we have one.
