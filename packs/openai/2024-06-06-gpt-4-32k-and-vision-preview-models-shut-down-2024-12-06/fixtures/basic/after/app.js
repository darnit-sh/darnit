import OpenAI from "openai";

const openai = new OpenAI();

export const a0 = await openai.chat.completions.create({ model: "gpt-4-vision-preview", messages });
export const b0 = await openai.chat.completions.create({ model: 'gpt-4-vision-preview', messages });
export const a1 = await openai.chat.completions.create({ model: "gpt-4-1106-vision-preview", messages });
export const b1 = await openai.chat.completions.create({ model: 'gpt-4-1106-vision-preview', messages });

// Near miss: a longer name is a different model.
export const near = await openai.chat.completions.create({ model: "gpt-4-vision-preview-x", messages });
