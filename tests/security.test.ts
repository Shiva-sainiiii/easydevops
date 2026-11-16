import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import crypto from "node:crypto";

const secret = "test-secret-test-secret-test-secret-123";
import { confirmToken, verifyConfirmToken, CONFIRM_TTL_SECONDS } from "../lib/commands/confirmation";
import { rateLimit, _resetRateLimitMemory } from "../lib/ratelimit";
import { needsConfirmation, riskOf, isKnownCommand } from "../lib/commands/risk";

const now = 1_800_000_000_000;

test("confirm token: sahi token ok", () => {
  const t = confirmToken("DELETE_REPO", '{"repo":"x"}', 42, { now, secret });
  assert.equal(verifyConfirmToken(t, "DELETE_REPO", '{"repo":"x"}', 42, { now: now + 5000, secret }), "ok");
});

test("confirm token: value / command / user badle to reject", () => {
  const t = confirmToken("DELETE_REPO", '{"repo":"x"}', 42, { now, secret });
  assert.equal(verifyConfirmToken(t, "DELETE_REPO", '{"repo":"y"}', 42, { now, secret }), "bad");
  assert.equal(verifyConfirmToken(t, "DELETE_FILE", '{"repo":"x"}', 42, { now, secret }), "bad");
  assert.equal(verifyConfirmToken(t, "DELETE_REPO", '{"repo":"x"}', 43, { now, secret }), "bad");
});

test("confirm token: purana unsalted sha256 token ab chalta nahi (forge nahi ho sakta)", () => {
  const forged = crypto.createHash("sha256").update('DELETE_REPO:{"repo":"x"}:42').digest("hex").slice(0, 16);
  assert.equal(verifyConfirmToken(forged, "DELETE_REPO", '{"repo":"x"}', 42, { now, secret }), "bad");
});

test("confirm token: expire hota hai", () => {
  const t = confirmToken("DELETE_REPO", "v", 1, { now, secret });
  assert.equal(verifyConfirmToken(t, "DELETE_REPO", "v", 1, { now: now + (CONFIRM_TTL_SECONDS + 5) * 1000, secret }), "expired");
});

test("confirm token: kachra input", () => {
  for (const bad of [undefined, null, 12, "", "abc", "zz.zz"]) {
    assert.equal(verifyConfirmToken(bad as any, "X", "v", 1, { now, secret }), "bad");
  }
});

beforeEach(() => _resetRateLimitMemory());

test("rate limit: limit ke baad block, alag key alag counter", async () => {
  const t = Date.now();
  for (let i = 0; i < 3; i++) assert.equal((await rateLimit("a", 3, 60, t)).ok, true);
  const r = await rateLimit("a", 3, 60, t);
  assert.equal(r.ok, false);
  assert.ok(r.retryAfter >= 1);
  assert.equal((await rateLimit("b", 3, 60, t)).ok, true);
  assert.equal((await rateLimit("a", 3, 60, t + 61_000)).ok, true); // window reset
});

test("risk tiers + AI-origin gating", () => {
  assert.equal(riskOf("LIST_REPOS"), "read");
  assert.equal(riskOf("CREATE_REPO"), "write");
  assert.equal(riskOf("DELETE_REPO"), "destructive");
  assert.equal(needsConfirmation("LIST_REPOS", "ai"), false);
  assert.equal(needsConfirmation("CREATE_FILE", "ai"), true);
  assert.equal(needsConfirmation("VERCEL_GET_ENV", "ai"), true); // secrets dikhane wala "read"
  assert.equal(needsConfirmation("CREATE_FILE", "rules"), false);
  assert.equal(needsConfirmation("DELETE_REPO", "rules"), true);
  assert.equal(isKnownCommand("RM_RF"), false);
});

import { summarizeUsage } from "../lib/usage_core";

test("usage: bina AI call = rules; AI call + source ai = ai; baaki hybrid", () => {
  assert.deepEqual(summarizeUsage([]), { mode: "rules", ai_calls: 0 });
  const a = { provider: "google", model: "gemini-x", status: 200, ms: 400, tokensIn: 10, tokensOut: 5 };
  assert.equal(summarizeUsage([a], "ai").mode, "ai");
  assert.equal(summarizeUsage([a], "hybrid").mode, "hybrid");
  const u = summarizeUsage([a, { ...a, status: 429, ms: 100, tokensIn: null, tokensOut: null }], "direct");
  assert.equal(u.ai_calls, 2);
  assert.equal(u.tokens, 15);
  assert.equal(u.ms, 500);
});
