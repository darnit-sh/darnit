import Groq from "groq-sdk";

const groq = new Groq();

export async function ask(prompt) {
  return groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 256,
  });
}
