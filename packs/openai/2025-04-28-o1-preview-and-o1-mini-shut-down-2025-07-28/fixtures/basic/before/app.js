import OpenAI from "openai";

const openai = new OpenAI();

export const a0 = await openai.chat.completions.create({ model: "o1-preview", messages });
export const b0 = await openai.chat.completions.create({ model: 'o1-preview', messages });

// Near miss: a longer name is a different model.
export const near = await openai.chat.completions.create({ model: "o1-preview-x", messages });
