import assert from "node:assert/strict";
import { test } from "node:test";
import { clipBytes } from "../src/pocket-layerfs/format.ts";

test("UTF-8 clipping never splits an emoji surrogate pair when reserving an ellipsis", () => {
    for (const budget of [4, 5, 7, 8, 9, 12]) {
        const value = clipBytes("😀😎🙂".repeat(10), budget);
        assert.equal(value.text.isWellFormed(), true, `budget=${budget}, result=${JSON.stringify(value.text)}`);
        assert.ok(Buffer.byteLength(value.text, "utf8") <= budget);
    }
});
