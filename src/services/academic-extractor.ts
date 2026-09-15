import { createHash } from "node:crypto";
import { markCache } from "../usage/meter.js";
import { HttpError } from "../usage/types.js";
import type { ExtractedDocument } from "../schemas/academic.schema.js";

export type AcademicFile = { buffer: Buffer; fileName: string; mimeType: string };

export interface AcademicExtractor {
  extractDocuments(files: AcademicFile[]): Promise<ExtractedDocument>;
}

export function getApiStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

export function getApiErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const directCode = "code" in error ? (error as { code?: unknown }).code : undefined;
  if (typeof directCode === "string") return directCode;
  const nested = "error" in error ? (error as { error?: unknown }).error : undefined;
  if (typeof nested !== "object" || nested === null || !("code" in nested)) return undefined;
  const nestedCode = (nested as { code?: unknown }).code;
  return typeof nestedCode === "string" ? nestedCode : undefined;
}

export function getApiRequestId(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = "requestID" in error ? (error as { requestID?: unknown }).requestID : undefined;
  return typeof value === "string" ? value : undefined;
}

export function isRetryableApiError(error: unknown): boolean {
  if (error instanceof HttpError) return false;
  const status = getApiStatus(error);
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export function retryAfterMs(error: unknown, fallbackMs = 1_000): number {
  if (typeof error !== "object" || error === null || !("headers" in error)) return fallbackMs;
  const headers = (error as { headers?: unknown }).headers;
  const raw = headers instanceof Headers
    ? headers.get("retry-after")
    : typeof headers === "object" && headers !== null && "get" in headers && typeof headers.get === "function"
      ? headers.get("retry-after")
      : undefined;
  if (typeof raw !== "string") return fallbackMs;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const dateMs = Date.parse(raw);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : fallbackMs;
}

export class CachedAcademicExtractor implements AcademicExtractor {
  private readonly cache = new Map<string, { value: ExtractedDocument; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<ExtractedDocument>>();

  constructor(
    private readonly delegate: AcademicExtractor,
    private readonly ttlMs = 24 * 60 * 60 * 1_000,
    private readonly maxEntries = 100
  ) {}

  async extractDocuments(files: AcademicFile[]): Promise<ExtractedDocument> {
    const key = hashFiles(files);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) { markCache("hit"); return structuredClone(cached.value); }
    if (cached) this.cache.delete(key);

    const existing = this.inFlight.get(key);
    if (existing) { markCache("shared"); return structuredClone(await existing); }

    const request = this.delegate.extractDocuments(files);
    this.inFlight.set(key, request);
    try {
      const value = await request;
      this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
      while (this.cache.size > this.maxEntries) {
        const oldestKey = this.cache.keys().next().value as string | undefined;
        if (!oldestKey) break;
        this.cache.delete(oldestKey);
      }
      return structuredClone(value);
    } finally {
      this.inFlight.delete(key);
    }
  }
}

export class FallbackAcademicExtractor implements AcademicExtractor {
  constructor(private readonly primary: AcademicExtractor, private readonly fallback: AcademicExtractor) {}

  async extractDocuments(files: AcademicFile[]): Promise<ExtractedDocument> {
    try {
      return await this.primary.extractDocuments(files);
    } catch (error) {
      if (!isRetryableApiError(error)) throw error;
      console.warn(`Provedor principal indisponível (HTTP ${getApiStatus(error)}); usando provedor alternativo.`);
      return this.fallback.extractDocuments(files);
    }
  }
}

function hashFiles(files: AcademicFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.mimeType).update("\0").update(file.buffer);
  }
  return hash.digest("hex");
}
