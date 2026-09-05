import type { Env } from "../config/env.js";
import { CachedAcademicExtractor, FallbackAcademicExtractor, type AcademicExtractor } from "./academic-extractor.js";
import { GeminiAcademicExtractor } from "./gemini.service.js";
import { OpenAIAcademicExtractor } from "./openai.service.js";

export function createAcademicExtractor(env: Env): AcademicExtractor {
  const primary = createProvider(env.AI_PROVIDER, env);
  const extractor = env.AI_FALLBACK_PROVIDER === "none" || env.AI_FALLBACK_PROVIDER === env.AI_PROVIDER
    ? primary
    : new FallbackAcademicExtractor(primary, createProvider(env.AI_FALLBACK_PROVIDER, env));
  return new CachedAcademicExtractor(extractor, env.AI_CACHE_TTL_MINUTES * 60_000, env.AI_CACHE_MAX_ENTRIES);
}

function createProvider(provider: "gemini" | "openai", env: Env): AcademicExtractor {
  if (provider === "openai") {
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada para o provedor OpenAI.");
    return new OpenAIAcademicExtractor(env.OPENAI_API_KEY, env.OPENAI_MODEL);
  }
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY não configurada para o provedor Gemini.");
  return new GeminiAcademicExtractor(env.GEMINI_API_KEY, env.GEMINI_MODEL, env.GEMINI_FALLBACK_MODEL);
}
