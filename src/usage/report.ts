import type { Report } from "./types.js";

export function summarize(report: Report) {
  const users = new Map<string, { uid: string; requests: number; successfulRequests: number; failedRequests: number; pendingRequests: number;
    cacheHits: number; sharedRequests: number; attempts: number; unknownCostAttempts: number; estimatedCostUsd: number;
    inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number }>();
  const user = (uid: string) => {
    let row = users.get(uid);
    if (!row) { row = { uid, requests: 0, successfulRequests: 0, failedRequests: 0, pendingRequests: 0, cacheHits: 0, sharedRequests: 0,
      attempts: 0, unknownCostAttempts: 0, estimatedCostUsd: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 }; users.set(uid, row); }
    return row;
  };
  for (const op of report.operations) {
    const row = user(op.uid); row.requests++;
    if (op.status === "success") row.successfulRequests++;
    else if (op.status === "error") row.failedRequests++; else row.pendingRequests++;
    if (op.cache === "hit") row.cacheHits++; if (op.cache === "shared") row.sharedRequests++;
  }
  for (const a of report.attempts) {
    const row = user(a.uid); row.attempts++;
    if (a.estimatedCostUsd === null) row.unknownCostAttempts++;
    else row.estimatedCostUsd += a.estimatedCostUsd;
    if (a.usage) { row.inputTokens += a.usage.inputTokens; row.cachedInputTokens += a.usage.cachedInputTokens;
      row.outputTokens += a.usage.outputTokens; row.reasoningTokens += a.usage.reasoningTokens; }
  }
  return [...users.values()].map(row => ({ ...row, estimatedCostUsd: Math.round(row.estimatedCostUsd * 1e9) / 1e9 }))
    .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd || a.uid.localeCompare(b.uid));
}
export function reportCsv(report: Report): string {
  const rows = summarize(report);
  const headers = ["uid", "requests", "successfulRequests", "failedRequests", "pendingRequests", "cacheHits", "sharedRequests", "attempts",
    "unknownCostAttempts", "estimatedCostUsd", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens"] as const;
  const escape = (value: string | number) => {
    const text = String(value);
    return `"${(/^[=+@\-\t\r\n]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
  };
  return "\uFEFF" + [headers.join(","), ...rows.map(row => headers.map(key => escape(row[key])).join(","))].join("\r\n") + "\r\n";
}
