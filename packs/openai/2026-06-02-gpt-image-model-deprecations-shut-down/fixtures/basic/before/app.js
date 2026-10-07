import OpenAI from "openai";

const openai = new OpenAI();

export const a0 = await openai.chat.completions.create({ model: "gpt-image-1-mini", messages });
export const b0 = await openai.chat.completions.create({ model: 'gpt-image-1-mini', messages });
export const a1 = await openai.chat.completions.create({ model: "gpt-image-1.5", messages });
export const b1 = await openai.chat.completions.create({ model: 'gpt-image-1.5', messages });
export const a2 = await openai.chat.completions.create({ model: "chatgpt-image-latest", messages });
export const b2 = await openai.chat.completions.create({ model: 'chatgpt-image-latest', messages });

// Near miss: a longer name is a different model.
export const near = await openai.chat.completions.create({ model: "gpt-image-1-mini-x", messages });
