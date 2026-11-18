import { readFileSync } from "node:fs";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { loadUsageConfig } from "../src/usage/config.js";
import { UsageService } from "../src/usage/meter.js";
import type { UsageLimits } from "../src/usage/types.js";
import { createAcademicExtractor } from "../src/services/extractor.factory.js";
import type { DocumentCacheStore } from "../src/services/document-cache.js";
import { extractedDocumentSchema, type ExtractedDocument } from "../src/schemas/academic.schema.js";
import { MemoryUsageStore, testSecurity } from "./support.js";

// Explicit sources keep these tests independent of local secrets and quota overrides.
const env = loadEnv({ NODE_ENV: "test", GEMINI_API_KEY: "fake", GEMINI_MODEL: "test", GEMINI_FALLBACK_MODEL: "test" });
const config = loadUsageConfig(env, { FIREBASE_PROJECT_ID: "demo-document-import" });
const algebra = readFileSync(new URL("./fixtures/algebra-linear.pdf", import.meta.url));
const databases = readFileSync(new URL("./fixtures/banco-de-dados.pdf", import.meta.url));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=", "base64");
const algebraData = extractedDocumentSchema.parse({ disciplines: [{
  documentTitle: "Plano de ensino - Algebra Linear", disciplineName: "Algebra Linear", disciplineCode: "MAT201",
  professor: "Ada", term: "2026/2", events: [{ title: "Prova de matrizes", date: "2026-12-01", time: "08:00", activityType: "PROVA", priority: "URGENTE" }]
}] });
const databasesData = extractedDocumentSchema.parse({ disciplines: [{
  documentTitle: "Plano de ensino - Banco de Dados", disciplineName: "Banco de Dados", disciplineCode: "INF202",
  professor: "Grace", term: "2026/2", events: [{ title: "Entrega do projeto SQL", date: "2026-12-05", time: "14:00", activityType: "PROJETO", priority: "ALTA" }]
}] });

function memoryDocumentCache(): DocumentCacheStore {
  const rows = new Map<string, { owner: string; value?: ExtractedDocument }>();
  return {
    async claim(key, owner) {
      const row = rows.get(key);
      if (row?.value) return { status: "hit", value: structuredClone(row.value) };
      if (row) return { status: "busy" };
      rows.set(key, { owner });
      return { status: "owned" };
    },
    async complete(key, owner, value) {
      if (rows.get(key)?.owner === owner) rows.set(key, { owner, value: structuredClone(value) });
    },
    async release(key, owner) {
      if (rows.get(key)?.owner === owner && !rows.get(key)?.value) rows.delete(key);
    }
  };
}

type ProviderBody = { contents: { parts: { inlineData?: { data: string; mimeType: string } }[] }[] };
function setup(options: { limits?: Partial<UsageLimits>; maxFileMb?: number; maxTotalMb?: number } = {}) {
  const store = new MemoryUsageStore();
  const security = testSecurity(store);
  security.maxUploadTotalMb = options.maxTotalMb ?? config.MAX_UPLOAD_TOTAL_MB;
  security.usage = new UsageService(store, { ...config.limits, ...options.limits }, {
    "gemini:test": { version: "test-only", inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 2 }
  });
  // Use the real SDK, provider adapter, persistent-cache wrapper and usage service.
  // Only provider HTTP, token verification and storage are replaced; no paid AI calls.
  const providerFiles: { buffer: Buffer; mimeType: string }[][] = [];
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as ProviderBody;
    const files = body.contents.flatMap(content => content.parts).flatMap(part => part.inlineData
      ? [{ buffer: Buffer.from(part.inlineData.data, "base64"), mimeType: part.inlineData.mimeType }] : []);
    providerFiles.push(files);
    let data: ExtractedDocument;
    if (files.length > 0 && files.every(file => file.mimeType === "image/png")) data = algebraData;
    else if (files.length === 1 && files[0]!.buffer.includes(Buffer.from("Disciplina: Algebra Linear"))) data = algebraData;
    else if (files.length === 1 && files[0]!.buffer.includes(Buffer.from("Disciplina: Banco de Dados"))) data = databasesData;
    else throw new Error("Unexpected fixture sent to the provider");
    return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: JSON.stringify(data) }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }), { status: 200 });
  });
  const app = createApp({ ...env, MAX_PDF_SIZE_MB: options.maxFileMb ?? env.MAX_PDF_SIZE_MB },
    createAcademicExtractor(env, memoryDocumentCache()), security);
  return { app, store, fetch, providerFiles };
}
function upload(app: ReturnType<typeof createApp>, buffer: Buffer, filename = "plano.pdf", token = "user-a") {
  return request(app).post("/api/v1/documents/extract").set("Authorization", `Bearer ${token}`)
    .attach("file", buffer, { filename, contentType: "application/pdf" });
}
const operations = (store: MemoryUsageStore) => [...store.operations.values()];
const attempts = (store: MemoryUsageStore) => [...store.attempts.values()];
const pad = (buffer: Buffer, size: number) => Buffer.concat([buffer, Buffer.alloc(size - buffer.length, 0x20)]);

