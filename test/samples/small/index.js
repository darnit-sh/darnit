import OpenAI from "openai";

const client = new OpenAI();

export async function reply(messages) {
  const res = await client.chat.completions.create({ model: "gpt-4o", messages, max_tokens: 200 });
  return res.choices[0].message.content;
}
