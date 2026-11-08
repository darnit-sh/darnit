import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { escapeRegExp } from "../src/detect.js";

/** A file of this repository, by its path from the root. */
export const read = (file: string) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

/** `file:line: text` for the line of `text` that holds offset `at`. */
export const where = (text: string, file: string, at: number) => {
  const n = text.slice(0, at).split("\n").length;
  return `${file}:${n}: ${text.split("\n")[n - 1]!.trim()}`;
};

// The files git tracks and their folders, so what only this checkout holds (node_modules/, dist/) does not count,
// and a name matches only in the case git stores it, whatever the disk does.
let tracked: { files: string[]; folders: string[] } | undefined;
const index = () => {
  if (tracked) return tracked;
  const root = fileURLToPath(new URL("../", import.meta.url));
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 2 ** 28 })
    .split("\0")
    .filter(Boolean);
  const folders = new Set(
    files.flatMap((f) =>
      f
        .split("/")
        .slice(0, -1)
        .map((_, i, names) => names.slice(0, i + 1).join("/")),
    ),
  );
  return (tracked = { files, folders: [...folders] });
};

const wild = (part: string) => (part === "*" ? "[^/]*" : "[^/]+");
const one = (name: string) =>
  name
    .split(/(\*|<(?<!<[^>]*?<)[^>]*>)/)
    .map((part, i) => (i % 2 === 0 ? escapeRegExp(part) : wild(part)))
    .join("");
const segment = (name: string, last: boolean) => {
  if (name === "**") return last ? ".+" : "(?:[^/]+/)*";
  return last ? one(name) : `${one(name)}/`;
};
/** A path's names as a pattern: `**` spans any number of folders, `*` and a placeholder such as `<vendor>` part of one name. */
const pattern = (names: string[]) =>
  new RegExp(`^${names.map((n, i) => segment(n, i === names.length - 1)).join("")}$`);

/** Whether a path from the root, `./` allowed, names a tracked file or folder; with a trailing slash it must be a folder. */
export function exists(path: string): boolean {
  const names = path.replace(/^\.\//, "").replace(/\/$/, "").split("/");
  if (names.some((n) => n === "" || n === "." || n === "..")) return false;
  const at = pattern(names);
  const { files, folders } = index();
  return folders.some((f) => at.test(f)) || (!path.endsWith("/") && files.some((f) => at.test(f)));
}
