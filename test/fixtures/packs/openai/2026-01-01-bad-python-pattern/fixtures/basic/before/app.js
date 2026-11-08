import OpenAI from "openai";

const openai = new OpenAI();
await openai.chat.completions.create({ model: "gpt-test-model", messages: [], max_tokens: 256 });
