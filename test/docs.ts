import { readFile } from "node:fs/promises";

/** A file of this repository, by its path from the root. */
export const read = (file: string) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

/** `file:line: text` for the line of `text` that holds offset `at`. */
export const where = (text: string, file: string, at: number) => {
  const n = text.slice(0, at).split("\n").length;
  return `${file}:${n}: ${text.split("\n")[n - 1]!.trim()}`;
};
