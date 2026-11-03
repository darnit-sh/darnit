import OpenAI from "openai";

const openai = new OpenAI();

export const a0 = await openai.chat.completions.create({ model: `o1-mini`, messages: [] });
export const b0 = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ "model": `o1-mini` }) });

// Near misses: a template with code in it, and a longer name.
export const near = await openai.chat.completions.create({ model: `o1-mini${suffix}`, messages: [] });
export const far = await openai.chat.completions.create({ model: `o1-mini-x`, messages: [] });
