import OpenAI from "openai";

const openai = new OpenAI();

export const a0 = await openai.chat.completions.create({ model: "gpt-5-2025-08-07", messages });
export const b0 = await openai.chat.completions.create({ model: 'gpt-5-2025-08-07', messages });
export const a1 = await openai.chat.completions.create({ model: "gpt-5-mini-2025-08-07", messages });
export const b1 = await openai.chat.completions.create({ model: 'gpt-5-mini-2025-08-07', messages });
export const a2 = await openai.chat.completions.create({ model: "gpt-5-nano-2025-08-07", messages });
export const b2 = await openai.chat.completions.create({ model: 'gpt-5-nano-2025-08-07', messages });
export const a3 = await openai.chat.completions.create({ model: "gpt-5-pro-2025-10-06", messages });
export const b3 = await openai.chat.completions.create({ model: 'gpt-5-pro-2025-10-06', messages });
export const a4 = await openai.chat.completions.create({ model: "o3-2025-04-16", messages });
export const b4 = await openai.chat.completions.create({ model: 'o3-2025-04-16', messages });
export const a5 = await openai.chat.completions.create({ model: "o3-pro-2025-06-10", messages });
export const b5 = await openai.chat.completions.create({ model: 'o3-pro-2025-06-10', messages });

// Near miss: a longer name is a different model.
export const near = await openai.chat.completions.create({ model: "gpt-5-2025-08-07-x", messages });
