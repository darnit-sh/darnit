import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("scripts/check-release.sh");
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const pr = (n: number, m = n) => `[#${n}](https://github.com/darnit-sh/darnit/pull/${m})`;

/** Runs check-release.sh for `version` in a folder holding `changelog`; outside git, so a passing changelog stops at the next gate. */
async function release(version: string, changelog: string) {
  const dir = await mkdtemp(join(tmpdir(), "darnit-release-"));
  tempDirs.push(dir);
  await writeFile(join(dir, "package.json"), JSON.stringify({ version }));
  await writeFile(join(dir, "CHANGELOG.md"), changelog);
  const r = spawnSync("sh", [script, `v${version}`, "0".repeat(40)], { cwd: dir, encoding: "utf8" });
  return { status: r.status, err: r.stderr };
}
const passedChangelog = (err: string) => !err.includes("CHANGELOG.md") && err.includes("is not on main");

const changelog = (unreleased: string, older = `- First release.`) =>
  `# Changelog\n\n## [Unreleased]\n\n### Added\n\n${unreleased}\n\n## [0.1.0] - 2026-10-07\n\n### Added\n\n${older}\n\n[Unreleased]: https://github.com/darnit-sh/darnit/compare/v0.1.0...HEAD\n`;

describe("check-release.sh changelog links", () => {
  it("fails a candidate naming each bullet in [Unreleased] with no pull request link", async () => {
    const r = await release("0.2.0-rc.1", changelog(`- Linked. (${pr(12)})\n- Not linked.\n\n### Fixed\n\n- Also not linked (#13)`));
    expect(r.status).toBe(1);
    expect(r.err).toContain("CHANGELOG.md [Unreleased] has a line with no pull request link: - Not linked.");
    expect(r.err).toContain("no pull request link: - Also not linked (#13)");
    expect(r.err).not.toContain("Linked. (");
    expect(r.err).not.toContain("is not on main");
  });

  it("passes when every bullet ends with its links, any number to a line, and over two lines", async () => {
    const r = await release(
      "0.2.0-rc.1",
      changelog(
        `- One. (${pr(12)})\n- Three. (${pr(13)}, ${pr(14)}, ${pr(16)})\n* Wrapped\n  over two lines. (${pr(15)})  `,
        "- Older, unlinked.",
      ),
    );
    expect(r.err).toSatisfy(passedChangelog);
  });

  it.each([
    ["a link to another number than it names", `- Off. (${pr(12, 13)})`],
    ["a link not at the end", `- Early (${pr(12)}) then more.`],
    ["a link to another repository", `- Elsewhere. ([#12](https://github.com/other/darnit/pull/12))`],
    ["a wrapped line whose link is not on the last line", `- Wrapped (${pr(12)})\n  then more.`],
    ["a nested bullet", `- Top. (${pr(12)})\n  - Nested.`],
    ["a bullet whose nested bullet links but it does not", `- Top.\n  - Nested. (${pr(12)})`],
  ])("fails %s", async (_, line) => {
    const r = await release("0.2.0-rc.1", changelog(line));
    expect(r.status).toBe(1);
    expect(r.err).toContain("no pull request link");
  });

  it("checks a final version's own section, not [Unreleased]", async () => {
    const final = `# Changelog\n\n## [Unreleased]\n\n- Next, unlinked.\n\n## [0.2.0] - 2026-11-01\n\n### Fixed\n\n`;
    expect((await release("0.2.0", `${final}- Fixed. (${pr(12)})\n`)).err).toSatisfy(passedChangelog);
    const r = await release("0.2.0", `${final}- Fixed, unlinked.\n`);
    expect(r.status).toBe(1);
    expect(r.err).toContain("CHANGELOG.md [0.2.0] has a line with no pull request link: - Fixed, unlinked.");
  });

  it("fails when the section being released is missing", async () => {
    const r = await release("0.3.0", changelog(`- One. (${pr(12)})`));
    expect(r.status).toBe(1);
    expect(r.err).toContain("CHANGELOG.md has no ## [0.3.0] section");
  });

  it("reads Windows line endings and fails plainly with no CHANGELOG.md", async () => {
    expect((await release("0.2.0-rc.1", changelog(`- One. (${pr(12)})\n- Two.`).replaceAll("\n", "\r\n"))).err).toContain(
      "no pull request link: - Two.",
    );
    const dir = await mkdtemp(join(tmpdir(), "darnit-release-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.2.0-rc.1" }));
    const r = spawnSync("sh", [script, "v0.2.0-rc.1", "0".repeat(40)], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toBe("::error::CHANGELOG.md has no ## [Unreleased] section");
  });
});
