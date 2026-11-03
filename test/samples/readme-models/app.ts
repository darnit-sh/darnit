import OpenAI from "openai";
const openai = new OpenAI();
export const a = await openai.responses.create({ model: "o3-2025-04-16", input });
export const b = await openai.responses.create({ model: "gpt-5-pro-2025-10-06", input });
