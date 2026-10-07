import OpenAI from "openai";

const openai = new OpenAI();

export const a0 = await openai.chat.completions.create({ model: "gpt-3.5-turbo-instruct", messages });
export const b0 = await openai.chat.completions.create({ model: 'gpt-3.5-turbo-instruct', messages });
export const a1 = await openai.chat.completions.create({ model: "babbage-002", messages });
export const b1 = await openai.chat.completions.create({ model: 'babbage-002', messages });
export const a2 = await openai.chat.completions.create({ model: "davinci-002", messages });
export const b2 = await openai.chat.completions.create({ model: 'davinci-002', messages });
export const a3 = await openai.chat.completions.create({ model: "gpt-3.5-turbo-1106", messages });
export const b3 = await openai.chat.completions.create({ model: 'gpt-3.5-turbo-1106', messages });

// Near miss: a longer name is a different model.
export const near = await openai.chat.completions.create({ model: "gpt-3.5-turbo-instruct-x", messages });
