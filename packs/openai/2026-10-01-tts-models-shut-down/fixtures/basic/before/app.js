import OpenAI from "openai";

const openai = new OpenAI();

export const r1 = await openai.audio.speech.create({ model: "tts-1", input: "Hello", voice: "alloy" });
export const r2 = await openai.audio.speech.create({ model: 'tts-1', input: "Hello", voice: "alloy" });
export const r3 = await openai.audio.speech.create({ model: "tts-1-hd", input: "Hello", voice: "alloy" });
export const r4 = await openai.audio.speech.create({ model: 'tts-1-hd', input: "Hello", voice: "alloy" });
export const r5 = await openai.audio.speech.create({ model: "gpt-4o-mini-tts-2025-03-20", input: "Hello", voice: "alloy" });
export const r6 = await openai.audio.speech.create({ model: 'gpt-4o-mini-tts-2025-03-20', input: "Hello", voice: "alloy" });
export const r7 = await openai.audio.speech.create({ model: "gpt-4o-mini-tts-2025-12-15", input: "Hello", voice: "alloy" });
export const r8 = await openai.audio.speech.create({ model: 'gpt-4o-mini-tts-2025-12-15', input: "Hello", voice: "alloy" });

// Near misses: other names, not part of this shutdown.
export const near1 = await openai.audio.speech.create({ model: "gpt-4o-mini-tts", input: "Hello", voice: "alloy" });
export const near2 = await openai.audio.speech.create({ model: "tts-1-hd-1106", input: "Hello", voice: "alloy" });
