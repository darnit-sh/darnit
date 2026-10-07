import OpenAI from "openai";

const openai = new OpenAI();

export const a0 = await openai.chat.completions.create({ model: "tts-1", messages });
export const b0 = await openai.chat.completions.create({ model: 'tts-1', messages });
export const a1 = await openai.chat.completions.create({ model: "tts-1-hd", messages });
export const b1 = await openai.chat.completions.create({ model: 'tts-1-hd', messages });
export const a2 = await openai.chat.completions.create({ model: "gpt-4o-mini-tts-2025-03-20", messages });
export const b2 = await openai.chat.completions.create({ model: 'gpt-4o-mini-tts-2025-03-20', messages });
export const a3 = await openai.chat.completions.create({ model: "gpt-4o-mini-tts-2025-12-15", messages });
export const b3 = await openai.chat.completions.create({ model: 'gpt-4o-mini-tts-2025-12-15', messages });

// Near miss: a longer name is a different model.
export const near = await openai.chat.completions.create({ model: "tts-1-x", messages });
