// No SDK: talks to the API directly.
export async function complete(messages) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o", messages, max_tokens: 300 }),
  });
  return (await res.json()).choices[0].message.content;
}
