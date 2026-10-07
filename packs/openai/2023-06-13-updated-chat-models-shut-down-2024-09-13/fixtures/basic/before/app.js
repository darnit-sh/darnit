import OpenAI from "openai";

const openai = new OpenAI();

export const a0 = await openai.chat.completions.create({ model: "gpt-3.5-turbo-0301", messages });
export const b0 = await openai.chat.completions.create({ model: 'gpt-3.5-turbo-0301', messages });

// Near miss: a longer name is a different model.
export const near = await openai.chat.completions.create({ model: "gpt-3.5-turbo-0301-x", messages });
