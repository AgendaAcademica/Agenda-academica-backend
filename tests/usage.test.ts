import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { loadUsageConfig } from "../src/usage/config.js";
import { CachedAcademicExtractor, FallbackAcademicExtractor } from "../src/services/academic-extractor.js";
import { AccountingError } from "../src/usage/types.js";
import { UsageService, estimateCost, geminiUsage, meteredCall, openaiUsage } from "../src/usage/meter.js";
import { summarize, reportCsv } from "../src/usage/report.js";
import { limits, MemoryUsageStore, testSecurity } from "./support.js";

const env = loadEnv({ NODE_ENV: "test", GEMINI_API_KEY: "test" });
const files = [{ buffer: Buffer.from("%PDF-1.7 test"), mimeType: "application/pdf", fileName: "test.pdf" }];
const data = { disciplines: [] };
const tokens = { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100, reasoningTokens: 20 };
const meta = () => ({ usage: tokens, model: "test-snapshot", requestId: "provider-123" });
const upload = (app: ReturnType<typeof createApp>, token = "user-a") => request(app).post("/api/v1/documents/extract")
  .set("Authorization", `Bearer ${token}`).attach("file", files[0]!.buffer, { filename: "test.pdf", contentType: "application/pdf" });

describe("authentication, quotas and reports", () => {
  it("rejects missing, expired and unauthorized credentials before processing", async () => {
    const extractor = { extractDocuments: vi.fn().mockResolvedValue(data) };
    const app = createApp(env, extractor, testSecurity());
    expect((await request(app).post("/api/v1/documents/extract")).status).toBe(401);
    expect((await upload(app, "expired")).status).toBe(401);
    expect((await upload(app, "outsider")).status).toBe(403);
    expect(extractor.extractDocuments).not.toHaveBeenCalled();
  });
  it("uses verified UID, not client identity, and restricts reports to administrators", async () => {
    const security = testSecurity();
    const app = createApp(env, { extractDocuments: async () => data }, security);
    expect((await upload(app)).status).toBe(200);
    const date = new Date().toISOString().slice(0, 10);
    const path = `/api/v1/admin/usage?from=${date}&to=${date}`;
    expect((await request(app).get(path).set("Authorization", "Bearer user-a")).status).toBe(403);
    const result = await request(app).get(path).set("Authorization", "Bearer admin");
    expect(result.body.users[0].uid).toBe("user-a");
    expect(result.headers["cache-control"]).toBe("no-store");
    const csv = await request(app).get(path + "&format=csv").set("Authorization", "Bearer admin");
    expect(csv.text).toContain('"user-a"');
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect((await request(app).get("/api/v1/admin/usage?from=2026-02-30&to=2026-03-01").set("Authorization", "Bearer admin")).status).toBe(400);
  });
  it("rejects spoofed UID form fields", async () => {
    const extractor = { extractDocuments: vi.fn() };
    const response = await request(createApp(env, extractor, testSecurity())).post("/api/v1/documents/extract")
      .set("Authorization", "Bearer user-a").field("uid", "admin").attach("file", files[0]!.buffer, "test.pdf");
    expect(response.status).toBe(400); expect(extractor.extractDocuments).not.toHaveBeenCalled();
  });
  it("blocks quota exhaustion before a provider call", async () => {
    const security = testSecurity(); security.usage = new UsageService(security.usage.store, { ...limits, userDailyRequests: 1 }, {});
    const extractor = { extractDocuments: vi.fn().mockResolvedValue(data) };
    const app = createApp(env, extractor, security);
    expect((await upload(app)).status).toBe(200); expect((await upload(app)).status).toBe(429);
    expect(extractor.extractDocuments).toHaveBeenCalledTimes(1);
  });
  it("fails closed when persistence is unavailable", async () => {
    const security = testSecurity(); vi.spyOn(security.usage.store, "reserveOperation").mockRejectedValue(new Error("offline"));
    const extractor = { extractDocuments: vi.fn() };
    const response = await upload(createApp(env, extractor, security));
    expect(response.status).toBe(503); expect(response.body.code).toBe("ACCOUNTING_UNAVAILABLE");
    expect(extractor.extractDocuments).not.toHaveBeenCalled();
  });
  it("limits total multipart bytes even when each file fits", async () => {
    const security = testSecurity(); security.maxUploadTotalMb = 0.001;
    const extractor = { extractDocuments: vi.fn() };
    const image = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(600)]);
    const response = await request(createApp(env, extractor, security)).post("/api/v1/documents/extract")
      .set("Authorization", "Bearer user-a")
      .attach("files", image, { filename: "1.png", contentType: "image/png" })
      .attach("files", image, { filename: "2.png", contentType: "image/png" });
    expect(response.status).toBe(413); expect(extractor.extractDocuments).not.toHaveBeenCalled();
  });
  it("requires release access lists and prices", () => {
    const prod = loadEnv({ NODE_ENV: "production" });
    expect(() => loadUsageConfig(prod, { FIREBASE_PROJECT_ID: "test" })).toThrow("TESTER_UIDS");
    expect(() => loadUsageConfig(prod, { FIREBASE_PROJECT_ID: "test", TESTER_UIDS: "a", ADMIN_UIDS: "b" })).toThrow("tarifa");
  });
});

