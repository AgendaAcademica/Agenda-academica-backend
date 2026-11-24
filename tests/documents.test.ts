import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/config/env.js";
import type { AcademicExtractor } from "../src/services/academic-extractor.js";
import { MemoryUsageStore, testSecurity } from "./support.js";

const env: Env = { NODE_ENV: "test", PORT: 3000, AI_PROVIDER: "gemini", AI_FALLBACK_PROVIDER: "none", GEMINI_API_KEY: "test", GEMINI_MODEL: "test", GEMINI_FALLBACK_MODEL: "test-lite", OPENAI_MODEL: "gpt-5-mini", AI_DOCUMENT_CACHE_TTL_DAYS: 30, AI_CACHE_TTL_MINUTES: 1440, AI_CACHE_MAX_ENTRIES: 100, MAX_PDF_SIZE_MB: 1, BASE_PLAN_DISCIPLINE_LIMIT: 6, CORS_ORIGIN: "*" };
const data = { disciplines: [{ documentTitle: "Plano", disciplineName: "Cálculo I", disciplineCode: "MAT101", professor: "Ada", term: "2026/2", classroom: "A1", schedule: "Seg 08:00", recommendedColorHex: "#2563EB", events: [] }] };

describe("POST /api/v1/documents/extract", () => {
  it("expõe a configuração ativa sem revelar credenciais", async () => {
    const extractor: AcademicExtractor = { extractDocuments: vi.fn() };
    const response = await request(createApp(env, extractor, testSecurity())).get("/health");
    expect(response.status).toBe(200);
    expect(response.body.ai).toEqual({ provider: "gemini", model: "test", fallbackProvider: "none", credentialsConfigured: true });
    expect(JSON.stringify(response.body)).not.toContain("GEMINI_API_KEY");
    expect(JSON.stringify(response.body)).not.toContain("test-lite");
  });

  it("valida ausência", async () => {
    const extractor: AcademicExtractor = { extractDocuments: vi.fn() };
    expect((await request(createApp(env, extractor, testSecurity())).post("/api/v1/documents/extract").set("Authorization", "Bearer user-a")).status).toBe(400);
  });

  it("rejeita arquivo com assinatura inválida", async () => {
    const extractor: AcademicExtractor = { extractDocuments: vi.fn() };
    const response = await request(createApp(env, extractor, testSecurity())).post("/api/v1/documents/extract").set("Authorization", "Bearer user-a").attach("file", Buffer.from("falso"), { filename: "falso.png", contentType: "image/png" });
    expect(response.status).toBe(415);
  });

  it("processa PDF", async () => {
    const extractor: AcademicExtractor = { extractDocuments: vi.fn().mockResolvedValue(data) };
    const response = await request(createApp(env, extractor, testSecurity())).post("/api/v1/documents/extract").set("Authorization", "Bearer user-a").attach("file", Buffer.from("%PDF-1.7 teste"), { filename: "plano.pdf", contentType: "application/pdf" });
    expect(response.status).toBe(200);
    expect(response.body.meta.disciplinesCount).toBe(1);
    expect(extractor.extractDocuments).toHaveBeenCalledWith([expect.objectContaining({ buffer: expect.any(Buffer), fileName: "plano.pdf", mimeType: "application/pdf" })]);
  });

  it("processa imagem PNG", async () => {
    const extractor: AcademicExtractor = { extractDocuments: vi.fn().mockResolvedValue(data) };
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("imagem")]);
    const response = await request(createApp(env, extractor, testSecurity())).post("/api/v1/documents/extract").set("Authorization", "Bearer user-a").attach("file", png, { filename: "cronograma.png", contentType: "image/png" });
    expect(response.status).toBe(200);
    expect(response.body.meta.mimeType).toBe("image/png");
    expect(extractor.extractDocuments).toHaveBeenCalledWith([expect.objectContaining({ buffer: expect.any(Buffer), fileName: "cronograma.png", mimeType: "image/png" })]);
  });

  it("processa várias imagens da mesma disciplina", async () => {
    const extractor: AcademicExtractor = { extractDocuments: vi.fn().mockResolvedValue(data) };
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("imagem")]);
    const response = await request(createApp(env, extractor, testSecurity())).post("/api/v1/documents/extract").set("Authorization", "Bearer user-a")
      .attach("files", png, { filename: "pagina-1.png", contentType: "image/png" })
      .attach("files", png, { filename: "pagina-2.png", contentType: "image/png" });
    expect(response.status).toBe(200);
    expect(response.body.meta.filesCount).toBe(2);
    expect(extractor.extractDocuments).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ fileName: "pagina-1.png" }),
      expect.objectContaining({ fileName: "pagina-2.png" })
    ]));
  });

  it.each(["file", "files", "ambos"])("aceita exatamente 10 PDFs usando %s", async field => {
    const store = new MemoryUsageStore();
    const extractor: AcademicExtractor = { extractDocuments: vi.fn().mockResolvedValue(data) };
    const upload = request(createApp(env, extractor, testSecurity(store))).post("/api/v1/documents/extract")
      .set("Authorization", "Bearer user-a");
    const files = Array.from({ length: 10 }, (_, index) => ({
      buffer: Buffer.from(`%PDF-1.7 plano ${index}`), fileName: `plano-${index}.pdf`, mimeType: "application/pdf"
    }));
    files.forEach((file, index) => upload.attach(field === "ambos" ? (index < 5 ? "file" : "files") : field,
      file.buffer, { filename: file.fileName, contentType: file.mimeType }));
    const response = await upload;
    expect(response.status).toBe(200);
    expect(response.body.meta).toMatchObject({ filesCount: 10, mimeType: "multipart/documents",
      fileSize: files.reduce((sum, file) => sum + file.buffer.length, 0) });
    expect(extractor.extractDocuments).toHaveBeenCalledExactlyOnceWith(files);
    expect([...store.operations.values()]).toEqual([expect.objectContaining({ filesCount: 10, status: "success" })]);
  });

  it.each(["file", "files", "ambos"])("avisa o limite total ao receber 11 documentos usando %s, sem consumir cota", async field => {
    const store = new MemoryUsageStore();
    const security = testSecurity(store);
    security.maxConcurrentExtractions = 1;
    const extractor: AcademicExtractor = { extractDocuments: vi.fn().mockResolvedValue(data) };
    const app = createApp(env, extractor, security);
    const upload = request(app).post("/api/v1/documents/extract").set("Authorization", "Bearer user-a");
    for (let index = 0; index < 11; index++) {
      upload.attach(field === "ambos" ? (index < 5 ? "file" : "files") : field,
        Buffer.from("%PDF-1.7 teste"), { filename: `plano-${index}.pdf`, contentType: "application/pdf" });
    }
    const response = await upload;
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Você pode enviar no máximo 10 documentos por vez.", code: "TOO_MANY_FILES", maxFiles: 10, retryable: false });
    expect(extractor.extractDocuments).not.toHaveBeenCalled();
    expect(store.operations.size).toBe(0);
    const retry = await request(app).post("/api/v1/documents/extract").set("Authorization", "Bearer user-a")
      .attach("file", Buffer.from("%PDF-1.7 teste"), { filename: "plano.pdf", contentType: "application/pdf" });
    expect(retry.status).toBe(200);
  });

  it("rejeita o lote inteiro quando um documento tem assinatura inválida", async () => {
    const store = new MemoryUsageStore();
    const extractor: AcademicExtractor = { extractDocuments: vi.fn() };
    const response = await request(createApp(env, extractor, testSecurity(store))).post("/api/v1/documents/extract")
      .set("Authorization", "Bearer user-a")
      .attach("files", Buffer.from("%PDF-1.7 teste"), { filename: "plano.pdf", contentType: "application/pdf" })
      .attach("files", Buffer.from("inválido"), { filename: "outro.pdf", contentType: "application/pdf" });
    expect(response.status).toBe(415);
    expect(extractor.extractDocuments).not.toHaveBeenCalled();
    expect(store.operations.size).toBe(0);
  });

  it("distingue um campo desconhecido do excesso de documentos", async () => {
    const extractor: AcademicExtractor = { extractDocuments: vi.fn() };
    const response = await request(createApp(env, extractor, testSecurity())).post("/api/v1/documents/extract")
      .set("Authorization", "Bearer user-a")
      .attach("document", Buffer.from("%PDF-1.7 teste"), { filename: "plano.pdf", contentType: "application/pdf" });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_UPLOAD");
    expect(extractor.extractDocuments).not.toHaveBeenCalled();
  });

  it("preserva indisponibilidade temporária como HTTP 503", async () => {
    const extractor: AcademicExtractor = { extractDocuments: vi.fn().mockRejectedValue({ status: 503 }) };
    const response = await request(createApp(env, extractor, testSecurity())).post("/api/v1/documents/extract").set("Authorization", "Bearer user-a")
      .attach("file", Buffer.from("%PDF-1.7 teste"), { filename: "plano.pdf", contentType: "application/pdf" });
    expect(response.status).toBe(503);
    expect(response.body.retryable).toBe(true);
    expect(response.headers["retry-after"]).toBe("30");
  });
});
