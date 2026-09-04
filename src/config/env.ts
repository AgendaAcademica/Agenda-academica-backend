import "dotenv/config";
import { z } from "zod";
const schema=z.object({NODE_ENV:z.enum(["development","test","production"]).default("development"),PORT:z.coerce.number().int().positive().default(3000),GEMINI_API_KEY:z.string().min(1,"GEMINI_API_KEY não configurada"),GEMINI_MODEL:z.string().min(1).default("gemini-3.5-flash"),GEMINI_FALLBACK_MODEL:z.string().min(1).default("gemini-3.5-flash-lite"),MAX_PDF_SIZE_MB:z.coerce.number().positive().max(50).default(20),CORS_ORIGIN:z.string().default("*")});
export type Env=z.infer<typeof schema>;
export function loadEnv(source:NodeJS.ProcessEnv=process.env):Env{return schema.parse(source);}
