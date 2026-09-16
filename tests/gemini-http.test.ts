import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiAcademicExtractor } from "../src/services/gemini.service.js";
import { MemoryUsageStore, testSecurity } from "./support.js";

const files = [{ buffer: Buffer.from("%PDF-1.7 test"), mimeType: "application/pdf", fileName: "test.pdf" }];
const document = { disciplines: [{ documentTitle: "Plano", disciplineName: "Cálculo", disciplineCode: "", professor: "", term: "", classroom: "", schedule: "", recommendedColorHex: "#2563EB", events: [] }] };
const ok = () => new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(document) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }), { status: 200 });
const unavailable = () => new Response(JSON.stringify({ error: { code: 503, message: "Temporarily unavailable", status: "UNAVAILABLE" } }), { status: 503, statusText: "Service Unavailable" });
afterEach(() => vi.restoreAllMocks());

describe("Gemini SDK real HTTP error handling (only fetch is mocked)", () => {
  it("preserves 503 status and switches to fallback after two failed requests", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(ok());
    const security = testSecurity();
    const r = await security.usage.run("user-a", 1, 20, () => new GeminiAcademicExtractor("fake", "test", "test-lite").extractDocuments(files));
    expect(r.data).toEqual(document);
    expect(fetch).toHaveBeenCalledTimes(3);
    const attempts = [...(security.usage.store as MemoryUsageStore).attempts.values()];
    expect(attempts.map(a => a.errorCode)).toEqual(["UPSTREAM_503", "UPSTREAM_503", null]);
    expect(attempts.map(a => a.requestedModel)).toEqual(["test", "test", "test-lite"]);
  });
  it("preserves permanent HTTP errors without retries", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: { code: 403, message: "Permission denied", status: "PERMISSION_DENIED" } }), { status: 403, statusText: "Forbidden" }));
    const security = testSecurity();
    await expect(security.usage.run("user-a", 1, 20, () => new GeminiAcademicExtractor("fake", "test").extractDocuments(files))).rejects.toMatchObject({ status: 403 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("uses the fallback immediately on a timeout and records it as 504", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("Aborted", "AbortError")).mockResolvedValueOnce(ok());
    const security = testSecurity();
    await security.usage.run("user-a", 1, 20, () => new GeminiAcademicExtractor("fake", "test", "test-lite").extractDocuments(files));
    expect(fetch).toHaveBeenCalledTimes(2);
    const attempts = [...(security.usage.store as MemoryUsageStore).attempts.values()];
    expect(attempts[0]!.errorCode).toBe("UPSTREAM_504");
    expect(attempts[1]!.requestedModel).toBe("test-lite");
  });
  it.each([
    ["MAX_TOKENS", JSON.stringify(document)],
    ["STOP", '{"disciplines": ['],
    ["STOP", '{"disciplines": []}'],
    ["STOP", ""]
  ])("falls back for incomplete/invalid output (%s) while keeping usage", async (finishReason, text) => {
    const broken = () => new Response(JSON.stringify({ candidates: [{ finishReason, content: { role: "model", parts: [{ text }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }), { status: 200 });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(broken()).mockResolvedValueOnce(ok());
    const security = testSecurity();
    const result = await security.usage.run("user-a", 1, 20, () => new GeminiAcademicExtractor("fake", "gemini-3.5-flash", "gemini-3.5-flash-lite").extractDocuments(files));
    expect(result.data).toEqual(document);
    expect(fetch).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    expect(firstBody.generationConfig.thinkingConfig.thinkingLevel).toBe("LOW");
    const secondBody = JSON.parse(fetch.mock.calls[1]![1]!.body as string);
    expect(secondBody.generationConfig.thinkingConfig).toBeUndefined();
    const attempts = [...(security.usage.store as MemoryUsageStore).attempts.values()];
    expect(attempts[0]!.usage?.outputTokens).toBe(5);
    expect(attempts[0]!.providerFinishReason).toBe(finishReason);
    expect(attempts[1]!.requestedModel).toBe("gemini-3.5-flash-lite");
  });
  it("does not accept or retry a safety-blocked response", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] }), { status: 200 }));
    const security = testSecurity();
    await expect(security.usage.run("user-a", 1, 20, () => new GeminiAcademicExtractor("fake", "test", "test-lite").extractDocuments(files))).rejects.toMatchObject({ code: "AI_OUTPUT_BLOCKED" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("stops after an invalid fallback and records a specific operation error", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "{}" }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }), { status: 200 }));
    const security = testSecurity();
    await expect(security.usage.run("user-a", 1, 20, () => new GeminiAcademicExtractor("fake", "test", "test-lite").extractDocuments(files))).rejects.toMatchObject({ code: "AI_OUTPUT_TRUNCATED", status: 503 });
    expect(fetch).toHaveBeenCalledTimes(2);
    const store = security.usage.store as MemoryUsageStore;
    expect([...store.operations.values()][0]!.errorCode).toBe("AI_OUTPUT_TRUNCATED");
    expect([...store.attempts.values()].every(a => a.usage !== null)).toBe(true);
  });

});
