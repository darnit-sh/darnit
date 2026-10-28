const base = "https://api.openai.com/v1";
const spend_control = { limit: 5 };

await fetch("https://api.openai.com/v1/agents/sessions", { method: "POST", body: JSON.stringify({ "spend_control": 1 }) });
await fetch("https://api.openai.com/v1/agents/sessions/sess_1", { method: "POST", body: JSON.stringify({ spend_control: 2 }) });
await fetch(`${base}/agents/sessions`, { method: "POST", body: JSON.stringify({ 'spend_control': 3 }) });
await fetch("https://api.openai.com/v1/agents/sessions", { method: "POST", body: JSON.stringify({ spend_control }) });

await fetch("/api/budget", { method: "POST", body: JSON.stringify({ "spend_control": 1 }) });
