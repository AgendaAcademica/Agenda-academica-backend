import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { documentCacheKey, PersistentAcademicExtractor, type DocumentCacheStore } from "../src/services/document-cache.js";
import { extractedDocumentSchema, type ExtractedDocument } from "../src/schemas/academic.schema.js";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { UsageService } from "../src/usage/meter.js";
import { limits, testSecurity } from "./support.js";

const files = [{ buffer: Buffer.from("%PDF-1.7 content"), fileName: "original.pdf", mimeType: "application/pdf" }];
const value = extractedDocumentSchema.parse({ disciplines: [{ documentTitle: "Plano", disciplineName: "Cálculo" }] });
function memoryCache(): DocumentCacheStore {
  const rows = new Map<string, { owner: string; value?: ExtractedDocument }>();
  return {
    async claim(key, owner) {
      const row = rows.get(key);
      if (row?.value) return { status: "hit", value: structuredClone(row.value) };
      if (row) return { status: "busy" };
      rows.set(key, { owner }); return { status: "owned" };
    },
    async complete(key, owner, result) { if (rows.get(key)?.owner === owner) rows.set(key, { owner, value: structuredClone(result) }); },
    async release(key, owner) { if (rows.get(key)?.owner === owner && !rows.get(key)?.value) rows.delete(key); }
  };
}

describe("persistent document cache", () => {
  it("keys content, MIME, file boundaries, order and version, but not file names", () => {
    expect(documentCacheKey(files, "v1")).toBe(documentCacheKey([{ ...files[0]!, fileName: "renamed.pdf" }], "v1"));
    expect(documentCacheKey(files, "v1")).not.toBe(documentCacheKey(files, "v2"));
    const other = { ...files[0]!, buffer: Buffer.from("different") };
    expect(documentCacheKey(files, "v1")).not.toBe(documentCacheKey([other], "v1"));
    expect(documentCacheKey(files, "v1")).not.toBe(documentCacheKey([{ ...files[0]!, mimeType: "image/png" }], "v1"));
    expect(documentCacheKey([...files, other], "v1")).not.toBe(documentCacheKey([other, ...files], "v1"));
    expect(documentCacheKey([...files, other], "v1")).not.toBe(documentCacheKey([{ ...other, buffer: Buffer.concat([files[0]!.buffer, other.buffer]) }], "v1"));
  });
  it("reuses another user's result after extractor recreation, without another daily slot", async () => {
    const store = memoryCache();
    const delegate = { extractDocuments: vi.fn().mockResolvedValue(value) };
    const security = testSecurity();
    security.usage = new UsageService(security.usage.store, { ...limits, globalDailyRequests: 1 }, {});
    const app = () => createApp(loadEnv({ NODE_ENV: "test" }), new PersistentAcademicExtractor(delegate, store, "v1", 60_000), security);
    const upload = (token: string) => request(app()).post("/api/v1/documents/extract").set("Authorization", `Bearer ${token}`)
      .attach("file", files[0]!.buffer, { filename: `${token}.pdf`, contentType: "application/pdf" });
    const first = await upload("user-a");
    const second = await upload("user-b");
    expect(first.status).toBe(200); expect(first.body.meta.cache).toBe("miss");
    expect(second.status).toBe(200); expect(second.body.meta.cache).toBe("hit");
    expect(second.body.data).toEqual(first.body.data);
    expect(delegate.extractDocuments).toHaveBeenCalledTimes(1);
  });
  it("blocks duplicate work across extractor instances while a document is pending", async () => {
    const store = memoryCache();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const delegate = { extractDocuments: vi.fn(async () => { await barrier; return value; }) };
    const first = new PersistentAcademicExtractor(delegate, store, "v1", 60_000).extractDocuments(files);
    await vi.waitFor(() => expect(delegate.extractDocuments).toHaveBeenCalledTimes(1));
    const second = new PersistentAcademicExtractor(delegate, store, "v1", 60_000);
    await expect(second.extractDocuments(files)).rejects.toMatchObject({ code: "SERVER_BUSY" });
    release(); await first;
    expect(await second.extractDocuments(files)).toEqual(value);
    expect(delegate.extractDocuments).toHaveBeenCalledTimes(1);
  });
  it("releases reservations on quota rejection and does not invoke AI", async () => {
    const store = memoryCache();
    const delegate = { extractDocuments: vi.fn().mockResolvedValue(value) };
    const extractor = new PersistentAcademicExtractor(delegate, store, "v1", 60_000);
    await expect(extractor.extractDocuments(files, async () => { throw new Error("quota"); })).rejects.toThrow("quota");
    expect(delegate.extractDocuments).not.toHaveBeenCalled();
    expect(await extractor.extractDocuments(files)).toEqual(value);
  });
  it("does not cache failures or invalid responses", async () => {
    const store = memoryCache();
    const delegate = { extractDocuments: vi.fn().mockRejectedValueOnce(new Error("provider")).mockResolvedValueOnce({ disciplines: [] }).mockResolvedValue(value) };
    const extractor = new PersistentAcademicExtractor(delegate, store, "v1", 60_000);
    await expect(extractor.extractDocuments(files)).rejects.toThrow("provider");
    await expect(extractor.extractDocuments(files)).rejects.toThrow();
    expect(await extractor.extractDocuments(files)).toEqual(value);
    expect(await extractor.extractDocuments(files)).toEqual(value);
    expect(delegate.extractDocuments).toHaveBeenCalledTimes(3);
  });
  it("fails closed when cache lookup is unavailable", async () => {
    const store = memoryCache(); vi.spyOn(store, "claim").mockRejectedValue(new Error("offline"));
    const delegate = { extractDocuments: vi.fn() };
    await expect(new PersistentAcademicExtractor(delegate, store, "v1", 60_000).extractDocuments(files)).rejects.toMatchObject({ code: "DOCUMENT_CACHE_UNAVAILABLE" });
    expect(delegate.extractDocuments).not.toHaveBeenCalled();
  });
});
