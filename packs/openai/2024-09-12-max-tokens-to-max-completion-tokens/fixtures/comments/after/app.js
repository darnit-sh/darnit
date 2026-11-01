import OpenAI from "openai";

const client = new OpenAI();

export const blockAfter = () => client.chat.completions.create({ model: "o1", max_completion_tokens: /* cap for cost */ 500, messages: [] });
export const blockBefore = () => client.chat.completions.create({ model: "o1", max_completion_tokens /* cap */ : 500, messages: [] });
export const lineAfter = () =>
  client.chat.completions.create({ model: "o1", max_completion_tokens: // cap for cost
    500, messages: [] });
export const lineBefore = () =>
  client.chat.completions.create({ model: "o1", max_completion_tokens // cap
    : 500, messages: [] });
