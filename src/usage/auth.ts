import type { RequestHandler } from "express";
import { HttpError } from "./types.js";

export type VerifiedUser = { uid: string; email?: string; email_verified?: boolean };
export type VerifyToken = (token: string) => Promise<VerifiedUser>;
export function authenticate(verify: VerifyToken, allowedUids?: Set<string>, unlimitedEmails: ReadonlySet<string> = new Set()): RequestHandler {
  return async (req, res, next) => {
    const match = req.headers.authorization?.match(/^Bearer ([^\s]+)$/i);
    if (!match) return next(new HttpError(401, "AUTH_REQUIRED", "Entre na sua conta para continuar."));
    let user: VerifiedUser;
    try { user = await verify(match[1]!); }
    catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : "";
      const invalid = new Set(["auth/id-token-expired", "auth/id-token-revoked", "auth/invalid-id-token", "auth/argument-error", "auth/user-disabled", "auth/user-not-found"]);
      return next(invalid.has(String(code)) ? new HttpError(401, "AUTH_INVALID", "Sua sessão expirou. Entre novamente.")
        : new HttpError(503, "AUTH_UNAVAILABLE", "Não foi possível verificar sua sessão. Tente novamente mais tarde."));
    }
    if (!user.uid) return next(new HttpError(401, "AUTH_INVALID", "Sessão inválida."));
    if (allowedUids && !allowedUids.has(user.uid)) return next(new HttpError(403, "ACCESS_DENIED", "Esta conta não está autorizada para este recurso."));
    res.locals.uid = user.uid;
    // Only the verified Firebase token can grant an email-based exemption.
    res.locals.unlimitedUserUsage = user.email_verified === true &&
      !!user.email && unlimitedEmails.has(user.email.trim().toLowerCase());
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
