import OpenAI from "openai";

const openai = new OpenAI();

const defaults = {
  model: "gpt-4o",
  max_tokens: 256,
};

export async function summarize(text) {
  const options = { ...defaults, messages: [{ role: "user", content: text }] };
  return openai.chat.completions.create(options);
}
