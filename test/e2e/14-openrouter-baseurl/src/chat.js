import OpenAI from "openai";

// OpenAI's SDK, but every call goes to OpenRouter.
const client = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY });

export async function ask(prompt) {
  return client.chat.completions.create({
    model: "meta-llama/llama-3.3-70b-instruct",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 256,
  });
}
