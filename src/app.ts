import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import multer from "multer";
import { ZodError } from "zod";
import type { Env } from "./config/env.js";
import { documentsRouter } from "./routes/documents.routes.js";
import { getApiStatus, type AcademicExtractor } from "./services/academic-extractor.js";

export function createApp(env: Env, extractor: AcademicExtractor) {
  const app = express();
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
  app.use("/api/v1/documents", documentsRouter(extractor, env.MAX_PDF_SIZE_MB));
  app.use((_request, response) => response.status(404).json({ error: "Rota não encontrada." }));

  const handler: ErrorRequestHandler = (error, _request, response, _next) => {
    const upstreamStatus = getApiStatus(error);
    if (upstreamStatus === 429) {
      console.warn("Limite do provedor de IA atingido (HTTP 429).");
      response.setHeader("Retry-After", "30");
      response.status(429).json({
        error: "O limite temporário de análises foi atingido. Aguarde alguns instantes e tente novamente.",
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
    console.error(error);
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      response.status(413).json({ error: `O arquivo excede o limite de ${env.MAX_PDF_SIZE_MB} MB.` });
      return;
    }
    if (error instanceof ZodError) {
      response.status(502).json({ error: "A inteligência artificial retornou dados fora do formato esperado.", details: error.issues });
      return;
    }
    response.status(502).json({ error: "Não foi possível processar o documento com a inteligência artificial." });
  };
  app.use(handler);
  return app;
}
