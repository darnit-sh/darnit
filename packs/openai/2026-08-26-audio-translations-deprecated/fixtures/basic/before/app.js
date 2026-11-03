import OpenAI from "openai";

const openai = new OpenAI();

export const a = await openai.audio.translations.create({ file, model: "whisper-1" });
export const b = await openai.audio.translations.create({ file, model });
export const c = await this.client.audio.translations.create({ file: stream, model: "whisper-1", prompt });
export const d = await openai.audio.translations.create(options).withResponse();

// Near misses: transcriptions stay, and realtime translations is the replacement.
export const near = await openai.audio.transcriptions.create({ file, model: "gpt-transcribe" });
export const next = await openai.realtime.translations.clientSecrets.create({});
