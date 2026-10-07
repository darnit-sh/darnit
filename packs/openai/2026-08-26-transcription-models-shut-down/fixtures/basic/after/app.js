import OpenAI from "openai";

const openai = new OpenAI();

export const r1 = await openai.audio.transcriptions.create({ model: "whisper-1", file });
export const r2 = await openai.audio.transcriptions.create({ model: 'whisper-1', file });
export const r3 = await openai.audio.transcriptions.create({ model: "gpt-4o-transcribe", file });
export const r4 = await openai.audio.transcriptions.create({ model: 'gpt-4o-transcribe', file });
export const r5 = await openai.audio.transcriptions.create({ model: "gpt-4o-mini-transcribe", file });
export const r6 = await openai.audio.transcriptions.create({ model: 'gpt-4o-mini-transcribe', file });
export const r7 = await openai.audio.transcriptions.create({ model: "gpt-4o-transcribe-diarize", file });
export const r8 = await openai.audio.transcriptions.create({ model: 'gpt-4o-transcribe-diarize', file });

// Near misses: other names, not part of this shutdown.
export const near1 = await openai.audio.transcriptions.create({ model: "gpt-4o-mini-transcribe-2025-12-15", file });
export const near2 = await openai.audio.transcriptions.create({ model: "gpt-transcribe", file });
