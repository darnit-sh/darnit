import { expect, it } from "vitest";
import { shown } from "../src/detect.js";

it("shows a zero-width no-break space as a question mark", () => expect(shown("a\ufeffb")).toBe("a?b"));
