import { expect, it } from "vitest";
import { shownAll } from "../src/detect.js";

it("shows each name", () => expect(shownAll(["a\ufeffb"])).toEqual(["a?b"]));
