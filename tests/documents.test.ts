import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/config/env.js";
import type { AcademicExtractor } from "../src/services/academic-extractor.js";

const env: Env = { NODE_ENV: "test", PORT: 3000, AI_PROVIDER: "gemini", AI_FALLBACK_PROVIDER: "none", GEMINI_API_KEY: "test", GEMINI_MODEL: "test", GEMINI_FALLBACK_MODEL: "test-lite", OPENAI_MODEL: "gpt-5-mini", AI_CACHE_TTL_MINUTES: 1440, AI_CACHE_MAX_ENTRIES: 100, MAX_PDF_SIZE_MB: 1, CORS_ORIGIN: "*" };
const data = { documentTitle: "Plano", disciplineName: "Cálculo I", disciplineCode: "MAT101", professor: "Ada", term: "2026/2", classroom: "A1", schedule: "Seg 08:00", recommendedColorHex: "#2563EB", events: [] };

describe("POST /api/v1/documents/extract", () => {
  it("expõe a configuração ativa sem revelar credenciais", async () => {
    const extractor: AcademicExtractor = { extractDocuments: vi.fn() };
    const response = await request(createApp(env, extractor)).get("/health");
    expect(response.status).toBe(200);
    expect(response.body.ai).toEqual({ provider: "gemini", model: "test", fallbackProvider: "none", credentialsConfigured: true });
    expect(JSON.stringify(response.body)).not.toContain("GEMINI_API_KEY");
    expect(JSON.stringify(response.body)).not.toContain("test-lite");
  });

  it("valida ausência", async () => {
    const extractor: AcademicExtractor = { extractDocuments: vi.fn() };
    expect((await request(createApp(env, extractor)).post("/api/v1/documents/extract")).status).toBe(400);
  });

  it("rejeita arquivo com assinatura inválida", async () => {
    const extractor: AcademicExtractor = { extractDocuments: vi.fn() };
    const response = await request(createApp(env, extractor)).post("/api/v1/documents/extract").attach("file", Buffer.from("falso"), { filename: "falso.png", contentType: "image/png" });
    expect(response.status).toBe(415);
  });

  it("processa PDF", async () => {
    const extractor: AcademicExtractor = { extractDocuments: vi.fn().mockResolvedValue(data) };
    const response = await request(createApp(env, extractor)).post("/api/v1/documents/extract").attach("file", Buffer.from("%PDF-1.7 teste"), { filename: "plano.pdf", contentType: "application/pdf" });
    expect(response.status).toBe(200);
    expect(extractor.extractDocuments).toHaveBeenCalledWith([expect.objectContaining({ buffer: expect.any(Buffer), fileName: "plano.pdf", mimeType: "application/pdf" })]);
  });

  it("processa imagem PNG", async () => {
    const extractor: AcademicExtractor = { extractDocuments: vi.fn().mockResolvedValue(data) };
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("imagem")]);
    const response = await request(createApp(env, extractor)).post("/api/v1/documents/extract").attach("file", png, { filename: "cronograma.png", contentType: "image/png" });
    expect(response.status).toBe(200);
    expect(response.body.meta.mimeType).toBe("image/png");
    expect(extractor.extractDocuments).toHaveBeenCalledWith([expect.objectContaining({ buffer: expect.any(Buffer), fileName: "cronograma.png", mimeType: "image/png" })]);
  });

  it("processa várias imagens da mesma disciplina", async () => {
    const extractor: AcademicExtractor = { extractDocuments: vi.fn().mockResolvedValue(data) };
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("imagem")]);
    const response = await request(createApp(env, extractor)).post("/api/v1/documents/extract")
      .attach("files", png, { filename: "pagina-1.png", contentType: "image/png" })
      .attach("files", png, { filename: "pagina-2.png", contentType: "image/png" });
    expect(response.status).toBe(200);
    expect(response.body.meta.filesCount).toBe(2);
    expect(extractor.extractDocuments).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ fileName: "pagina-1.png" }),
      expect.objectContaining({ fileName: "pagina-2.png" })
    ]));
  });

  it("preserva indisponibilidade temporária como HTTP 503", async () => {
    const extractor: AcademicExtractor = { extractDocuments: vi.fn().mockRejectedValue({ status: 503 }) };
    const response = await request(createApp(env, extractor)).post("/api/v1/documents/extract")
      .attach("file", Buffer.from("%PDF-1.7 teste"), { filename: "plano.pdf", contentType: "application/pdf" });
    expect(response.status).toBe(503);
    expect(response.body.retryable).toBe(true);
    expect(response.headers["retry-after"]).toBe("30");
  });
});
