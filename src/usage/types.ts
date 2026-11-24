export type Provider = "gemini" | "openai";
export type TokenUsage = { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number };
export type Price = { version: string; inputUsdPerMillion: number; cachedInputUsdPerMillion: number; outputUsdPerMillion: number };
export type PriceTable = Record<string, Price>;
export type Operation = {
  id: string; uid: string; createdAt: string; status: "pending" | "success" | "error";
  cache: "miss" | "hit" | "shared"; filesCount: number; totalBytes: number;
  durationMs: number | null; errorCode: string | null;
};
export type Attempt = {
  id: string; operationId: string; uid: string; createdAt: string; provider: Provider;
  providerFinishReason?: string | null;
  requestedModel: string; actualModel: string | null; status: "pending" | "success" | "error";
  usage: TokenUsage | null; estimatedCostUsd: number | null; price: Price | null;
  durationMs: number | null; providerRequestId: string | null; errorCode: string | null;
};
export type UsageLimits = {
  userDailyRequests: number; globalDailyRequests: number; userRequestsPerMinute: number;
  userDailyAttempts: number; globalDailyAttempts: number;
  userDailyUsd: number; globalDailyUsd: number;
};
export type Report = { operations: Operation[]; attempts: Attempt[] };
export interface UsageStore {
  reserveOperation(operation: Operation, limits: UsageLimits): Promise<void>;
  finishOperation(id: string, result: Pick<Operation, "status" | "cache" | "durationMs" | "errorCode">): Promise<void>;
  reserveAttempt(attempt: Attempt, limits: UsageLimits): Promise<void>;
  finishAttempt(attempt: Attempt): Promise<void>;
  report(from: string, to: string): Promise<Report>;
}
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) { super(message); }
}
export class AccountingError extends HttpError {
  constructor() { super(503, "ACCOUNTING_UNAVAILABLE", "O registro de consumo está indisponível. Tente novamente mais tarde."); }
}
