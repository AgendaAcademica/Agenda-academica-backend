import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createAcademicExtractor } from "./services/extractor.factory.js";

const env = loadEnv();
const app = createApp(
  env,
  createAcademicExtractor(env),
);

const server = app.listen(env.PORT, "0.0.0.0", () => {
  console.log(`API acadêmica disponível na porta ${env.PORT}`);
  const model = env.AI_PROVIDER === "openai" ? env.OPENAI_MODEL : env.GEMINI_MODEL;
  console.log(`IA principal: ${env.AI_PROVIDER} (${model}); fallback: ${env.AI_FALLBACK_PROVIDER}.`);
});

const shutdown = (signal: string) => {
  console.log(`${signal} recebido. Encerrando a API com segurança...`);
  server.close((error) => {
    if (error) {
      console.error("Erro ao encerrar o servidor:", error);
      process.exit(1);
    }
    process.exit(0);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
