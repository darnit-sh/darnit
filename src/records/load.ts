import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseChangeRecord, type ChangeRecord } from "./schema.js";

// Resolves to <repo>/packs both from src/ (tsx) and from dist/ (built).
export const PACKS_DIR = fileURLToPath(new URL("../../packs/", import.meta.url));

export type LoadedRecord = {
  record: ChangeRecord;
  /** Absolute path of the pack directory holding change.json. */
  packDir: string;
  /** Path of change.json relative to the packs root, for messages. */
  file: string;
};

/** Loads every packs/<vendor>/<pack>/change.json, validated. Throws on the first invalid record. */
export async function loadRecords(packsDir: string = PACKS_DIR): Promise<LoadedRecord[]> {
  const files = (await readdir(packsDir, { recursive: true })).filter((f) => f.endsWith("/change.json"));
  const loaded = await Promise.all(
    files.map(async (file) => ({
      record: parseChangeRecord(JSON.parse(await readFile(join(packsDir, file), "utf8")), file),
      packDir: join(packsDir, dirname(file)),
      file,
    })),
  );
  return loaded.sort((a, b) => a.record.id.localeCompare(b.record.id));
}
