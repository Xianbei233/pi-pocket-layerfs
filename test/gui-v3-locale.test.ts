import assert from "node:assert/strict";
import { test } from "node:test";

test("plugin-local Chinese labels and normal English fallback do not need a shared dictionary", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    try {
        Object.defineProperty(globalThis, "document", { value: { documentElement: { lang: "zh-CN" } }, configurable: true });
        const zh = await import("../src/pocket-layerfs/i18n.js?independent-zh");
        assert.equal(zh.t("config"), "配置"); assert.equal(zh.isChinese(), true);
        Object.defineProperty(globalThis, "document", { value: { documentElement: { lang: "fr" } }, configurable: true });
        const fallback = await import("../src/pocket-layerfs/i18n.js?independent-fallback");
        assert.equal(fallback.t("config"), "Configuration"); assert.equal(fallback.isChinese(), false);
        assert.equal(fallback.t("unknown-test-key"), "unknown-test-key");
    } finally { if (original) Object.defineProperty(globalThis, "document", original); else Reflect.deleteProperty(globalThis, "document"); }
});
