import OpenAI from "openai";

const client = new OpenAI();
const user = "u1";
await client.images.edit({ image, prompt: "x", user });
await client.images.generate({ prompt: "x", user: "u1" });
await fetch("https://api.openai.com/v1/images/generations", { method: "POST", body: JSON.stringify({ prompt: "x", "user": "u1" }) });

const profile = { user };
save({ user: "u1" });
