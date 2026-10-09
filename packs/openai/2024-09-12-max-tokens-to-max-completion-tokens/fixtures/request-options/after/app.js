import OpenAI from "openai";

const openai = new OpenAI();

export function reply(messages) {
  return openai.chat.completions.create(
    { model: "gpt-4o", messages, max_completion_tokens: 256 },
    { timeout: 10000, max_tokens: 1 },
  );
}

export function replyShorthand(messages, max_tokens) {
  return openai.chat.completions.create({ model: "gpt-4o", messages, max_completion_tokens: max_tokens }, { max_tokens });
}

export function replyWithComment(messages) {
  return openai.chat.completions.create(
    // the limit for summaries
    { model: "gpt-4o", messages, max_completion_tokens: 512 },
  );
}
