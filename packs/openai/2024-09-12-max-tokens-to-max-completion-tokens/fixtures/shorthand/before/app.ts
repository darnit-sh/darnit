import OpenAI from "openai";

const openai = new OpenAI();

export async function reply(messages: OpenAI.ChatCompletionMessageParam[], max_tokens = 256): Promise<string | null> {
  const res = await openai.chat.completions.create({ model: "gpt-4o", messages, max_tokens });
  return res.choices[0]?.message.content ?? null;
}