beforeEach(() => {
  // Freeze only Date: HTTP and SDK timers must continue to run normally.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-18T12:00:00.000Z"));
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("sequential PDF imports through the HTTP and provider adapters", () => {
  it("returns independent subjects and events for different PDFs even with the same filename", async () => {
    const { app, store, fetch, providerFiles } = setup();
    const first = await upload(app, algebra);
    const second = await upload(app, databases);
    for (const [response, buffer, data] of [[first, algebra, algebraData], [second, databases, databasesData]] as const) {
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(data);
      expect(response.body.meta).toEqual({ operationId: expect.any(String), cache: "miss", fileName: "plano.pdf",
        fileSize: buffer.length, filesCount: 1, disciplinesCount: 1, eventsCount: 1, mimeType: "application/pdf" });
    }
    expect(first.body.meta.operationId).not.toBe(second.body.meta.operationId);
    expect(providerFiles).toEqual([[{ buffer: algebra, mimeType: "application/pdf" }], [{ buffer: databases, mimeType: "application/pdf" }]]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(operations(store).map(op => [op.id, op.status, op.filesCount, op.totalBytes])).toEqual([
      [first.body.meta.operationId, "success", 1, algebra.length], [second.body.meta.operationId, "success", 1, databases.length]
    ]);
    expect(attempts(store).map(attempt => attempt.operationId)).toEqual([first.body.meta.operationId, second.body.meta.operationId]);
  });

  it("preserves the first success, rejects an invalid PDF without quota, then retries only the corrected file", async () => {
    const { app, store, fetch, providerFiles } = setup({ limits: { userDailyRequests: 2 } });
    const first = await upload(app, algebra, "algebra-linear.pdf");
    const invalid = await upload(app, Buffer.from("arquivo corrompido"), "banco-de-dados.pdf");
    expect(first.status).toBe(200);
    expect(invalid.status).toBe(415);
    expect(invalid.body).toEqual({ error: "O arquivo deve ser um PDF, JPEG, PNG ou WebP válido." });
    expect(operations(store)).toHaveLength(1);
    expect(attempts(store)).toHaveLength(1);
    const corrected = await upload(app, databases, "banco-de-dados.pdf");
    expect(corrected.status).toBe(200);
    expect(corrected.body.data).toEqual(databasesData);
    expect(first.body.data).toEqual(algebraData);
    expect(operations(store).map(op => op.status)).toEqual(["success", "success"]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(providerFiles[1]).toEqual([{ buffer: databases, mimeType: "application/pdf" }]);
  });

  it.each(["application/octet-stream", "text/plain"])("rejects unsupported declared MIME %s before accounting", async contentType => {
    const { app, store, fetch } = setup();
    const response = await request(app).post("/api/v1/documents/extract").set("Authorization", "Bearer user-a")
      .attach("file", algebra, { filename: "plano.pdf", contentType });
    expect(response.status).toBe(415);
    expect(response.body).toEqual({ error: "O arquivo deve ser um PDF, JPEG, PNG ou WebP válido." });
    expect(store.operations.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["PDF", "imagem"])("rejects a PDF accompanied by another %s before accounting", async kind => {
    const { app, store, fetch } = setup();
    const response = await request(app).post("/api/v1/documents/extract").set("Authorization", "Bearer user-a")
      .attach("files", algebra, { filename: "algebra.pdf", contentType: "application/pdf" })
      .attach("files", kind === "PDF" ? databases : png, { filename: kind === "PDF" ? "banco.pdf" : "pagina.png", contentType: kind === "PDF" ? "application/pdf" : "image/png" });
    expect(response.status).toBe(415);
    expect(response.body).toEqual({ error: "O envio múltiplo aceita somente imagens." });
    expect(store.operations.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps joint analysis of ten image pages in one operation and rejects an eleventh", async () => {
    const { app, store, fetch, providerFiles } = setup();
    const pages = (count: number) => {
      const req = request(app).post("/api/v1/documents/extract").set("Authorization", "Bearer user-a");
      for (let page = 1; page <= count; page++) req.attach("files", png, { filename: `pagina-${page}.png`, contentType: "image/png" });
      return req;
    };
    const response = await pages(10);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(algebraData);
    expect(response.body.meta).toMatchObject({ filesCount: 10, fileSize: png.length * 10, mimeType: "multipart/images" });
    expect(providerFiles[0]).toEqual(Array.from({ length: 10 }, () => ({ buffer: png, mimeType: "image/png" })));
    const tooMany = await pages(11);
    expect(tooMany.status).toBe(400);
    expect(tooMany.body).toEqual({ error: "Envio inválido. Use até dez arquivos nos campos file ou files.", code: "INVALID_UPLOAD" });
    expect(store.operations.size).toBe(1);
    expect(store.attempts.size).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("upload size boundaries", () => {
  it("uses 20 MiB defaults for both file and total limits", () => {
    expect(env.MAX_PDF_SIZE_MB).toBe(20);
    expect(config.MAX_UPLOAD_TOTAL_MB).toBe(20);
    expect(config.MAX_CONCURRENT_EXTRACTIONS).toBe(2);
  });

  it("accepts a PDF below the file limit and rejects the boundary and excess without quota", async () => {
    const { app, store, fetch } = setup({ maxFileMb: 1 / 1024, maxTotalMb: 2 / 1024 });
    expect((await upload(app, pad(algebra, 1023))).status).toBe(200);
    for (const size of [1024, 1025]) {
      const response = await upload(app, pad(databases, size));
      expect(response.status).toBe(413);
      expect(response.body).toEqual({ error: "O arquivo excede o limite de 0.0009765625 MB." });
    }
    expect(store.operations.size).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await upload(app, databases)).status).toBe(200);
    expect(store.operations.size).toBe(2);
  });

  it("accepts exactly the total limit and rejects its excess even when each image fits", async () => {
    const { app, store, fetch } = setup({ maxFileMb: 2 / 1024, maxTotalMb: 1 / 1024 });
    const pages = (secondSize: number) => request(app).post("/api/v1/documents/extract").set("Authorization", "Bearer user-a")
      .attach("files", pad(png, 512), { filename: "1.png", contentType: "image/png" })
      .attach("files", pad(png, secondSize), { filename: "2.png", contentType: "image/png" });
    expect((await pages(512)).status).toBe(200);
    const response = await pages(513);
    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: "O tamanho total dos arquivos excede o limite permitido.", code: "UPLOAD_TOO_LARGE", retryable: false });
    expect(store.operations.size).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("applies the total limit to a single PDF and resets it for each consecutive request", async () => {
    const { app, store, fetch } = setup({ maxFileMb: 2 / 1024, maxTotalMb: 1 / 1024 });
    for (const pdf of [algebra, databases, pad(databases, 1024)]) expect((await upload(app, pdf)).status).toBe(200);
    const response = await upload(app, pad(databases, 1025));
    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: "O tamanho total dos arquivos excede o limite permitido.", code: "UPLOAD_TOO_LARGE", retryable: false });
    expect(store.operations.size).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("quota consumption and isolated retries", () => {
  it("pauses the fourth new PDF in a fixed minute and resumes it after Retry-After", async () => {
    const { app, store, fetch } = setup();
    const third = Buffer.concat([algebra, Buffer.from("\n% revisao 2\n")]);
    const fourth = Buffer.concat([databases, Buffer.from("\n% revisao 2\n")]);
    for (const pdf of [algebra, databases, third]) expect((await upload(app, pdf)).status).toBe(200);
    const blocked = await upload(app, fourth);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: "Muitos envios.", code: "USER_RATE_LIMIT", retryable: true });
    expect(blocked.headers["retry-after"]).toBe("60");
    expect(store.operations.size).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(3);
    vi.setSystemTime(Date.now() + Number(blocked.headers["retry-after"]) * 1000);
    const resumed = await upload(app, fourth);
    expect(resumed.status).toBe(200);
    expect(resumed.body.data).toEqual(databasesData);
    expect(resumed.body.meta.cache).toBe("miss");
    expect(operations(store).map(op => op.status)).toEqual(["success", "success", "success", "success"]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each([
    { cap: { userDailyRequests: 1 }, code: "USER_DAILY_QUOTA", admitted: false, token: "user-a" },
    { cap: { globalDailyRequests: 1 }, code: "GLOBAL_DAILY_QUOTA", admitted: false, token: "user-b" },
    { cap: { userDailyAttempts: 1 }, code: "USER_AI_QUOTA", admitted: true, token: "user-a" },
    { cap: { globalDailyAttempts: 1 }, code: "GLOBAL_AI_QUOTA", admitted: true, token: "user-b" },
    { cap: { userDailyUsd: 0.00002 }, code: "USER_COST_LIMIT", admitted: true, token: "user-a" },
    { cap: { globalDailyUsd: 0.00002 }, code: "GLOBAL_COST_LIMIT", admitted: true, token: "user-b" }
  ])("reports $code and allows only the blocked PDF to be retried after the UTC reset", async ({ cap, code, admitted, token }) => {
    const { app, store, fetch } = setup({ limits: cap });
    const first = await upload(app, algebra);
    expect(first.status).toBe(200);
    const blocked = await upload(app, databases, "banco.pdf", token);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: "Cota atingida.", code, retryable: false });
    expect(blocked.headers["retry-after"]).toBe("43200");
    expect(operations(store).map(op => op.status)).toEqual(admitted ? ["success", "error"] : ["success"]);
    expect(attempts(store)).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-11-19T00:00:00.000Z"));
    const retried = await upload(app, databases, "banco.pdf", token);
    expect(retried.status).toBe(200);
    expect(retried.body.data).toEqual(databasesData);
    expect(retried.body.meta.cache).toBe("miss");
    expect(first.body.data).toEqual(algebraData);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reuses an identical renamed PDF after daily exhaustion but still applies the minute quota", async () => {
    const { app, store, fetch } = setup({ limits: { userDailyRequests: 1, globalDailyRequests: 1 } });
    const first = await upload(app, algebra);
    for (const filename of ["renomeado.pdf", "mais-uma-tentativa.pdf"]) {
      const repeated = await upload(app, algebra, filename);
      expect(repeated.status).toBe(200);
      expect(repeated.body.data).toEqual(algebraData);
      expect(repeated.body.meta).toMatchObject({ cache: "hit", fileName: filename });
      expect(repeated.body.meta.operationId).not.toBe(first.body.meta.operationId);
    }
    const blocked = await upload(app, algebra);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("USER_RATE_LIMIT");
    expect(blocked.headers["retry-after"]).toBe("60");
    expect(operations(store).map(op => op.cache)).toEqual(["miss", "hit", "hit"]);
    expect(attempts(store)).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([429, 503])("accounts for a provider HTTP %s failure and charges a fresh operation on isolated retry", async status => {
    const { app, store, fetch } = setup();
    const unavailable = () => new Response(JSON.stringify({ error: { code: status, message: "Provider unavailable" } }), { status });
    // Exhaust both calls of the real adapter's internal retry before the mobile retry.
    fetch.mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(unavailable());
    const failed = await upload(app, algebra);
    expect(failed.status).toBe(status);
    expect(failed.body).toEqual(status === 429
      ? { error: "O limite temporário de análises foi atingido. Aguarde alguns instantes e tente novamente.", code: "PROVIDER_RATE_LIMIT", retryable: true }
      : { error: "O serviço de inteligência artificial está temporariamente ocupado. Aguarde alguns instantes e tente novamente.", retryable: true });
    expect(failed.headers["retry-after"]).toBe("30");
    vi.setSystemTime(Date.now() + 30_000);
    const retried = await upload(app, algebra);
    expect(retried.status).toBe(200);
    expect(retried.body.data).toEqual(algebraData);
    expect(retried.body.meta.cache).toBe("miss");
    expect(operations(store).map(op => [op.status, op.cache])).toEqual([["error", "miss"], ["success", "miss"]]);
    expect(attempts(store).map(attempt => [attempt.status, attempt.estimatedCostUsd])).toEqual([["error", null], ["error", null], ["success", 0.00002]]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
