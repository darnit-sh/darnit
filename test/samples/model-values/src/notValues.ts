type Options = { model: "gpt-4" | "gpt-4o" };
let model: "gpt-4";
const prices = { "gpt-4": 1, "o1": 2 };
const models = ["gpt-4", "o1-mini"];
// model: "gpt-4"
/* const DEFAULT_MODEL = "gpt-4"; */
export const old = (o: Options) => o.model === "gpt-4";
export const nested = { model: `gpt-${4}` };
export { model, prices, models };
export const tokenizer = new Tiktoken({ model: "gpt-4" });
export function countTokens(text: string, model = "gpt-4") {
  return text.length + model.length;
}
