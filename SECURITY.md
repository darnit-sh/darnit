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
- Run inside a repository, `npx darnit` may use a darnit from that repository's `node_modules`, or
  settings such as the registry from its `.npmrc`. On code you do not trust, install darnit from
  outside the repository (`npm install -g darnit`) and run `darnit check` in it.
- Problems in a vendor's API or SDK.
- Problems in a dependency that darnit does not reach. Report those upstream, and tell us if
  darnit is affected.
- Attacks that need someone who can already change your workflow files or your machine.

In the README's `fix --pr` workflow, your install scripts and tests run in the job that holds the
GitHub token. The token is not in their environment, on disk or in the pull request, but a process
there can still read darnit's own environment, and the token with it. On code you do not trust, run
`check` only. A workflow that runs the tests in a separate job without the token is planned.

## How we handle a report

1. We confirm the problem with a test that shows it.
2. We keep the report private while we prepare the fix, then land it and release it at once
   through the steps in [RELEASING.md](RELEASING.md).
3. For a problem in a released version, we publish a GitHub security advisory, request a CVE,
   and mark affected versions as deprecated on npm.

We aim to disclose within 90 days of the report, and sooner once a fix is out. If a problem is being
exploited, we publish a fix or a workaround as soon as we have one.
