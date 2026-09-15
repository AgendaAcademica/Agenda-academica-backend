import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ gemini: vi.fn(), openai: vi.fn(), geminiOptions: vi.fn() }));
vi.mock("@google/genai", () => ({ GoogleGenAI: class { models = { generateContent: mocks.gemini }; constructor(options: unknown) { mocks.geminiOptions(options); } } }));
vi.mock("openai", () => ({ default: class { responses = { create: mocks.openai }; } }));
import { GeminiAcademicExtractor } from "../src/services/gemini.service.js";
import { OpenAIAcademicExtractor } from "../src/services/openai.service.js";
import { MemoryUsageStore, testSecurity } from "./support.js";

const files = [{ buffer: Buffer.from("%PDF-1.7 test"), fileName: "test.pdf", mimeType: "application/pdf" }];
const result = { disciplines: [{ documentTitle: "Plano", disciplineName: "Cálculo", disciplineCode: "", professor: "", term: "", classroom: "", schedule: "", recommendedColorHex: "#2563EB", events: [] }] };
beforeEach(() => vi.clearAllMocks());
describe("real provider adapters with mocked network", () => {
  it("meters Gemini retries and disables hidden SDK retries", async () => {
    mocks.gemini.mockRejectedValueOnce({ status: 503 }).mockResolvedValueOnce({ text: JSON.stringify(result), modelVersion: "test-snapshot", responseId: "gem-1",
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 5 } });
    const security = testSecurity(); const provider = new GeminiAcademicExtractor("fake", "test");
    expect(await security.usage.run("user-a", 1, 20, () => provider.extractDocuments(files))).toMatchObject({ data: result });
    const attempts = [...(security.usage.store as MemoryUsageStore).attempts.values()];
    expect(attempts).toHaveLength(2); expect(attempts[0]!.estimatedCostUsd).toBeNull();
    expect(attempts[1]!.usage?.outputTokens).toBe(15);
    expect(mocks.geminiOptions).toHaveBeenCalledWith(expect.objectContaining({ httpOptions: { timeout: 75000, retryOptions: { attempts: 1 } } }));
  });
  it("records Gemini fallback model instead of attributing it to the primary model", async () => {
    mocks.gemini.mockRejectedValueOnce({ status: 503 }).mockRejectedValueOnce({ status: 503 }).mockResolvedValueOnce({ text: JSON.stringify(result), modelVersion: "lite-snapshot",
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
    const security = testSecurity();
    await security.usage.run("user-a", 1, 20, () => new GeminiAcademicExtractor("fake", "test", "test-lite").extractDocuments(files));
    const attempts = [...(security.usage.store as MemoryUsageStore).attempts.values()];
    expect(attempts.map(a => a.requestedModel)).toEqual(["test", "test", "test-lite"]);
    expect(attempts[2]!.estimatedCostUsd).toBeNull(); // Missing tariff is not zero cost.
  });
  it("persists OpenAI usage before rejecting invalid JSON", async () => {
    mocks.openai.mockResolvedValueOnce({ id: "resp-1", _request_id: "request-1", model: "gpt-test-snapshot", output_text: "invalid",
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 15 } } });
    const security = testSecurity();
    await expect(security.usage.run("user-a", 1, 20, () => new OpenAIAcademicExtractor("fake", "gpt-test").extractDocuments(files))).rejects.toThrow();
    const a = [...(security.usage.store as MemoryUsageStore).attempts.values()][0]!;
    expect(a.status).toBe("success"); expect(a.providerRequestId).toBe("request-1");
    expect(a.usage?.outputTokens).toBe(30); expect(a.usage?.reasoningTokens).toBe(15);
  });
});
