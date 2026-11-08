import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

const openai = new OpenAI();
const anthropic = new Anthropic();

export async function summarize(messages) {
  return openai.chat.completions.create({
    model: "gpt-6-luna",
    messages,
    max_tokens: 256,
  });
}

export async function reply(model, messages) {
  return anthropic.messages.create({ model, max_tokens: 1024, messages });
}
