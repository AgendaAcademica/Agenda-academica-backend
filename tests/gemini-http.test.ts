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
});
