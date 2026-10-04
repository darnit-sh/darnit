import OpenAI from "openai";

const openai = new OpenAI();

export async function weather(city) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: `Weather in ${city}?` }],
    functions: [{ name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } }],
    function_call: "auto",
  });
  return res.choices[0].message.function_call;
}
