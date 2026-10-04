import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

const openai = new OpenAI();
const anthropic = new Anthropic();

export async function draft(prompt: string) {
  return openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 512,
  });
}

export async function review(prompt: string) {
  return anthropic.messages.create({
    model: "claude-sonnet",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 1024,
  });
}
