import { ChatOpenAI } from "@langchain/openai";

export const chat = new ChatOpenAI({ modelName: "gpt-3.5-turbo" });
