import { readdir, readFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compilePatterns } from "../scan/astgrep.js";
import { ChangeRecordError, parseChangeRecord, type AstGrepPattern, type ChangeRecord, type Lang } from "./schema.js";

// Resolves to <repo>/packs both from src/ (tsx) and from dist/ (built).
export const PACKS_DIR = fileURLToPath(new URL("../../packs/", import.meta.url));

export type LoadedRecord = {
  record: ChangeRecord;
  /** Absolute path of the pack directory holding change.json. */
  packDir: string;
  /** Path of change.json relative to the packs root, for messages. */
  file: string;
};

/** A record whose patterns ast-grep cannot compile, in any language, does not load: it would throw on every file of that language. */
function compiled(record: ChangeRecord, file: string): ChangeRecord {
  for (const [lang, patterns] of Object.entries(record.detection.astGrepPatterns) as [Lang, AstGrepPattern[]][]) {
    try {
      compilePatterns(lang, patterns);
    } catch (err) {
      throw new ChangeRecordError(file, `${record.id}: ${(err as Error).message}`);
    }
  }
  return record;
}

/** Loads every packs/<vendor>/<pack>/change.json, validated and its patterns compiled. Throws on the first invalid record. */
export async function loadRecords(packsDir: string = PACKS_DIR): Promise<LoadedRecord[]> {
  const files = (await readdir(packsDir, { recursive: true }))
    .map((f) => f.split(sep).join("/"))
    .filter((f) => f.endsWith("/change.json"));
  const loaded = await Promise.all(
    files.map(async (file) => ({
      record: compiled(parseChangeRecord(JSON.parse(await readFile(join(packsDir, file), "utf8")), file), file),
      packDir: join(packsDir, dirname(file)),
      file,
    })),
  );
  return loaded.sort((a, b) => a.record.id.localeCompare(b.record.id));
}
