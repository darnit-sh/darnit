import OpenAI from "openai";

const client = new OpenAI();

// Options object built elsewhere — the edge case the rewrite must not silently miss.
const defaults = { model: "gpt-4o", max_tokens: 512 };

export async function chat(messages: OpenAI.ChatCompletionMessageParam[]) {
  return client.chat.completions.create({ ...defaults, messages });
}
