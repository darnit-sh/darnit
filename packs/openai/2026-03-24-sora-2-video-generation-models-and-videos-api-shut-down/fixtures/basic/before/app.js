import OpenAI from "openai";

const openai = new OpenAI();

export const a0 = await openai.chat.completions.create({ model: "sora-2", messages });
export const b0 = await openai.chat.completions.create({ model: 'sora-2', messages });
export const a1 = await openai.chat.completions.create({ model: "sora-2-pro", messages });
export const b1 = await openai.chat.completions.create({ model: 'sora-2-pro', messages });
export const a2 = await openai.chat.completions.create({ model: "sora-2-2025-10-06", messages });
export const b2 = await openai.chat.completions.create({ model: 'sora-2-2025-10-06', messages });
export const a3 = await openai.chat.completions.create({ model: "sora-2-2025-12-08", messages });
export const b3 = await openai.chat.completions.create({ model: 'sora-2-2025-12-08', messages });
export const a4 = await openai.chat.completions.create({ model: "sora-2-pro-2025-10-06", messages });
export const b4 = await openai.chat.completions.create({ model: 'sora-2-pro-2025-10-06', messages });

// Near miss: a longer name is a different model.
export const near = await openai.chat.completions.create({ model: "sora-2-x", messages });
