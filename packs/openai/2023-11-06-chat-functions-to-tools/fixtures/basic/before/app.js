import OpenAI from "openai";

const client = new OpenAI();

// Unrelated config that happens to use the same key names. Must not change.
export const deploy = {
  functions: [{ source: "functions", runtime: "nodejs20" }],
  function_call: "none",
};

export async function ask(messages, schema) {
  const res = await client.chat.completions.create({
    model: "gpt-4",
    messages,
    functions: [{ name: "get_weather", description: "Current weather", parameters: schema }],
    function_call: "auto",
  });
  return res.choices[0].message;
}
