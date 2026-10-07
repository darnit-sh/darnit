import OpenAI from "openai";

const openai = new OpenAI();

export const r1 = await openai.chat.completions.create({ model: "gpt-5.1", messages });
export const r2 = await openai.chat.completions.create({ model: 'gpt-5.1', messages });
export const r3 = await openai.chat.completions.create({ model: "gpt-5.3-codex", messages });
export const r4 = await openai.chat.completions.create({ model: 'gpt-5.3-codex', messages });
export const r5 = await openai.chat.completions.create({ model: "gpt-5.4-nano", messages });
export const r6 = await openai.chat.completions.create({ model: 'gpt-5.4-nano', messages });

// Near misses: other names, not part of this shutdown.
export const near1 = await openai.chat.completions.create({ model: "gpt-5.1-mini", messages });
export const near2 = await openai.chat.completions.create({ model: "gpt-5.1-codex", messages });
export const near3 = await openai.chat.completions.create({ model: "gpt-5.4-nano-2026-01-01", messages });
