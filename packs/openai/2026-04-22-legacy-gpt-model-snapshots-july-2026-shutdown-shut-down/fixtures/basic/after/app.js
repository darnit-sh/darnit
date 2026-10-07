import OpenAI from "openai";

const openai = new OpenAI();

export const a0 = await openai.chat.completions.create({ model: "computer-use-preview-2025-03-11", messages });
export const b0 = await openai.chat.completions.create({ model: 'computer-use-preview-2025-03-11', messages });
export const a1 = await openai.chat.completions.create({ model: "computer-use-preview", messages });
export const b1 = await openai.chat.completions.create({ model: 'computer-use-preview', messages });
export const a2 = await openai.chat.completions.create({ model: "gpt-4o-mini-search-preview-2025-03-11", messages });
export const b2 = await openai.chat.completions.create({ model: 'gpt-4o-mini-search-preview-2025-03-11', messages });
export const a3 = await openai.chat.completions.create({ model: "gpt-4o-search-preview-2025-03-11", messages });
export const b3 = await openai.chat.completions.create({ model: 'gpt-4o-search-preview-2025-03-11', messages });
export const a4 = await openai.chat.completions.create({ model: "gpt-5-chat-latest", messages });
export const b4 = await openai.chat.completions.create({ model: 'gpt-5-chat-latest', messages });
export const a5 = await openai.chat.completions.create({ model: "gpt-5-codex", messages });
export const b5 = await openai.chat.completions.create({ model: 'gpt-5-codex', messages });
export const a6 = await openai.chat.completions.create({ model: "gpt-5.1-chat-latest", messages });
export const b6 = await openai.chat.completions.create({ model: 'gpt-5.1-chat-latest', messages });
export const a7 = await openai.chat.completions.create({ model: "gpt-5.1-codex", messages });
export const b7 = await openai.chat.completions.create({ model: 'gpt-5.1-codex', messages });
export const a8 = await openai.chat.completions.create({ model: "gpt-5.1-codex-max", messages });
export const b8 = await openai.chat.completions.create({ model: 'gpt-5.1-codex-max', messages });
export const a9 = await openai.chat.completions.create({ model: "gpt-5.1-codex-mini", messages });
export const b9 = await openai.chat.completions.create({ model: 'gpt-5.1-codex-mini', messages });
export const a10 = await openai.chat.completions.create({ model: "gpt-audio-mini-2025-10-06", messages });
export const b10 = await openai.chat.completions.create({ model: 'gpt-audio-mini-2025-10-06', messages });
export const a11 = await openai.chat.completions.create({ model: "gpt-realtime-mini-2025-10-06", messages });
export const b11 = await openai.chat.completions.create({ model: 'gpt-realtime-mini-2025-10-06', messages });
export const a12 = await openai.chat.completions.create({ model: "o3-deep-research-2025-06-26", messages });
export const b12 = await openai.chat.completions.create({ model: 'o3-deep-research-2025-06-26', messages });
export const a13 = await openai.chat.completions.create({ model: "o3-deep-research", messages });
export const b13 = await openai.chat.completions.create({ model: 'o3-deep-research', messages });
export const a14 = await openai.chat.completions.create({ model: "o4-mini-deep-research-2025-06-26", messages });
export const b14 = await openai.chat.completions.create({ model: 'o4-mini-deep-research-2025-06-26', messages });
export const a15 = await openai.chat.completions.create({ model: "o4-mini-deep-research", messages });
export const b15 = await openai.chat.completions.create({ model: 'o4-mini-deep-research', messages });
export const a16 = await openai.chat.completions.create({ model: "gpt-5.2-codex", messages });
export const b16 = await openai.chat.completions.create({ model: 'gpt-5.2-codex', messages });

// Near miss: a longer name is a different model.
export const near = await openai.chat.completions.create({ model: "computer-use-preview-2025-03-11-x", messages });
