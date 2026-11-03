import OpenAI from "openai";

const openai = new OpenAI();

export const a0 = await openai.chat.completions.create({ model: `o1-mini`, messages });
export const b0 = await openai.chat.completions.create({ messages, model: options.model ?? `o1-mini` });

// Near misses: a template with code in it, and a longer name.
export const near = await openai.chat.completions.create({ model: `o1-${size}`, messages });
export const far = await openai.chat.completions.create({ model: `o1-mini-x`, messages });
