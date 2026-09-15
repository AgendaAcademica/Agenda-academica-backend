// Normalize transport failures without logging request bodies, URLs or credentials.
export function providerErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = error as { status?: unknown; name?: unknown; code?: unknown; cause?: { code?: unknown } };
  if (typeof value.status === "number") return value.status;
  if (["AbortError", "TimeoutError", "APIConnectionTimeoutError"].includes(String(value.name))) return 504;
  const code = String(value.cause?.code ?? value.code ?? "");
  if (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code)) return 504;
  if (["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_SOCKET"].includes(code)
    || value.name === "APIConnectionError") return 503;
  return undefined;
}
