import { HttpError, type Attempt, type Operation, type UsageLimits, type UsageStore } from "../src/usage/types.js";
import { UsageService } from "../src/usage/meter.js";
import type { AppSecurity } from "../src/app.js";

export const limits: UsageLimits = { userDailyRequests: 20, globalDailyRequests: 200, userRequestsPerMinute: 3,
  userDailyAttempts: 40, globalDailyAttempts: 400, userDailyUsd: 1, globalDailyUsd: 10 };
// Test double only; production has no in-memory accounting fallback.
export class MemoryUsageStore implements UsageStore {
  operations = new Map<string, Operation>(); attempts = new Map<string, Attempt>();
  async reserveOperation(op: Operation, cap: UsageLimits) {
    const today = [...this.operations.values()].filter(x => x.createdAt.slice(0, 10) === op.createdAt.slice(0, 10));
    const user = today.filter(x => x.uid === op.uid);
    if (op.cache === "miss" && user.filter(x => x.cache === "miss").length >= cap.userDailyRequests)
      throw new HttpError(429, "USER_DAILY_QUOTA", "Cota atingida.");
    if (op.cache === "miss" && today.filter(x => x.cache === "miss").length >= cap.globalDailyRequests)
      throw new HttpError(429, "GLOBAL_DAILY_QUOTA", "Cota atingida.");
    if (user.filter(x => x.createdAt.slice(0, 16) === op.createdAt.slice(0, 16)).length >= cap.userRequestsPerMinute)
      throw new HttpError(429, "USER_RATE_LIMIT", "Muitos envios.");
    this.operations.set(op.id, structuredClone(op));
  }
  async finishOperation(id: string, patch: Pick<Operation, "status" | "cache" | "durationMs" | "errorCode">) { Object.assign(this.operations.get(id)!, patch); }
  async reserveAttempt(attempt: Attempt, cap: UsageLimits) {
    const today = [...this.attempts.values()].filter(x => x.createdAt.slice(0, 10) === attempt.createdAt.slice(0, 10));
    const user = today.filter(x => x.uid === attempt.uid);
    if (user.length >= cap.userDailyAttempts) throw new HttpError(429, "USER_AI_QUOTA", "Cota atingida.");
    if (today.length >= cap.globalDailyAttempts) throw new HttpError(429, "GLOBAL_AI_QUOTA", "Cota atingida.");
    if (user.reduce((sum, x) => sum + (x.estimatedCostUsd ?? 0), 0) >= cap.userDailyUsd)
      throw new HttpError(429, "USER_COST_LIMIT", "Cota atingida.");
    if (today.reduce((sum, x) => sum + (x.estimatedCostUsd ?? 0), 0) >= cap.globalDailyUsd)
      throw new HttpError(429, "GLOBAL_COST_LIMIT", "Cota atingida.");
    this.attempts.set(attempt.id, structuredClone(attempt));
  }
  async finishAttempt(attempt: Attempt) { this.attempts.set(attempt.id, structuredClone(attempt)); }
  async report(from: string, to: string) { return { operations: [...this.operations.values()].filter(x => x.createdAt >= from && x.createdAt < to),
    attempts: [...this.attempts.values()].filter(x => x.createdAt >= from && x.createdAt < to) }; }
}
export function testSecurity(store = new MemoryUsageStore()): AppSecurity {
  return { verifyToken: async token => { if (token === "expired") throw { code: "auth/id-token-expired" }; return { uid: token }; },
    unlimitedEmails: new Set(), admins: new Set(["admin"]), maxConcurrentExtractions: 2, maxUploadTotalMb: 1,
    usage: new UsageService(store, limits, { "gemini:test": { version: "test-only", inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 2 } }) };
}
