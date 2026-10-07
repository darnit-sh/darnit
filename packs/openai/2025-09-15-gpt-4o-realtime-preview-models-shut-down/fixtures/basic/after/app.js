import OpenAI from "openai";

const openai = new OpenAI();

export const a0 = await openai.chat.completions.create({ model: "gpt-4o-realtime-preview", messages });
export const b0 = await openai.chat.completions.create({ model: 'gpt-4o-realtime-preview', messages });
export const a1 = await openai.chat.completions.create({ model: "gpt-4o-realtime-preview-2025-06-03", messages });
export const b1 = await openai.chat.completions.create({ model: 'gpt-4o-realtime-preview-2025-06-03', messages });
export const a2 = await openai.chat.completions.create({ model: "gpt-4o-realtime-preview-2024-12-17", messages });
export const b2 = await openai.chat.completions.create({ model: 'gpt-4o-realtime-preview-2024-12-17', messages });
export const a3 = await openai.chat.completions.create({ model: "gpt-4o-mini-realtime-preview", messages });
export const b3 = await openai.chat.completions.create({ model: 'gpt-4o-mini-realtime-preview', messages });
export const a4 = await openai.chat.completions.create({ model: "gpt-4o-audio-preview", messages });
export const b4 = await openai.chat.completions.create({ model: 'gpt-4o-audio-preview', messages });
export const a5 = await openai.chat.completions.create({ model: "gpt-4o-mini-audio-preview", messages });
export const b5 = await openai.chat.completions.create({ model: 'gpt-4o-mini-audio-preview', messages });

// Near miss: a longer name is a different model.
export const near = await openai.chat.completions.create({ model: "gpt-4o-realtime-preview-x", messages });
