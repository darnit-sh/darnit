import { z } from "zod";

// Absent fields are omitted, never null; hence .optional() throughout
// and .strict() so a typo'd key fails loudly instead of being silently ignored.

export const LANGS = ["js", "py"] as const;
export const LangSchema = z.enum(LANGS);
export type Lang = z.infer<typeof LangSchema>;

// Always context + selector. A bare pattern like `max_tokens: $N` parses as a
// labeled statement, not an object pair, and matches nothing without complaint.
export const AstGrepPatternSchema = z
  .object({
    context: z.string().min(1),
    selector: z.string().min(1),
  })
  .strict();
export type AstGrepPattern = z.infer<typeof AstGrepPatternSchema>;

const IsoDate = z.iso.date();
const Version = z.string().regex(/^\d+\.\d+\.\d+$/, "versions are x.y.z");

export const ChangeRecordSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9-]+:\d{4}-\d{2}-\d{2}:[a-z0-9-]+$/, "id must be <vendor>:<YYYY-MM-DD>:<slug>"),
    /** One human sentence, used for report headings, commit subjects and pull request titles. */
    title: z.string().min(1).max(100).optional(),
    /**
     * "candidate": produced from a spec diff, not yet reviewed. "parser-verified": generated from the
     * vendor's own page and confirmed by a second, separate parser, not yet read by a person.
     * Only reviewed records drive fix.
     */
    status: z.enum(["candidate", "parser-verified", "reviewed"]),
    vendor: z.string().min(1),
    announcedAt: IsoDate,
    effectiveAt: IsoDate.optional(),
    kind: z.enum(["breaking", "behavioral", "deprecation", "additive"]),
    surface: z
      .object({
        endpoints: z.array(z.string().min(1)).optional(),
        sdkSymbols: z.array(z.string().min(1)).optional(),
        fields: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .refine((s) => s.sdkSymbols?.length || s.endpoints?.length, "surface needs sdkSymbols or endpoints, or matches are not tied to the vendor"),
    classification: z.enum(["mechanical", "semantic", "unfixable"]),
    sources: z
      .array(
        z
          .object({
            // Rendered into pull requests and commit messages, so plain https only.
            url: z.url({ protocol: /^https$/ }).regex(/^[^\s<>[\]()`]+$/, "url must not contain spaces, brackets or backticks"),
            quoteId: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1, "every record cites at least one source"),
    detection: z
      .object({
        astGrepPatterns: z.partialRecord(LangSchema, z.array(AstGrepPatternSchema).min(1)),
      })
      .strict()
      .refine(
        (d) => Object.values(d.astGrepPatterns).some((p) => p !== undefined && p.length > 0),
        "detection needs at least one pattern in at least one language",
      ),
    fix: z
      .object({
        rulePackPath: z.string().min(1).optional(),
        agentBriefPath: z.string().min(1).optional(),
        /** Oldest package version the rewritten code works with, per ecosystem. */
        requires: z
          .object({
            npm: z.record(z.string().min(1), Version).optional(),
            pypi: z.record(z.string().min(1), Version).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    notes: z
      .object({
        migration: z.string().optional(),
        removalDate: z.string().optional(),
        edgeCases: z.array(z.string()).optional(),
        citationQuality: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((r) => r.id.startsWith(`${r.vendor}:${r.announcedAt}:`), {
    message: "id must be <vendor>:<announcedAt>:<slug> and agree with the vendor/announcedAt fields",
    path: ["id"],
  });

export type ChangeRecord = z.infer<typeof ChangeRecordSchema>;

export class ChangeRecordError extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`invalid ChangeRecord at ${file}:\n${detail}`);
    this.name = "ChangeRecordError";
  }
}

export function parseChangeRecord(json: unknown, file: string): ChangeRecord {
  const result = ChangeRecordSchema.safeParse(json);
  if (!result.success) throw new ChangeRecordError(file, z.prettifyError(result.error));
  return result.data;
}
