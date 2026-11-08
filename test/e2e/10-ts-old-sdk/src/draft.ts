import OpenAI from "openai";

const openai = new OpenAI();

export async function draft(prompt: string) {
  return openai.chat.completions.create({
    model: "gpt-6-luna",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 512,
  });
}
