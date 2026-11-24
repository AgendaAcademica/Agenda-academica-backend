import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import multer from "multer";
import { ZodError } from "zod";
import type { Env } from "./config/env.js";
import { DOCUMENT_UPLOAD_LIMIT_MESSAGE, MAX_DOCUMENTS_PER_UPLOAD } from "./config/upload.js";
import { documentsRouter } from "./routes/documents.routes.js";
import { getApiStatus, type AcademicExtractor } from "./services/academic-extractor.js";
import { authenticate, concurrencyLimit, type VerifyToken } from "./usage/auth.js";
import type { UsageService } from "./usage/meter.js";
import { HttpError } from "./usage/types.js";
import { usageRouter } from "./routes/usage.routes.js";
import { MemoryDisciplinePlanStore } from "./plan/memory-plan-store.js";
import type { DisciplinePlanStore } from "./plan/types.js";

export type AppSecurity = {
  verifyToken: VerifyToken;
  unlimitedEmails: Set<string>;
  admins: Set<string>;
  usage: UsageService;
  maxConcurrentExtractions: number;
  maxUploadTotalMb: number;
  planStore?: DisciplinePlanStore;
};
export function createApp(env: Env, extractor: AcademicExtractor, security: AppSecurity) {
  const app = express();
  const planStore = security.planStore ?? new MemoryDisciplinePlanStore();
  const origin = env.CORS_ORIGIN === "*" ? "*" : env.CORS_ORIGIN.split(",").map(value => value.trim());
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin }));
  app.use(express.json({ limit: "100kb" }));
  app.get("/health", (_request, response) => response.json({
    status: "ok",
    ai: {
      provider: env.AI_PROVIDER,
      model: env.AI_PROVIDER === "openai" ? env.OPENAI_MODEL : env.GEMINI_MODEL,
      fallbackProvider: env.AI_FALLBACK_PROVIDER,
      credentialsConfigured: env.AI_PROVIDER === "openai" ? Boolean(env.OPENAI_API_KEY) : Boolean(env.GEMINI_API_KEY)
    }
  }));
  app.use(
    "/api/v1/documents",
    authenticate(security.verifyToken, undefined, security.unlimitedEmails),
    documentsRouter(
      extractor,
      env.MAX_PDF_SIZE_MB,
      security.usage,
      security.maxUploadTotalMb,
      planStore,
      env.BASE_PLAN_DISCIPLINE_LIMIT,
      concurrencyLimit(security.maxConcurrentExtractions)
    )
  );
  app.use("/api/v1/admin/usage", authenticate(security.verifyToken, security.admins), usageRouter(security.usage.store));
  app.use((_request, response) => response.status(404).json({ error: "Rota não encontrada." }));

  const handler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof HttpError) {
      if (error.status === 429) {
        const daily = ["USER_DAILY_QUOTA", "GLOBAL_DAILY_QUOTA", "USER_AI_QUOTA", "GLOBAL_AI_QUOTA", "USER_COST_LIMIT", "GLOBAL_COST_LIMIT"].includes(error.code);
        const now = new Date();
        const seconds = daily ? Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()) / 1000) : 60;
        response.setHeader("Retry-After", String(seconds));
      }
      response.status(error.status).json({
        error: error.message,
        code: error.code,
        retryable: error.status === 503 || error.code === "SERVER_BUSY" || error.code === "USER_RATE_LIMIT",
        ...(error.details ?? {})
      });
      return;
    }
    if (error instanceof SyntaxError && "status" in error && (error as { status?: unknown }).status === 400) {
      response.status(400).json({ error: "Corpo JSON inválido.", code: "INVALID_JSON", retryable: false });
      return;
    }
    const upstreamStatus = getApiStatus(error);
    if (upstreamStatus === 429) {
      console.warn("Limite do provedor de IA atingido (HTTP 429).");
      response.setHeader("Retry-After", "30");
      response.status(429).json({
        error: "O limite temporário de análises foi atingido. Aguarde alguns instantes e tente novamente.",
        code: "PROVIDER_RATE_LIMIT",
        retryable: true
      });
      return;
    }
    if (upstreamStatus === 500 || upstreamStatus === 502 || upstreamStatus === 503 || upstreamStatus === 504) {
      console.warn(`Provedor de IA temporariamente indisponível (HTTP ${upstreamStatus}).`);
      response.setHeader("Retry-After", "30");
      response.status(503).json({
        error: "O serviço de inteligência artificial está temporariamente ocupado. Aguarde alguns instantes e tente novamente.",
        retryable: true
      });
      return;
    }
    // Never log whole SDK errors: they can contain document text, headers or credentials.
    console.error("Falha no processamento", { status: upstreamStatus ?? null, type: error instanceof Error ? error.name : "unknown" });
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      response.status(413).json({ error: `O arquivo excede o limite de ${env.MAX_PDF_SIZE_MB} MB.` });
      return;
    }
    if (error instanceof ZodError) {
      response.status(502).json({ error: "A inteligência artificial retornou dados fora do formato esperado." });
      return;
    }
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_COUNT") {
      response.status(400).json({ error: DOCUMENT_UPLOAD_LIMIT_MESSAGE, code: "TOO_MANY_FILES", maxFiles: MAX_DOCUMENTS_PER_UPLOAD, retryable: false });
      return;
    }
    if (error instanceof multer.MulterError) {
      response.status(400).json({ error: `Envio inválido. Use até ${MAX_DOCUMENTS_PER_UPLOAD} documentos nos campos file ou files.`, code: "INVALID_UPLOAD" });
      return;
    }
    response.status(502).json({ error: "Não foi possível processar o documento com a inteligência artificial." });
  };
  app.use(handler);
  return app;
}
