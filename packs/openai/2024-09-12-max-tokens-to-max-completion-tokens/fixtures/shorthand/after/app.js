import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

const openai = new OpenAI();
const anthropic = new Anthropic();

export async function reply(messages, { model = "gpt-test-model", max_tokens = 256 } = {}) {
  const res = await openai.chat.completions.create({ model, messages, max_completion_tokens: max_tokens });
  return res.choices[0]?.message.content ?? null;
}

export function streamReply(messages, max_tokens) {
  return openai.chat.completions.stream({
    model: "gpt-test-model",
    messages,
    max_completion_tokens: max_tokens,
  });
}

export function replyWithClaude(messages, max_tokens) {
  return anthropic.messages.create({ model: "claude-sonnet-5", messages, max_tokens });
}

export function trimmed(messages, max_tokens) {
  return openai.chat.completions.create({
    model: "gpt-test-model",
    messages: trim(messages, { max_tokens }),
  });
}

export function limitFrom(opts) {
  const { max_tokens } = opts;
  return max_tokens;
}
