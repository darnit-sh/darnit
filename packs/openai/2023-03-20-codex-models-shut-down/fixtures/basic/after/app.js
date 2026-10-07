import OpenAI from "openai";

const openai = new OpenAI();

export const a0 = await openai.chat.completions.create({ model: "code-davinci-001", messages });
export const b0 = await openai.chat.completions.create({ model: 'code-davinci-001', messages });
export const a1 = await openai.chat.completions.create({ model: "code-cushman-002", messages });
export const b1 = await openai.chat.completions.create({ model: 'code-cushman-002', messages });
export const a2 = await openai.chat.completions.create({ model: "code-cushman-001", messages });
export const b2 = await openai.chat.completions.create({ model: 'code-cushman-001', messages });

// Near miss: a longer name is a different model.
export const near = await openai.chat.completions.create({ model: "code-davinci-001-x", messages });
