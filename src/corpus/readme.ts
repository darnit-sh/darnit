import type { ChangeRecord } from "../records/schema.js";
import { modelNames } from "../scan/astgrep.js";

/** How many model names the records retire. */
export const retiringModels = (records: readonly ChangeRecord[]) =>
  new Set(records.flatMap((r) => Object.values(r.detection.astGrepPatterns).flatMap(modelNames))).size;

/** The README with its counts of change records and retiring models set from `records`, so a new record updates them in the same pull request. */
export const readmeCounts = (readme: string, records: readonly ChangeRecord[]) =>
  readme
    .replace(/(against )\d+( change records)/g, `$1${records.length}$2`)
    .replace(/(OpenAI: )\d+( retiring models)/g, `$1${retiringModels(records)}$2`);
