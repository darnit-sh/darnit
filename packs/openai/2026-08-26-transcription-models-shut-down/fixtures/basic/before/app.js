import OpenAI from "openai";

const openai = new OpenAI();

export const a0 = await openai.chat.completions.create({ model: "whisper-1", messages });
export const b0 = await openai.chat.completions.create({ model: 'whisper-1', messages });
export const a1 = await openai.chat.completions.create({ model: "gpt-4o-transcribe", messages });
export const b1 = await openai.chat.completions.create({ model: 'gpt-4o-transcribe', messages });
export const a2 = await openai.chat.completions.create({ model: "gpt-4o-mini-transcribe", messages });
export const b2 = await openai.chat.completions.create({ model: 'gpt-4o-mini-transcribe', messages });
export const a3 = await openai.chat.completions.create({ model: "gpt-4o-transcribe-diarize", messages });
export const b3 = await openai.chat.completions.create({ model: 'gpt-4o-transcribe-diarize', messages });

// Near miss: a longer name is a different model.
export const near = await openai.chat.completions.create({ model: "whisper-1-x", messages });
