import { z } from "zod";
import type { Env } from "../config/env.js";
import type { PriceTable, UsageLimits } from "./types.js";

const priceSchema = z.object({ version: z.string().min(1), inputUsdPerMillion: z.number().finite().nonnegative(),
  cachedInputUsdPerMillion: z.number().finite().nonnegative(), outputUsdPerMillion: z.number().finite().nonnegative() }).strict();
const schema = z.object({
  FIREBASE_PROJECT_ID: z.string().min(1), FIRESTORE_DATABASE_ID: z.string().min(1).default("(default)"),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  ADMIN_UIDS: z.string().default(""),
  UNLIMITED_USER_EMAILS: z.string().default("").transform(value =>
    value.split(",").map(email => email.trim().toLowerCase()).filter(Boolean)
  ).pipe(z.array(z.string().email())),
  AI_PRICES_JSON: z.string().default("{}"),
  USER_DAILY_REQUESTS: z.coerce.number().int().positive().default(20),
  GLOBAL_DAILY_REQUESTS: z.coerce.number().int().positive().default(200),
  USER_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(3),
  USER_DAILY_AI_ATTEMPTS: z.coerce.number().int().positive().default(40),
  GLOBAL_DAILY_AI_ATTEMPTS: z.coerce.number().int().positive().default(400),
  USER_DAILY_USD: z.coerce.number().positive().default(1),
  GLOBAL_DAILY_USD: z.coerce.number().positive().default(10),
  MAX_UPLOAD_TOTAL_MB: z.coerce.number().positive().max(50).default(20),
  MAX_CONCURRENT_EXTRACTIONS: z.coerce.number().int().positive().max(20).default(2)
});
export function loadUsageConfig(env: Env, source: NodeJS.ProcessEnv = process.env) {
  const config = schema.parse(source);
  const unlimitedEmails = new Set(config.UNLIMITED_USER_EMAILS);
  const admins = new Set(config.ADMIN_UIDS.split(",").map(s => s.trim()).filter(Boolean));
  const prices: PriceTable = z.record(z.string(), priceSchema).parse(JSON.parse(config.AI_PRICES_JSON));
  if (env.NODE_ENV === "production") {
    if (!admins.size) throw new Error("ADMIN_UIDS deve listar os administradores do relatório.");
    const providers = new Set([env.AI_PROVIDER, env.AI_FALLBACK_PROVIDER]);
    const models = [ ...(providers.has("gemini") ? [`gemini:${env.GEMINI_MODEL}`, `gemini:${env.GEMINI_FALLBACK_MODEL}`] : []),
      ...(providers.has("openai") ? [`openai:${env.OPENAI_MODEL}`] : []) ];
    for (const model of models) if (!prices[model]) throw new Error(`Cadastre a tarifa de ${model} em AI_PRICES_JSON antes do deploy.`);
    if (source.FIRESTORE_EMULATOR_HOST || source.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Emuladores não são permitidos em produção.");
  }
  const limits: UsageLimits = { userDailyRequests: config.USER_DAILY_REQUESTS, globalDailyRequests: config.GLOBAL_DAILY_REQUESTS,
    userRequestsPerMinute: config.USER_REQUESTS_PER_MINUTE, userDailyAttempts: config.USER_DAILY_AI_ATTEMPTS,
    globalDailyAttempts: config.GLOBAL_DAILY_AI_ATTEMPTS, userDailyUsd: config.USER_DAILY_USD, globalDailyUsd: config.GLOBAL_DAILY_USD };
  return { ...config, unlimitedEmails, admins, prices, limits };
}
export type UsageConfig = ReturnType<typeof loadUsageConfig>;
