import { describe, expect, it } from "vitest";
import { exists, read, where } from "./docs.js";

// A path from the repository root: names joined by slashes, a trailing slash for a folder, or one file name with its
// extension, with `**`, `*` and placeholders such as `<vendor>` as test/docs.ts reads them.
const SHAPE = /^\/?[\w.*<>-]+(\/[\w.*<>-]*)*$/;
const FILE = /[\w-]\.(md|ts|js|mjs|cjs|json|ya?ml|tsv|sh|txt)$/;
const looksLikePath = (word: string) => SHAPE.test(word) && (word.includes("/") || FILE.test(word));

/**
 * Each path a markdown text names, with its offset: every word of a fenced block or a code span, every link target,
 * and every other word, table cells included, that has a path's shape.
 */
function namedPaths(md: string): { path: string; at: number }[] {
  const found: { path: string; at: number }[] = [];
  const words = (text: string, from: number) => {
    for (const w of text.matchAll(/\S+/g)) {
      const path = w[0].replace(/^[("'*_]+/, "").replace(/(?<![)"'*_,.;:])[)"'*_,.;:]+$/, "");
      if (looksLikePath(path)) found.push({ path, at: from + w.index + w[0].indexOf(path) });
    }
  };
  for (const m of md.matchAll(/^```[^\n]*\n([^]*?)^```|`([^`\n]+)`|\]\(([^)\s]+)\)|[^\s`|[\]()]+/gm)) {
    const [whole, fenced, span, link] = m;
    if (fenced !== undefined) words(fenced, m.index + whole.indexOf("\n") + 1);
    else if (span !== undefined) words(span, m.index + 1);
    else if (link !== undefined) words(link.replace(/#.*/, ""), m.index + 2);
    else words(whole, m.index);
  }
  return found;
}

describe("the paths ARCHITECTURE.md names", () => {
  it("are all tracked", async () => {
    const text = await read("ARCHITECTURE.md");
    const named = namedPaths(text);
    expect(named.map((n) => n.path)).toEqual(
      expect.arrayContaining([
        "src/cli.ts",
        "src/scan/",
        "scripts/allow/imports.tsv",
        "packs/<vendor>/<record>/change.json",
      ]),
    );
    expect(
      named
        .filter((n) => !exists(n.path))
        .map((n) => `${where(text, "ARCHITECTURE.md", n.at)}: names ${n.path}, which git does not track`),
    ).toEqual([]);
  });

  it("are found in code spans, table rows, fenced blocks, links and prose, with globs, placeholders and folders", () => {
    const md = [
      "A `src/a.ts` and (`src/b/`), `packs/*/c/` and `packs/<vendor>/d.json`, run `npx tsx scripts/e.ts`.",
      "| `src/f.ts` | 1 | src/g.ts |",
      "```\ncat src/h.ts\n```",
      "See [the guide](docs/i.md#top), CONTRIBUTING.md and scripts/j/.",
    ].join("\n");
    const paths = [
      "src/a.ts",
      "src/b/",
      "packs/*/c/",
      "packs/<vendor>/d.json",
      "scripts/e.ts",
      "src/f.ts",
      "src/g.ts",
      "src/h.ts",
      "docs/i.md",
      "CONTRIBUTING.md",
      "scripts/j/",
    ];
    const named = namedPaths(md);
    expect(named.map((n) => n.path)).toEqual(paths);
    for (const n of named) expect(md.slice(n.at, n.at + n.path.length)).toBe(n.path);
  });

  it("leave out commands, flags, tags, titles, links to the web and bare extensions", () => {
    const md =
      "`npm run check`, `--prepare`, `@ts-expect-error`, `jscpd:ignore`, `type(scope): what changed`, `Proof: none, <reason>`, `## [Unreleased]`, `.ts`, `Refusal`, https://example.com/a/b, [site](https://example.com/c.md), [up](#floors), e.g. one, 0 to 2.";
    expect(namedPaths(md)).toEqual([]);
  });

  it("must be tracked as named: a folder as a folder, a glob or placeholder matching something, inside the repository", () => {
    for (const path of [
      "src/cli.ts",
      "src/scan/",
      "src/scan",
      "scripts/allow/*.tsv",
      "packs/<vendor>/<record>/rules/js/",
      "packs/**/change.json",
      "packs/**/fixtures/",
      "./src/cli.ts",
      "ARCHITECTURE.md",
    ])
      expect(exists(path), path).toBe(true);
    for (const path of [
      "src/nope.ts",
      "src/cli.ts/",
      "scripts/allow/*.tsx",
      "packs/<vendor>/<record>/nope/",
      "../README.md",
      "src/./cli.ts",
      "/etc/hosts",
      "src//cli.ts",
      "packs/**/nope.json",
      "src/CLI.ts",
      "node_modules/vitest/package.json",
      "dist/cli.js",
    ])
      expect(exists(path), path).toBe(false);
  });
});
