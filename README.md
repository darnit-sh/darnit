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
darnit fix      # apply a tested rewrite and open a pull request with the results attached (in progress)
```

`darnit check` exits with status 1 when something is affected, so the scheduled
workflow fails the day a change lands and GitHub lets you know.

## What darnit knows

Every change darnit can report lives in `packs/`, one folder per vendor per
change. Each holds a description of the change with a link to the vendor's own
announcement, the rewrite rules, and before/after examples that must pass in CI.
A rule that changes nothing when its examples expect a change fails the build.

What darnit does not see: an options object built in one place and passed to the
API call by name. Those call sites are listed as unchecked rather than guessed at.

## License

Apache-2.0
