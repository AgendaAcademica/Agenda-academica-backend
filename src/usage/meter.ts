import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { providerErrorStatus } from "../services/provider-error.js";
import type { GenerateContentResponse } from "@google/genai";
import type { Response } from "openai/resources/responses/responses";
import { AccountingError, HttpError, type Attempt, type Operation, type PriceTable, type Provider, type TokenUsage, type UsageLimits, type UsageStore } from "./types.js";

type Context = { operation: Operation; store: UsageStore; limits: UsageLimits; prices: PriceTable };
export const usageContext = new AsyncLocalStorage<Context>();
export function markCache(cache: Operation["cache"]) { const ctx = usageContext.getStore(); if (ctx) ctx.operation.cache = cache; }

export function estimateCost(usage: TokenUsage | null, price: PriceTable[string] | undefined): number | null {
  if (!usage || !price) return null;
  return Math.round(((usage.inputTokens - usage.cachedInputTokens) * price.inputUsdPerMillion
    + usage.cachedInputTokens * price.cachedInputUsdPerMillion + usage.outputTokens * price.outputUsdPerMillion) * 1000) / 1e9;
}
function validUsage(input: number | undefined, cached: number, output: number | undefined, reasoning: number): TokenUsage | null {
  if (input === undefined || output === undefined || ![input, cached, output, reasoning].every(n => Number.isSafeInteger(n) && n >= 0)
    || cached > input || reasoning > output) return null;
  return { inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningTokens: reasoning };
}
export function geminiUsage(response: GenerateContentResponse) {
  const u = response.usageMetadata;
  return validUsage(u?.promptTokenCount, u?.cachedContentTokenCount ?? 0,
    u?.candidatesTokenCount === undefined ? undefined : u.candidatesTokenCount + (u.thoughtsTokenCount ?? 0), u?.thoughtsTokenCount ?? 0);
}
export function openaiUsage(response: Response) {
  const u = response.usage;
  // OpenAI output_tokens already includes reasoning; Gemini candidatesTokenCount does not.
  return validUsage(u?.input_tokens, u?.input_tokens_details?.cached_tokens ?? 0, u?.output_tokens, u?.output_tokens_details?.reasoning_tokens ?? 0);
}
export function safeErrorCode(error: unknown): string {
  if (error instanceof HttpError) return error.code;
  const status = providerErrorStatus(error);
  return typeof status === "number" ? `UPSTREAM_${status}` : "PROCESSING_FAILED";
}
async function persist(action: () => Promise<void>) {
  try { await action(); } catch (error) { if (error instanceof HttpError) throw error; throw new AccountingError(); }
}
export async function meteredCall<T>(provider: Provider, model: string, call: () => Promise<T>, metadata: (response: T) => {
  usage: TokenUsage | null; model: string | null; requestId: string | null;
}): Promise<T> {
  const ctx = usageContext.getStore();
  if (!ctx) throw new AccountingError();
  const started = Date.now();
  const attempt: Attempt = { id: randomUUID(), operationId: ctx.operation.id, uid: ctx.operation.uid,
    createdAt: new Date(started).toISOString(), provider, requestedModel: model, actualModel: null,
    status: "pending", usage: null, estimatedCostUsd: null, price: ctx.prices[`${provider}:${model}`] ?? null,
    durationMs: null, providerRequestId: null, errorCode: null };
  await persist(() => ctx.store.reserveAttempt(attempt, ctx.limits));
  let response: T;
  try { response = await call(); }
  catch (error) {
    attempt.status = "error"; attempt.errorCode = safeErrorCode(error); attempt.durationMs = Date.now() - started;
    // A timeout/error without usage is unknown, never a fabricated zero-dollar call.
    await persist(() => ctx.store.finishAttempt(attempt));
    throw error;
  }
  const meta = metadata(response);
  attempt.actualModel = meta.model; attempt.usage = meta.usage; attempt.providerRequestId = meta.requestId;
  attempt.estimatedCostUsd = estimateCost(meta.usage, attempt.price ?? undefined);
  attempt.status = "success"; attempt.durationMs = Date.now() - started;
  // Persist BEFORE JSON parsing: malformed output may still have a provider cost.
  await persist(() => ctx.store.finishAttempt(attempt));
  return response;
}

export class UsageService {
  constructor(readonly store: UsageStore, readonly limits: UsageLimits, readonly prices: PriceTable) {}
  async run<T>(uid: string, filesCount: number, totalBytes: number, action: () => Promise<T>): Promise<{ data: T; operationId: string; cache: Operation["cache"] }> {
    const started = Date.now();
    const operation: Operation = { id: randomUUID(), uid, createdAt: new Date(started).toISOString(), status: "pending",
      cache: "miss", filesCount, totalBytes, durationMs: null, errorCode: null };
    await persist(() => this.store.reserveOperation(operation, this.limits));
    return usageContext.run({ operation, store: this.store, limits: this.limits, prices: this.prices }, async () => {
      let data: T;
      try { data = await action(); }
      catch (error) {
        await persist(() => this.store.finishOperation(operation.id, { status: "error", cache: operation.cache,
          durationMs: Date.now() - started, errorCode: safeErrorCode(error) }));
        throw error;
      }
      await persist(() => this.store.finishOperation(operation.id, { status: "success", cache: operation.cache,
        durationMs: Date.now() - started, errorCode: null }));
      return { data, operationId: operation.id, cache: operation.cache };
    });
  }
}
