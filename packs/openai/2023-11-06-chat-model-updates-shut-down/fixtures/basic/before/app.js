import OpenAI from "openai";

const openai = new OpenAI();

export const a0 = await openai.chat.completions.create({ model: "gpt-3.5-turbo-0613", messages });
export const b0 = await openai.chat.completions.create({ model: 'gpt-3.5-turbo-0613', messages });
export const a1 = await openai.chat.completions.create({ model: "gpt-3.5-turbo-16k-0613", messages });
export const b1 = await openai.chat.completions.create({ model: 'gpt-3.5-turbo-16k-0613', messages });

// Near miss: a longer name is a different model.
export const near = await openai.chat.completions.create({ model: "gpt-3.5-turbo-0613-x", messages });
