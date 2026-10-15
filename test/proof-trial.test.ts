import { expect, it } from "vitest";
import { shown } from "../src/detect.js";

it("keeps plain text", () => expect(shown("ab")).toBe("ab"));
