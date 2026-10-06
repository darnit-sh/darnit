import OpenAI from "openai";

const openai = new OpenAI();

export async function summarize(messages: OpenAI.ChatCompletionMessageParam[]): Promise<string | null> {
  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    messages,
    max_tokens: 256,
  });
  return res.choices[0]?.message.content ?? null;
}
