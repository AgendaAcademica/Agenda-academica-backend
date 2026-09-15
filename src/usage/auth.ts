import type { RequestHandler } from "express";
import { HttpError } from "./types.js";

export type VerifyToken = (token: string) => Promise<{ uid: string }>;
export function authenticate(verify: VerifyToken, allowedUids?: Set<string>): RequestHandler {
  return async (req, res, next) => {
    const match = req.headers.authorization?.match(/^Bearer ([^\s]+)$/i);
    if (!match) return next(new HttpError(401, "AUTH_REQUIRED", "Entre na sua conta para continuar."));
    let uid: string;
    try { uid = (await verify(match[1]!)).uid; }
    catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : "";
      const invalid = new Set(["auth/id-token-expired", "auth/id-token-revoked", "auth/invalid-id-token", "auth/argument-error", "auth/user-disabled", "auth/user-not-found"]);
      return next(invalid.has(String(code)) ? new HttpError(401, "AUTH_INVALID", "Sua sessão expirou. Entre novamente.")
        : new HttpError(503, "AUTH_UNAVAILABLE", "Não foi possível verificar sua sessão. Tente novamente mais tarde."));
    }
    if (!uid) return next(new HttpError(401, "AUTH_INVALID", "Sessão inválida."));
    if (allowedUids && !allowedUids.has(uid)) return next(new HttpError(403, "ACCESS_DENIED", "Esta conta não está autorizada para este recurso."));
    res.locals.uid = uid;
    next();
  };
}

// Acquired before multer allocates upload buffers; never queue unbounded uploads in memory.
export function concurrencyLimit(max: number): RequestHandler {
  let active = 0;
  return (_req, res, next) => {
    if (active >= max) return next(new HttpError(429, "SERVER_BUSY", "Há análises em andamento. Tente novamente em instantes."));
    active++;
    let released = false;
    res.locals.releaseExtraction = () => { if (!released) { released = true; active--; } };
    // A client disconnect during AI processing must not free the slot early.
    res.once("finish", res.locals.releaseExtraction);
    res.once("close", () => { if (!res.locals.processingExtraction) res.locals.releaseExtraction(); });
    next();
  };
}
