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
level the tree is at, and keeps the bytes of each file it rewrote. It then builds the commit from those
bytes alone, on that commit, in an index of its own, with replace refs off and no filter, hook or signing
program run, checks that it changes exactly those files, and pushes that commit id alone, with no tags
following it. What the tests do to the work tree, the index, HEAD, refs, `core.worktree` or a nested
repository therefore cannot change what is pushed. Each change starts from its files as committed: when
an earlier change's build or tests changed them, or when a rewritten file on disk differs afterwards, is a
link or has a second name, darnit opens no pull request for that change and says why. Git config the
tests write, or a process they leave running writes, still applies to that commit and push: the author
and committer name and email, and where the push goes with what credentials, as above. Such a process
could also rewrite the object files darnit reads the starting commit from, since git does not check an
object against its id when reading it. Commits, staged changes and config the tests make stay in the
repository.

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

## How we handle a report

1. We confirm the problem with a test that shows it.
2. We keep the report private while we prepare the fix, then land it and release it at once
   through the steps in [RELEASING.md](RELEASING.md).
3. For a problem in a released version, we publish a GitHub security advisory, request a CVE,
   and mark affected versions as deprecated on npm.

We aim to disclose within 90 days of the report, and sooner once a fix is out. If a problem is being
exploited, we publish a fix or a workaround as soon as we have one.
