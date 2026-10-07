import OpenAI from "openai";

const openai = new OpenAI();

export const a0 = await openai.chat.completions.create({ model: "gpt-4o-realtime-preview-2024-10-01", messages });
export const b0 = await openai.chat.completions.create({ model: 'gpt-4o-realtime-preview-2024-10-01', messages });

// Near miss: a longer name is a different model.
export const near = await openai.chat.completions.create({ model: "gpt-4o-realtime-preview-2024-10-01-x", messages });
