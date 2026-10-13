import OpenAI from "openai";
import Groq from "groq-sdk";

const openai = new OpenAI();
const groq = new Groq();
export const a = await openai.chat.completions.create({ model: "gpt-4", messages: [] });
export const b = await groq.audio.transcriptions.create({ model: "whisper-1", file: null });
