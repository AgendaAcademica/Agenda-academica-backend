import { createHash, randomUUID } from "node:crypto";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { extractedDocumentSchema, type ExtractedDocument } from "../schemas/academic.schema.js";
import { HttpError } from "../usage/types.js";
import type { AcademicExtractor, AcademicFile, ExtractionRunner } from "./academic-extractor.js";

export const DOCUMENT_CACHE_COLLECTION = "backendDocumentCache";
// Bump whenever provider prompts, parsing or normalization semantics change.
export const EXTRACTION_VERSION = "academic-v1";
export const CACHE_LEASE_MS = 15 * 60_000;
const MAX_RESULT_BYTES = 800_000;

export function documentCacheKey(files: AcademicFile[], version: string): string {
  // Hash each file first: delimiters in binary content cannot create ambiguous boundaries.
  const parts = files.map(file => [file.mimeType, createHash("sha256").update(file.buffer).digest("hex")]);
  return createHash("sha256").update(JSON.stringify([version, parts])).digest("hex");
}

export type CacheClaim = { status: "hit"; value: ExtractedDocument } | { status: "owned" } | { status: "busy" };
export interface DocumentCacheStore {
  claim(key: string, owner: string, version: string): Promise<CacheClaim>;
  complete(key: string, owner: string, value: ExtractedDocument, ttlMs: number): Promise<void>;
  release(key: string, owner: string): Promise<void>;
}

export class FirestoreDocumentCache implements DocumentCacheStore {
  constructor(private readonly db: Firestore, private readonly now: () => number = Date.now) {}

  async claim(key: string, owner: string, version: string): Promise<CacheClaim> {
    const ref = this.db.collection(DOCUMENT_CACHE_COLLECTION).doc(key);
    return this.db.runTransaction(async tx => {
      const row = (await tx.get(ref)).data();
      const now = this.now();
      if (row?.status === "ready" && row.version === version && row.expiresAt instanceof Timestamp && row.expiresAt.toMillis() > now) {
        try {
          const value = extractedDocumentSchema.parse(JSON.parse(row.resultJson));
          return { status: "hit", value };
        } catch { /* Invalid or incompatible entries are replaced, never served. */ }
      }
      if (row?.status === "pending" && row.leaseUntil instanceof Timestamp && row.leaseUntil.toMillis() > now) {
        return { status: "busy" };
      }
      tx.set(ref, { status: "pending", owner, version, createdAt: Timestamp.fromMillis(now),
        leaseUntil: Timestamp.fromMillis(now + CACHE_LEASE_MS) });
      return { status: "owned" };
    });
  }

  async complete(key: string, owner: string, value: ExtractedDocument, ttlMs: number): Promise<void> {
    const resultJson = JSON.stringify(extractedDocumentSchema.parse(value));
    const ref = this.db.collection(DOCUMENT_CACHE_COLLECTION).doc(key);
    await this.db.runTransaction(async tx => {
      const row = (await tx.get(ref)).data();
      // Fencing: a process that lost its lease must not overwrite the new owner.
      if (row?.status !== "pending" || row.owner !== owner) return;
      if (Buffer.byteLength(resultJson, "utf8") > MAX_RESULT_BYTES) {
        tx.delete(ref); // Deliver large results normally without exceeding Firestore's document limit.
        return;
      }
      const now = this.now();
      tx.set(ref, { status: "ready", version: row.version, resultJson,
        createdAt: Timestamp.fromMillis(now), expiresAt: Timestamp.fromMillis(now + ttlMs) });
    });
  }

  async release(key: string, owner: string): Promise<void> {
    const ref = this.db.collection(DOCUMENT_CACHE_COLLECTION).doc(key);
    await this.db.runTransaction(async tx => {
      const row = (await tx.get(ref)).data();
      if (row?.status === "pending" && row.owner === owner) tx.delete(ref);
    });
  }
}

async function cacheAccess<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch { throw new HttpError(503, "DOCUMENT_CACHE_UNAVAILABLE", "O cache de análises está indisponível. Tente novamente mais tarde."); }
}

export class PersistentAcademicExtractor implements AcademicExtractor {
  constructor(private readonly delegate: AcademicExtractor, private readonly store: DocumentCacheStore,
    private readonly version: string, private readonly ttlMs: number) {}

  async extractDocuments(files: AcademicFile[], run: ExtractionRunner = (_cache, action) => action()): Promise<ExtractedDocument> {
    // Provider prompts use the current date to resolve omitted years.
    const version = `${this.version}:${new Date().getUTCFullYear()}`;
    const key = documentCacheKey(files, version);
    const owner = randomUUID();
    const claim = await cacheAccess(() => this.store.claim(key, owner, version));
    if (claim.status === "hit") return run("hit", async () => structuredClone(claim.value));
    if (claim.status === "busy") return run("shared", async () => {
      throw new HttpError(429, "SERVER_BUSY", "Este documento já está sendo analisado. Tente novamente em instantes.");
    });
    try {
      return await run("miss", async () => {
        const value = extractedDocumentSchema.parse(await this.delegate.extractDocuments(files));
        await cacheAccess(() => this.store.complete(key, owner, value, this.ttlMs));
        return value;
      });
    } catch (error) {
      // Quota rejection and provider failures must not leave a pending lock.
      // If cleanup itself fails, the lease provides bounded recovery after a restart.
      try { await this.store.release(key, owner); } catch { console.warn("Não foi possível liberar a reserva do cache de documentos."); }
      throw error;
    }
  }
}
