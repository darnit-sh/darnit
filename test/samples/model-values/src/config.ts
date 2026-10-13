export const DEFAULT_MODEL = "gpt-4-turbo";
export const VOICE_ENGINE = `tts-1`;

export class Writer {
  model = "gpt-4";
  constructor(private readonly engine: string = "text-davinci-003") {}
  reset() {
    this.model = "o3-mini";
  }
}

export function draft(prompt: string, model: string = "o1-mini") {
  return { prompt, model };
}

export function plain(prompt, model = 'whisper-1') {
  const { modelName = "dall-e-3" } = prompt;
  return { model, modelName };
}

export const pick = (fast: boolean) => ({ model: fast ? "gpt-4o" : "gpt-4-32k" });
export function fallback(opts: { model?: string }) {
  const model = opts.model ?? "gpt-3.5-turbo-0613";
  return model;
}

export const cli = yargs.option("model", { default: "gpt-3.5-turbo" }).option("temperature", { default: "gpt-4" });
export const bound = new ChatOpenAI({ modelName: "gpt-4", maxTokens: 500 }).bind({});
export const flags = yargs.option("token").option("model", { default: "gpt-4" });
