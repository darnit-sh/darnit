import OpenAI from "openai";

const openai = new OpenAI();

export const a0 = await openai.chat.completions.create({ model: "gpt-5.3-codex", messages });
export const b0 = await openai.chat.completions.create({ model: 'gpt-5.3-codex', messages });
export const a1 = await openai.chat.completions.create({ model: "gpt-5.4-nano", messages });
export const b1 = await openai.chat.completions.create({ model: 'gpt-5.4-nano', messages });
export const a2 = await openai.chat.completions.create({ model: "gpt-5.1", messages });
export const b2 = await openai.chat.completions.create({ model: 'gpt-5.1', messages });

// Near miss: a longer name is a different model.
export const near = await openai.chat.completions.create({ model: "gpt-5.3-codex-x", messages });
