import OpenAI from "openai";

const client = new OpenAI();

export async function ask(messages, schema) {
  const res = await client.chat.completions.create({
    model: "gpt-4",
    messages,
    functions: [{ name: "get_weather", description: "Current weather", parameters: schema }],
    function_call: "auto",
  });
  return res.choices[0].message;
}
