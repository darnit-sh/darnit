import axios from "axios";
import OpenAI from "openai";

const openai = new OpenAI();
const BASE = "https://api.openai.com";

// The SDK call is rewritten as in basic/; every quoted key below is reported, not rewritten.
export const res = await openai.chat.completions.create({ model: "gpt-4o", messages: [], max_completion_tokens: 256 });
export const quoted = await openai.chat.completions.create({ "model": "gpt-4o", "messages": [], "max_tokens": 256 });

// Raw HTTP to chat completions, the key in double or single quotes.
export const a = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ "model": "gpt-4o", "max_tokens": 100 }) });
export const b = await fetch(`${BASE}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ 'max_tokens': 100 }) });
export const c = await axios.post("https://api.openai.com/v1/chat/completions", { "max_tokens": 100 });

// Not an OpenAI chat completions request: another vendor, legacy completions, a config object,
// a log message, and a payload passed by name (not checked; the report says so).
export const d = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify({ "max_tokens": 100 }) });
export const e = await axios.post("https://api.openai.com/v1/completions", { 'max_tokens': 100 });
export const defaults = { "max_tokens": 100 };
console.log('posting {"max_tokens": 100} to /v1/chat/completions');
console.log("posting to /v1/chat/completions", { "max_tokens": 100 });
const payload = { "max_tokens": 100 };
export const f = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: JSON.stringify(payload) });
