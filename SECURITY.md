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

Only the newest 0.2 release gets security fixes. On an older version, update to the latest 0.2
release.

| Version | Security fixes |
|---|---|
| Newest 0.2.x | Yes |
| Older 0.2.x | No, update to the latest 0.2 release |
| 0.1.x and older | No, update to the latest 0.2 release |

Workflows written by `darnit init` from a 0.2 release run `npx darnit@0.2`, so they pick up a new
0.2 release on their next run.

## What counts

- `check` or `init` running code from the repository they read.
- Anything in a repository (a file, a file name, a link, `darnit.yml`) that makes darnit write
  outside the repository, leave a finding out of its report, or put live content in a terminal, a
  workflow log or a pull request: escape codes, workflow commands, links, mentions or HTML.
- darnit's GitHub token reaching the repository's own commands, or being sent anywhere other than
  api.github.com.
- A weakness in how darnit is built and published: this repository's workflows and the npm
  package.

## What does not

- `fix` runs your repository's build and test commands; that is its job. Run `fix` only on
  repositories whose code you would run yourself.
- Problems in a vendor's API or SDK.
- Problems in a dependency that darnit does not reach. Report those upstream, and tell us if
  darnit is affected.
- Attacks that need someone who can already change your workflow files or your machine.

## How we handle a report

1. We confirm the problem with a test that shows it.
2. We fix it in private and release the fix through the steps in [RELEASING.md](RELEASING.md).
3. For a problem in a released version, we publish a GitHub security advisory, request a CVE,
   and mark affected versions as deprecated on npm.

We disclose within 90 days of the report, and sooner once a fix is out. If a problem is being
exploited, we publish a fix or a workaround as soon as we have one.
