import assert from "node:assert";
import { fakeClient } from "./fake.js";
import { summarize } from "./src/summarize.js";

const client = fakeClient({ choices: [{ message: { content: "short" } }] });
await summarize(client, "a long text");
// This test pins the old parameter name, so the rename breaks it.
assert.equal(client.calls[0].max_tokens, 256);
console.log("1 test passed");
