export async function summarize(client, text) {
  const res = await client.chat.completions.create({
    model: "gpt-6-luna",
    messages: [{ role: "user", content: `Summarize: ${text}` }],
    max_completion_tokens: 256,
  });
  return res.choices[0].message.content;
}
