import OpenAI from "openai";

const openai = new OpenAI();
await openai.chat.completions.create({ model: "gpt-4o", messages: [], max_tokens: 256 });
