import assert from "node:assert";
import { fakeClient } from "./fake.js";
import { summarize } from "./src/summarize.js";

const client = fakeClient({ choices: [{ message: { content: "short" } }] });
assert.equal(await summarize(client, "a long text"), "short");
console.log("1 test passed");
