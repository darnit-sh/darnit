import OpenAI from "openai";

const openai = new OpenAI();

// Every chat completions entry point takes the same options.
export const parsed = await openai.chat.completions.parse({ model: "gpt-4o", messages: [], max_tokens: 100 });
export const streamed = openai.chat.completions.stream({ model: "gpt-4o", messages: [], max_tokens: 100 });
export const tooled = await openai.chat.completions.runTools({ model: "gpt-4o", messages: [], tools: [], max_tokens: 100 });
export const betaParsed = await openai.beta.chat.completions.parse({ model: "gpt-4o", messages: [], max_tokens: 100 });
export const betaFns = await openai.beta.chat.completions.runFunctions({ model: "gpt-4o", messages: [], functions: [], max_tokens: 100 });

// Legacy completions keep max_tokens; it is not deprecated there.
export const legacy = await openai.completions.create({ model: "gpt-3.5-turbo-instruct", prompt: "hi", max_tokens: 100 });

// Chains broken across lines, and optional chaining, are the same call.
export const multiline = await openai.chat.completions
  .create({ model: "gpt-4o", messages: [], max_tokens: 100 });
export const optional = await openai.chat?.completions.create({ model: "gpt-4o", messages: [], max_tokens: 100 });
