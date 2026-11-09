import test from "node:test";
import assert from "node:assert/strict";
import { providerIcon, providerKey } from "../src/view.mjs";

test("provider logos: DeepSeek and GLM aliases", () => {
  assert.equal(providerKey("deepseek", "deepseek-v4.1"), "deepseek");
  assert.equal(providerIcon("deepseek", "deepseek-v4.1"), "provider:deepseek");
  assert.equal(providerKey("zai", "glm-4.6"), "zai");
  assert.equal(providerIcon("zai", "glm-4.6"), "provider:zai");
  assert.equal(providerKey("zhipu", "glm-4.5"), "zhipu-coding-plan");
  assert.equal(providerIcon("zhipu", "glm-4.5"), "provider:zhipu-coding-plan");
  assert.equal(providerKey("", "deepseek-chat"), "deepseek");
  assert.equal(providerKey("", "glm-4.5"), "zhipu-coding-plan");
  assert.equal(providerIcon("openrouter", ""), "provider:openrouter");
});

test("unknown providers keep the generic sparkles icon", () => {
  assert.equal(providerIcon("unknown-provider", "unknown-model"), "sparkles");
});
