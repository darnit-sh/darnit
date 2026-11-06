import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll } from "vitest";

// No test, and no process a test starts, can read a credential of whoever runs the suite. A test that
// needs a token sets a fake one itself.
const TOKEN_VARS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_HOST",
  "SSH_AUTH_SOCK",
];

const dir = mkdtempSync(join(tmpdir(), "darnit-no-credentials-"));
for (const k of TOKEN_VARS) delete process.env[k];
// gh reads its stored login from here, not from HOME, so HOME stays as it is for npm, git and tsx.
process.env.GH_CONFIG_DIR = join(dir, "gh");
mkdirSync(process.env.GH_CONFIG_DIR);
// With no login in its config, gh still reads the system keyring, so the real gh never runs; a test
// that puts its own gh first on PATH still gets it.
mkdirSync(join(dir, "bin"));
writeFileSync(join(dir, "bin", "gh"), `#!/bin/sh\necho 'gh: not run in the tests' >&2\nexit 1\n`, { mode: 0o755 });
process.env.PATH = `${join(dir, "bin")}${delimiter}${process.env.PATH}`;
// No credential helper from the user's or the system's git config.
process.env.GIT_CONFIG_GLOBAL = join(dir, "gitconfig");
writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
process.env.GIT_CONFIG_NOSYSTEM = "1";

afterAll(() => rmSync(dir, { recursive: true, force: true }));
