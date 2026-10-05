import OpenAI from "openai";
import Groq from "groq-sdk";

const openai = new OpenAI();
const groq = new Groq();

export const draft = (prompt) =>
  openai.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: prompt }], max_tokens: 256 });

export const review = (prompt) =>
  groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }], max_tokens: 256 });
