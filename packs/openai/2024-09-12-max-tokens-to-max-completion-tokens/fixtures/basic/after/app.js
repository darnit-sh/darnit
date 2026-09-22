import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { trim } from "./trim.js";

const openai = new OpenAI();
const anthropic = new Anthropic();

export async function summarize(messages) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    messages,
    max_completion_tokens: 256,
  });
  return res.choices[0].message.content;
}

export async function summarizeTrimmed(messages) {
  // trim() has its own max_tokens; only the create() one is OpenAI's.
  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: await trim(messages, { max_tokens: 4096 }),
    max_completion_tokens: 256,
  });
  return res.choices[0].message.content;
}

export async function summarizeWithClaude(messages) {
  // Anthropic's max_tokens is a different, current parameter and must stay.
  const res = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 256,
    messages,
  });
  return res.content;
}
