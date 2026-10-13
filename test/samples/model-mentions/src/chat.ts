import OpenAI from "openai";

const openai = new OpenAI();
const MODEL = "o4-mini";
// The old default was text-davinci-003.
export const reply = await openai.chat.completions.create({ model: "gpt-4", messages: [] }); // was o1
export const other = await openai.chat.completions.create({ model: MODEL, messages: [] });
