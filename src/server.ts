import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { GeminiAcademicExtractor } from "./services/gemini.service.js";

const env = loadEnv();
const app = createApp(
  env,
  new GeminiAcademicExtractor(env.GEMINI_API_KEY, env.GEMINI_MODEL, env.GEMINI_FALLBACK_MODEL),
);

const server = app.listen(env.PORT, "0.0.0.0", () => {
  console.log(`API acadêmica disponível na porta ${env.PORT}`);
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
