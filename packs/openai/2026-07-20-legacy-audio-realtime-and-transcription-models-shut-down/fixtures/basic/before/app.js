import OpenAI from "openai";

const openai = new OpenAI();

export const a0 = await openai.chat.completions.create({ model: "gpt-realtime", messages });
export const b0 = await openai.chat.completions.create({ model: 'gpt-realtime', messages });
export const a1 = await openai.chat.completions.create({ model: "gpt-audio", messages });
export const b1 = await openai.chat.completions.create({ model: 'gpt-audio', messages });
export const a2 = await openai.chat.completions.create({ model: "gpt-4o-audio", messages });
export const b2 = await openai.chat.completions.create({ model: 'gpt-4o-audio', messages });
export const a3 = await openai.chat.completions.create({ model: "gpt-4o-realtime", messages });
export const b3 = await openai.chat.completions.create({ model: 'gpt-4o-realtime', messages });
export const a4 = await openai.chat.completions.create({ model: "gpt-realtime-mini", messages });
export const b4 = await openai.chat.completions.create({ model: 'gpt-realtime-mini', messages });
export const a5 = await openai.chat.completions.create({ model: "gpt-audio-mini", messages });
export const b5 = await openai.chat.completions.create({ model: 'gpt-audio-mini', messages });
export const a6 = await openai.chat.completions.create({ model: "gpt-4o-mini-realtime", messages });
export const b6 = await openai.chat.completions.create({ model: 'gpt-4o-mini-realtime', messages });
export const a7 = await openai.chat.completions.create({ model: "gpt-4o-mini-audio", messages });
export const b7 = await openai.chat.completions.create({ model: 'gpt-4o-mini-audio', messages });
export const a8 = await openai.chat.completions.create({ model: "gpt-4o-mini-transcribe-2025-03-20", messages });
export const b8 = await openai.chat.completions.create({ model: 'gpt-4o-mini-transcribe-2025-03-20', messages });

// Near miss: a longer name is a different model.
export const near = await openai.chat.completions.create({ model: "gpt-realtime-x", messages });
