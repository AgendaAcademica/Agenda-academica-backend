import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { loadUsageConfig } from "../src/usage/config.js";
import { UsageService, meteredCall } from "../src/usage/meter.js";
import type { VerifiedUser } from "../src/usage/auth.js";
import { limits, MemoryUsageStore, testSecurity } from "./support.js";

const env = loadEnv({ NODE_ENV: "test", GEMINI_API_KEY: "test" });
const data = { disciplines: [] };
const upload = (app: ReturnType<typeof createApp>, token = "team") => request(app)
  .post("/api/v1/documents/extract").set("Authorization", `Bearer ${token}`)
  .attach("file", Buffer.from("%PDF-1.7 test"), { filename: "test.pdf", contentType: "application/pdf" });

function setup(user: VerifiedUser = { uid: "team", email: " TEAM@Example.com ", email_verified: true }) {
  const store = new MemoryUsageStore();
  const security = testSecurity(store);
  security.verifyToken = async () => user;
  security.unlimitedEmails = new Set(["team@example.com"]);
  security.usage = new UsageService(store, {
    ...limits, userDailyRequests: 1, userRequestsPerMinute: 1, userDailyAttempts: 1,
    userDailyUsd: 1, globalDailyRequests: 3, globalDailyAttempts: 3, globalDailyUsd: 10
  }, { "gemini:test": { version: "test", inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0 } });
  const call = vi.fn(async () => data);
  const extractor = { extractDocuments: () => meteredCall("gemini", "test", call, () => ({
    usage: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    model: "test", requestId: null
  })) };
  return { app: createApp(env, extractor, security), store, security, call, extractor };
}

describe("authenticated access and email quota exemptions", () => {
  it("normalizes and validates the configured email list, empty by default", () => {
    expect(loadUsageConfig(env, { FIREBASE_PROJECT_ID: "test" }).unlimitedEmails.size).toBe(0);
    const config = loadUsageConfig(env, { FIREBASE_PROJECT_ID: "test", UNLIMITED_USER_EMAILS: " Team@Example.com, ,team@example.com,other@example.com " });
    expect([...config.unlimitedEmails]).toEqual(["team@example.com", "other@example.com"]);
    expect(() => loadUsageConfig(env, { FIREBASE_PROJECT_ID: "test", UNLIMITED_USER_EMAILS: "not-an-email" })).toThrow();
  });

  it("exempts verified listed emails from all user quotas while retaining accounting and global quotas", async () => {
    const { app, store, call } = setup();
    for (let index = 0; index < 3; index++) expect((await upload(app)).status).toBe(200);
    const blocked = await upload(app);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("GLOBAL_DAILY_QUOTA");
    expect(call).toHaveBeenCalledTimes(3);
    expect(store.operations.size).toBe(3);
    expect([...store.attempts.values()].map(attempt => attempt.estimatedCostUsd)).toEqual([2, 2, 2]);
  });

  it.each([
    { uid: "normal", email: "normal@example.com", email_verified: true },
    { uid: "unverified", email: "team@example.com", email_verified: false },
    { uid: "missing-verification", email: "team@example.com" },
    { uid: "no-email" }
  ])("retains normal quotas for $uid", async user => {
    const { app } = setup(user);
    expect((await upload(app)).status).toBe(200);
    expect((await upload(app)).body.code).toBe("USER_DAILY_QUOTA");
  });

  it.each([
    { cap: { globalDailyRequests: 100, globalDailyAttempts: 1 }, code: "GLOBAL_AI_QUOTA" },
    { cap: { globalDailyRequests: 100, globalDailyUsd: 2 }, code: "GLOBAL_COST_LIMIT" }
  ])("retains $code for exempt users", async ({ cap, code }) => {
    const { security, store, call, extractor } = setup();
    security.usage = new UsageService(store, { ...security.usage.limits, ...cap }, security.usage.prices);
    const updatedApp = createApp(env, extractor, security);
    expect((await upload(updatedApp)).status).toBe(200);
    expect((await upload(updatedApp)).body.code).toBe(code);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("does not accept a client email header as proof of exemption", async () => {
    const { app } = setup({ uid: "normal", email: "normal@example.com", email_verified: true });
    expect((await upload(app).set("X-User-Email", "team@example.com")).status).toBe(200);
    expect((await upload(app).set("X-User-Email", "team@example.com")).body.code).toBe("USER_DAILY_QUOTA");
  });

  it("does not grant administrative report access to an exempt account", async () => {
    const { app } = setup();
    const response = await request(app).get("/api/v1/admin/usage?from=2026-11-17&to=2026-11-17")
      .set("Authorization", "Bearer team");
    expect(response.status).toBe(403);
  });
});
