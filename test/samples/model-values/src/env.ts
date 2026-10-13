export const chatModel = process.env.OPENAI_MODEL || "gpt-3.5-turbo";
const judge = process.env.JUDGE ?? 'gpt-4';
export const fast = process.env.FAST || "gpt-4o";
export { judge };