describe("provider accounting", () => {
  it("prices cached inputs and output including reasoning without double counting", () => {
    expect(estimateCost(tokens, { version: "test", inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 2 })).toBe(0.00102);
    expect(estimateCost(null, undefined)).toBeNull();
    const gemini = geminiUsage({ usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 200, candidatesTokenCount: 80, thoughtsTokenCount: 20 } } as Parameters<typeof geminiUsage>[0]);
    const openai = openaiUsage({ usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 20 } } } as Parameters<typeof openaiUsage>[0]);
    expect(gemini).toEqual(tokens); expect(openai).toEqual(tokens);
    expect(geminiUsage({} as Parameters<typeof geminiUsage>[0])).toBeNull();
  });
  it("attributes a shared provider call only to the initiating user", async () => {
    const security = testSecurity(); const store = security.usage.store as MemoryUsageStore;
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const cached = new CachedAcademicExtractor({ extractDocuments: () => meteredCall("gemini", "test", async () => { await barrier; return data; }, meta) });
    const first = security.usage.run("user-a", 1, 20, () => cached.extractDocuments(files));
    await vi.waitFor(() => expect(store.attempts.size).toBe(1));
    const second = security.usage.run("user-b", 1, 20, () => cached.extractDocuments(files));
    release(); await Promise.all([first, second]);
    await security.usage.run("user-b", 1, 20, () => cached.extractDocuments(files));
    expect(store.attempts.size).toBe(1); expect([...store.attempts.values()][0]!.uid).toBe("user-a");
    expect([...store.operations.values()].map(x => x.cache)).toEqual(["miss", "shared", "hit"]);
    const summary = summarize(await store.report("2000", "2100"));
    expect(summary.find(x => x.uid === "user-a")?.estimatedCostUsd).toBe(0.00102);
    expect(summary.find(x => x.uid === "user-b")?.estimatedCostUsd).toBe(0);
  });
  it("keeps billable usage when parsing the response fails", async () => {
    const security = testSecurity(); const store = security.usage.store as MemoryUsageStore;
    await expect(security.usage.run("user-a", 1, 20, async () => {
      const raw = await meteredCall("gemini", "test", async () => "invalid JSON", meta);
      return JSON.parse(raw);
    })).rejects.toThrow();
    expect([...store.attempts.values()][0]!.estimatedCostUsd).toBe(0.00102);
    expect([...store.operations.values()][0]!.status).toBe("error");
  });
  it("records each fallback attempt and reports unknown failed-call cost", async () => {
    const security = testSecurity(); const store = security.usage.store as MemoryUsageStore;
    const fallback = new FallbackAcademicExtractor({ extractDocuments: () => meteredCall("gemini", "test", async () => { throw { status: 503 }; }, meta) },
      { extractDocuments: () => meteredCall("gemini", "test", async () => data, meta) });
    await security.usage.run("user-a", 1, 20, () => fallback.extractDocuments(files));
    expect([...store.attempts.values()].map(a => a.estimatedCostUsd)).toEqual([null, 0.00102]);
    expect(summarize(await store.report("2000", "2100"))[0]!.unknownCostAttempts).toBe(1);
  });
  it("does not retry/fallback on ledger failure after provider success", async () => {
    const security = testSecurity(); vi.spyOn(security.usage.store, "finishAttempt").mockRejectedValue(new Error("offline"));
    const alternate = { extractDocuments: vi.fn() };
    const fallback = new FallbackAcademicExtractor({ extractDocuments: () => meteredCall("gemini", "test", async () => data, meta) }, alternate);
    await expect(security.usage.run("user-a", 1, 20, () => fallback.extractDocuments(files))).rejects.toBeInstanceOf(AccountingError);
    expect(alternate.extractDocuments).not.toHaveBeenCalled();
    expect([...(security.usage.store as MemoryUsageStore).attempts.values()][0]!.status).toBe("pending");
  });
  it("never invokes a provider outside an accounting context", async () => {
    const call = vi.fn(); await expect(meteredCall("gemini", "test", call, meta)).rejects.toBeInstanceOf(AccountingError);
    expect(call).not.toHaveBeenCalled();
  });
  it("escapes spreadsheet formulas in exported identifiers", () => {
    const csv = reportCsv({ operations: [], attempts: [{ uid: "=HYPERLINK(1)", estimatedCostUsd: null, usage: null } as never] });
    expect(csv).toContain('"\'=HYPERLINK(1)"');
  });
});
